/**
 * Forwards what reached the previous account to the session's account, one chunk in flight at a
 * time. The chunk is saved on the watch before its transfer leaves and is resolved by its hash
 * before anything else, so a reload or a second run never sends twice for one chunk.
 */
import { MAX_TX_LIFETIME_MS } from "@obsidion/core/constants"
import { isSpendEnvelopeRefusal, type SpendShape, type TxHashCallback } from "@obsidion/sdk"
import type { Hex } from "viem"
import type {
  PreviousAccountMove,
  PreviousAccountWatchStore,
} from "../storages/PreviousAccountWatchStore"
import type { TxOutcome } from "./backupRotationFlow"
import { planMove, unreadDeposits } from "./planMove"
import { isDust, openWatch, pushWatch } from "./previousAccount"

/** How long a run waits before reading the chunk in flight again. */
export const PREVIOUS_MOVE_POLL_MS = 15_000

export interface PreviousMoveDeps {
  store: PreviousAccountWatchStore
  /** The watch's key: the previous account's address. */
  address: string
  /** The account the move sends from. */
  source: string
  /** The session's account. */
  destination: string
  /** The source's shape on the moved token, read while no chunk is in flight. */
  shape(): Promise<SpendShape>
  cap: bigint
  /** The smallest balance worth a transfer. */
  dust: bigint
  /**
   * One sponsored transfer of `amount` to the destination. `onTxHash` is awaited before it leaves;
   * an abort seen before the signing call throws with nothing sent.
   */
  send(amount: bigint, onTxHash: TxHashCallback, signal: AbortSignal): Promise<void>
  /** `txOutcome` over the node and the wallet's clock. */
  outcome(txHash: string, expiresAtMs: number): Promise<TxOutcome>
  /** Whether the destination is still the session's verified account. */
  destinationOk(): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
}

/**
 * How a run ends. A `spend` refusal names the chunk the transfer's envelope refused; a
 * `destination` one is a failed destination check, with no new chunk sent.
 */
export type PreviousMoveResult =
  | { kind: "done" }
  | { kind: "refused"; reason: "spend" | "destination"; amount: bigint }
  | { kind: "stopped" }

const DONE: PreviousMoveResult = { kind: "done" }
const STOPPED: PreviousMoveResult = { kind: "stopped" }

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Checkpointed or final, whether the transfer took effect or not: either way the next chunk is cut
 * from the live shape.
 */
function settled(outcome: TxOutcome): boolean {
  switch (outcome.kind) {
    case "included":
      return outcome.checkpointed
    case "mined":
    case "reverted":
    case "dead":
      return true
    default:
      return false
  }
}

/** Drops the stored chunk while it is still the one inspected. */
const clearChunk = (deps: Pick<PreviousMoveDeps, "store" | "address">, txHash: string) =>
  deps.store.update(deps.address, (current) => {
    if (!current || current.move?.txHash !== txHash) return null
    const { move: _, ...rest } = current
    return rest
  })

const pushWindow = (deps: PreviousMoveDeps) => {
  const now = deps.now()
  return deps.store.update(deps.address, (current) =>
    pushWatch(current ?? openWatch(deps.address, now), now),
  )
}

/**
 * Reads the stored chunk's outcome once and clears it once settled; never plans, sends or signs.
 * Answers whether a chunk is still stored.
 */
export async function settleStoredChunk(
  deps: Pick<PreviousMoveDeps, "store" | "address" | "outcome">,
): Promise<boolean> {
  const move = (await deps.store.get(deps.address))?.move
  if (!move) return false
  if (!settled(await deps.outcome(move.txHash, move.expiresAtMs))) return true
  return !!(await clearChunk(deps, move.txHash))?.move
}

/**
 * Moves the previous account's balance to the destination: the stored chunk first, by its hash,
 * then one chunk at a time cut from the live shape. Every end pushes the watch out.
 */
export async function movePreviousBalance(
  deps: PreviousMoveDeps,
  signal: AbortSignal,
): Promise<PreviousMoveResult> {
  let result: PreviousMoveResult
  try {
    result = await moveChunks(deps, signal)
  } catch (err) {
    await pushWindow(deps).catch(() => undefined)
    throw err
  }
  await pushWindow(deps)
  return result
}

async function moveChunks(
  deps: PreviousMoveDeps,
  signal: AbortSignal,
): Promise<PreviousMoveResult> {
  for (;;) {
    const move = (await deps.store.get(deps.address))?.move
    if (move) {
      if (!settled(await deps.outcome(move.txHash, move.expiresAtMs))) {
        if (signal.aborted) return STOPPED
        await deps.sleep(PREVIOUS_MOVE_POLL_MS)
        continue
      }
      await clearChunk(deps, move.txHash)
      if (
        !sameAddress(move.source, deps.source) ||
        !sameAddress(move.destination, deps.destination)
      )
        return { kind: "refused", reason: "destination", amount: BigInt(move.amount) }
      continue
    }
    if (signal.aborted) return STOPPED
    const shape = await deps.shape()
    if (isDust(shape.balance, deps.dust)) return DONE
    const chunk = planMove(shape, deps.cap, unreadDeposits(shape)).chunks[0]
    if (!chunk) return DONE
    if (!(await deps.destinationOk()))
      return { kind: "refused", reason: "destination", amount: chunk.amount }
    if (signal.aborted) return STOPPED
    const ended = await sendChunk(deps, chunk.amount, signal)
    if (ended) return ended
  }
}

/** One chunk out, its hash saved first; answers how the run ends when the send fails before that. */
async function sendChunk(
  deps: PreviousMoveDeps,
  amount: bigint,
  signal: AbortSignal,
): Promise<PreviousMoveResult | undefined> {
  let saved = false
  const onTxHash: TxHashCallback = async (txHash, { expiresAtMs }) => {
    const now = deps.now()
    const move: PreviousAccountMove = {
      source: deps.source,
      destination: deps.destination,
      txHash: txHash as Hex,
      expiresAtMs: Math.min(expiresAtMs, now + MAX_TX_LIFETIME_MS),
      amount: amount.toString(),
    }
    await deps.store.update(deps.address, (current) => ({
      ...pushWatch(current ?? openWatch(deps.address, now), now),
      move,
    }))
    saved = true
  }
  try {
    await deps.send(amount, onTxHash, signal)
  } catch (err) {
    // A chunk with its hash saved may have left; it is resolved by hash, never sent again.
    if (saved) throw err
    if (isSpendEnvelopeRefusal(err)) return { kind: "refused", reason: "spend", amount }
    if (signal.aborted) return STOPPED
    throw err
  }
  if (!saved) throw new Error("previous account move: the send saved no hash")
  return undefined
}
