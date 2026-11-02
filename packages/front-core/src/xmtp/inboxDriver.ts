/**
 * XmtpInboxReceiverDriver — foreground-only polling loop that walks all
 * consented XMTP conversations every 5s and dispatches payment-request and
 * connect-back messages to their receivers. (Incoming transfers are
 * chain-native — `TransferEventScanner` — and never ride XMTP.)
 *
 * Why this exists: per-conversation chat hooks only process the
 * currently-open DM. This driver runs independently of any tab / hook so
 * lifecycle messages land for every consented conversation, on a single 5s
 * cadence, while the app is foregrounded.
 *
 * Lifecycle is owned by the platform wiring:
 *   - `start()` after PXE + XMTP are both ready (idempotent)
 *   - `stop()` when the app leaves the foreground
 *   - `start()` on return to foreground
 *
 * Streaming: a stream fast-path plus a tiered backstop. The driver consumes
 * the client port's `subscribeAllMessages` / `syncAllConversations`
 * primitives; the per-conversation cursor + connect-back budget below stay
 * authoritative — the stream is only a "this conversation changed" signal,
 * never a trusted content source.
 *
 * Correctness invariants:
 *   - Cursor map is bound to the live xmtpInstallationId. On mismatch
 *     (backup-restore rotates the installation), all per-conversation
 *     cursors reset; the in-lock txHash idempotency at the store layer
 *     defends against duplicate rows on the reprocess.
 *   - Cursor advances on accepted | rejected | duplicate. On deferred
 *     (or a per-message throw), the cursor stays unmoved and the
 *     message is re-presented on the next cycle.
 *   - Cursor math is bigint (ns timestamps exceed 2^53); persisted values
 *     stay JSON numbers when losslessly representable, decimal strings
 *     otherwise.
 *   - Connect-back budget is global per pollOnce (10); when exhausted,
 *     the next cycle resumes from `resumeConversationId` so under
 *     sustained backlog every conversation is eventually visited.
 *   - All persistence happens in one storage write at end of cycle.
 *     A mid-cycle crash drops the in-memory advances; reprocessed rows
 *     hit the store-layer idempotency.
 */

import type { AztecPaymentRequestContent } from "@obsidion/sdk"

import type { IStorageAdapter } from "../core/storages/adapter"
import type { ConnectBackStatus } from "./ConnectBackReceiver"
import type { RequestReceiveStatus } from "./requestReceiverTypes"
import type { InboxConversation, InboxMessage, XmtpClientManagerLike } from "./types"

/**
 * Structural surface the driver consumes from `ConnectBackReceiver`. A
 * tiny structural type keeps tests trivial — a hand-rolled fake satisfies it
 * and the real receiver does too because the method signature matches.
 */
export interface ConnectBackReceiverLike {
  process(input: {
    uuid: string
    senderXmtpAddresses: string[]
    ownXmtpAddress?: string | null
    claimedTag?: string | null
  }): Promise<ConnectBackStatus>
}

/**
 * Structural surface the driver consumes from `RequestReceiver`. Same reasoning
 * as `ConnectBackReceiverLike` — a hand-rolled fake satisfies it and the real
 * receiver does too because the method signature matches.
 */
export interface RequestReceiverLike {
  process(input: {
    content: AztecPaymentRequestContent
    senderXmtpAddresses: string[]
  }): Promise<RequestReceiveStatus>
}

const POLL_INTERVAL_MS = 5_000
// Per-cycle cap for connect-back handshakes (shared with payment-requests,
// see PAYMENT_REQUEST_TYPE_ID below). Connect-backs are cheap (a local lookup
// + at most one registry read + one connect delete) and rare, so a small cap
// is plenty.
const CONNECT_BACK_BUDGET_PER_CYCLE = 10
const CURSOR_STORAGE_KEY = "@obsidion/xmtp-inbox-driver/cursors/v1"

// Stream-driven dirty drain. Coalesce a burst of markDirty() calls into
// one drain, and cap how many conversations a single drain syncs so an attacker
// minting many conversations can't drive unbounded sync work — the overflow
// stays dirty for the next drain.
const DRAIN_DEBOUNCE_MS = 250
const MAX_DIRTY_DRAIN_BATCH = 20

// The full network sweep (the unconditional correctness net) runs rarely — the
// cheap ~5s probe handles the common case. This cadence bounds how long a message
// the probe's unread-discovery misses can wait, so it is a correctness knob.
const FULL_SWEEP_INTERVAL_MS = 2 * 60_000

// Stream reconnect (the SDKs have no auto-reconnect). Bounded exponential
// backoff; correctness is independent of reconnect — the probe + full sweep
// back it.
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

// Watchdog: if a consumer's inner work (network RPC / PXE proof) hangs, the
// single-consumer `running` guard must not stay true forever and silently stop
// ALL ingestion. The deadline sits well above any legitimate full-drain time, so
// only a true hang trips it; on trip the guard is released and the next tick runs.
const CONSUMER_DEADLINE_MS = 5 * 60_000

