import type { IStorageAdapter, WithdrawalRecord } from "@obsidion/front-core"
import {
  analyticsEnabled,
  firePaylinkEvent,
  paylinkAmountBucket,
  paylinkPh,
  type PaylinkAmountBucket,
  type PaylinkFlavor,
} from "../../lib/analytics"

/**
 * The `claimed` lifecycle event of a claim to Ethereum. The burn can outlive the screen that started
 * it (a broadcast recovered after an error, a closed tab), so the event is saved as the burn starts
 * and sent once its withdrawal record shows the burn mined on L2, by whichever surface sees that
 * first. Keyed by the record's `paylinkId`; only the link hash, flavor and amount range are kept, and
 * only while analytics is on. Sending deletes the entry under a lock, so this browser sends a claim
 * at most once; delivery is the usual unacknowledged POST.
 */

const OWED_KEY = "analytics.paylinkClaims"
const LOCK = "webwallet.analytics.paylinkClaims"
/** An entry whose burn never mined (it failed and was not retried) is forgotten after this. */
const OWED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface OwedClaim {
  paylink_ph: string
  flavor: PaylinkFlavor
  amount_bucket: PaylinkAmountBucket
  at: number
}

type Owed = Record<string, OwedClaim>

async function readOwed(storage: IStorageAdapter): Promise<Owed> {
  try {
    return (JSON.parse((await storage.getItem(OWED_KEY)) ?? "{}") as Owed) ?? {}
  } catch {
    return {}
  }
}

/** Serializes this tab where Web Locks are missing; Web Locks also cover the other tabs. */
let tabQueue: Promise<void> = Promise.resolve()

function withLock(fn: () => Promise<void>): Promise<void> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (locks) return locks.request(LOCK, fn)
  const run = tabQueue.then(fn, fn)
  tabQueue = run.catch(() => {})
  return run
}

/** Past the burn: the escrow is spent on L2, whatever the L1 leg does next. */
const mined = (r: WithdrawalRecord) => r.phase !== "submitting" && r.phase !== "failed"

/** Saves the claim this burn will make. Call before the burn is signed; never throws. */
export async function owePaylinkClaim(
  storage: IStorageAdapter,
  paylinkId: string,
  claim: {
    rollupAddress: string
    secret: { toBuffer(): Uint8Array }
    flavor: PaylinkFlavor
    amount: bigint
    decimals: number
  },
): Promise<void> {
  try {
    if (!analyticsEnabled()) return
    const ph = await paylinkPh({ rollupAddress: claim.rollupAddress, secret: claim.secret })
    await withLock(async () => {
      const owed = await readOwed(storage)
      owed[paylinkId] = {
        paylink_ph: ph,
        flavor: claim.flavor,
        amount_bucket: paylinkAmountBucket(claim.amount, claim.decimals),
        at: Date.now(),
      }
      await storage.setItem(OWED_KEY, JSON.stringify(owed))
    })
  } catch {
    // Analytics must never hold up a claim.
  }
}

/** Sends every saved claim whose burn has mined, and forgets it. Never throws. */
export async function reportPaylinkClaims(
  records: readonly WithdrawalRecord[],
  storage: IStorageAdapter,
): Promise<void> {
  try {
    await withLock(async () => {
      const owed = await readOwed(storage)
      const ids = Object.keys(owed)
      if (ids.length === 0) return
      const now = Date.now()
      let changed = false
      for (const id of ids) {
        const claim = owed[id]!
        if (records.some((r) => r.paylinkId === id && r.intent !== "registration" && mined(r))) {
          firePaylinkEvent({
            stage: "claimed",
            flavor: claim.flavor,
            amount_bucket: claim.amount_bucket,
            paylink_ph: claim.paylink_ph,
          })
        } else if (now - claim.at <= OWED_MAX_AGE_MS) {
          continue
        }
        delete owed[id]
        changed = true
      }
      if (changed) await storage.setItem(OWED_KEY, JSON.stringify(owed))
    })
  } catch {
    // Analytics must never break the withdrawals view.
  }
}
