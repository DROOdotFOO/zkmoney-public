/**
 * SIPA deposit sync — discovery → claim → spendable, the recipient-side
 * composition over the sdk primitives and the front-core crypto/store:
 *
 *   1. read the recipient's `SIPA` events (`shared_secret_salt` + `resweepable`)
 *      off the token (requires `setupSipaDiscovery` to have registered the
 *      senders in this PXE),
 *   2. per event, derive the recipient commitment + recoveryAddress and compute
 *      the SIPA address offline,
 *   3. observe every SIPA at once (`observeSipas`): the portal deposits its sweeps made, which
 *      carry the claim inputs and the L1→L2 message key, its transfers in and out, and its
 *      holdings — a fixed number of requests however many SIPAs,
 *   4. per unclaimed sweep, wait for settlement (`store_deposit` asserts the settled root, so
 *      claiming earlier just fails), then claim via `TokenService.claimSweptDeposit` — after which
 *      `balance_of` reflects the net amount and the next transfer spends it.
 *
 * The first `Transfer(to = sipa)` stamps the funding attribution (funder address + tx) and fires
 * the deposit-attested contact hook.
 *
 * Every known SIPA is observed every pass, settled or not, since a claimed SIPA can be paid again;
 * claims dedup by inbox index. The relayer sweeps an address once per publish, so new funds on a
 * claimed SIPA reopen its record and ask the caller to publish it again (`onSweptAddressFunded`);
 * an address that is not resweepable can only be recovered. A funded SIPA whose balance is at or
 * below the deposit floor — the relayer's sweep fee — can never be swept, so it flips to
 * `recoverable`, surfacing the `recoverERC20` exit.
 *
 * A SIPA reads its whole history once, then rides the deployment's cursor: each pass reads only the
 * blocks since the last. A sweep not yet claimable keeps its claim inputs on the record. Only the
 * claims queue on the PXE one at a time; the pass reads the balance once after its last.
 *
 * Per-event failures are isolated: one bad SIPA must not stall the rest.
 * Pure over injected collaborators; shared by every wallet front end.
 */

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { isL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { keccak256 } from "@aztec-labs/foundation/crypto/keccak"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import { formatUnits, type Address, type Hex, type PublicClient } from "viem"
import type { OxideEnvTuple, RegistrationSchedule } from "@obsidion/core/types"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import { registrationFloor } from "@obsidion/core/constants"
import {
  directAnnouncementIntentHash,
  fetchSipaEvents,
  isAlreadyClaimedDepositError,
  readBlessedImplementations,
  readBlockTimeMs,
  readDepositFee,
  readDepositSIPAImplementation,
  readRegistrationSIPAImplementation,
  readSipaDepositsConsumed,
  readSipaCloneImplementation,
  readSipaIntent,
  readSweepEmitters,
  type PortalDeposit,
  type SipaEvent,
  type TokenService,
  type TokenTransfer,
} from "@obsidion/sdk"
import { logger } from "../utils/logger"

import { OxidePortalAbi, SipaIntent } from "@oxide/l1-contracts"
import { computeSIPAAddress as computeAccountSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { computeSIPAAddress } from "../core/services/deposits/sipa/sipaAddress"
import { isAlreadyClaimedError } from "./depositClaimErrors"
import {
  deploymentSipaRoute,
  sipaIntentName,
  sipaRecordIntent,
  sipaRecordIntentOf,
} from "./sipaRoute"
import {
  sipaRowByFunding,
  sipaRowByL2Token,
  sipaRowByPortal,
  sipaRowFundingTokens,
  type SipaRow,
} from "./sipaRows"
export { isAlreadyClaimedError }
import {
  firstFunding,
  NATIVE_ETH,
  inRowUnits,
  readSipaFunding,
  sweptFunding,
  type SipaFundingToken,
} from "./sipaFunding"
import { observeSipas, type ObservedSweep, type SipaObserved } from "./sipaObservation"
import {
  computeStealthRecipientHash,
  deriveRecoveryAddress,
  type SipaK1Point,
} from "../core/services/deposits/sipa/stealth"
import {
  directDepositKey,
  directDepositSettled,
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  type SIPADepositFields,
  type SIPADepositRecord,
  type SIPAPendingSweep,
  type SIPASweep,
  type SIPADepositStore,
} from "../core/services/deposits/SIPADepositStore"
import { syncCatchUp } from "../engine/catchUp"

/** Node surface for the settlement check (`isL1ToL2MessageReady`) and the consumed check. */
export interface SipaClaimsNode {
  getL1ToL2MessageCheckpoint(messageHash: Fr): Promise<number | undefined>
  /** The batched nullifier lookup the consumed check uses. */
  findLeavesIndexes?: AztecNode["findLeavesIndexes"]
  getBlockData?(tag: string): Promise<unknown>
}

/**
 * Overlap re-read on a resumed scan, so a `Sweep` cannot fall between two windows when
 * the head it was measured against is reorged away. Re-reading a claimed sweep costs
 * nothing (inbox-index dedup); missing one strands the deposit.
 */
const SCAN_REORG_OVERLAP_BLOCKS = 128n

/** How long a funded, sweepable SIPA may wait for the relayer before it is published again. */
export const SWEEP_OVERDUE_MS = 60 * 60_000

/** How often an overdue SIPA is published again while it stays unswept. */
export const REPUBLISH_INTERVAL_MS = 24 * 60 * 60_000

/** How long a fresh SIPA counts as in flight, so the caller keeps its fast cadence. */
const FRESH_WINDOW_MS = 10 * 60_000

/** The look-back a SIPA's first read takes when the caller cannot say where its history starts. */
const SIPA_DEFAULT_LOOKBACK_BLOCKS = 50_000n

/**
 * Whether `record`'s next event is imminent: a sweep or settlement in flight, or a fresh address.
 * A missing record is an event discovered just now, which always is; a replayed one is history.
 */
function isInFlight(record: SIPADepositRecord | null, now: number): boolean {
  if (!record) return true
  // A sweep or an L1->L2 settlement is in flight; both land in minutes.
  if (record.phase === "sweeping" || record.phase === "pendingClaim") return true
  if (isSettledSipaPhase(record.phase)) return false
  if (record.replayed) return false
  return now - record.startTime < FRESH_WINDOW_MS
}

/** The funder proven by the on-chain funding transfer — the legacy gateway hook's shape. */
export interface SipaFundingWalletDetected {
  address: Address
  walletName?: string
  walletImageUrl?: string
  walletProvider?: string
  lastUsedAt?: number
}

/**
 * What a wallet can say about a registration SIPA's pricing:
 *
 * - a `RegistrationSchedule` — ours, and its sweep is priced against these amounts;
 * - `"unsweepable"` — ours, and no schedule can ever sweep it (the controller pays exactly the fee
 *   the address commits to), so any balance there is recoverable;
 * - `null` — ours, schedule not in hand; hold the phase for a pass that can price it;
 * - `undefined` — not ours: a plain deposit, classified on the fee and the cap alone.
 */
export type RegistrationScheduleAnswer = RegistrationSchedule | "unsweepable" | null | undefined

export interface SipaDepositSyncDeps {
  publicClient: PublicClient
  /** Node handle for the settlement check (`isL1ToL2MessageReady`). */
  node: SipaClaimsNode
  /** Reads the recipient's `SIPA` events off the token. */
  wallet: Pick<Wallet, "getPrivateEvents">
  /**
   * The token service of a row's L2 token: a sweep is claimed on the token of the row it settled on. Absent in an
   * observe-only pass, which claims nothing.
   */
  tokenServiceFor?: (l2Token: string) => Promise<Pick<TokenService, "claimSweptDeposit">>
  /**
   * Reads L1 and writes records only: no L2 events, no readiness reads, no claims. A claimable sweep
   * keeps its claim inputs for a full pass. For a surface that must not compete with the PXE, such
   * as signup's sponsored account setup, or a screen watching an address. It reads only the head
   * while the head has not passed the cursor.
   */
  observeOnly?: boolean
  /**
   * Reads the balance after a claim lands in the PXE. The claim is recorded once this settles, so
   * the balance holds the deposit before its record reads `claimed`. A failed read is logged and the
   * claim recorded anyway.
   */
  refreshBalance?: () => Promise<void>
  /** Items the pass has checked, once its events are read and the total is known. */
  onProgress?: (done: number, total: number) => void
  /** Without the cursor methods every SIPA re-reads its whole history each pass. */
  store: Pick<SIPADepositStore, "get" | "upsert" | "list" | "remove"> &
    Partial<
      Pick<SIPADepositStore, "observedThrough" | "setObservedThrough" | "adoptObservedThrough">
    >
  tuple: OxideEnvTuple
  /** The recipient account this PXE discovers events for. */
  recipient: AztecAddress
  /**
   * `recipient` takes over a portal-wide cursor the store still holds (one keyed by no account): set
   * for the one account whose passes wrote it. Any other account starts from its history.
   */
  adoptLegacyCursor?: boolean
  /**
   * Keeps the pass out of the session's sync catch-up: it neither begins one nor joins one in
   * progress. For a pass over another account, whose backfill must not hold the session's balance
   * and activity placeholders.
   */
  skipCatchUp?: boolean
  /** The user's stealth public key (`deriveStealthKey(masterSecret).publicKey`). */
  stealthPublicKey: SipaK1Point
  /**
   * The recipient's nullifier hiding key. With it, sweeps whose deposits were already spent (their
   * nullifiers are in the tree) are found in one batched lookup before any claim, and never sent to
   * the PXE.
   */
  masterNullifierHidingKey?: GrumpkinScalar
  recoveryAccount?: Address
  /**
   * The rows of the pinned table the account's SIPAs settle on (`sipaRows`). Events are read on each
   * row's L2 token, each sweep is claimed through its own row, and a SIPA's funding is priced on the
   * row each token settles on.
   */
  rows: readonly SipaRow[]
  /** A row portal's `TX_AMOUNT_CAP()` when the caller keeps it across runs; read once per run and row without it. */
  txAmountCap?: (row: SipaRow) => Promise<bigint>
  l1ChainId: number
  /** The wallet's network, stamped on the records the pass creates. */
  networkId: string
  /**
   * Fired once per SIPA when funding attribution first lands — the app-level
   * hook for saving deposit-attested contacts. Wallet identity fields are set
   * only when the funder matches the record's connected-session wallet.
   */
  onFundingWalletDetected?: (params: SipaFundingWalletDetected) => Promise<void>
  /**
   * The schedule a registration SIPA's sweep is priced against, for the addresses this wallet
   * registered. Without it a deposit short of the schedule's floor reads as sweepable and is
   * stamped with a credit the chain will never pay.
   */
  registrationScheduleFor?: (sipa: Address) => RegistrationScheduleAnswer
  /**
   * The first L1 block a deposit to this account can sit in. A SIPA scans from here once: when it
   * has never been scanned, and when a replayed deposit is still unfunded after the default
   * look-back. Without it those scans take the look-back, which misses an older deposit.
   */
  historyStartBlock?: (head: bigint) => Promise<bigint>
  /**
   * A claimed SIPA holds new funds. The relayer sweeps it again only after a newer publish on
   * Aztec, so the caller publishes it again. Fired once, when the record reopens.
   */
  onSweptAddressFunded?: (sipaAddress: Address) => Promise<void>
  /**
   * A funded, sweepable SIPA has gone unswept for `SWEEP_OVERDUE_MS`: the relayer dropped its
   * operation (it drops one that waits 14 days) or never had it. The caller publishes it again and
   * says whether it could. Asked at most once per `REPUBLISH_INTERVAL_MS`, whatever the answer.
   */
  onSweepOverdue?: (sipaAddress: Address) => Promise<boolean>
}

export interface SipaDepositSyncResult {
  /** Distinct SIPAs discovered from `SIPA` events this run. */
  discovered: number
  /**
   * SIPAs with a sweep or settlement in flight, or freshly handed out. Zero means nothing is
   * expected to change soon and the caller can poll slowly.
   */
  active: number
  /** Sweeps claimed into the PXE this run (balance-visible). */
  claimed: number
  /** Sweeps found but not yet settled L1→L2 — retried next sync. */
  pendingSettlement: number
  /** SIPAs stuck under the fee floor — recoverERC20 is the exit. */
  recoverable: number
  /**
   * Sweeps the PXE had already claimed but the local record hadn't marked
   * (crash between claim and store write, store restore) — reconciled, not
   * re-claimed.
   */
  reconciled: number
  /** Events or sweeps that failed this run (isolated; retried next sync). */
  failed: number
  /**
   * The pass read everything it should. False when anything failed, the history start did not
   * read, a stray was adopted (its history is read next pass), the cursor write was skipped, or a
   * step gave up and left its work to a later pass.
   */
  complete: boolean
}

export async function syncSipaDeposits(
  callerDeps: SipaDepositSyncDeps,
): Promise<SipaDepositSyncResult> {
  const deps = {
    ...callerDeps,
    publicClient: passClient(callerDeps.publicClient),
    store: strictWrites(callerDeps.store),
  }
  const { tuple } = deps
  if (!tuple.sipaFactory || !deps.rows.length) {
    throw new Error(
      "oxide manifest lacks the SIPA surface (sipaFactory / table rows) — " +
        "SIPA deposit sync requires a dev.json-shaped deployment",
    )
  }
  if (!/^\d+$/.test(tuple.rollupVersion ?? "")) {
    throw new Error(
      `oxide manifest has a missing or non-numeric rollupVersion ("${tuple.rollupVersion}") — ` +
        "the SIPA CREATE2 derivation binds to it",
    )
  }

  const result: SipaDepositSyncResult = {
    discovered: 0,
    active: 0,
    claimed: 0,
    pendingSettlement: 0,
    recoverable: 0,
    reconciled: 0,
    failed: 0,
    complete: false,
  }

  // A received deposit is the deposit intent, so its clone delegates to the factory's deposit
  // implementation; the offline address derivation needs it. The factory's pointer is read rather
  // than the tuple's `depositSIPAImplementation` on purpose: the pointer is what the deposit-address
  // side sent the payer to. Retired generations are the historic probe's job, and it must not read
  // this pointer at all.
  //
  // One head bounds every SIPA's scan this run, and is what each persists as scanned-through — so
  // `cacheTime: 0`, since viem's default caches it for a polling interval. A lagging head both hides
  // the newest sweeps and gets persisted as the cursor, and the reorg overlap is the only thing that
  // would ever walk back over them.
  const [implementation, read, head] = await Promise.all([
    readDepositSIPAImplementation(deps.publicClient, tuple.sipaFactory as Address),
    deps.observeOnly ? Promise.resolve([]) : readRowEvents(deps),
    deps.publicClient.getBlockNumber({ cacheTime: 0 }),
  ])
  const depositImplementation = EthAddress.fromString(implementation)
  // A direct deposit's announcement names no SIPA: it only gives its record, before any derivation.
  const { events, missed } = await recordDirectAnnouncements(deps, read)

  const seen = new Set<string>()
  const kinds = await Promise.all(events.map((event) => eventKind(event, deps.recipient)))
  const eventKey = (i: number) => pinKey(events[i]!.sharedSecretSalt.toString(), kinds[i]!)
  const recipient = deps.recipient.toString()
  const recipientKey = recipient.toLowerCase()

  // A self-initiated SIPA's record was written at derivation, before its event existed. Index those
  // records by salt and intent kind so an event and its record never disagree on the address. A
  // registration restarted at another fee reuses its salt at a new address, so one key can pin
  // several. Only the recipient's own records: a salt carries no recipient and nonces restart per
  // account, so another account's record under the same salt is not this one's.
  const localByKey = new Map<string, Address[]>()
  for (const r of deps.store.list()) {
    if (!r.messageSecret || r.recipientL2Address?.toLowerCase() !== recipientKey) continue
    for (const kind of recordKinds(r)) {
      const key = pinKey(r.messageSecret, kind)
      localByKey.set(key, [...(localByKey.get(key) ?? []), r.sipaAddress])
    }
  }

  const now = Date.now()

  // Priced off the table row a sweep settles on for the address's intent, one read per intent and row
  // per run — and none at all if no SIPA reaches the probe. A failed read is dropped from the map, so
  // one transient RPC error leaves only its own event unpriced.
  const fees = new Map<string, Promise<bigint>>()
  const feeFor = (intent: SipaIntent, row: SipaRow) => {
    const key = `${intent}:${row.portal.toLowerCase()}`
    const cached = fees.get(key)
    if (cached) return cached
    const pending = readDepositFee(
      deps.publicClient,
      deploymentSipaRoute(tuple, intent, row.token.address),
    )
    fees.set(key, pending)
    pending.catch(() => {
      if (fees.get(key) === pending) fees.delete(key)
    })
    return pending
  }
  let registrationRead: Promise<EthAddress> | undefined
  const registrationImplementation = () =>
    (registrationRead ??= readRegistrationSIPAImplementation(
      deps.publicClient,
      tuple.sipaFactory as Address,
    ).then((address) => EthAddress.fromString(address)))
  // The sweep window's ceiling. A per-portal immutable, so one lazy read per row per run unless the caller
  // holds it.
  const caps = new Map<string, Promise<bigint>>()
  const txAmountCap = (row: SipaRow) => {
    if (deps.txAmountCap) return deps.txAmountCap(row)
    const key = row.portal.toLowerCase()
    const cached = caps.get(key)
    if (cached) return cached
    const pending = deps.publicClient.readContract({
      address: row.portal,
      abi: OxidePortalAbi,
      functionName: "TX_AMOUNT_CAP",
    })
    caps.set(key, pending)
    pending.catch(() => {
      if (caps.get(key) === pending) caps.delete(key)
    })
    return pending
  }
  const fundingTokens = sipaRowFundingTokens(deps.rows)
  // A look-back taken because the history start failed to read is partial, so it marks nothing read.
  let historyFailed = false
  let startRead: Promise<bigint | undefined> | undefined
  const historyStart = () =>
    (startRead ??= (deps.historyStartBlock?.(head) ?? Promise.resolve(undefined)).catch((err) => {
      historyFailed = true
      logger.warn("[sipaClaims] history start read failed, using the default look-back:", err)
      return undefined
    }))
  // Cleared by any step that leaves work to a later pass.
  let complete = !missed
  // A skipped cursor write follows a failure or a failed history start, both counted here.
  const finish = () => {
    result.complete = complete && !historyFailed && result.failed === 0
    return result
  }
  // A user operation's SIPA delegates to the implementation the factory blessed when it was
  // prepared, and a later bless keeps the earlier one blessed, so every blessed one is a candidate.
  // Read once per run, however it answered, only when an event needs it. The sdk reads the factory's
  // whole history where the RPC allows and this pass's window where it does not.
  let blessedRead: Promise<EthAddress[]> | undefined
  const userOpImplementations = () =>
    (blessedRead ??= (async () =>
      readBlessedImplementations(
        deps.publicClient,
        tuple.sipaFactory as Address,
        SipaIntent.UserOp,
        (await historyStart()) ?? lookbackStart(head),
      ))().then((addresses) => addresses.map((address) => EthAddress.fromString(address))))
  /** A factory clone's record intent, null for an address the factory does not vouch for. */
  const cloneIntent = async (clone: Address) =>
    sipaRecordIntentOf(await readSipaIntent(deps.publicClient, tuple.sipaFactory as Address, clone))
  const cloneImplementation = async (clone: Address) => {
    const implementation = await readSipaCloneImplementation(
      deps.publicClient,
      tuple.sipaFactory as Address,
      clone,
    )
    return /^0x0+$/i.test(implementation) ? undefined : EthAddress.fromString(implementation)
  }
  const recordWrites: (() => Promise<void>)[] = []
  let claims = 0
  let writesFailed = false
  const ready = new Map<string, Promise<boolean>>()
  const run: SyncRunContext = {
    consumed: new Set(),
    retryFrom: new Map(),
    head,
    now,
    feeFor,
    registrationImplementation,
    userOpImplementations,
    cloneIntent,
    cloneImplementation,
    txAmountCap,
    fundingTokens,
    record: (write) => void recordWrites.push(write),
    incomplete: () => {
      complete = false
    },
    claimed: (write) => {
      claims += 1
      recordWrites.push(write)
    },
    messageReady: (messageKey) => {
      const key = messageKey.toLowerCase()
      const cached = ready.get(key)
      if (cached) return cached
      const pending = isL1ToL2MessageReady(
        deps.node as never,
        Fr.fromHexString(messageKey) as never,
      )
      ready.set(key, pending)
      pending.catch(() => {
        if (ready.get(key) === pending) ready.delete(key)
      })
      return pending
    },
  }

  const replaying = events.some((_, i) => !localByKey.has(eventKey(i)))
  // A pass that discovers events with no local record is replaying history onto this device, so it
  // holds the balance and activity placeholders until its claims have refreshed the chain view.
  // Otherwise it only joins a catch-up already in progress.
  const end =
    !deps.skipCatchUp && (replaying || syncCatchUp.status.get()) ? syncCatchUp.begin() : undefined
  const eventPins = new Map<string, number>()
  events.forEach((_, i) => {
    const key = eventKey(i)
    if (!eventPins.has(key)) eventPins.set(key, localByKey.get(key)?.length ?? 1)
  })
  // Records are the authoritative list of self-initiated SIPAs, so one whose event is absent
  // (discovery raced the broadcast, PXE reset) still syncs, settled or not: a settled address can
  // be paid again.
  const eventless = deps.store.list().filter(
    (r) =>
      !!r.messageSecret &&
      r.recipientL2Address?.toLowerCase() === recipientKey &&
      // A direct deposit's commitment is public: another sender can deposit under it first, so
      // its record is read until the rail has claimed the batch's whole amount.
      !(r.direct && directDepositSettled(r)) &&
      !recordSeen({ ...r, messageSecret: r.messageSecret }, new Set(eventPins.keys())),
  )
  const total = [...eventPins.values()].reduce((sum, n) => sum + n, 0) + eventless.length
  let done = 0
  const stepProgress = () => deps.onProgress?.(Math.min(++done, total), total)
  deps.onProgress?.(0, total)

  const attempt = async <T>(label: string, step: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await step()
    } catch (err) {
      result.failed += 1
      logger.warn(`[sipaClaims] ${label} sync failed (will retry next sync):`, err)
      stepProgress()
      return undefined
    }
  }

  try {
    // Every event and record names the addresses it needs read; one observation reads them all.
    const planned: PlannedEvent[] = []
    // Records whose plan failed: they keep the window this pass would have read.
    const unplanned: Address[] = []
    for (const [i, event] of events.entries()) {
      const key = eventKey(i)
      if (seen.has(key)) continue
      seen.add(key)
      for (const pin of localByKey.get(key) ?? [undefined]) {
        const plan = await attempt("event", () =>
          planEvent(deps, event, depositImplementation, run, pin),
        )
        if (plan) planned.push(plan)
        else if (pin) unplanned.push(pin)
      }
    }
    for (const r of eventless) {
      const plan = await attempt("record", () => {
        const pseudo: SipaEvent = {
          sharedSecretSalt: Fr.fromString(r.messageSecret!),
          resweepable: false,
          intentHash: NO_EVENT_INTENT,
        }
        return planEvent(deps, pseudo, depositImplementation, run, r.sipaAddress)
      })
      if (plan) planned.push(plan)
      else unplanned.push(r.sipaAddress)
    }

    // Every row's portal is observed in one pass, so the pass is read through the earliest of their
    // cursors. A portal with none, such as a row the table added, has unread history on every SIPA,
    // so the pass backfills them all, and the portal gets a cursor only once that backfill is whole.
    const portals = [...new Set(deps.rows.map((row) => row.portal.toLowerCase()))] as Address[]
    if (deps.adoptLegacyCursor)
      await Promise.all(
        portals.map((portal) => deps.store.adoptObservedThrough?.(portal, recipient)),
      )
    const cursors = await Promise.all(
      portals.map((portal) => deps.store.observedThrough?.(portal, recipient)),
    )
    const cursor = cursors.some((c) => c === undefined)
      ? undefined
      : cursors.reduce((min, c) => (c! < min! ? c : min))
    for (const address of unplanned) {
      const start = windowStart(deps.store.get(address), cursor)
      if (start !== undefined) run.record(markForRescan(deps, address, start))
    }
    // Observing only, with every SIPA read through a cursor the head has not passed: nothing is new.
    if (
      deps.observeOnly &&
      cursor !== undefined &&
      head <= cursor &&
      unplanned.length === 0 &&
      planned.every((p) => p.owner?.observedFrom && !p.owner.rescanFrom)
    )
      return finish()
    const backfillFrom = planned.some((p) => windowStart(p.owner, cursor) === undefined)
      ? (await historyStart()) ?? lookbackStart(head)
      : 0n
    const windowOf = (plan: PlannedEvent) => {
      const start = windowStart(plan.owner, cursor)
      return {
        fromBlock: start ?? backfillFrom,
        backfilled: start === undefined,
        complete: start !== undefined || !historyFailed,
      }
    }
    const { observed, strays } = await observeSipas(deps.publicClient, {
      portals,
      tokens: [...new Set(fundingTokens.map((t) => t.address.toLowerCase()))] as Address[],
      head,
      subjects: planned.flatMap((plan) =>
        plan.addresses.map((address) => ({
          address,
          // The stored hash is what the address was derived with.
          commitment: (plan.owner?.recipientHash || plan.recipientCommitment.toString()) as Hex,
          fromBlock: windowOf(plan).fromBlock,
          inflows: !plan.owner?.fundingFromAddress && !plan.owner?.direct,
          ...(plan.owner?.direct ? { direct: true } : {}),
        })),
      ),
    })

    await adoptStrays(deps, run, planned, strays)

    const due: DueScan[] = []
    for (const plan of planned) {
      const window = windowOf(plan)
      // Resolved without the blessed list: the window is read again once the list reads.
      if (!plan.candidatesKnown) rereadFrom(run, plan.addresses[0]!, window.fromBlock)
      if (!plan.addresses.every((address) => observed.has(address.toLowerCase()))) {
        // Its window failed: it keeps its place and re-reads that window next pass.
        result.failed += 1
        stepProgress()
        run.record(markForRescan(deps, plan.addresses[0]!, window.fromBlock))
        continue
      }
      const scans = await attempt("event", () => finishEvent(plan, observed, window, result, run))
      if (scans) due.push(...scans)
      else run.record(markForRescan(deps, plan.addresses[0]!, window.fromBlock))
    }
    if (!deps.observeOnly) await readConsumed(deps, run, due)
    await prefetchSweepReads(deps, run, due)
    for (const scan of due) {
      try {
        await scanOne(scan)
      } catch (err) {
        result.failed += 1
        run.record(markForRescan(deps, scan.sipaAddress, scan.fromBlock))
        logger.warn(`[sipaClaims] ${scan.sipaAddress} sync failed (will retry next sync):`, err)
      } finally {
        stepProgress()
      }
    }
    // One balance read covers every claim this pass made; each still reads `claimed` only after it.
    if (claims > 0) {
      try {
        await deps.refreshBalance?.()
      } catch (err) {
        complete = false
        logger.warn("[sipaClaims] balance refresh failed:", err)
      }
    }
    for (const write of recordWrites) {
      try {
        await write()
      } catch (err) {
        writesFailed = true
        result.failed += 1
        logger.warn("[sipaClaims] recording a sweep failed (reconciled next sync):", err)
      }
    }
    // Every SIPA read this pass is now covered through `head`, or holds its own place to re-read
    // from: the cursor moves only once those writes landed.
    if (!writesFailed)
      await Promise.all(
        portals
          .filter((_, i) => cursors[i] !== undefined || !historyFailed)
          .map((portal) => deps.store.setObservedThrough?.(portal, recipient, head)),
      )
  } finally {
    end?.()
  }

  // TODO: a resolver deposit whose discovery event never arrives (resolver or broadcaster failed)
  // has a record only if `ResolverPaymentWatcher` saw it funded inside its window (today and
  // yesterday, a few nonces past the last one used). Anything older has no record and no exit.

  return finish()
}

/**
 * Writes the deposit record of each event that announces a direct deposit (a migration executor's
 * deposit straight into the portal, with no SIPA), unless it exists, and returns the other events
 * and whether a write did not land. The record has no read window yet, so the pass reads its
 * commitment from the deployment's start.
 */
async function recordDirectAnnouncements(
  deps: SipaDepositSyncDeps,
  events: readonly RowEvent[],
): Promise<{ events: SipaEvent[]; missed: boolean }> {
  const rest: SipaEvent[] = []
  let missed = false
  for (const { event, l2Token } of events) {
    const commitment = await directAnnouncementOf(event, deps.recipient)
    if (!commitment) {
      rest.push(event)
      continue
    }
    const key = directDepositKey(commitment)
    if (deps.store.get(key)) continue
    // The destination asset's token announces the deposit, which lands on that token's row.
    const row = sipaRowByL2Token(deps.rows, l2Token) ?? defaultRow(deps, undefined)
    // A failed write is tried again on the next pass, which reads the event again.
    await deps.store
      .upsert(
        key,
        { phase: "broadcast", replayed: true },
        {
          recipientL2Address: deps.recipient.toString(),
          messageSecret: event.sharedSecretSalt.toString(),
          recipientHash: commitment,
          recoveryAddress: "",
          l1ChainId: deps.l1ChainId,
          networkId: deps.networkId,
          amount: "0",
          tokenSymbol: row.token.symbol,
          tokenAddress: row.token.address,
          tokenDecimals: row.token.decimals,
          startTime: Date.now(),
          direct: { recipientCommitment: commitment, portal: row.portal },
          fee: "0",
        },
      )
      .catch((err) => {
        missed = true
        logger.warn(`[sipaClaims] direct deposit ${commitment} not recorded (will retry):`, err)
      })
  }
  return { events: rest, missed }
}

/** The commitment a direct deposit's announcement names, or undefined for any other event. */
async function directAnnouncementOf(
  event: SipaEvent,
  recipient: AztecAddress,
): Promise<Hex | undefined> {
  const commitment = (
    await computeStealthRecipientHash(event.sharedSecretSalt, recipient)
  ).toString() as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(commitment) || !/^0x[0-9a-fA-F]+$/.test(event.intentHash))
    return undefined
  return BigInt(event.intentHash) === BigInt(directAnnouncementIntentHash(commitment))
    ? (commitment.toLowerCase() as Hex)
    : undefined
}

