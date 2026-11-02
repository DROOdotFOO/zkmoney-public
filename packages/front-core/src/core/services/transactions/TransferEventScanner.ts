/**
 * TransferEventScanner — the chain-native source of the account's L2 transfer history.
 *
 * Reads the wallet's own private `Transfer` events from a persisted block cursor and writes a
 * verified row per event: a `receive` when the account is `to`, a `send` when it is `from` (the
 * token delivers every transfer to both parties, so a fresh client rebuilds what it sent too), and
 * a paylink claim row when the source verified the event's payout lane.
 * Nothing arrives off-chain: the sender's tag (and memo / request id) ride the event's `meta`, and
 * the tag is display attribution only — it is kept when the name registry resolves it to the
 * on-chain `from`, else the row shows the raw address and no contact is auto-added. Sends keep the
 * recipient L2 address so contact history can match it and resolve its display name; the recipient
 * tag the sender wrote into its own event copy is adopted as a contact under the same registry
 * check, against the on-chain `to`. Every downstream consumer (the bell, balance refresh, reorg
 * anchoring via `blockNumber`) reads the stored receive; sends only land in the store.
 *
 * Scans run in chunks of at most `MAX_BLOCKS_PER_TICK`; the cursor advances per completed chunk, in
 * one transaction with that chunk's rows, so a failure retries only its own chunk, never the whole
 * history. Only a pass's first chunk syncs PXE; the rest read at its anchor, since each new anchor
 * wipes the token's note discovery. The cursor never persists past the source's `anchorBlock` (PXE's synced block): head is the node tip,
 * but `listIncoming` only sees what PXE has decrypted, and PXE lags whenever a send pins the sync —
 * advancing to head would skip every block in the gap. The anchor is sampled BEFORE each list: it
 * is monotone, so a pre-read never exceeds the list's true coverage, while a post-read could claim
 * blocks a mid-pass sync added that the list never saw. While the anchor trails head a pass keeps
 * rescanning instead of idling, which re-triggers the very sync that advances the anchor. An anchor
 * below the cursor means PXE was rebuilt (store wipe, generation change) — the cursor rewinds to it
 * so the re-decrypted blocks are rescanned, just like a head that regressed below the cursor. A
 * registry outage holds the chunk's cursor so the range is retried; after `MAX_INGEST_ATTEMPTS`
 * failures the registry lookup — the only shed-able dependency — is dropped and the row is written
 * with the raw sender address, because PXE already validated the event itself: it must be recorded,
 * never skipped. Each pass rescans `REORG_MARGIN` blocks behind the cursor (the store's txHash
 * dedup makes that free).
 *
 * Every await that leaves the device is bounded by a timeout and ends when the pass is aborted, so
 * no hung RPC or registry fetch can wedge a pass or outlive it. A catch-up read gets a longer
 * bound: a fresh device's first note discovery can outlast the normal one, and a timed-out or
 * abandoned read keeps running in PXE's queue ahead of its retry.
 * While head is static a scheduled pass skips the scan entirely — `headBlock` is a plain node read
 * but `listIncoming` drags a full PXE sync behind it — with a periodic full pass so a static-head
 * rebuild is still caught. A `full` pass (a wake: resume, pull-to-refresh) never skips.
 *
 * Snapshot sources return events and balances from one validated PXE anchor. `onSynced` publishes
 * the snapshot before event attribution/persistence, so their failures cannot withhold a balance.
 * A throwing hook fails the pass and forces a full rescan next pass. The `transferScan` runtime
 * task schedules the passes.
 */

import type { TokenInTxService } from "../../../types/tokens"
import type { PaylinkTransaction, TokenTransaction, Transaction } from "../../../types/transactions"
import type { OnNetwork } from "../../../types/networkStamp"
import type {
  ScannedTransferEvent,
  TransferEventSource,
  WalletBalanceRead,
  WalletSyncSource,
} from "@obsidion/sdk"
import type {
  ContactsByL2,
  ITagForwardResolver,
  NewIncomingTokenTx,
  NewPaylinkPayoutTx,
  TransactionStoreWrites,
} from "../../../xmtp/receiverTypes"
import { syncCatchUp, type CatchUp } from "../../../engine/catchUp"
import { bestEffort, WalletError } from "../../../engine/errors"
import type { Database, Write } from "../../../engine/database"
import { within } from "../../../engine/runtime"
import { logger } from "../../../utils/logger"
import { PaylinkActionEnum, TokenActionEnum } from "@obsidion/core/constants"

