/**
 * The one-key account a rotated wallet left, and the watch that keeps reading it for money that
 * still arrives there.
 */
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { normalizePubkeyHex, type RecoveryMetadata } from "@obsidion/sdk"
import type { PaylinkTransaction } from "../../types/transactions"
import {
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  type SIPADepositRecord,
} from "../services/deposits/SIPADepositStore"
import type { PreviousAccountWatch } from "../storages/PreviousAccountWatchStore"

const DAY_MS = 24 * 60 * 60 * 1000
/** How long the watch stays open after the account last held something or was moved from. */
export const WATCH_WINDOW_MS = 7 * DAY_MS
/** How often a closed watch checks the account again. */
export const WATCH_CHECK_MS = DAY_MS
/** How long after closing a watch keeps checking daily; after that it stops. */
export const WATCH_TAPER_MS = 21 * DAY_MS

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function normalKey(hex: string): string | undefined {
  try {
    return normalizePubkeyHex(hex)
  } catch {
    return undefined
  }
}

/**
 * The root key of the one-key account, as x‖y hex with no prefix, from a record of the account that
 * replaced it. A set of exactly two distinct keys holding the record's own is the root and one
 * backup: the record's key on the root's record, the other one on the backup's. Any other record
 * names none.
 */
export function previousRootKey(
  record: Pick<RecoveryMetadata, "pubkey" | "isMskRoot" | "passkeySet">,
): string | undefined {
  const own = normalKey(record.pubkey)
  const [a, b, ...rest] = record.passkeySet?.map(normalKey) ?? []
  if (!own || !a || !b || rest.length > 0 || a === b) return undefined
  if (own !== a && own !== b) return undefined
  if (record.isMskRoot) return own
  return own === a ? b : a
}

/** Whether `amount` is below the dust floor, the smallest amount Home shows. */
export const isDust = (amount: bigint, dust: bigint): boolean => amount < dust

/** The moved token's forwarding-table row, as deposit records name it. */
export interface MovedTokenRow {
  /** The portal its sweeps land in. */
  portal: string
  /** Its own L1 token: a record's `rowToken`, else its `tokenAddress`. */
  token: string
}

/** A record that names no token yet may be the row's. */
function onRow(record: SIPADepositRecord, row: MovedTokenRow): boolean {
  const token = record.rowToken ?? record.tokenAddress
  if (token === undefined || sameAddress(token, row.token)) return true
  return !!record.pendingSweeps?.some(
    (sweep) => !!sweep.portal && sameAddress(sweep.portal, row.portal),
  )
}

/**
 * Whether a deposit record still holds money of the moved token. A `recoverable` payment sits below
 * the sweep fee and only an L1 recovery moves it, so it never holds the watch.
 */
export function recordHoldsMoney(
  record: SIPADepositRecord,
  row: MovedTokenRow,
  dust: bigint,
): boolean {
  if (!onRow(record, row) || record.phase === "recoverable") return false
  if (record.pendingSweeps?.length || record.phase === "pendingClaim") return true
  if (record.heldBalance !== undefined && !isDust(BigInt(record.heldBalance), dust)) return true
  return !isSettledSipaPhase(record.phase) && !isUnfundedSipaDeposit(record)
}

/** Whether a refund of a paylink `creator` made was sent and has not landed. */
export function refundOnItsWay(paylink: PaylinkTransaction, creator: string): boolean {
  return (
    paylink.action === PaylinkActionEnum.PAY &&
    !!paylink.obsidionAccountAddress &&
    sameAddress(paylink.obsidionAccountAddress, creator) &&
    !!paylink.refundTxHash &&
    !paylink.isRefunded
  )
}

/** What one check of the previous account found. */
export interface WatchObservation {
  /** The claims pass read all it should and the balance read landed. */
  completed: boolean
  /** A balance at or above the dust floor, a deposit record holding money, or a refund on its way. */
  held: boolean
  /** A move chunk is being sent. */
  inFlight: boolean
}

/** The watch of an account first seen now. */
export function openWatch(address: string, now: number): PreviousAccountWatch {
  return { address, watchUntilMs: now + WATCH_WINDOW_MS }
}

/** The watch open until a window from now at the earliest. */
export function pushWatch(watch: PreviousAccountWatch, now: number): PreviousAccountWatch {
  const { closed: _, closedAtMs: __, ...open } = watch
  return { ...open, watchUntilMs: Math.max(watch.watchUntilMs, now + WATCH_WINDOW_MS) }
}

/**
 * The watch after a check at `now`. Holding pushes it out. It closes only past its end, on a
 * complete check that found nothing, with no chunk stored or being sent. A closed watch reopens on
 * money or a chunk; an incomplete check leaves it closed and unchecked, dated so the taper still
 * runs out. A watch is returned as it is when nothing changes.
 */
export function observeWatch(
  watch: PreviousAccountWatch,
  observation: WatchObservation,
  now: number,
): PreviousAccountWatch {
  const moving = observation.inFlight || !!watch.move
  if (watch.closed) {
    if (observation.held || moving) return pushWatch(watch, now)
    if (observation.completed) {
      return { ...watch, closedAtMs: watch.closedAtMs ?? now, lastCheckAtMs: now }
    }
    return watch.closedAtMs === undefined ? { ...watch, closedAtMs: now } : watch
  }
  if (observation.held) return pushWatch(watch, now)
  if (!observation.completed || moving || now < watch.watchUntilMs) return watch
  return { ...watch, closed: true, closedAtMs: now, lastCheckAtMs: now }
}

/** Whether a closed watch is due its daily check; none is due once the taper has run out. */
export function watchCheckDue(watch: PreviousAccountWatch, now: number): boolean {
  if (!watch.closed) return false
  const closedAt = watch.closedAtMs ?? watch.lastCheckAtMs ?? now
  if (now >= closedAt + WATCH_TAPER_MS) return false
  return watch.lastCheckAtMs === undefined || now - watch.lastCheckAtMs >= WATCH_CHECK_MS
}