/**
 * Where a SIPA's read starts: the deployment's cursor once its history was read, less the reorg
 * overlap, or the start of a window a failed pass left it, if earlier. Undefined when its history is
 * still unread, as for every record written before the cursor existed.
 */
function windowStart(
  owner: SIPADepositRecord | null,
  cursor: bigint | undefined,
): bigint | undefined {
  if (cursor === undefined || !owner?.observedFrom) return undefined
  const steady = bigMax(cursor - SCAN_REORG_OVERLAP_BLOCKS, 0n)
  const rescan = owner.rescanFrom ? BigInt(owner.rescanFrom) : undefined
  return rescan !== undefined && rescan < steady ? rescan : steady
}

/** The pass's store: every write is strict, so one that did not land fails and holds the cursor. */
function strictWrites(store: SipaDepositSyncDeps["store"]): SipaDepositSyncDeps["store"] {
  return {
    get: (address) => store.get(address),
    list: () => store.list(),
    remove: (address) => store.remove(address),
    upsert: (address, patch, fallback) => store.upsert(address, patch, fallback, { strict: true }),
    observedThrough: store.observedThrough?.bind(store),
    setObservedThrough: store.setObservedThrough?.bind(store),
    adoptObservedThrough: store.adoptObservedThrough?.bind(store),
  }
}