// Hardcoded to match the string the XMTP SDKs put on the decoded message's
// content-type id. Bumping the codec version requires updating this string
// everywhere it is matched.
// Connect-back handshake content type. Mirrors the codec id
// `ConnectBackContentTypeId` from `@obsidion/sdk`.
const CONNECT_BACK_TYPE_ID = "obsidion.xyz/connect-back:1.0"
// Payment-request content type. Mirrors `AztecPaymentRequestContentTypeId` from
// `@obsidion/sdk`; hardcoded here for the same reason as the id above.
// Payment-request messages are cheap (a local storage write, no PXE call), so
// they share the connect-back per-cycle budget.
const PAYMENT_REQUEST_TYPE_ID = "obsidion.xyz/payment-request:1.0"

export interface CurrentAccountInfo {
  tag: string
  l2Address: string
  rollupId: string
}

interface DriverLogger {
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

interface CursorMap {
  installationId: string | null
  cursors: Record<string, bigint> // conversationId -> lastSentNs
  resumeConversationId?: string
}

// On-disk shape: cursor values are JSON numbers when losslessly representable,
// decimal strings otherwise.
interface PersistedCursorMap {
  installationId: string | null
  cursors: Record<string, number | string>
  resumeConversationId?: string
}

export interface XmtpInboxReceiverDriverOptions {
  xmtp: XmtpClientManagerLike
  /**
   * Sharer-side connect-back handler. Optional — when omitted, connect-back
   * messages are treated like any other unhandled content (cursor advances,
   * no processing).
   */
  connectBackReceiver?: ConnectBackReceiverLike
  /**
   * Payment-request handler. Optional — when omitted, payment-request messages
   * are treated like any other unhandled content (cursor advances, no
   * processing).
   */
  requestReceiver?: RequestReceiverLike
  /**
   * This device's own XMTP (Ethereum-format) address, used to ignore
   * self-sent connect-backs. Optional; the receiver degrades gracefully when
   * absent.
   */
  ownXmtpAddress?: string | null
  /**
   * Resolves the current Aztec account context (rollup scoping for the
   * request lane). Returns null when no account is available (locked /
   * mid-switch); the driver defers the cycle in that case.
   */
  currentAccount: () => Promise<CurrentAccountInfo | null>
  asyncStorage: IStorageAdapter
  /** Platform logger; defaults to `console`. */
  logger?: DriverLogger
  /** Override for tests; defaults to POLL_INTERVAL_MS. */
  pollIntervalMs?: number
  /** Override for tests; defaults to FULL_SWEEP_INTERVAL_MS (rare full sweep). */
  fullSweepIntervalMs?: number
  /** Override for tests; defaults to CONNECT_BACK_BUDGET_PER_CYCLE. */
  connectBackBudgetPerCycle?: number
  /**
   * Verbose per-cycle logging for development. When true, the driver
   * emits a structured trace of every cycle: current account, conversation
   * counts, consent filter outcomes, per-conversation message counts +
   * content type IDs, and per-message receiver results. Off in production.
   */
  debug?: boolean
}

export class XmtpInboxReceiverDriver {
  private static instance: XmtpInboxReceiverDriver | null = null

  /**
   * Process-wide singleton. The wiring constructs exactly once after PXE +
   * XMTP are ready. Subsequent calls return the existing instance — useful
   * for hot-reload scenarios where the layout effect may re-run.
   */
  static getOrCreate(opts: XmtpInboxReceiverDriverOptions): XmtpInboxReceiverDriver {
    if (!XmtpInboxReceiverDriver.instance) {
      XmtpInboxReceiverDriver.instance = new XmtpInboxReceiverDriver(opts)
    }
    return XmtpInboxReceiverDriver.instance
  }

  /** Test-only escape hatch. */
  static resetInstance(): void {
    XmtpInboxReceiverDriver.instance?.stop()
    XmtpInboxReceiverDriver.instance = null
  }

  private readonly pollIntervalMs: number
  private readonly fullSweepIntervalMs: number
  private readonly connectBackBudgetPerCycle: number
  private readonly debugEnabled: boolean
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private sweepIntervalHandle: ReturnType<typeof setInterval> | null = null
  // Single consumer guard: pollOnce (full sweep / probe tick) and drainDirty
  // (stream-driven) both run through `running`, so only one consumer at a time
  // writes the cursor map + liveConnectBackBudget. This is the load-bearing
  // concurrency invariant — a second unguarded entry point would race the cursor.
  private running = false
  private currentRun: Promise<void> | null = null
  private state: CursorMap = { installationId: null, cursors: {} }
  private loaded = false
  private historyReplayPending = false

  // ── Stream-driven dirty drain ──
  private readonly dirtyIds = new Set<string>()
  private drainDebounceHandle: ReturnType<typeof setTimeout> | null = null
  private pendingDrain = false
  // Connect-back budget shared across triggers, refilled at the top of each
  // full sweep / probe tick (NOT per call) so a stream drain and a sweep can't
  // each grab a fresh 10 and silently multiply the DoS bound.
  private liveConnectBackBudget: number

