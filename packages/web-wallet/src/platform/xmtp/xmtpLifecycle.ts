/**
 * One visible tab owns the XMTP client. The browser-sdk's OPFS VFS supports a single
 * connection, so the client is constructed only while holding the `xmtp-client` Web Lock AND
 * visible. The leader closes the client and releases on hide; a visible non-leader keeps a pending
 * lock request and auto-promotes when the leader releases. A hidden non-leader withdraws its
 * request so a background tab can never be promoted. A failed or timed-out client construction
 * surfaces as "error" and retries on the next visibility transition; "unsupported" is reserved for
 * the capability probe (browser genuinely can't run the client).
 */

import { RequestBroadcaster, type ErrorCode, type IXmtpSender } from "@obsidion/front-core"
import words from "../../errors/catalog.copy"
import { createExternalState } from "../../lib/externalState"
import type { WebXmtpClient } from "./WebXmtpClient"

export type XmtpUiState = "off" | "leader" | "another-tab" | "unsupported" | "error"

/** The code per unusable messaging state. The banner renders its copy; send paths throw it. */
const STATE_CODE = {
  "another-tab": "messaging.anotherTab",
  "unsupported": "messaging.unsupported",
  "error": "messaging.failed",
} as const satisfies Partial<Record<XmtpUiState, ErrorCode>>

export const XMTP_STATE_COPY: Partial<Record<XmtpUiState, string>> = {
  "another-tab": words[STATE_CODE["another-tab"]],
  "unsupported": words[STATE_CODE.unsupported],
  "error": words[STATE_CODE.error],
}

export function xmtpUnavailableCode(state: XmtpUiState): ErrorCode {
  return (STATE_CODE as Partial<Record<XmtpUiState, ErrorCode>>)[state] ?? "messaging.starting"
}

const XMTP_LOCK_NAME = "xmtp-client"

/** Bound on leader client construction; on expiry the tab lands on "error" and frees the lock. */
export const XMTP_CREATE_CLIENT_TIMEOUT_MS = 60_000

// ── Shared UI state (banner + screens read this; the lifecycle writes it) ────

const uiState = createExternalState<XmtpUiState>("off")
export const getXmtpUiState = uiState.get
export const setXmtpUiState = uiState.set
export const subscribeXmtpUiState = uiState.subscribe

// ── Inbox catch-up state (KTD-10) ────────────────────────────────────────────
//
// "catching-up" from leader client construction until the first awaited full inbox drain after
// unlock completes; chat surfaces (U13) can show a catching-up treatment without blocking the UI.

export type XmtpInboxState = "idle" | "catching-up" | "ready"

const inboxState = createExternalState<XmtpInboxState>("idle")
export const getXmtpInboxState = inboxState.get
export const setXmtpInboxState = inboxState.set
export const subscribeXmtpInboxState = inboxState.subscribe

// ── Live leader sender ───────────────────────────────────────────────────────
//
// UI-initiated sends (request announce / decline signal) go through the leader tab's client. Null
// while this tab is not the leader — callers treat that as "delivery unavailable" and keep their
// local write (delivery is best-effort).

/** The leader client's send surface: requests, plus the connect-back a /connect confirm sends. */
export type LiveXmtpSender = IXmtpSender & Pick<WebXmtpClient, "sendConnectBack">

let xmtpSender: LiveXmtpSender | null = null

export function setXmtpSender(next: LiveXmtpSender | null): void {
  xmtpSender = next
}

export function getXmtpSender(): LiveXmtpSender | null {
  return xmtpSender
}

/** A RequestBroadcaster over the live leader sender, or null while this tab is not the leader. */
export function getRequestBroadcaster(): RequestBroadcaster | null {
  const sender = getXmtpSender()
  return sender ? new RequestBroadcaster(sender) : null
}

// ── Capability probe ─────────────────────────────────────────────────────────