function lookbackStart(head: bigint): bigint {
  return head > SIPA_DEFAULT_LOOKBACK_BLOCKS ? head - SIPA_DEFAULT_LOOKBACK_BLOCKS : 0n
}

/**
 * Tracks the SIPA behind a deposit to one of this wallet's commitments that no tracked SIPA sent,
 * such as a registration address this device never derived: the deposit's own `Sweep` log names it
 * and the factory names its intent, so a clone of an implementation this pass could not list is
 * still filed as what it is. The next pass reads its history and claims it like any other.
 */
async function adoptStrays(
  deps: SipaDepositSyncDeps,
  run: SyncRunContext,
  planned: readonly PlannedEvent[],
  strays: readonly PortalDeposit[],
): Promise<void> {
  if (strays.length === 0) return
  const byCommitment = new Map(
    planned.map((plan) => [
      (plan.owner?.recipientHash || plan.recipientCommitment.toString()).toLowerCase(),
      plan,
    ]),
  )
  await Promise.all(
    strays.map(async (deposit) => {
      const plan = byCommitment.get(deposit.recipientCommitment.toLowerCase())
      if (!plan) return
      try {
        // Any contract can emit the log: the clone is the first emitter the factory vouches for.
        for (const sipa of await readSweepEmitters(
          deps.publicClient,
          deposit.txHash,
          deposit.index,
        )) {
          if (deps.store.get(sipa)) return
          const intent = await run.cloneIntent(sipa)
          if (intent === null) continue
          logger.info(
            `[sipaClaims] tracking ${sipa}: it swept deposit ${deposit.index} to this wallet`,
          )
          await deps.store.upsert(
            sipa,
            { phase: "broadcast", replayed: true },
            {
              recipientL2Address: deps.recipient.toString(),
              messageSecret: plan.sharedSecretSalt.toString(),
              recipientHash: deposit.recipientCommitment,
              recoveryAddress: plan.accountProtocol ? "" : plan.recoveryAddress.toString(),
              l1ChainId: deps.l1ChainId,
              networkId: deps.networkId,
              amount: "0",
              tokenSymbol: defaultRow(deps, intent).token.symbol,
              startTime: Date.now(),
              tokenAddress: defaultRow(deps, intent).token.address,
              ...(intent ? { intent } : {}),
            },
          )
          run.incomplete()
          return
        }
      } catch (err) {
        // The commitment's SIPA re-reads from the deposit, so a later pass meets the stray again.
        run.incomplete()
        rereadFrom(run, plan.addresses[0]!, deposit.blockNumber)
        logger.warn(`[sipaClaims] could not track the SIPA behind deposit ${deposit.index}:`, err)
      }
    }),
  )
}