  // ── Stream fast-path ──
  private streamCancel: (() => void) | null = null
  private streamWanted = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly topicToId = new Map<string, string>()
  private streamStarting = false
  // Watchdog generation: each guarded consumer gets a fresh gen so a stale release
  // (watchdog vs finally, or a hung op resolving late) is a no-op.
  private consumerGen = 0
  private guardWatchdog: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: XmtpInboxReceiverDriverOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
    this.fullSweepIntervalMs = opts.fullSweepIntervalMs ?? FULL_SWEEP_INTERVAL_MS
    this.connectBackBudgetPerCycle = opts.connectBackBudgetPerCycle ?? CONNECT_BACK_BUDGET_PER_CYCLE
    this.debugEnabled = opts.debug ?? false
    this.liveConnectBackBudget = this.connectBackBudgetPerCycle
  }

  /**
   * Start the polling loop. Idempotent — calling on an already-started
   * driver is a no-op. Fires `pollOnce()` immediately so foreground
   * transitions feel responsive, then re-runs every `pollIntervalMs`.
   */
  async start(): Promise<void> {
    if (this.intervalHandle || this.sweepIntervalHandle) return
    await this.loadIfNeeded()
    // Initial full sweep on (re)start — cold start / foreground resume.
    void this.pollOnce()
    // ~5s tick: the cheap probe (syncAllConversations + a local-read sweep).
    this.intervalHandle = setInterval(() => {
      void this.probeOnce()
    }, this.pollIntervalMs)
    // Rare full network sweep — the unconditional correctness net.
    this.sweepIntervalHandle = setInterval(() => {
      void this.pollOnce()
    }, this.fullSweepIntervalMs)
  }

  /**
   * Stop the polling loop. An in-flight `pollOnce()` finishes its current
   * iteration and exits at the next await boundary.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    if (this.sweepIntervalHandle !== null) {
      clearInterval(this.sweepIntervalHandle)
      this.sweepIntervalHandle = null
    }
    if (this.drainDebounceHandle !== null) {
      clearTimeout(this.drainDebounceHandle)
      this.drainDebounceHandle = null
    }
    // Intentionally do NOT clear the consumer watchdog here: it belongs to the
    // in-flight consumer (begin/releaseConsumer), not the tick lifecycle. An
    // in-flight poll/drain when stop() lands (e.g. backgrounding mid-cycle)
    // winds down on its own and releases the guard; if it instead wedges, the
    // watchdog is the only thing that un-wedges it across a foreground return.
    this.stopStream()
    // Intentionally do NOT clear dirtyIds: keeping the marks is idempotent and
    // avoids dropping a late mark across a background/foreground cycle — the
    // drain re-reads authoritatively, and catch-up on restart re-marks anyway.
  }

  /**
   * Run one cycle. Public for tests; the timer calls it internally too.
   * Re-entrant calls coalesce into the in-flight cycle — a concurrent caller
   * gets back the running cycle's promise rather than starting a second one.
   */
  async pollOnce(): Promise<void> {
    if (this.running) return this.currentRun ?? undefined
    return this.startRun("pollOnce", async () => {
      this.liveConnectBackBudget = this.connectBackBudgetPerCycle // refill at the tick (shared across triggers)
      await this.runCycle()
    })
  }

  /**
   * Force a fresh full cycle on demand — pull-to-refresh / receive catch-up.
   * Unlike `pollOnce` (which coalesces into an already-running cycle), `pollNow`
   * first drains whatever cycle is in flight, THEN runs a guaranteed-fresh one:
   * the in-flight cycle may have snapshotted the conversation list before the
   * just-arrived message landed, so only a cycle that starts after the trigger
   * is guaranteed to see it.
   */
  async pollNow(): Promise<void> {
    if (this.currentRun) await this.currentRun.catch(() => {})
    await this.pollOnce()
  }

  /** Queue a replay after archive import; the next sweep resets cursors under its consumer guard. */
  requestHistoryReplay(): void {
    this.historyReplayPending = true
  }

  /**
   * Cheap stall-defense tick (the ~5s timer). One batched network sync of unread
   * conversations, then a local-read sweep (no per-conversation network sync) — so
   * steady-state network cost is O(1), not O(consented conversations). The rare
   * full `pollOnce` sweep remains the unconditional correctness net (the probe
   * only covers what `syncAllConversations` deems unread).
   */
  async probeOnce(): Promise<void> {
    if (this.running) return this.currentRun ?? undefined
    return this.startRun("probeOnce", async () => {
      this.liveConnectBackBudget = this.connectBackBudgetPerCycle // refill at the tick (shared across triggers)
      await this.runProbe()
    })
  }

  private async runProbe(): Promise<void> {
    if (!this.opts.xmtp.isReady()) return
    try {
      await this.opts.xmtp.syncAllConversations()
    } catch (err) {
      // Proceed to the local sweep anyway — it reads whatever is already local;
      // the next probe / full sweep retries the network sync.
      this.warn("syncAllConversations failed", err)
    }
    await this.runCycle(true)
  }

  /**
   * Mark a conversation as having (possibly) new messages. Called by the stream
   * fast-path. Coalesces a burst into one debounced drain; the drain re-reads
   * authoritatively via the cursor and verifies — the mark is only a "this
   * conversation changed" signal, never trusted content.
   */
  markDirty(conversationId: string): void {
    this.dirtyIds.add(conversationId)
    if (this.drainDebounceHandle === null) {
      this.drainDebounceHandle = setTimeout(() => {
        this.drainDebounceHandle = null
        this.requestDrain()
      }, DRAIN_DEBOUNCE_MS)
    }
  }