/** Can this browser run the client at all (Worker + WASM + OPFS + Web Locks)? Fails closed. */
export function messagingCapability(): "ok" | "unsupported" {
  const ok =
    typeof Worker === "function" &&
    typeof WebAssembly === "object" &&
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof navigator.locks?.request === "function"
  return ok ? "ok" : "unsupported"
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export interface XmtpClientHandle {
  close(): void | Promise<void>
}

/** Structural subset of `LockManager` so tests inject a fake. */
export interface XmtpLockManager {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>
}

export interface XmtpLifecycleDeps {
  locks: XmtpLockManager
  isVisible(): boolean
  /** Subscribe to visibility changes; returns unsubscribe. */
  onVisibilityChange(listener: () => void): () => void
  /** The shared `deriveKeyFromSecret(msk, "xmtp-store")` key. Must yield 32 bytes. */
  deriveDbKey(): Promise<Uint8Array>
  /** `signal` fires when this attempt times out or the lifecycle stops: start no further SDK work. */
  createClient(dbEncryptionKey: Uint8Array, signal: AbortSignal): Promise<XmtpClientHandle>
  onState?(state: XmtpUiState): void
  log?(message: string, ...args: unknown[]): void
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export class XmtpLifecycle {
  private stopped = false
  private errored = false
  private requesting = false
  private client: XmtpClientHandle | null = null
  private abort: AbortController | null = null
  private construction: AbortController | null = null
  private releaseHold: (() => void) | null = null
  private unsubscribeVisibility: (() => void) | null = null

  constructor(private readonly deps: XmtpLifecycleDeps) {}

  start(): void {
    this.unsubscribeVisibility = this.deps.onVisibilityChange(() => this.onVisibility())
    this.onVisibility()
  }

  /** Wallet lock / logout / unmount: close the client, release the lock, go dark. */
  stop(): void {
    this.stopped = true
    this.unsubscribeVisibility?.()
    this.unsubscribeVisibility = null
    this.releaseHold?.()
    this.abort?.abort()
    this.abort = null
    this.construction?.abort()
    this.setState("off")
  }

  private onVisibility(): void {
    if (this.stopped) return
    // A construction failure is transient: any visibility transition retries.
    this.errored = false
    if (this.deps.isVisible()) {
      void this.acquire()
    } else {
      // Leader: close + release. Waiter: withdraw the pending request.
      this.releaseHold?.()
      this.abort?.abort()
      this.abort = null
    }
  }

  private async acquire(): Promise<void> {
    if (this.requesting || this.client) return
    this.requesting = true
    const abort = new AbortController()
    this.abort = abort
    // Pending grant means another tab is leader.
    this.setState("another-tab")
    try {
      await this.deps.locks.request(XMTP_LOCK_NAME, { signal: abort.signal }, () => this.lead())
    } catch {
      // AbortError — request withdrawn (hidden / stopped).
    } finally {
      this.requesting = false
      if (this.abort === abort) this.abort = null
      // Level-triggered: a hide→show flicker that landed while this request was settling must
      // re-request, or a visible tab strands on "another-tab" with no pending request.
      if (!this.stopped && !this.errored && this.deps.isVisible()) void this.acquire()
    }
  }

  /** Runs while holding the lock; returning releases it. */
  private async lead(): Promise<void> {
    if (this.stopped || !this.deps.isVisible()) return
    const construction = new AbortController()
    this.construction = construction
    let pending: Promise<XmtpClientHandle> | undefined
    try {
      const key = await this.deps.deriveDbKey()
      if (key.length !== 32) throw new Error(`xmtp db key must be 32 bytes, got ${key.length}`)
      if (this.stopped) return
      pending = this.deps.createClient(key, construction.signal)
      this.client = await withTimeout(
        pending,
        XMTP_CREATE_CLIENT_TIMEOUT_MS,
        "xmtp client construction",
      )
    } catch (err) {
      // The lock is released on return: tell the attempt to start nothing more.
      construction.abort()
      this.deps.log?.("[XmtpLifecycle] client construction failed", err)
      // A timed-out construction may still settle; close it so the single OPFS connection is freed.
      void pending?.then((c) => c.close()).catch(() => {})
      this.errored = true
      if (!this.stopped) this.setState("error")
      return
    } finally {
      if (this.construction === construction) this.construction = null
    }
    if (this.stopped || !this.deps.isVisible()) {
      await this.closeClient()
      return
    }
    this.setState("leader")
    await new Promise<void>((resolve) => {
      this.releaseHold = resolve
    })
    this.releaseHold = null
    await this.closeClient()
    if (!this.stopped) this.setState("another-tab")
  }

  private async closeClient(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    try {
      await client.close()
    } catch (err) {
      this.deps.log?.("[XmtpLifecycle] client close failed", err)
    }
  }

  private setState(state: XmtpUiState): void {
    this.deps.onState?.(state)
  }
}