/** The next pass reads `owner` from `block` or earlier, stamped when its scan is covered. */
function rereadFrom(run: SyncRunContext, owner: Address, block: bigint) {
  const key = owner.toLowerCase()
  const known = run.retryFrom.get(key)
  if (known === undefined || block < known) run.retryFrom.set(key, block)
}

/** A failed SIPA re-reads from the window it missed, however far the cursor moves meanwhile. */
function markForRescan(deps: SipaDepositSyncDeps, sipaAddress: Address, fromBlock: bigint) {
  return async () => {
    const stored = deps.store.get(sipaAddress)
    if (!stored?.observedFrom) return
    if (stored.rescanFrom && BigInt(stored.rescanFrom) <= fromBlock) return
    await deps.store.upsert(sipaAddress, { phase: stored.phase, rescanFrom: fromBlock.toString() })
  }
}

/** Stamp the funder + funding tx off the first observed `Transfer(to = sipa)` and fire the contact hook. */
async function attributeFunding(
  deps: SipaDepositSyncDeps,
  sipaAddress: Address,
  fallback: SIPADepositFields,
  run: SyncRunContext,
  inflows: readonly TokenTransfer[],
): Promise<bigint | undefined> {
  const found = firstFunding(
    run.fundingTokens.map((token) =>
      inflows
        .filter((flow) => flow.token.toLowerCase() === token.address.toLowerCase())
        .map((flow) => ({
          from: flow.from,
          amount: flow.value,
          blockNumber: flow.blockNumber,
          txHash: flow.txHash,
        })),
    ),
    run.fundingTokens,
  )
  if (!found) return undefined
  const { transfer: first, token: fundedWith } = found

  const current = deps.store.get(sipaAddress)
  const patch: Partial<SIPADepositRecord> = {
    fundingTxHash: first.txHash,
    fundingFromAddress: first.from,
    fundingTokenSymbol: fundedWith.symbol,
  }
  // Attribution can arrive after a sweep or claim; keep the credited token in that case.
  if (current?.netAmount == null) {
    patch.tokenAddress = fundedWith.address
    patch.tokenSymbol = fundedWith.symbol
    patch.tokenDecimals = fundedWith.decimals
    if (current) {
      const row = sipaRowByFunding(deps.rows, fundedWith.address)
      patch.fee = feeOnRow(deps, current, current.intent, row, undefined)
    }
  }
  // Backfill the display identity so third-party deposits thread under a
  // contact; a connected-session identity is never overwritten.
  if (!current?.walletAddress) patch.walletAddress = first.from
  await deps.store.upsert(sipaAddress, { phase: current?.phase ?? "broadcast", ...patch }, fallback)

  if (deps.onFundingWalletDetected) {
    const sessionMatch = current?.walletAddress?.toLowerCase() === first.from.toLowerCase()
    await deps.onFundingWalletDetected({
      address: first.from,
      walletName: sessionMatch ? current?.walletName : undefined,
      walletImageUrl: sessionMatch ? current?.walletImageUrl : undefined,
      walletProvider: sessionMatch ? current?.walletProvider : undefined,
      lastUsedAt: Date.now(),
    })
  }
  return first.blockNumber
}

/** The intentHash of a record's synthesized event: no event was discovered, so it carries no intent. */
const NO_EVENT_INTENT = "0x0"

/**
 * Whether an event announces a deposit, and the hash its address commits to. A deposit commits to
 * the recipient, so its hash re-derives here. Any other hash is a registration or a user operation,
 * whose intent data only the event's sender holds.
 */
function eventIntent(
  sipaEvent: SipaEvent,
  recipientCommitment: Fr,
): { deposit: boolean; intentHash: Buffer } {
  const deposit = keccak256(recipientCommitment.toBuffer())
  const carried = Buffer.from(sipaEvent.intentHash.slice(2).padStart(64, "0"), "hex")
  return carried.equals(deposit)
    ? { deposit: true, intentHash: deposit }
    : { deposit: false, intentHash: carried }
}

/** Plain deposits and the other intents pin separately, even under one salt. */
type IntentKind = "deposit" | "other"

const pinKey = (salt: string, kind: IntentKind) => `${salt.toLowerCase()}:${kind}`

/**
 * The kinds of event a record can stand for. One with no intent whose origin was derived is a
 * deposit; one with neither predates both fields and takes its intent from whichever event matches.
 */
const recordKinds = (record: SIPADepositRecord): IntentKind[] =>
  record.intent ? ["other"] : record.origin ? ["deposit"] : ["deposit", "other"]

const recordSeen = (record: SIPADepositRecord & { messageSecret: string }, keys: Set<string>) =>
  recordKinds(record).some((kind) => keys.has(pinKey(record.messageSecret, kind)))

async function eventKind(sipaEvent: SipaEvent, recipient: AztecAddress): Promise<IntentKind> {
  const commitment = await computeStealthRecipientHash(sipaEvent.sharedSecretSalt, recipient)
  return eventIntent(sipaEvent, commitment).deposit ? "deposit" : "other"
}

/**
 * A replayed registration record never swept as one: a user operation's event reads as a registration
 * until its clone is swept. A registration's own sweep settles the question; stray funds sent to the
 * address do not.
 */
function maybeMisfiled(record: SIPADepositRecord | null): record is SIPADepositRecord {
  return (
    !!record &&
    record.intent === "registration" &&
    !!record.replayed &&
    !record.sweepTxHash &&
    !record.inboxIndex &&
    !record.sweeps?.length
  )
}

/** A SIPA ready for its scan: what discovery found, and what the pass observed of it. */
type DueScan = Awaited<ReturnType<typeof finishEvent>>[number]

/** Values shared by every event in one run: the scan's upper bound, its clock, its fee floors. */
interface SyncRunContext {
  head: bigint
  now: number
  feeFor: (intent: SipaIntent, row: SipaRow) => Promise<bigint>
  registrationImplementation: () => Promise<EthAddress>
  /** Every user-op implementation the factory has blessed, the current one first. */
  userOpImplementations: () => Promise<EthAddress[]>
  /** The intent a deployed clone was cloned for, from the factory. Throws for an address it did not clone. */
  cloneIntent: (clone: Address) => Promise<SIPADepositRecord["intent"] | null>
  /** The implementation a deployed clone delegates to, from its code. Undefined for an address without one. */
  cloneImplementation: (clone: Address) => Promise<EthAddress | undefined>
  /** A row portal's `TX_AMOUNT_CAP()`: the most one sweep may credit. */
  txAmountCap: (row: SipaRow) => Promise<bigint>
  /** Every token a SIPA of `deps.rows` may be funded with; non-empty. */
  fundingTokens: SipaFundingToken[]
  /**
   * Queues a sweep's record write. The queue runs in order after the pass's one balance read, so a
   * claim reads `claimed` only once the balance holds it and never overwrites a later sweep's state.
   */
  record: (write: () => Promise<void>) => void
  /** A step left work to a later pass: the result is not `complete`. */
  incomplete: () => void
  /** `record`, for a write that marks a claim: the balance is read before the queue runs. */
  claimed: (write: () => Promise<void>) => void
  /** Sweeps whose deposits were already spent, by `consumedKey`. */
  consumed: Set<string>
  /** Blocks SIPAs must re-read from on a later pass, by lowercased address: a stray they lost. */
  retryFrom: Map<string, bigint>
  /** Whether the L1→L2 message `messageKey` is ready to claim, read at most once per run. */
  messageReady: (messageKey: Hex) => Promise<boolean>
}

/** The pass's L1 client: a block is read once however many steps need it. A failed read is dropped. */
export function passClient(client: PublicClient): PublicClient {
  const blocks = new Map<bigint, ReturnType<PublicClient["getBlock"]>>()
  return {
    ...client,
    getBlock: ((args) => {
      if (args?.blockNumber === undefined || args.includeTransactions) return client.getBlock(args)
      const key = args.blockNumber
      const cached = blocks.get(key)
      if (cached) return cached
      const pending = client.getBlock(args)
      blocks.set(key, pending)
      pending.catch(() => {
        if (blocks.get(key) === pending) blocks.delete(key)
      })
      return pending
    }) as PublicClient["getBlock"],
  }
}

/** A `SIPA` event and the row L2 token that emitted it. */
interface RowEvent {
  event: SipaEvent
  l2Token: string
}

/**
 * The recipient's `SIPA` events on every row's L2 token, each SIPA once. The wallet's own broadcast
 * notifies the pinned bridge's token and the resolver's each portal's, so a fresh device finds a SIPA
 * either way.
 */