  /**
   * Acquire the single-consumer guard and arm a watchdog. Each consumer gets a
   * fresh generation so a stale release (watchdog vs finally, or a hung op
   * resolving late) is a no-op. Returns the gen to pass to releaseConsumer.
   */
  private beginConsumer(label: string): number {
    this.running = true
    const gen = ++this.consumerGen
    this.guardWatchdog = setTimeout(() => {
      this.warn(`${label} exceeded ${CONSUMER_DEADLINE_MS}ms — releasing guard`, {})
      this.releaseConsumer(gen)
    }, CONSUMER_DEADLINE_MS)
    return gen
  }

  /**
   * Release the single-consumer guard for `gen` (no-op if a newer consumer owns it
   * or it was already released) and, if a dirty drain was requested while a
   * consumer was running (trailing-edge coalescing), run it now.
   */
  private releaseConsumer(gen: number): void {
    if (this.consumerGen !== gen) return
    this.consumerGen++ // consume this gen so a second release (watchdog vs finally) no-ops
    if (this.guardWatchdog !== null) {
      clearTimeout(this.guardWatchdog)
      this.guardWatchdog = null
    }
    this.running = false
    if (this.pendingDrain) {
      this.pendingDrain = false
      void this.drainDirty()
    }
  }

  /**
   * Acquire the single-consumer guard, run `body`, and publish the in-flight
   * promise as `currentRun` so `pollNow` can await whatever is running before it
   * forces a fresh cycle. The guard + watchdog live in begin/releaseConsumer;
   * this wrapper adds the awaitable handle and uniform error logging. Callers
   * must check `this.running` first — it assumes the guard is free.
   */
  private startRun(label: string, body: () => Promise<void>): Promise<void> {
    const gen = this.beginConsumer(label)
    const run = (async () => {
      try {
        await body()
      } catch (err) {
        this.warn(`${label} threw`, err)
      } finally {
        // Clear currentRun BEFORE releasing: releaseConsumer may synchronously
        // start a trailing drainDirty that publishes its own currentRun, and
        // clearing after would clobber that handle.
        this.currentRun = null
        this.releaseConsumer(gen)
      }
    })()
    this.currentRun = run
    return run
  }

  /**
   * Debounced entry from markDirty. If a consumer (pollOnce or another
   * drainDirty) is mid-flight, defer via the trailing-edge flag; else run.
   */
  private requestDrain(): void {
    if (this.running) {
      this.pendingDrain = true
      return
    }
    void this.drainDirty()
  }

  private async drainDirty(): Promise<void> {
    if (this.running) {
      this.pendingDrain = true
      return
    }
    await this.startRun("drainDirty", () => this.runDirtyCycle())
  }

  // ── Stream fast-path ─────────────────────────────────────────────────────

  /**
   * Subscribe to the message stream and route each delivered message to
   * markDirty. The stream is a signal — only `msg.topic` is read; the drain
   * re-reads + verifies authoritatively. Idempotent. The driver owns the
   * subscription so the topic->id map and reconnect state sit with the dirty-set
   * state they feed; the platform wiring just calls start/stopStream on
   * foreground transitions.
   */
  async startStream(): Promise<void> {
    this.streamWanted = true
    // `streamStarting` guards the await window: subscribeAllMessages is async, so
    // two overlapping starts (e.g. a foreground transition racing the reconnect
    // timer) could otherwise open two subscriptions and leak the first.
    if (this.streamCancel || this.streamStarting) return
    if (!this.opts.xmtp.isReady()) return
    this.streamStarting = true
    try {
      await this.refreshTopicMap()
      const cancel = await this.opts.xmtp.subscribeAllMessages(
        (msg) => void this.onStreamMessage(msg),
        () => this.onStreamClose(),
      )
      // stop()/stopStream() may have fired while we awaited; honour the latest
      // intent rather than installing a subscription nobody wants.
      if (!this.streamWanted) {
        try {
          cancel()
        } catch (err) {
          this.warn("stream cancel threw", err)
        }
        return
      }
      this.streamCancel = cancel
      this.reconnectAttempts = 0
    } catch (err) {
      this.warn("subscribeAllMessages failed", err)
      this.scheduleReconnect()
    } finally {
      this.streamStarting = false
    }
  }