export type { ScannedTransferEvent, TransferEventSource }

const LOG_PREFIX = "[TransferEventScanner]"
export const TRANSFER_SCAN_POLL_INTERVAL_MS = 5_000
export const TRANSFER_SCAN_REORG_MARGIN = 64
export const TRANSFER_SCAN_MAX_BLOCKS_PER_TICK = 10_000
/** Cursor lag that hides a pass behind the activity skeleton: a rebuild or a gap of many hours, not a reopen. */
export const TRANSFER_SCAN_CATCH_UP_BLOCKS = 1_000
export const TRANSFER_SCAN_SOURCE_TIMEOUT_MS = 30_000
export const TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS = 300_000
const CURSOR_STORAGE_KEY = "@obsidion/transfer-scan/cursor/v1"
/** Failed ingests for one txHash before attribution degrades to the raw sender address. */
const MAX_INGEST_ATTEMPTS = 3
/** Full rescan cadence while head is static, so a reorg that rebuilt without advancing head lands. */
const IDLE_TICKS_PER_FULL_PASS = 12

type ScanScope = Pick<TransferScanContext, "accountAddress" | "networkId">

function cursorKey(ctx: ScanScope & Pick<TransferScanContext, "endpointScope">): string {
  const scope = ctx.endpointScope ? `/${ctx.endpointScope}` : ""
  return `${CURSOR_STORAGE_KEY}/${ctx.networkId}${scope}/${ctx.accountAddress.toLowerCase()}`
}

/** Every cursor an account's scans kept starts with this; `transferScanNetworkOf` reads the network off one. */
export const TRANSFER_SCAN_CURSOR_PREFIX = `${CURSOR_STORAGE_KEY}/`

/** The network a stored scan cursor's key names, or undefined for any other key. */
export function transferScanNetworkOf(key: string): string | undefined {
  if (!key.startsWith(TRANSFER_SCAN_CURSOR_PREFIX)) return undefined
  return key.slice(TRANSFER_SCAN_CURSOR_PREFIX.length).split("/")[0] || undefined
}