async function readRowEvents(deps: SipaDepositSyncDeps): Promise<RowEvent[]> {
  const l2Tokens = [...new Set(deps.rows.map((row) => row.l2Token.toLowerCase()))]
  const perToken = await Promise.all(
    l2Tokens.map((l2Token) =>
      fetchSipaEvents(deps.wallet, AztecAddress.fromStringUnsafe(l2Token), deps.recipient),
    ),
  )
  const seen = new Set<string>()
  const tagged = perToken.flatMap((events, i) =>
    events.map((event) => ({ event, l2Token: l2Tokens[i]! })),
  )
  return tagged.filter(({ event }) => {
    const key = `${event.sharedSecretSalt
      .toString()
      .toLowerCase()}:${event.intentHash.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Starts every read a due SIPA's claim tail makes before the first claim: its funding and sweep
 * blocks and each sweep's message readiness. They batch into a few round trips, and the tail then
 * finds them in the pass's caches. A failed read is left to the tail.
 */
async function prefetchSweepReads(
  deps: SipaDepositSyncDeps,
  run: SyncRunContext,
  due: readonly DueScan[],
): Promise<void> {
  const soft = (read: () => unknown) =>
    Promise.resolve()
      .then(read)
      .catch(() => undefined)
  await Promise.all(
    due.flatMap((scan) => {
      const claimed = new Set(scan.record?.claimedInboxIndexes ?? [])
      const firstFunding = scan.observed.inflows?.[0]?.blockNumber
      return [
        ...(firstFunding === undefined
          ? []
          : [soft(() => readBlockTimeMs(deps.publicClient, firstFunding))]),
        ...sweepsOf(scan)
          .filter((s) => !claimed.has(s.index.toString()))
          .flatMap((sweep) => [
            soft(() => readBlockTimeMs(deps.publicClient, sweep.blockNumber)),
            // A consumed sweep is recorded without a claim, so its readiness is never asked.
            ...(run.consumed.has(consumedKey(scan.sipaAddress, sweep.index))
              ? []
              : deps.observeOnly
              ? []
              : [soft(() => run.messageReady(sweep.messageKey))]),
          ]),
      ]
    }),
  )
}

const consumedKey = (sipa: Address, index: bigint) => `${sipa.toLowerCase()}:${index}`

/**
 * Finds the unclaimed sweeps whose deposits were already spent, on this device or another: one
 * batched nullifier lookup before any claim, so a replayed history of spent deposits costs no PXE
 * claim attempts. A deposit stored elsewhere but unspent has no nullifier yet and is claimed, which
 * stores it in this PXE. A failed lookup leaves every sweep to its claim.
 */
async function readConsumed(
  deps: SipaDepositSyncDeps,
  run: SyncRunContext,
  due: readonly DueScan[],
): Promise<void> {
  const node = deps.node
  if (!deps.masterNullifierHidingKey || !node.findLeavesIndexes) return
  // A deposit's nullifier is its row's L2 token's, so each row's sweeps are looked up on that token.
  const byToken = new Map<string, { scan: DueScan; sweep: PassSweep }[]>()
  for (const scan of due) {
    const claimed = new Set(scan.record?.claimedInboxIndexes ?? [])
    for (const sweep of sweepsOf(scan)) {
      if (claimed.has(sweep.index.toString())) continue
      const l2Token = sweepRow(deps, sweep, scan.intent).l2Token.toLowerCase()
      byToken.set(l2Token, [...(byToken.get(l2Token) ?? []), { scan, sweep }])
    }
  }
  const masterNullifierHidingKey = deps.masterNullifierHidingKey
  await Promise.all(
    [...byToken].map(async ([l2Token, pending]) => {
      try {
        // The message hash is the portal's own `key`, the one readiness is asked about too.
        const found = await readSipaDepositsConsumed(
          node as Pick<AztecNode, "findLeavesIndexes">,
          { l2Token: AztecAddress.fromStringUnsafe(l2Token), masterNullifierHidingKey },
          pending.map(({ sweep }) => sweep.messageKey),
        )
        found.forEach((consumed, i) => {
          if (consumed)
            run.consumed.add(consumedKey(pending[i]!.scan.sipaAddress, pending[i]!.sweep.index))
        })
      } catch (err) {
        run.incomplete()
        logger.warn("[sipaClaims] consumed-sweep lookup failed, claiming each sweep:", err)
      }
    }),
  )
}

/**
 * A sweep to settle, with what an earlier pass saw it take when its window is gone. A sweep an earlier
 * pass saved before sweeps named their portal has none.
 */
type PassSweep = Omit<ObservedSweep, "portal" | "blockHash"> & {
  portal?: Address
  blockHash?: Hex
  funding?: { token: Address; gross: bigint }
}

/**
 * What the pass observed swept from a SIPA, plus the sweeps an earlier pass left unclaimed. The
 * observation answers for its window: a saved sweep inside it that it no longer shows was reorged
 * away, and one it shows again takes its observed claim inputs.
 */
function sweepsOf(scan: DueScan): PassSweep[] {
  const sweeps: PassSweep[] = [...scan.observed.sweeps]
  for (const pending of scan.record?.pendingSweeps ?? []) {
    if (sweeps.some((s) => s.index.toString() === pending.inboxIndex)) continue
    if (BigInt(pending.blockNumber) >= scan.fromBlock) continue
    sweeps.push({
      index: BigInt(pending.inboxIndex),
      amount: BigInt(pending.amount),
      messageKey: pending.messageKey,
      blockNumber: BigInt(pending.blockNumber),
      txHash: pending.sweepTxHash,
      ...(pending.portal ? { portal: pending.portal } : {}),
      ...(pending.grossAmount && pending.fundingToken
        ? { funding: { token: pending.fundingToken, gross: BigInt(pending.grossAmount) } }
        : {}),
    })
  }
  return sweeps.sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  )
}

/**
 * What one event, or one record with no event, needs observed. `local` is the recorded address of
 * a self-initiated SIPA; it overrides the event's derivation. Reads nothing from L1.
 */
async function planEvent(
  deps: SipaDepositSyncDeps,
  sipaEvent: SipaEvent,
  depositImplementation: EthAddress,
  run: SyncRunContext,
  local?: Address,
) {
  const { tuple } = deps
  const sharedSecretSalt = sipaEvent.sharedSecretSalt
  const recipientCommitment = await computeStealthRecipientHash(sharedSecretSalt, deps.recipient)
  const recoveryAddress = deriveRecoveryAddress(deps.stealthPublicKey, sharedSecretSalt)
  const fromEvent =
    sipaEvent.intentHash === NO_EVENT_INTENT ? null : eventIntent(sipaEvent, recipientCommitment)
  const accountProtocol = tuple.sipaRecoveryProtocol === "account"
  if (accountProtocol && (!deps.recoveryAccount || !tuple.accountFactory))
    throw new Error("SIPA discovery needs the recovery account")
  if (accountProtocol && !tuple.forwardingTable)
    throw new Error("SIPA discovery needs the deployment's forwarding table")
  const recoveryCommitment = accountProtocol
    ? deriveRecoveryCommitment(sharedSecretSalt, EthAddress.fromString(deps.recoveryAccount!))
    : undefined
  const predict = (implementation: EthAddress) => {
    if (!fromEvent) return undefined
    const inputs = {
      sipaFactory: EthAddress.fromString(tuple.sipaFactory!),
      implementation,
      intentHash: fromEvent.intentHash,
      rollupVersion: BigInt(tuple.rollupVersion),
      resweepable: sipaEvent.resweepable,
    }
    return accountProtocol
      ? computeAccountSIPAAddress({
          ...inputs,
          recoveryCommitment: recoveryCommitment!,
          forwardingTable: EthAddress.fromString(tuple.forwardingTable!),
        })
      : computeSIPAAddress({ ...inputs, recoveryAddress })
  }
  // The intent comes from the record when it holds one, else the event. Only the event's sender
  // holds a non-deposit intent's data, so the chain decides: a user operation's SIPA is swept when
  // the relayer runs it, and a clone holding a registration's intent hash cannot be. Until that
  // sweep, the event reads as a registration. A record that may be a misfiled user operation keeps
  // watching for it until it is swept.
  const pinned = local ? deps.store.get(local) : null
  const recheck = maybeMisfiled(pinned)
  const resolving = !!fromEvent && !fromEvent.deposit && (!pinned?.intent || recheck)
  const guess = resolving ? "registration" : pinned?.intent
  const candidate = (implementation: EthAddress): UserOpCandidate | undefined => {
    const address = predict(implementation)?.toString() as Address | undefined
    return address && { implementation, address }
  }
  // A recorded user operation's SIPA was prepared on the implementation its origin names, else on
  // the one its deployed clone delegates to, else on the blessed one that derives it.
  const userOpImplementation = async () => {
    const recorded = pinned?.origin?.implementation
    if (recorded) return EthAddress.fromString(recorded)
    const deployed = local ? await run.cloneImplementation(local) : undefined
    if (deployed) return deployed
    const blessed = await run.userOpImplementations()
    const found = blessed.find(
      (impl) => candidate(impl)?.address.toLowerCase() === local?.toLowerCase(),
    )
    if (!found) throw new Error(`no blessed user-op implementation derives ${local}`)
    return found
  }
  const implementation =
    guess === "registration"
      ? await run.registrationImplementation()
      : guess === "user-op"
      ? await userOpImplementation()
      : depositImplementation
  const predicted = predict(implementation)
  const primary = local ?? (predicted?.toString() as Address | undefined)
  if (!primary) throw new Error("SIPA event has no address origin")
  // An implementation that derives the registration address is no user operation's.
  const taken = new Set([primary.toLowerCase()])
  const userOpCandidates: UserOpCandidate[] = []
  // Without the blessed list the event resolves as a registration this pass; a registration is not
  // held back by a read it does not need.
  let candidatesKnown = true
  if (resolving) {
    const blessed = await run.userOpImplementations().catch((err: unknown) => {
      candidatesKnown = false
      run.incomplete()
      logger.warn("[sipaClaims] blessed user-op implementations unread this pass:", err)
      return [] as EthAddress[]
    })
    for (const impl of blessed) {
      const found = candidate(impl)
      if (!found || taken.has(found.address.toLowerCase())) continue
      taken.add(found.address.toLowerCase())
      userOpCandidates.push(found)
    }
  }
  return {
    deps,
    sipaEvent,
    depositImplementation,
    local,
    sharedSecretSalt,
    recipientCommitment,
    recoveryAddress,
    fromEvent,
    accountProtocol,
    recoveryCommitment,
    predict,
    pinned,
    recheck,
    userOpCandidates,
    candidatesKnown,
    guess,
    implementation,
    predicted,
    /** The record whose history and cursor this event's reads follow. */
    owner: deps.store.get(primary),
    addresses: [primary, ...userOpCandidates.map((c) => c.address)],
  }
}

type PlannedEvent = Awaited<ReturnType<typeof planEvent>>

/** A blessed user-op implementation and the address an event's clone has on it. */
interface UserOpCandidate {
  implementation: EthAddress
  address: Address
}

/** A user operation's clone the chain showed swept. */
type SweptClone = UserOpCandidate & { intent: "user-op" }

/** Writes what discovery learned about one event and hands each swept clone's observation to the scan. */
async function finishEvent(
  plan: PlannedEvent,
  observed: Map<string, SipaObserved>,
  window: { fromBlock: bigint; backfilled: boolean; complete: boolean },
  result: SipaDepositSyncResult,
  run: SyncRunContext,
) {
  const { deps, sipaEvent, depositImplementation, local, sharedSecretSalt, recipientCommitment } =
    plan
  const { recoveryAddress, fromEvent, accountProtocol, recoveryCommitment, predict, pinned } = plan
  const { recheck, userOpCandidates, guess } = plan
  const { tuple } = deps
  let intent = pinned?.intent
  let misfiled: Address | undefined
  const swept = (address: Address) => !!observed.get(address.toLowerCase())?.sweeps.length
  const sweptUserOps = userOpCandidates.filter((c) => swept(c.address))
  const userOp = sweptUserOps[0]
  // Every swept clone holds a credit of its own: the first resolves the event, the others get records
  // beside it.
  const sweptClones: SweptClone[] = sweptUserOps.map((c) => ({ ...c, intent: "user-op" as const }))
  if (fromEvent && !fromEvent.deposit && (!intent || recheck)) {
    const clone = sweptClones[0]
    // A funded, misfiled record keeps its stray funds under its own intent: the swept clone gets a
    // record beside it.
    const holdsStray = !!clone && recheck && !isUnfundedSipaDeposit(pinned!)
    if (!holdsStray) {
      const resolved = clone?.intent ?? "registration"
      if (recheck && resolved !== intent) misfiled = local
      intent = resolved
    }
  }
  const implementation =
    intent === guess
      ? plan.implementation
      : intent === "registration"
      ? await run.registrationImplementation()
      : intent === "user-op"
      ? userOp!.implementation
      : depositImplementation
  const predicted = intent === guess ? plan.predicted : predict(implementation)
  const sipaAddress = (misfiled ? undefined : local) ?? (predicted?.toString() as Address)
  if (!sipaAddress) throw new Error("SIPA event has no address origin")
  const originFor = (implementation: EthAddress): SIPADepositRecord["origin"] => ({
    sipaFactory: tuple.sipaFactory! as Address,
    implementation: implementation.toString() as Address,
    intentHash: sipaEvent.intentHash,
    rollupVersion: tuple.rollupVersion,
    resweepable: sipaEvent.resweepable,
    ...(accountProtocol
      ? {
          protocol: "account" as const,
          accountFactory: tuple.accountFactory! as Address,
          forwardingTable: tuple.forwardingTable! as Address,
          recoveryAccount: deps.recoveryAccount!,
          recoveryCommitment: recoveryCommitment!.toString() as Hex,
        }
      : {
          protocol: "legacy-eoa" as const,
          recoveryAddress: recoveryAddress.toString() as Address,
        }),
  })
  const origin =
    predicted?.toString().toLowerCase() === sipaAddress.toLowerCase()
      ? originFor(implementation)
      : undefined
  result.discovered += 1

  const fallback: SIPADepositFields = {
    recipientL2Address: deps.recipient.toString(),
    messageSecret: sharedSecretSalt.toString(),
    recipientHash: recipientCommitment.toString(),
    recoveryAddress: accountProtocol ? "" : recoveryAddress.toString(),
    origin,
    l1ChainId: deps.l1ChainId,
    networkId: deps.networkId,
    amount: "0",
    tokenSymbol: defaultRow(deps, intent).token.symbol,
    startTime: Date.now(),
    tokenAddress: defaultRow(deps, intent).token.address,
    ...(intent ? { intent } : {}),
  }
  // Writes what the event proved about an address. A record first seen this run (a fresh device
  // replaying history) carries no real start time until its funding or sweep block is read below.
  // Self-initiated records are created pre-discovery with empty derived fields — backfill them so
  // the deposit is enumerable. Monotonic: never overwrite a non-empty value.
  const file = async (address: Address, fields: typeof fallback) => {
    const stored = deps.store.get(address)
    if (!stored) {
      await deps.store.upsert(address, { phase: "broadcast", replayed: true }, fields)
      return
    }
    const backfill: Partial<SIPADepositRecord> = {}
    if (!stored.messageSecret) backfill.messageSecret = fields.messageSecret
    if (!stored.recipientHash) backfill.recipientHash = fields.recipientHash
    if (!stored.recoveryAddress) backfill.recoveryAddress = fields.recoveryAddress
    if (!stored.origin && fields.origin) backfill.origin = fields.origin
    if (fields.intent && !stored.intent) backfill.intent = fields.intent
    if (Object.keys(backfill).length > 0) {
      await deps.store.upsert(address, { phase: stored.phase, ...backfill })
    }
  }
  const existing = deps.store.get(sipaAddress)
  const discovered = !existing
  await file(sipaAddress, fallback)

  if (misfiled) await deps.store.remove(misfiled)
  // A record with the salt and this recipient is planned on its own, as this event's pin or without
  // an event: its scan is that plan's.
  const recipientKey = deps.recipient.toString().toLowerCase()
  const plannedOnItsOwn = (record: SIPADepositRecord | null | undefined) =>
    !!record?.messageSecret && record.recipientL2Address?.toLowerCase() === recipientKey
  // The other swept clones get records beside the event's and scans of their own, unless one is
  // planned on its own or is another account's.
  const extras = sweptClones
    .filter((c) => c.address.toLowerCase() !== sipaAddress.toLowerCase())
    .map((clone) => ({ clone, before: deps.store.get(clone.address) }))
    .filter(
      ({ before }) =>
        !before ||
        (!before.messageSecret && before.recipientL2Address?.toLowerCase() === recipientKey),
    )
  const cloneFields = (clone: SweptClone): typeof fallback => ({
    ...fallback,
    origin: originFor(clone.implementation),
    intent: clone.intent,
  })
  for (const { clone } of extras) await file(clone.address, cloneFields(clone))

  // Judged on the records as they stood before this pass wrote them: a clone discovered now is in
  // flight.
  if (isInFlight(existing, run.now)) result.active += 1
  for (const { before } of extras) if (isInFlight(before, run.now)) result.active += 1
  const scanOf = (
    address: Address,
    own: {
      fallback: typeof fallback
      intent: typeof intent
      implementation: EthAddress
      discovered: boolean
    },
  ) => {
    const record = deps.store.get(address)
    const seen = observed.get(address.toLowerCase())
    if (!seen) throw new Error(`${address} was not observed this pass`)
    return {
      deps,
      result,
      run,
      sharedSecretSalt,
      sipaAddress: address,
      fallback: own.fallback,
      record,
      phase: record?.phase ?? "broadcast",
      intent: own.intent,
      implementation: own.implementation,
      discovered: own.discovered,
      observed: seen,
      /** Where this pass read the SIPA from: a failed scan re-reads from here. */
      fromBlock: window.fromBlock,
      /** This pass read the SIPA from its history start. */
      backfilled: window.backfilled,
      /**
       * Everything before this pass's window was already read: the window reaches the history
       * start, or this address rode the cursor to it. A clone another record's window first met
       * is read from its own history start before it rides the cursor.
       */
      complete: window.backfilled ? window.complete : !!record?.observedFrom,
    }
  }
  // A misfiled pin whose event moved to a clone planned on its own leaves the clone's scan to that plan.
  return [
    ...(misfiled && plannedOnItsOwn(existing)
      ? []
      : [scanOf(sipaAddress, { fallback, intent, implementation, discovered })]),
    ...extras.map(({ clone, before }) =>
      scanOf(clone.address, {
        fallback: cloneFields(clone),
        intent: clone.intent,
        implementation: clone.implementation,
        discovered: !before,
      }),
    ),
  ]
}

/** The rest of a due SIPA's sync, once the batched reads land. */
async function scanOne(due: DueScan): Promise<void> {
  const { deps, result, run, sharedSecretSalt, sipaAddress, fallback, record, phase } = due
  const { intent, observed } = due
  // History is dated by chain. A direct deposit's announcement writes its record before its deposit
  // is seen, so that record is history until its first deposit is ledgered.
  const discovered =
    due.discovered || !!(record?.replayed && record.direct && !record.sweeps?.length)

  // Funding attribution: the token-level sender of the first Transfer into the SIPA. Read only
  // until it is stamped. Isolated: attribution is auxiliary and must not fail the claim path.
  const fundingBlock =
    record?.fundingFromAddress || !observed.inflows
      ? undefined
      : await attributeFunding(deps, sipaAddress, fallback, run, observed.inflows).catch((err) => {
          run.incomplete()
          logger.warn("[sipaClaims] funding attribution failed (will retry next sync):", err)
          return undefined
        })
  const sweeps = sweepsOf(due)

  // A deposit swept before the wallet's first scan skips the funding probe entirely, so the sweep
  // writes are where its fee lands. The read is a run-level immutable. It may not fail the write
  // it decorates: the claim it follows has already landed on L2, and a throw here would leave the
  // record marked unclaimed until a later pass reconciles it.
  const sweepFee = async (row: SipaRow): Promise<string | undefined> => {
    const stored = deps.store.get(sipaAddress) ?? record
    // A direct deposit has no sweep, so it pays no sweep fee.
    if (stored?.direct) return "0"
    const [read] = await Promise.allSettled([run.feeFor(sipaRecordIntent(intent), row)])
    if (read.status !== "fulfilled") {
      run.incomplete()
      return undefined
    }
    return bigMax(read.value, BigInt(stored?.registrationFee ?? 0)).toString()
  }
  const feeBreakdown = async (row: SipaRow): Promise<Partial<SIPADepositRecord>> => {
    const stored = deps.store.get(sipaAddress) ?? record
    if (stored?.fee != null) return {}
    const fee = await sweepFee(row)
    return fee === undefined ? {} : { fee }
  }

  // Stamps a fee a failed read lost, so the deposit can show its net. The fee owes nothing to the
  // log, so it retries on every tick until it lands — the cursor moves past the sweep that would
  // otherwise carry it.
  const repriceIfUnpriced = async () => {
    const stored = deps.store.get(sipaAddress) ?? record
    if (!stored || stored.fee != null) return
    const patch = await feeBreakdown(pricedRow(deps, stored, intent))
    if (Object.keys(patch).length === 0) return
    await deps.store.upsert(sipaAddress, { ...patch, phase: stored.phase })
  }

  // Phases past a claim: every earlier one is priced by the funding probe below.
  const settledPhase = (deps.store.get(sipaAddress) ?? record)?.phase
  if (settledPhase === "claimed" || settledPhase === "pendingClaim") await repriceIfUnpriced()

  // A deposit is dated by its L1 funding transfer; a replayed one with none read, by its sweep.
  const datedBy = fundingBlock ?? (discovered ? sweeps[0]?.blockNumber : undefined)
  const startTime =
    datedBy === undefined ? undefined : await readBlockTimeMs(deps.publicClient, datedBy)
  if (startTime !== undefined) {
    const current = deps.store.get(sipaAddress)
    await deps.store.upsert(sipaAddress, { phase: current?.phase ?? phase, startTime }, fallback)
  }

  // What the address holds now in tokens its intent settles, swept or not: what the registration
  // tick and the screens read.
  if (observed.balances) {
    const held = heldBalance(observed.balances, intentRows(deps, intent)).toString()
    const current = deps.store.get(sipaAddress)
    if (current?.heldBalance !== held)
      await deps.store.upsert(
        sipaAddress,
        { phase: current?.phase ?? phase, heldBalance: held },
        fallback,
      )
  }

  if (sweeps.length === 0 && (deps.store.get(sipaAddress) ?? record)?.direct) {
    // A direct deposit's key holds nothing and nothing sweeps it: until its deposit is seen, the
    // pass only notes the window it read.
    const patch = covered(due)
    if (Object.keys(patch).length > 0)
      await deps.store.upsert(sipaAddress, { phase: record?.phase ?? phase, ...patch }, fallback)
    return
  }

  if (sweeps.length === 0) {
    // An event means the resolver broadcast, so a sweep should follow within
    // moments — a persistent zero here is the derivation-mismatch signature
    // (derived address ≠ the funded SIPA) or a stuck relayer. Once a sweep has
    // been claimed off this SIPA an empty window is just the steady state.
    if (!record?.claimedInboxIndexes?.length) {
      logger.log(
        `[sipaClaims] event → ${sipaAddress.slice(
          0,
          10,
        )}… has no sweeps on L1 yet (sweep in flight, or derived address mismatch)`,
      )
    }
    // Each row's floor and ceiling at once, and settled: an RPC failure on one row must not cost the
    // event its funding and sweep reads, nor price a balance on another row. A table with no row
    // for the intent prices nothing, and the balance is still read.
    const factoryIntent = sipaRecordIntent(intent)
    const intentRows = deps.rows.filter((row) =>
      row.intents.includes(sipaIntentName(factoryIntent)),
    )
    const priceable = intentRows.length > 0
    const rows = priceable ? intentRows : deps.rows
    const terms = priceable
      ? await Promise.allSettled(
          rows.map(async (row) => {
            const [fee, cap] = await Promise.all([
              run.feeFor(factoryIntent, row),
              run.txAmountCap(row),
            ])
            return { row, fee, cap }
          }),
        )
      : []
    const pricedRows = new Set(rows.filter((_, i) => terms[i]?.status === "fulfilled"))
    const answer =
      intent === "registration" ? deps.registrationScheduleFor?.(sipaAddress) : undefined
    // No schedule can sweep this address, so its balance is the user's to recover whatever the
    // floor reads say.
    const unsweepable = answer === "unsweepable"
    const schedule = answer === "unsweepable" ? undefined : answer
    const accepted = (balance: bigint) =>
      !unsweepable && (!schedule || balance >= registrationFloor(schedule))
    // A registration SIPA routes the schedule fee, which is at least the implementation's own.
    const registrationFee = BigInt(record?.registrationFee ?? 0)
    const routes = rows.flatMap((row, i) => {
      const read = terms[i]
      const fee = bigMax(read?.status === "fulfilled" ? read.value.fee : 0n, registrationFee)
      const txAmountCap = read?.status === "fulfilled" ? read.value.cap : 0n
      return [row.token, ...row.swapped].map((token) => ({
        token,
        settlesIn: row.token,
        fee,
        txAmountCap,
      }))
    })
    // `sweepable` covers the per-transaction window alone. The portal meters a global rate-limited
    // cap besides, which this sync does not read (`createSipaProcessingObserver` explains it), so a
    // balance inside the window can still be refused. An unpriced row's routes have no window.
    const { token: fundedWith, status: funding } = await readSipaFunding(deps.publicClient, {
      sipa: sipaAddress,
      routes,
      accepted,
      decided: schedule !== null,
      balances: observed.balances,
    })
    const fundedRow = sipaRowByFunding(rows, fundedWith.address)
    const priced = !!fundedRow && pricedRows.has(fundedRow)
    // The floor cannot be priced: an unread immutable would floor it at zero and make dust look
    // sweepable, or the registration's schedule is not in hand. The balance is recorded and the
    // phase held for a pass that can price it.
    const undecided = !priced || schedule === null
    const before = deps.store.get(sipaAddress) ?? record
    const fundedFee = priced
      ? routes.find((r) => r.token === fundedWith)!.fee.toString()
      : undefined
    // Capture the gross funding + fee here — the third-party flow has no hook
    // to stamp them, and this is the only point both are in hand before a
    // sweep overwrites `amount` with the net. An unpriced pass writes neither, and the UI shows
    // the gross until a later pass reads the fee. Funds first seen with no funding block to date
    // them start the record's clock: the feed sorts it as new and the overdue sweep counts from then.
    const funded = {
      ...(funding.balance > 0n && startTime === undefined && before && isUnfundedSipaDeposit(before)
        ? { startTime: run.now }
        : {}),
      amount: formatUnits(funding.balance, fundedWith.decimals),
      fee: feeOnRow(deps, before, intent, fundedRow, fundedFee),
      tokenAddress: fundedWith.address,
      rowToken:
        fundedRow && fundedRow.token.address !== fundedWith.address
          ? fundedRow.token.address
          : undefined,
      tokenSymbol: fundedWith.symbol,
      tokenDecimals: fundedWith.decimals,
      fundingTokenSymbol: fundedWith.symbol,
    }
    // A listed sweep the observation no longer shows is dropped here.
    const scanned = covered(due)
    const paidAgain = funding.balance > 0n && !!before && claimedBefore(before)
    const resweepable = (before?.origin ?? fallback.origin)?.resweepable !== false
    if (unsweepable && funding.balance > 0n) {
      // recoverERC20 is the only exit and it owes nothing to the fee reads, so this outranks an
      // unpriced pass — holding here would pin the record short of every recovery entry point.
      await deps.store.upsert(
        sipaAddress,
        { phase: "recoverable", ...funded, ...scanned },
        fallback,
      )
      result.recoverable += 1
    } else if (undecided && funding.balance > 0n) {
      run.incomplete()
      await deps.store.upsert(sipaAddress, { phase, ...funded, ...scanned }, fallback)
    } else if (funding.balance > 0n && (!funding.sweepable || (paidAgain && !resweepable))) {
      // Outside the sweep window — the balance is at or below the sweep fee, or what clears it
      // exceeds the per-transaction cap — or a second payment to an address that refuses a second
      // sweep. No sweep moves it.
      await deps.store.upsert(
        sipaAddress,
        { phase: "recoverable", ...funded, ...scanned },
        fallback,
      )
      result.recoverable += 1
    } else if (paidAgain) {
      // Publish first: the record keeps its claim until then, so a failed publish retries next scan.
      try {
        await deps.onSweptAddressFunded?.(sipaAddress)
      } catch (err) {
        run.incomplete()
        logger.warn(`[sipaClaims] ${sipaAddress} republish failed, retrying next scan:`, err)
        return
      }
      // The record now tracks the new payment: the stuck clock starts now, with no sweep yet.
      await deps.store.upsert(
        sipaAddress,
        {
          phase: "sweeping",
          ...funded,
          ...scanned,
          startTime: run.now,
          endTime: undefined,
          netAmount: undefined,
          sweepTxHash: undefined,
          claimTxHash: undefined,
          reorgEpoch: before?.reorgEpoch,
        },
        fallback,
      )
    } else if (funding.balance > 0n) {
      await deps.store.upsert(sipaAddress, { phase: "sweeping", ...funded, ...scanned }, fallback)
      await republishIfOverdue(deps, run, sipaAddress)
    } else {
      // No sweep moves ETH, so any at a never-swept address is the user's to recover. The sweep
      // window is only the recent blocks, so a claimed deposit reads as unswept here too. A failed
      // read throws: falling through would heal a `recoverable` ETH record to `recovered`.
      const stored = deps.store.get(sipaAddress) ?? record
      const swept =
        !!stored?.sweepTxHash || !!stored?.inboxIndex || !!stored?.claimedInboxIndexes?.length
      const eth = swept
        ? 0n
        : observed.balances?.get(NATIVE_ETH.address) ??
          (await deps.publicClient.getBalance({ address: sipaAddress }))
      if (eth > 0n) {
        await deps.store.upsert(
          sipaAddress,
          {
            phase: "recoverable",
            amount: formatUnits(eth, NATIVE_ETH.decimals),
            // A token fee read on an earlier pass would price the ETH.
            fee: undefined,
            netAmount: undefined,
            tokenAddress: NATIVE_ETH.address,
            rowToken: undefined,
            tokenSymbol: NATIVE_ETH.symbol,
            tokenDecimals: NATIVE_ETH.decimals,
            ...scanned,
          },
          fallback,
        )
        result.recoverable += 1
        return
      }
      const recovery = observed.recoveries.at(-1)
      if (recovery) {
        await deps.store.upsert(
          sipaAddress,
          { phase: "recovered", recoveryTxHash: recovery.txHash, ...scanned },
          fallback,
        )
        return
      }
      // Re-read: two awaits sit between the phase snapshot and this write, and a concurrent
      // `runSipaRecovery` may have settled the record as `recovered` inside them. Echoing the
      // snapshot would undo it, and a zero-balance SIPA is scanned forever, so it never heals.
      const latest = deps.store.get(sipaAddress)
      const current = latest?.phase ?? phase
      // Only a recovery empties a SIPA without emitting a `Sweep`, so a `recoverable` one
      // now at zero was recovered — including by a submission whose receipt wait never returned.
      // The hash stamped at submission survives the merge; none is invented here.
      const healed = current === "recoverable" && !latest?.claimedInboxIndexes?.length
      const patch = { ...scanned }
      if (healed || Object.keys(patch).length > 0 || !latest)
        await deps.store.upsert(
          sipaAddress,
          { phase: healed ? "recovered" : current, ...patch },
          fallback,
        )
    }
    return
  }

  // Sweeps this pass could not claim keep their claim inputs, so a later pass claims them without
  // reading L1 again however far the cursor moves.
  const unresolved: SIPAPendingSweep[] = []
  const leaveForRetry = (
    sweep: PassSweep,
    swept: { token: SipaFundingToken; gross?: bigint } | undefined,
  ) => {
    if (unresolved.some((s) => s.inboxIndex === sweep.index.toString())) return
    unresolved.push({
      inboxIndex: sweep.index.toString(),
      amount: sweep.amount.toString(),
      messageKey: sweep.messageKey,
      blockNumber: sweep.blockNumber.toString(),
      sweepTxHash: sweep.txHash,
      ...(sweep.portal ? { portal: sweep.portal } : {}),
      ...(swept?.gross === undefined
        ? {}
        : { grossAmount: swept.gross.toString(), fundingToken: swept.token.address }),
    })
  }

  // Per-SWEEP isolation: one sweep's failure must not block the SIPA's other
  // sweeps (a re-used SIPA accumulates several), and a deposit the PXE
  // already holds — claimed before the store write landed — is reconciled
  // into the record instead of retried forever.
  const claimedIndexes = new Set(record?.claimedInboxIndexes ?? [])
  // Whether every write this SIPA queued landed; the cursor only moves past sweeps that did.
  let writesLanded = true
  const landing = (write: () => Promise<void>) => async () => {
    try {
      await write()
    } catch (err) {
      writesLanded = false
      throw err
    }
  }

  for (const sweep of sweeps) {
    const indexKey = sweep.index.toString()
    const claimed = claimedIndexes.has(indexKey)
    if (claimed && deps.store.get(sipaAddress)?.sweeps?.some((s) => s.inboxIndex === indexKey)) {
      await repriceIfUnpriced()
      continue
    }

    // The sweep's block dates its ledger entry. A replayed deposit also settles there, whether this
    // device claims it or an earlier one did; a deposit already on record settles when its claim
    // lands.
    const sweptAt = await readBlockTimeMs(deps.publicClient, sweep.blockNumber)
    const settledAt = discovered ? sweptAt : undefined
    // What the sweep took out of the SIPA: which token, since a re-used address can be funded again
    // in another one and attribution names only its first funding, and how much, every funding
    // transfer it settled. Read before anything is written: a failed read leaves the sweep for the
    // next tick, like the message-key read off the same receipt. A row with one accepted token needs
    // no read for its name, so a failed read then only leaves the gross unknown.
    const readSwept = async (
      row: SipaRow,
    ): Promise<{ token: SipaFundingToken; gross?: bigint } | undefined> => {
      const tokens = [row.token, ...row.swapped]
      const saved = sweep.funding
      const savedToken = saved
        ? tokens.find((t) => t.address.toLowerCase() === saved.token.toLowerCase())
        : undefined
      const found =
        sweptFunding(observed.outflows, sweep.txHash, tokens) ??
        (savedToken ? { token: savedToken, gross: saved!.gross } : undefined)
      return tokens.length === 1 ? { token: row.token, gross: found?.gross } : found
    }
    let swept: { token: SipaFundingToken; gross?: bigint } | undefined
    const ledgerEntry = (row: SipaRow, fee: string | undefined): SIPASweep => ({
      inboxIndex: indexKey,
      sweepTxHash: sweep.txHash,
      netAmount: sweep.amount.toString(),
      messageKey: sweep.messageKey,
      ...creditedBy(row),
      ...(fee === undefined ? {} : { fee }),
      ...(sweptAt === undefined ? {} : { settledAt: sweptAt }),
      ...(swept?.gross === undefined
        ? {}
        : {
            grossAmount: swept.gross.toString(),
            fundingTokenSymbol: swept.token.symbol,
            fundingTokenDecimals: swept.token.decimals,
          }),
    })
    // A sweep's fee is its own row's, read for this pass; the record's fee is its latest sweep's. A
    // sweep keeps the fee a pass already saved for it, since the owner may reprice the row before
    // the claim.
    const rowFee = async (row: SipaRow) => {
      const stored = deps.store.get(sipaAddress) ?? record
      if (
        stored?.inboxIndex === indexKey &&
        stored.fee != null &&
        pricedRow(deps, stored, intent) === row
      )
        return stored.fee
      return feeOnRow(deps, stored, intent, row, await sweepFee(row))
    }

    // A sweep claimed before the ledger existed gets its entry from the reads a claim makes.
    // Isolated: the ledger only reports, and a failed read leaves it to the next scan from the start.
    if (claimed) {
      await repriceIfUnpriced()
      try {
        const row = sweepRow(deps, sweep, intent)
        swept = await readSwept(row)
        const entry = ledgerEntry(row, await rowFee(row))
        const stored = deps.store.get(sipaAddress)
        await deps.store.upsert(sipaAddress, {
          phase: stored?.phase ?? phase,
          sweeps: withSweep(stored?.sweeps, entry),
          reorgEpoch: stored?.reorgEpoch,
        })
      } catch (err) {
        run.incomplete()
        logger.warn(
          `[sipaClaims] sweep ${indexKey}: ledger read failed (will retry next sync):`,
          err,
        )
      }
      continue
    }

    /** What the record reads once this sweep settled on `row`: its amounts are in the row token's units. */
    const credited = (row: SipaRow): Partial<SIPADepositRecord> => ({
      inboxIndex: indexKey,
      netAmount: sweep.amount.toString(),
      amount: formatUnits(sweep.amount, row.token.decimals),
      tokenAddress: row.token.address,
      rowToken: undefined,
      tokenSymbol: row.token.symbol,
      tokenDecimals: row.token.decimals,
      sweepTxHash: sweep.txHash,
      // The token the funder sent, when the row swapped it.
      ...(swept ? { fundingTokenSymbol: swept.token.symbol } : {}),
    })

    const markClaimed = async (row: SipaRow) => {
      claimedIndexes.add(indexKey)
      // `claimed` waits for the pass's balance read, but any other read may already hold the claim.
      const pending = deps.store.get(sipaAddress)
      if (pending?.phase === "pendingClaim")
        await deps.store
          .upsert(sipaAddress, {
            phase: pending.phase,
            claimLanded: { inboxIndex: indexKey, at: Date.now() },
            reorgEpoch: pending.reorgEpoch,
          })
          .catch((err: unknown) =>
            logger.warn(`[sipaClaims] sweep ${indexKey}: stamping its claim failed:`, err),
          )
      const fee = await rowFee(row)
      const entry = ledgerEntry(row, fee)
      const patch = credited(row)
      run.claimed(
        landing(async () => {
          const stored = deps.store.get(sipaAddress)
          await deps.store.upsert(sipaAddress, {
            phase: "claimed",
            ...(settledAt === undefined ? {} : { endTime: settledAt }),
            ...patch,
            claimedInboxIndexes: Array.from(claimedIndexes),
            sweeps: withSweep(stored?.sweeps, entry),
            fee,
            // Thread the current epoch so a re-claim after a reorg demote isn't fenced as stale.
            reorgEpoch: stored?.reorgEpoch,
          })
        }),
      )
    }

    const row = sweepRow(deps, sweep, intent)
    // Spent already, here or on another device: record it claimed, with no readiness read or claim.
    if (run.consumed.has(consumedKey(sipaAddress, sweep.index))) {
      swept = await readSwept(row)
      await markClaimed(row)
      result.reconciled += 1
      continue
    }

    try {
      const messageKey = sweep.messageKey
      swept = await readSwept(row)

      if (deps.observeOnly || !deps.tokenServiceFor || !(await run.messageReady(messageKey))) {
        logger.log(
          `[sipaClaims] sweep ${indexKey}: message ${String(messageKey).slice(
            0,
            10,
          )}… not yet settled on L2 — will retry`,
        )
        const pending: Partial<SIPADepositRecord> = {
          ...credited(row),
          fee: await rowFee(row),
        }
        run.record(
          landing(async () => {
            await deps.store.upsert(sipaAddress, { phase: "pendingClaim", ...pending })
          }),
        )
        result.pendingSettlement += 1
        leaveForRetry(sweep, swept)
        continue
      }

      logger.log(`[sipaClaims] sweep ${indexKey}: settled — claiming into PXE…`)
      const tokenService = await deps.tokenServiceFor(row.l2Token)
      await tokenService.claimSweptDeposit({
        inboxIndex: sweep.index,
        amount: sweep.amount,
        recipient: deps.recipient,
        sharedSecretSalt,
      })
      await markClaimed(row)
      result.claimed += 1
      logger.log(
        `[sipaClaims] sweep ${indexKey}: CLAIMED ${formatUnits(sweep.amount, row.token.decimals)} ${
          row.token.symbol
        } — balance should reflect it`,
      )
    } catch (err) {
      if (isAlreadyClaimedDepositError(err)) {
        await markClaimed(row)
        result.reconciled += 1
        continue
      }
      result.failed += 1
      leaveForRetry(sweep, swept)
      logger.warn(`[sipaClaims] sweep ${indexKey} failed (will retry next sync):`, err)
    }
  }

  // Queued after this SIPA's own writes: a cursor saved before them would skip a sweep whose record
  // never landed, once it fell behind the reorg overlap.
  run.record(async () => {
    if (!writesLanded) {
      await markForRescan(deps, sipaAddress, due.fromBlock)()
      return
    }
    const patch = covered(due, unresolved)
    if (Object.keys(patch).length === 0) return
    await deps.store.upsert(sipaAddress, {
      phase: deps.store.get(sipaAddress)?.phase ?? phase,
      ...patch,
    })
  })
}

/**
 * What a finished scan stamps: its whole history read once, any re-read cleared, the sweeps it left
 * unclaimed. Empty when nothing changes, so a quiet SIPA writes nothing.
 */
function covered(due: DueScan, pending: SIPAPendingSweep[] = []): Partial<SIPADepositRecord> {
  const stored = due.deps.store.get(due.sipaAddress) ?? due.record
  const patch: Partial<SIPADepositRecord> = {}
  if (due.complete && (due.backfilled || !stored?.observedFrom))
    patch.observedFrom = due.run.head.toString()
  const retry = due.run.retryFrom.get(due.sipaAddress.toLowerCase())
  if (retry !== undefined) patch.rescanFrom = retry.toString()
  else if (stored?.rescanFrom) patch.rescanFrom = undefined
  const same = JSON.stringify(stored?.pendingSweeps ?? []) === JSON.stringify(pending)
  if (!same) patch.pendingSweeps = pending.length ? pending : undefined
  return patch
}

/** Publishes a funded SIPA again when the relayer has left it unswept past `SWEEP_OVERDUE_MS`. */
async function republishIfOverdue(deps: SipaDepositSyncDeps, run: SyncRunContext, sipa: Address) {
  const record = deps.store.get(sipa)
  if (!deps.onSweepOverdue || !record || run.now - record.startTime < SWEEP_OVERDUE_MS) return
  if (record.republishAskedAt && run.now - record.republishAskedAt < REPUBLISH_INTERVAL_MS) return
  // Asked once per interval whatever the answer: an address with no broadcast of ours to repeat
  // answers no every time.
  await deps.store.upsert(sipa, { phase: record.phase, republishAskedAt: run.now })
  try {
    if (await deps.onSweepOverdue(sipa))
      logger.info(`[sipaClaims] ${sipa} is overdue for its sweep: published again`)
  } catch (err) {
    run.incomplete()
    logger.warn(`[sipaClaims] ${sipa} republish failed, asking again in a day:`, err)
  }
}

/** The ledger with `entry` in place of any earlier entry for its sweep, in inbox order. */
function withSweep(sweeps: readonly SIPASweep[] | undefined, entry: SIPASweep): SIPASweep[] {
  return [...(sweeps ?? []).filter((s) => s.inboxIndex !== entry.inboxIndex), entry].sort((a, b) =>
    BigInt(a.inboxIndex) < BigInt(b.inboxIndex) ? -1 : 1,
  )
}

/**
 * Whether the funds now at this SIPA come after a claimed sweep. Besides `claimed`, a `sweeping`
 * record still stamped with its claimed sweep (settled time, claimed inbox index) qualifies: a
 * second payment once left the record so, with no stuck clock and no exit.
 */
function claimedBefore(
  record: Pick<SIPADepositRecord, "phase" | "endTime" | "inboxIndex" | "claimedInboxIndexes">,
): boolean {
  if (record.phase === "claimed") return true
  return (
    record.phase === "sweeping" &&
    !!record.endTime &&
    !!record.inboxIndex &&
    !!record.claimedInboxIndexes?.includes(record.inboxIndex)
  )
}

/**
 * The row a SIPA's record is shown in before any sweep names one: the pinned bridge's for a deposit,
 * else the first row that settles the intent.
 */
function defaultRow(deps: SipaDepositSyncDeps, intent: SIPADepositRecord["intent"]): SipaRow {
  const rows = intentRows(deps, intent)
  return (
    (sipaIntentName(sipaRecordIntent(intent)) === "deposit" &&
      sipaRowByFunding(rows, bridgeUnderlying(deps.tuple))) ||
    rows[0] ||
    deps.rows[0]!
  )
}

/** The rows a sweep for the record's intent settles on: a registration's is the fee token's alone. */
function intentRows(deps: SipaDepositSyncDeps, intent: SIPADepositRecord["intent"]): SipaRow[] {
  const name = sipaIntentName(sipaRecordIntent(intent))
  return deps.rows.filter((row) => row.intents.includes(name))
}

/** The row a sweep settled on: its portal's, or the record's default row for a sweep saved without one. */
function sweepRow(
  deps: SipaDepositSyncDeps,
  sweep: { portal?: string },
  intent: SIPADepositRecord["intent"],
): SipaRow {
  return (sweep.portal && sipaRowByPortal(deps.rows, sweep.portal)) || defaultRow(deps, intent)
}

/**
 * What `balances` (keyed by lowercased token) hold at most, in units of the row each token settles on:
 * the balance a sweep of the largest holding would credit.
 */
function heldBalance(balances: ReadonlyMap<string, bigint>, rows: readonly SipaRow[]): bigint {
  let best = { held: 0n, comparable: 0n }
  for (const row of rows) {
    for (const token of [row.token, ...row.swapped]) {
      const held = inRowUnits(balances.get(token.address.toLowerCase()) ?? 0n, token, row.token)
      const comparable = held * 10n ** BigInt(Math.max(36 - row.token.decimals, 0))
      if (comparable > best.comparable) best = { held, comparable }
    }
  }
  return best.held
}

/** The row a record's stored fee was priced on: its funds' row, or before any funds, the default one. */
function pricedRow(
  deps: SipaDepositSyncDeps,
  stored: SIPADepositRecord,
  intent: SIPADepositRecord["intent"],
): SipaRow {
  return sipaRowByFunding(deps.rows, stored.tokenAddress) ?? defaultRow(deps, intent)
}

/**
 * The fee a record names once its funds or its sweep sit on `row`: `fresh`, read off that row, else the
 * stored fee when it was priced on that row. A fee priced on another row goes until a pass prices this one.
 */
function feeOnRow(
  deps: SipaDepositSyncDeps,
  stored: SIPADepositRecord | null,
  intent: SIPADepositRecord["intent"],
  row: SipaRow | undefined,
  fresh: string | undefined,
): string | undefined {
  if (fresh !== undefined) return fresh
  return stored?.fee != null && row && pricedRow(deps, stored, intent) === row
    ? stored.fee
    : undefined
}

/** What a sweep through `row` credits: the row's portal, L2 token and token. */
function creditedBy(
  row: SipaRow,
): Pick<SIPASweep, "portal" | "l2Token" | "tokenAddress" | "tokenSymbol" | "tokenDecimals"> {
  return {
    portal: row.portal,
    l2Token: row.l2Token,
    tokenAddress: row.token.address,
    tokenSymbol: row.token.symbol,
    tokenDecimals: row.token.decimals,
  }
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}