  /** Cancel the stream and stop reconnecting (background / teardown). */
  stopStream(): void {
    this.streamWanted = false
    // Reset backoff so the next start() (foreground return) reconnects from the
    // base delay instead of inheriting a stale exponent from an earlier session.
    this.reconnectAttempts = 0
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.streamCancel) {
      try {
        this.streamCancel()
      } catch (err) {
        this.warn("stream cancel threw", err)
      }
      this.streamCancel = null
    }
  }

  private async onStreamMessage(msg: InboxMessage): Promise<void> {
    const topic = msg.topic
    if (!topic) return
    let id = this.topicToId.get(topic)
    if (!id) {
      // Brand-new conversation: refresh the map from the list and retry once.
      await this.refreshTopicMap()
      id = this.topicToId.get(topic)
    }
    // An unresolved topic is dropped — the probe / full sweep picks it up.
    if (id) this.markDirty(id)
  }

  private onStreamClose(): void {
    // Streams don't auto-reconnect. Re-arm with bounded backoff if still
    // wanted; correctness is independent (probe + sweep back it).
    this.streamCancel = null
    if (this.streamWanted) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.streamWanted || this.reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.startStream()
    }, delay)
  }

  /**
   * Rebuild the topic->id map from the conversation list (each conversation
   * carries `.topic` and `.id`). The stream delivers `msg.topic`; the cursor map
   * is keyed by `conversation.id`.
   */
  private async refreshTopicMap(): Promise<void> {
    let convs: InboxConversation[]
    try {
      convs = await this.opts.xmtp.listConversations()
    } catch (err) {
      this.warn("refreshTopicMap listConversations failed", err)
      return
    }
    this.topicToId.clear()
    for (const c of convs) {
      if (c.topic) this.topicToId.set(c.topic, c.id)
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async runCycle(local = false): Promise<void> {
    await this.loadIfNeeded()

    const currentAccount = await this.opts.currentAccount()
    if (!currentAccount) {
      this.debug("cycle skipped — currentAccount returned null")
      return
    }

    if (!this.opts.xmtp.isReady()) {
      this.debug("cycle skipped — xmtp not ready")
      return
    }

    // installationId mismatch resets all cursors. Bound to the live
    // client so a backup-restore (new installationId, same inboxId)
    // triggers a reset rather than silently skipping unread messages.
    const liveInstallationId = this.opts.xmtp.installationId
    if (liveInstallationId && this.state.installationId !== liveInstallationId) {
      this.debug("installationId mismatch — resetting cursor map", {
        was: this.state.installationId,
        now: liveInstallationId,
      })
      this.state = {
        installationId: liveInstallationId,
        cursors: {},
      }
    }

    if (this.historyReplayPending) {
      this.historyReplayPending = false
      this.state.cursors = {}
      this.state.resumeConversationId = undefined
    }

    this.debug("cycle start", {
      tag: currentAccount.tag,
      l2Address: shortenId(currentAccount.l2Address),
      installationId: shortenId(liveInstallationId),
    })

    // Enumerate consented conversations. listConversations doesn't return
    // consent state inline — it's a per-conversation async call. Treat throw
    // as "unknown" to keep the conversation eligible.
    let allConversations: InboxConversation[]
    try {
      allConversations = await this.opts.xmtp.listConversations()
    } catch (err) {
      this.warn("listConversations threw", err)
      return
    }
    this.debug("listConversations", { total: allConversations.length })

    const { consented, deniedCount } = await this.filterConsentedDebug(allConversations)
    this.debug("filterConsented", {
      eligible: consented.length,
      denied: deniedCount,
    })
    if (consented.length === 0) {
      await this.persist()
      return
    }

    // Round-robin checkpoint: start from `resumeConversationId` if any,
    // wrap around. If the saved id no longer matches a consented
    // conversation, start from the beginning.
    const startIdx = this.findResumeIndex(consented)
    const ordered: InboxConversation[] = [
      ...consented.slice(startIdx),
      ...consented.slice(0, startIdx),
    ]

    // The connect-back budget was refilled at the consumer tick (pollOnce /
    // probeOnce); the sweep and any stream drains between ticks consume from
    // the same counter.
    const { exhaustedConvId } = await this.drainConversations(ordered, local)

    this.state.resumeConversationId = exhaustedConvId
    await this.persist()
    this.debug("cycle end", {
      resumeConversationId: exhaustedConvId ?? null,
    })
  }

  /**
   * Drain an already-ordered list of conversations under the shared
   * connect-back budget. Extracted from runCycle so the full sweep, the
   * stream-driven dirty drain, and the probe share one budget-aware,
   * cursor-aware loop. Does NOT touch `resumeConversationId` — that
   * round-robin checkpoint belongs to the full sweep and stays in runCycle.
   *
   * Returns, when the budget was exhausted partway through a conversation,
   * that conversation's id (so the full sweep can set its round-robin resume
   * point).
   */
  private async drainConversations(
    conversations: InboxConversation[],
    local = false,
  ): Promise<{ exhaustedConvId?: string }> {
    let exhaustedConvId: string | undefined
    for (const conv of conversations) {
      // We don't pre-bail on a zero connect-back budget. processConversation
      // handles it and only marks exhaustedMidConversation when it actually
      // had a connect-back / payment-request message it couldn't process — a
      // conversation with no such messages costs 0 budget and shouldn't push
      // the checkpoint forward.
      const result = await this.processConversation(conv, this.liveConnectBackBudget, local)
      this.liveConnectBackBudget = result.connectBackBudgetRemaining
      if (result.exhaustedMidConversation) {
        exhaustedConvId = conv.id
        break
      }
    }
    return { exhaustedConvId }
  }

  /**
   * Drain the dirty set: resolve ids -> live conversations, re-check consent
   * (allowed before unknown), cap the batch, and run the shared drain loop under
   * the shared budget. New marks that arrive mid-drain re-accumulate and are
   * picked up by the trailing-edge re-run.
   */
  private async runDirtyCycle(): Promise<void> {
    await this.loadIfNeeded()
    const currentAccount = await this.opts.currentAccount()
    if (!currentAccount) return
    if (!this.opts.xmtp.isReady()) return

    // Snapshot + CAP, then clear. Cap the snapshot (not just the drain) so an
    // unknown-consent conversation flood can't drive O(N) findConversation /
    // consentState work per drain — overflow ids are re-queued and drained on a
    // later tick. Marks arriving during the drain re-accumulate and are caught by
    // the trailing-edge re-run.
    const allIds = [...this.dirtyIds]
    this.dirtyIds.clear()
    if (allIds.length === 0) return
    const ids = allIds.slice(0, MAX_DIRTY_DRAIN_BATCH)
    for (const id of allIds.slice(MAX_DIRTY_DRAIN_BATCH)) this.dirtyIds.add(id)

    const resolved: InboxConversation[] = []
    for (const id of ids) {
      let conv: InboxConversation | undefined
      try {
        conv = await this.opts.xmtp.findConversation(id)
      } catch (err) {
        this.warn("findConversation failed", { id, err })
        continue
      }
      // An unresolvable id (conversation not in the local DB yet) is dropped;
      // the probe / full sweep picks it up once listConversations sees it.
      if (conv) resolved.push(conv)
    }
    if (resolved.length === 0) return

    // Already capped at the snapshot — consent-order (allowed before unknown), drain.
    const batch = await this.consentOrdered(resolved)
    if (batch.length === 0) return

    const { exhaustedConvId } = await this.drainConversations(batch)

    if (exhaustedConvId) {
      // Budget ran out partway: re-queue the exhausted conversation + the rest of
      // this batch. Don't trigger an immediate re-drain (it would busy-loop on a
      // zero budget) — the next sweep / probe tick refreshes the budget.
      const idx = batch.findIndex((c) => c.id === exhaustedConvId)
      if (idx >= 0) for (const conv of batch.slice(idx)) this.dirtyIds.add(conv.id)
    } else if (this.dirtyIds.size > 0 && this.liveConnectBackBudget > 0) {
      // Overflow / new marks remain and budget is left — keep draining.
      this.pendingDrain = true
    }

    await this.persist()
  }

  /**
   * Re-check consent at drain time and order allowed-consent conversations before
   * unknown-consent ones, so an unknown-consent flood can't starve allowed
   * senders for the shared budget. Denied are dropped; a missing/throwing
   * consentState() is treated as unknown (eligible, low priority).
   */
  private async consentOrdered(conversations: InboxConversation[]): Promise<InboxConversation[]> {
    const allowed: InboxConversation[] = []
    const unknown: InboxConversation[] = []
    for (const c of conversations) {
      if (typeof c.consentState !== "function") {
        unknown.push(c)
        continue
      }
      try {
        const state = await c.consentState()
        if (state === "denied") continue
        if (state === "allowed") allowed.push(c)
        else unknown.push(c)
      } catch {
        unknown.push(c)
      }
    }
    return [...allowed, ...unknown]
  }

  /**
   * Full-sweep consent filter: drop denied conversations, keep allowed +
   * unknown, and return a denied count for debug logs. The dirty drain uses
   * `consentOrdered` instead (same eligibility rule, but it also priority-orders
   * allowed before unknown for the shared budget).
   */
  private async filterConsentedDebug(
    conversations: InboxConversation[],
  ): Promise<{ consented: InboxConversation[]; deniedCount: number }> {
    const consented: InboxConversation[] = []
    let deniedCount = 0
    for (const c of conversations) {
      if (typeof c.consentState !== "function") {
        // SDK lacks the call — include defensively (matches the inbox UI's
        // fallback for a missing consent surface).
        consented.push(c)
        continue
      }
      try {
        const state = await c.consentState()
        if (state === "denied") {
          deniedCount += 1
        } else {
          consented.push(c)
        }
      } catch {
        // Treat throw as unknown — eligible.
        consented.push(c)
      }
    }
    return { consented, deniedCount }
  }

  private findResumeIndex(consented: InboxConversation[]): number {
    if (!this.state.resumeConversationId) return 0
    const idx = consented.findIndex((c) => c.id === this.state.resumeConversationId)
    return idx >= 0 ? idx : 0
  }

  /**
   * Process one conversation's messages newer than its cursor, dispatching
   * payment-request and connect-back content to their receivers under the
   * shared connect-back budget. Unrecognized or legacy content (text,
   * reactions, legacy transfer DMs) advances the cursor immediately as
   * skipped — no receiver call, no budget spent.
   */
  private async processConversation(
    conv: InboxConversation,
    connectBackBudget: number,
    local = false,
  ): Promise<{
    connectBackBudgetRemaining: number
    exhaustedMidConversation: boolean
  }> {
    const convId = conv.id
    const cursor = this.state.cursors[convId] ?? 0n

    let messages: InboxMessage[]
    try {
      // The probe reads locally (syncAllConversations already pulled the network
      // state); the full sweep does a per-conversation network sync.
      messages = local
        ? await this.opts.xmtp.messagesAfterLocal(conv, cursor)
        : await this.opts.xmtp.messagesAfter(conv, cursor)
    } catch (err) {
      this.warn("messagesAfter failed", { convId, err })
      return {
        connectBackBudgetRemaining: connectBackBudget,
        exhaustedMidConversation: false,
      }
    }

    // Defensive sort by (sentNs, id) — the SDK should return ascending
    // order, but we don't rely on it. Ties on sentNs are deduped via the
    // in-cycle just-seen set keyed by (sentNs, id).
    messages.sort((a, b) => {
      const an = toNs(a.sentNs)
      const bn = toNs(b.sentNs)
      if (an !== bn) return an < bn ? -1 : 1
      return a.id.localeCompare(b.id)
    })

    this.debug("conv messages", {
      convId: shortenId(convId),
      cursorBefore: cursor,
      messages: messages.length,
      contentTypeIds: messages.map((m) => m.contentTypeId),
    })

    const seen = new Set<string>()
    let advancedTo = cursor
    let connectBackBudgetRemaining = connectBackBudget

    for (const msg of messages) {
      const sentNs = toNs(msg.sentNs)
      const dedupKey = `${sentNs}:${msg.id}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      // Connect-back handshake (sharer side). Dispatched before the generic
      // skip-and-advance fallback so a connect-back is never silently skipped.
      if (msg.contentTypeId === CONNECT_BACK_TYPE_ID) {
        if (!this.opts.connectBackReceiver) {
          this.info("connect-back received but no receiver is wired", {
            convId: shortenId(convId),
            msgId: shortenId(msg.id),
            sentNs: msg.sentNs,
          })
          // No handler wired — treat like any other unhandled content:
          // advance the cursor and move on (no re-loop).
          advancedTo = sentNs
          continue
        }

        if (connectBackBudgetRemaining === 0) {
          // Connect-back budget exhausted; hold the line at the last
          // successfully-processed message and resume next cycle.
          this.state.cursors[convId] = advancedTo
          return {
            connectBackBudgetRemaining: 0,
            exhaustedMidConversation: true,
          }
        }

        let uuid: string
        let claimedTag: string | undefined
        try {
          const content = msg.content() as { uuid?: unknown; tag?: unknown }
          if (typeof content?.uuid !== "string" || content.uuid.length === 0) {
            // Malformed / un-decodable connect-back — skip it (advance).
            this.warn("malformed connect-back skipped", {
              convId: shortenId(convId),
              msgId: shortenId(msg.id),
              content,
            })
            advancedTo = sentNs
            continue
          }
          uuid = content.uuid
          if (typeof content.tag === "string" && content.tag.length > 0) {
            claimedTag = content.tag
          }
        } catch (err) {
          this.warn("decoding connect-back failed", { convId, msgId: msg.id, err })
          advancedTo = sentNs
          continue
        }

        // Resolve the authenticated sender. Empty when unresolvable — the receiver
        // treats that as a terminal no-add.
        let senderXmtpAddresses: string[]
        try {
          senderXmtpAddresses = await this.opts.xmtp.getDmPeerAddresses(conv)
        } catch (err) {
          this.warn("getDmPeerAddresses threw for connect-back", { convId, msgId: msg.id, err })
          senderXmtpAddresses = []
        }

        this.info("connect-back received", {
          convId: shortenId(convId),
          msgId: shortenId(msg.id),
          uuid,
          senderXmtpAddresses,
          ownXmtpAddress: this.opts.ownXmtpAddress ?? null,
        })

        connectBackBudgetRemaining -= 1

        let cbResult: ConnectBackStatus
        try {
          cbResult = await this.opts.connectBackReceiver.process({
            uuid,
            senderXmtpAddresses,
            ownXmtpAddress: this.opts.ownXmtpAddress ?? null,
            claimedTag,
          })
        } catch (err) {
          // The receiver is designed never to throw; a throw here is treated
          // as deferred — hold the cursor and re-present next cycle.
          this.warn("connectBackReceiver.process threw", { convId, msgId: msg.id, err })
          this.state.cursors[convId] = advancedTo
          return { connectBackBudgetRemaining, exhaustedMidConversation: false }
        }

        this.debug("connect-back result", {
          convId: shortenId(convId),
          msgId: shortenId(msg.id),
          status: cbResult.status,
        })
        this.info("connect-back processed", {
          convId: shortenId(convId),
          msgId: shortenId(msg.id),
          uuid,
          senderXmtpAddresses,
          result: cbResult,
        })

        if (cbResult.status === "deferred") {
          // Hold the line — re-present this connect-back next cycle.
          this.state.cursors[convId] = advancedTo
          return { connectBackBudgetRemaining, exhaustedMidConversation: false }
        }

        // accepted (terminal) — advance.
        advancedTo = sentNs
        continue
      }

      // Payment request (announce / fulfilled / declined). Shares the
      // connect-back per-cycle budget — processing is a local storage write,
      // never a PXE call.
      if (msg.contentTypeId === PAYMENT_REQUEST_TYPE_ID) {
        if (!this.opts.requestReceiver) {
          this.info("payment-request received but no receiver is wired", {
            convId: shortenId(convId),
            msgId: shortenId(msg.id),
          })
          advancedTo = sentNs
          continue
        }

        if (connectBackBudgetRemaining === 0) {
          this.state.cursors[convId] = advancedTo
          return {
            connectBackBudgetRemaining: 0,
            exhaustedMidConversation: true,
          }
        }

        let requestContent: AztecPaymentRequestContent
        try {
          requestContent = msg.content() as AztecPaymentRequestContent
        } catch (err) {
          this.warn("decoding payment-request failed", { convId, msgId: msg.id, err })
          advancedTo = sentNs
          continue
        }
        // The XMTP SDK swallows codec schema errors and returns undefined content
        // (e.g. a message kind the current schema no longer accepts). Skip, don't wedge.
        if (!requestContent?.kind) {
          this.warn("undecodable payment-request content; skipping", { convId, msgId: msg.id })
          advancedTo = sentNs
          continue
        }

        connectBackBudgetRemaining -= 1

        // Authenticated sender for the receiver's tag check; empty when unresolvable
        // (the receiver then skips the message rather than trusting its content).
        let requestSenders: string[]
        try {
          requestSenders = await this.opts.xmtp.getDmPeerAddresses(conv)
        } catch (err) {
          this.warn("getDmPeerAddresses threw for payment-request", { convId, msgId: msg.id, err })
          requestSenders = []
        }

        let requestResult: RequestReceiveStatus
        try {
          requestResult = await this.opts.requestReceiver.process({
            content: requestContent,
            senderXmtpAddresses: requestSenders,
          })
        } catch (err) {
          // The receiver never throws; a throw is treated as deferred — hold
          // the cursor and re-present next cycle.
          this.warn("requestReceiver.process threw", { convId, msgId: msg.id, err })
          this.state.cursors[convId] = advancedTo
          return { connectBackBudgetRemaining, exhaustedMidConversation: false }
        }

        this.debug("payment-request result", {
          convId: shortenId(convId),
          msgId: shortenId(msg.id),
          status: requestResult.status,
        })

        if (requestResult.status === "deferred") {
          this.state.cursors[convId] = advancedTo
          return { connectBackBudgetRemaining, exhaustedMidConversation: false }
        }

        // accepted | duplicate | ignored: terminal for this message; advance.
        advancedTo = sentNs
        continue
      }

      // Any other content (text, reaction, legacy transfer DMs) — advance
      // cursor and skip. No budget consumed.
      advancedTo = sentNs
    }

    this.state.cursors[convId] = advancedTo
    this.debug("conv done", {
      convId: shortenId(convId),
      cursorAfter: advancedTo,
      connectBackBudgetRemaining,
    })
    return { connectBackBudgetRemaining, exhaustedMidConversation: false }
  }

  private async loadIfNeeded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const json = await this.opts.asyncStorage.getItem(CURSOR_STORAGE_KEY)
      if (!json) return
      const parsed = JSON.parse(json) as PersistedCursorMap
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.cursors &&
        typeof parsed.cursors === "object"
      ) {
        const cursors: Record<string, bigint> = {}
        for (const [id, v] of Object.entries(parsed.cursors)) {
          try {
            cursors[id] = BigInt(v)
          } catch {
            // Unparseable cursor — drop it; the conversation reprocesses and
            // the store-layer idempotency absorbs duplicates.
          }
        }
        this.state = {
          installationId: parsed.installationId ?? null,
          cursors,
          resumeConversationId: parsed.resumeConversationId,
        }
      }
    } catch (err) {
      this.warn("loading cursor map failed", err)
    }
  }

  private async persist(): Promise<void> {
    try {
      const cursors: Record<string, number | string> = {}
      for (const [id, v] of Object.entries(this.state.cursors)) {
        cursors[id] = serializeNs(v)
      }
      const persisted: PersistedCursorMap = {
        installationId: this.state.installationId,
        cursors,
        resumeConversationId: this.state.resumeConversationId,
      }
      await this.opts.asyncStorage.setItem(CURSOR_STORAGE_KEY, JSON.stringify(persisted))
    } catch (err) {
      this.warn("persisting cursor map failed", err)
    }
  }

  private warn(...args: unknown[]): void {
    ;(this.opts.logger ?? console).warn("[XmtpInboxReceiverDriver]", ...args)
  }

  private info(...args: unknown[]): void {
    ;(this.opts.logger ?? console).log("[XmtpInboxReceiverDriver]", ...args)
  }

  /** No-op when `opts.debug` is false. */
  private debug(...args: unknown[]): void {
    if (!this.debugEnabled) return
    ;(this.opts.logger ?? console).log("[XmtpInboxReceiverDriver]", ...args)
  }
}

function toNs(v: number | bigint): bigint {
  return typeof v === "bigint" ? v : BigInt(v)
}

/** Persist a cursor as a JSON number when lossless, else as a decimal string. */
function serializeNs(v: bigint): number | string {
  const n = Number(v)
  return Number.isFinite(n) && BigInt(n) === v ? n : v.toString()
}

/** First 8 chars of a hex/id-like string + "…" — keeps debug logs compact. */
function shortenId(id: string | null | undefined): string | null {
  if (!id) return null
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