async function loadBlock(db: Pick<Database, "get">, key: string): Promise<number | undefined> {
  const raw = await db.get(key)
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export interface TransferScanContext {
  accountAddress: string
  /** Display identity written to the row's `to`. */
  accountTag: string
  networkId: string
  /**
   * Keys the cursor to a non-default node endpoint, so its scans never move the cursor the
   * default endpoint resumes from. Absent on the default endpoint.
   */
  endpointScope?: string
}

export interface TransferEventScannerOptions {
  source: TransferEventSource & Partial<Pick<WalletSyncSource, "readSnapshot">>
  /** The account's database: the cursor saves in one transaction with the rows it covers. */
  db: Database
  transactionStore: TransactionStoreWrites
  /** The rows a chunk filed, once saved. */
  onFiled?: (rows: readonly Transaction[]) => void
  tags: ITagForwardResolver
  contacts: ContactsByL2
  token: { address: string; symbol: string; decimals: number }
  /** Publishes each chunk's validated snapshot before event attribution or persistence. */
  onSynced?: (anchorBlock: number, read?: Partial<WalletBalanceRead>) => Promise<void>
  /** Each pass that read every chunk up to head. */
  onCaughtUp?: () => void
  sourceTimeoutMs?: number
  catchUpTimeoutMs?: number
  /** Where a pass that rebuilds history holds the activity skeleton. */
  catchUp?: CatchUp
}

export interface TransferScanPass {
  /** Skips nothing: a wake, never the cadence. */
  full?: boolean
  /** Ends the pass at once, letting go of its holds; not a failure. */
  signal?: AbortSignal
}

export class TransferEventScanner {
  private readonly opts: TransferEventScannerOptions
  private readonly sourceTimeoutMs: number
  private readonly catchUpTimeoutMs: number
  /** Failed ingest attempts per txHash; at `MAX_INGEST_ATTEMPTS` the ingest goes degraded. */
  private readonly ingestAttempts = new Map<string, number>()
  private lastScannedHead: number | undefined
  private idleTicks = 0

  constructor(options: TransferEventScannerOptions) {
    this.opts = options
    this.sourceTimeoutMs = options.sourceTimeoutMs ?? TRANSFER_SCAN_SOURCE_TIMEOUT_MS
    this.catchUpTimeoutMs = options.catchUpTimeoutMs ?? TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS
  }

  /** One pass. False when a chunk could not complete: its cursor holds for the next pass. */
  async pass(ctx: TransferScanContext, opts: TransferScanPass = {}): Promise<boolean> {
    const { signal } = opts
    if (opts.full) this.idleTicks = IDLE_TICKS_PER_FULL_PASS
    // ponytail: one pass, complete or not, ends the catch-up; a partial history then lands live.
    let endCatchUp: (() => void) | undefined
    const release = () => {
      endCatchUp?.()
      endCatchUp = undefined
    }
    signal?.addEventListener("abort", release)
    try {
      return await this.scan(ctx, signal, () => {
        if (!signal?.aborted) endCatchUp ??= (this.opts.catchUp ?? syncCatchUp).begin()
      })
    } catch (err) {
      if (signal?.aborted) return true
      throw err
    } finally {
      signal?.removeEventListener("abort", release)
      release()
    }
  }

  /**
   * Returns true when every chunk up to head completed (cursor at head). `catchUp` holds the
   * activity skeleton for the pass: no cursor, or one more than `TRANSFER_SCAN_CATCH_UP_BLOCKS`
   * behind head.
   */
  private async scan(
    ctx: TransferScanContext,
    signal: AbortSignal | undefined,
    catchUp: () => void,
  ): Promise<boolean> {
    const head = await this.bounded(this.opts.source.headBlock(), "headBlock", signal)
    let cursor = await this.loadCursor(ctx)

    // A head behind the cursor means the chain was rebuilt shorter than the margin reaches. Pull
    // the cursor back to the surviving head, else the blocks between them are never rescanned and
    // a transfer re-included on the new chain is lost for good.
    if (cursor !== undefined && head < cursor) {
      logger.warn(`${LOG_PREFIX} head ${head} regressed below cursor ${cursor}; rewinding`)
      await this.saveCursor(ctx, head)
      cursor = head
    }

    let anchor = await this.readAnchor(head, signal)
    // PXE rebuilt below the cursor: rewind so its re-decrypted blocks are rescanned.
    if (cursor !== undefined && anchor < cursor) {
      logger.warn(`${LOG_PREFIX} anchor ${anchor} below cursor ${cursor}; rewinding`)
      await this.saveCursor(ctx, anchor)
      cursor = anchor
    }

    let from = Math.max(1, Math.min(cursor ?? 1, head) - TRANSFER_SCAN_REORG_MARGIN)
    if (head < from) return true

    // `headBlock` is a plain node read; `listIncoming` drags a full PXE sync behind it. While head
    // is static there is nothing new to decrypt, so skip the sync and let the pass idle.
    if (head === this.lastScannedHead && this.idleTicks < IDLE_TICKS_PER_FULL_PASS) {
      this.idleTicks++
      return true
    }
    this.idleTicks = 0

    // Catching up: rows from this pass land behind the activity skeleton, released when the pass ends.
    let readTimeoutMs = this.sourceTimeoutMs
    if (cursor === undefined || head - cursor > TRANSFER_SCAN_CATCH_UP_BLOCKS) {
      catchUp()
      readTimeoutMs = this.catchUpTimeoutMs
    }
    let synced = false
    while (from <= head) {
      // A pass stopped mid-way ends without counting as a failure.
      if (signal?.aborted) return true
      const chunkEnd = Math.min(from + TRANSFER_SCAN_MAX_BLOCKS_PER_TICK - 1, head)
      const snapshot = this.opts.source.readSnapshot
        ? await this.bounded(
            this.opts.source.readSnapshot(
              from,
              chunkEnd + 1,
              synced ? { assumeSynced: true } : undefined,
            ),
            "readSnapshot",
            signal,
            readTimeoutMs,
          )
        : {
            events: await this.bounded(
              this.opts.source.listIncoming(from, chunkEnd + 1),
              "listIncoming",
              signal,
              readTimeoutMs,
            ),
            anchorBlock: await this.readAnchor(head, signal),
            balances: undefined,
          }
      synced = true
      if (signal?.aborted) return true
      anchor = snapshot.anchorBlock
      // Publish the balance before attribution or persistence can defer an event. The bounded
      // snapshot has no side effects: a late result after timeout/stop can never publish here.
      const balanceComplete = await this.synced(anchor, snapshot, signal)
      const ingested = await this.ingestEvents(ctx, snapshot.events, signal)
      if (signal?.aborted) return true
      const scannedTo = Math.min(chunkEnd, anchor)
      const covered = ingested.complete && balanceComplete && scannedTo >= from
      await this.save(ctx, ingested.writes, covered ? scannedTo : undefined)
      if (!ingested.complete || !balanceComplete) return false
      if (anchor < chunkEnd) return true // next pass rescans and re-syncs
      from = chunkEnd + 1
    }
    this.lastScannedHead = head
    this.opts.onCaughtUp?.()
    return true
  }

  /** Runs the post-sync hook; a failure fails the pass and forces a full pass next time. */
  private async synced(
    anchor: number,
    read: Partial<WalletBalanceRead>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (!this.opts.onSynced || signal?.aborted) return true
    try {
      await this.bounded(this.opts.onSynced(anchor, read), "onSynced", signal)
      return true
    } catch (err) {
      if (signal?.aborted) throw err
      logger.warn(`${LOG_PREFIX} onSynced failed:`, err)
      this.lastScannedHead = undefined
      return false
    }
  }

  private readAnchor(head: number, signal: AbortSignal | undefined): Promise<number> {
    if (!this.opts.source.anchorBlock) return Promise.resolve(head)
    return this.bounded(this.opts.source.anchorBlock(), "anchorBlock", signal)
  }

  /**
   * Saves a chunk's rows, with the cursor once they are all in, as one transaction: a cursor saved
   * without its rows would skip them for good.
   */
  private async save(
    ctx: TransferScanContext,
    writes: readonly Filing[],
    cursor: number | undefined,
  ): Promise<void> {
    if (writes.length === 0 && cursor === undefined) return
    const filed = await this.opts.db.write(async (w) => {
      const rows: Transaction[] = []
      for (const write of writes) {
        const row = await write(w)
        if (row) rows.push(row)
      }
      if (cursor !== undefined) w.put(cursorKey(ctx), String(cursor))
      return rows
    })
    if (filed.length > 0) this.opts.onFiled?.(filed)
  }

  /** Each event's row write, run by `save`; an event that cannot be read yet holds the cursor. */
  private async ingestEvents(
    ctx: TransferScanContext,
    events: ScannedTransferEvent[],
    signal: AbortSignal | undefined,
  ): Promise<{ complete: boolean; writes: Filing[] }> {
    let complete = true
    const writes: Filing[] = []
    /** Hashes this chunk files, which the store holds only once `save` runs. */
    const filed = new Set<string>()
    for (const event of events) {
      if (signal?.aborted) return { complete: false, writes: [] }
      const action = this.direction(event, ctx)
      if (!action) continue
      const attempts = this.ingestAttempts.get(event.txHash) ?? 0
      try {
        const degraded = attempts >= MAX_INGEST_ATTEMPTS
        const write = await this.ingest(event, ctx, action, degraded, filed, signal)
        if (write) writes.push(write)
        this.ingestAttempts.delete(event.txHash)
      } catch (err) {
        if (signal?.aborted) throw err
        // Hold the cursor and retry; repeated failures shed the registry lookup, never the event.
        this.ingestAttempts.set(event.txHash, attempts + 1)
        complete = false
        logger.warn(
          `${LOG_PREFIX} ingest deferred for ${event.txHash} (attempt ${attempts + 1}):`,
          err,
        )
      }
    }
    return { complete, writes }
  }

  private bounded<T>(
    promise: Promise<T>,
    label: string,
    signal: AbortSignal | undefined,
    ms: number = this.sourceTimeoutMs,
  ): Promise<T> {
    return within(promise, label, { ms, signal })
  }

  /** Self-transfers and events of other accounts are neither. */
  private direction(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
  ): "send" | "receive" | undefined {
    const me = ctx.accountAddress.toLowerCase()
    const from = event.from.toLowerCase()
    const to = event.to.toLowerCase()
    if (from === to) return undefined
    if (to === me) return "receive"
    if (from === me) return "send"
    return undefined
  }

  /** Reads what the event's row needs and returns its write. */
  private async ingest(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
    action: "send" | "receive",
    degraded: boolean,
    filed: Set<string>,
    signal: AbortSignal | undefined,
  ): Promise<Filing | undefined> {
    const store = this.opts.transactionStore
    // A verified payout lane: the escrow paid this account's claim. No sender to attribute, and no
    // hash check: the write upgrades a plain receive filed before the lane was read and is a no-op
    // on any other row, so a claim row is never duplicated.
    if (action === "receive" && event.paylinkPayout) {
      const { flavor } = event.paylinkPayout
      const timestamp = await this.timestampOf(event, signal)
      if (signal?.aborted) return undefined
      const row = payoutRow({
        action: PaylinkActionEnum.CLAIM,
        txHash: event.txHash,
        flavor,
        token: buildTokenInTxService({ ...this.opts.token, rawAmount: event.amount }),
        amountAtomic: BigInt(event.amount),
        timestamp,
        blockNumber: event.blockNumber,
        memo: event.memo,
        networkId: ctx.networkId,
      })
      return async (w) => {
        const { tx, inserted } = await store.record(row, { replaces: TokenActionEnum.RECEIVE }, w)
        if (!inserted) return undefined
        logger.log(`${LOG_PREFIX} paylink claim ${event.txHash}`)
        return tx
      }
    }

    // Any row already carrying this hash, not just a send/receive: the paylink escrow pays the
    // claimant with the same token `transfer`, so a claim or refund arrives here as a `Transfer`
    // to us. Matching only send/receive would file it a second time as a stranger receive. It is
    // also what keeps a send this client made itself from being filed twice. The payout carries the
    // creator's memo, which a claim or refund row written before the tx mined does not have yet.
    const hash = event.txHash.toLowerCase()
    if (filed.has(hash) || (await store.hasTxHash(event.txHash))) {
      const { memo } = event
      return memo
        ? async (w) => {
            await store.backfillMemo(event.txHash, memo, w)
            return undefined
          }
        : undefined
    }

    const counterparty =
      action === "receive"
        ? await this.bounded(
            this.attributeSender(event, ctx, degraded),
            "attributeCounterparty",
            signal,
          )
        : event.to
    if (action === "send") {
      await this.bounded(this.adoptRecipient(event, ctx, degraded), "adoptRecipient", signal)
    }
    const timestamp = await this.timestampOf(event, signal)
    // The awaits above can outlive a stop; never write once the pass is stopped.
    if (signal?.aborted) return undefined
    filed.add(hash)
    const row = scannedRow({
      action,
      txHash: event.txHash,
      from: action === "receive" ? counterparty : ctx.accountTag,
      senderL2Address: event.from,
      to: action === "receive" ? ctx.accountTag : counterparty,
      token: buildTokenInTxService({ ...this.opts.token, rawAmount: event.amount }),
      timestamp,
      memo: event.memo,
      blockNumber: event.blockNumber,
      requestId: event.requestId,
      amountAtomic: BigInt(event.amount),
      networkId: ctx.networkId,
    })
    return async (w) => {
      const { tx, inserted } = await store.record(row, {}, w)
      if (!inserted) return undefined
      logger.log(`${LOG_PREFIX} ${action} ${event.txHash} ${counterparty}`)
      return tx
    }
  }

  /**
   * PXE decrypted this block, so the node has it; a missing header is transient. The row's date is
   * permanent (the store dedups by hash), so defer and retry rather than stamp the clock.
   */
  private async timestampOf(
    event: ScannedTransferEvent,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const timestamp = await this.bounded(
      this.opts.source.blockTimestampMs(event.blockNumber),
      "blockTimestampMs",
      signal,
    )
    if (timestamp === undefined)
      throw new WalletError("scan.incomplete", `block ${event.blockNumber} time unavailable`)
    return timestamp
  }

  /**
   * Display attribution: a saved contact's tag wins; else the claimed tag, only when the registry
   * resolves it to the on-chain sender (then auto-added as a contact); else the raw address.
   * A resolver transport failure throws so the caller defers — unless `degraded`, which skips the
   * registry entirely and settles for the raw address after repeated deferrals.
   */
  private async attributeSender(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
    degraded: boolean,
  ): Promise<string> {
    const contact = await bestEffort("unknown", this.opts.contacts.findByL2Address(event.from))
    if (contact?.tag) return contact.tag
    if (!event.senderTag || degraded) return event.from
    const adopted = await this.adoptTag(event.senderTag, event.from, ctx)
    return adopted ? event.senderTag : event.from
  }

  /**
   * The sender's mirror of `attributeSender`: the recipient tag it wrote into its own event copy
   * becomes a contact once the registry resolves it to the on-chain `to`. The row keeps the raw
   * address either way; contact history resolves the display name from it.
   */
  private async adoptRecipient(
    event: ScannedTransferEvent,
    ctx: TransferScanContext,
    degraded: boolean,
  ): Promise<void> {
    if (!event.recipientTag || degraded) return
    const contact = await bestEffort("unknown", this.opts.contacts.findByL2Address(event.to))
    if (contact?.tag) return
    await this.adoptTag(event.recipientTag, event.to, ctx)
  }

  /** Registers `tag` as a contact when the registry resolves it to `l2Address`; throws on transport failure. */
  private async adoptTag(
    tag: string,
    l2Address: string,
    ctx: TransferScanContext,
  ): Promise<boolean> {
    const resolved = await this.opts.tags.resolveL2(tag, ctx.networkId)
    if (!resolved || resolved.l2Address.toLowerCase() !== l2Address.toLowerCase()) {
      logger.warn(`${LOG_PREFIX} tag "${tag}" does not resolve to ${l2Address}; using address`)
      return false
    }
    await this.opts.contacts
      .registerL2?.({ tag, l2Address })
      .catch((err) => logger.warn(`${LOG_PREFIX} contact auto-add failed:`, err))
    return true
  }

  private loadCursor(ctx: TransferScanContext): Promise<number | undefined> {
    return loadBlock(this.opts.db, cursorKey(ctx))
  }

  /** A rewind covers no rows, so it saves alone. */
  private saveCursor(ctx: TransferScanContext, block: number): Promise<void> {
    return this.opts.db.write(async (w) => w.put(cursorKey(ctx), String(block)))
  }
}

/** One row's write in a chunk's transaction; the row when it was filed. */
type Filing = (w: Write) => Promise<Transaction | undefined>

/** The row a scanned transfer files. */
export function scannedRow(input: NewIncomingTokenTx): OnNetwork<TokenTransaction> {
  return {
    id: input.txHash.toLowerCase(),
    action: input.action === "send" ? TokenActionEnum.SEND : TokenActionEnum.RECEIVE,
    token: input.token,
    amountAtomic: input.amountAtomic,
    timestamp: input.timestamp,
    status: "success",
    txHash: input.txHash,
    from: input.from,
    to: input.to,
    senderL2Address: input.senderL2Address,
    memo: input.memo,
    networkId: input.networkId,
    blockNumber: input.blockNumber,
    requestId: input.requestId,
  }
}

/** The claim or refund row a paylink escrow's payout to this account files. */
export function payoutRow(input: NewPaylinkPayoutTx): OnNetwork<PaylinkTransaction> {
  return {
    ...input,
    id: input.txHash.toLowerCase(),
    emailPaymentAction: input.action,
    status: "success",
  }
}

/** Row token for a verified receive; the display amount follows the send path's `Number` model. */
export function buildTokenInTxService(args: {
  address: string
  symbol: string | undefined
  decimals: number
  rawAmount: string
}): TokenInTxService {
  const symbol = args.symbol?.trim() || "?"
  return {
    address: args.address,
    name: symbol,
    symbol,
    decimals: args.decimals,
    logo: "",
    amount: rawToDisplay(args.rawAmount, args.decimals),
    price: 0,
  }
}

function rawToDisplay(rawAmount: string, decimals: number): number {
  let raw: bigint
  try {
    raw = BigInt(rawAmount)
  } catch {
    return 0
  }
  if (decimals <= 0) return Number(raw)
  const divisor = 10n ** BigInt(decimals)
  return Number(raw / divisor) + Number(raw % divisor) / Number(divisor)
}
