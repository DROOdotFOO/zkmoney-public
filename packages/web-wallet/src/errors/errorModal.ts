import { type PasskeyReportEnv, isWedgedTabError, passkeyReportEnvFor } from "@obsidion/passkey-web"
import { passkeyTelemetry } from "../lib/passkeyTelemetry"
import { sponsorshipErrorCopy } from "../features/allowance/sponsorshipError"
import { reloadPage } from "../platform/storage/walletStorage"
import { errorCopy } from "./catalog"

/**
 * Module-level emitter for the global error/info modal, callable from any
 * catch block without a React context. `ErrorModalHost` (mounted once at the
 * root) subscribes and renders the modal.
 */
export type ErrorModalPayload = {
  title: string
  message: string
  /** Raw technical payload, rendered smaller under the message. */
  detail?: string
  /**
   * Show Copy + Report. Off by default — known error templates own their
   * copy and don't need it. Opt in per template, or for unknown/unexpected
   * errors caught without a specific template.
   */
  showReport?: boolean
  /** Flow tag included in shared error reports, e.g. "deposit:send". */
  context?: string
  /** Device and passkey provider when the modal was raised; a report sends it. */
  env?: PasskeyReportEnv
  /** A docs page that explains the error. */
  link?: { label: string; href: string }
  /** A way to try the failed step again, offered as a button that closes the modal first. */
  retry?: { label: string; run: () => void }
}

let listener: ((payload: ErrorModalPayload) => void) | null = null
// Buffers errors raised before `ErrorModalHost` mounts (early boot); flushed
// on subscribe so they are not silently dropped.
let pending: ErrorModalPayload[] = []
const MAX_PENDING = 3

export function showErrorModal(raised: Omit<ErrorModalPayload, "env">): void {
  const payload = { ...raised, env: reportEnv() }
  if (listener) listener(payload)
  else if (pending.length < MAX_PENDING) pending.push(payload)
}

/** The error shows whether or not the device can be described. */
function reportEnv(): PasskeyReportEnv | undefined {
  try {
    return passkeyReportEnvFor(passkeyTelemetry.snapshot())
  } catch {
    return undefined
  }
}

const OUT_OF_MEMORY = {
  title: "Not enough memory",
  message:
    "The browser could not give zk.money the memory it needs. Wait a few seconds, then reload the page.",
  retry: { label: "Reload page", run: () => void reloadPage() },
}

export function outOfMemoryCopy(e: unknown): typeof OUT_OF_MEMORY | undefined {
  return isOutOfMemory(e) ? OUT_OF_MEMORY : undefined
}

function isOutOfMemory(e: unknown): boolean {
  if (e instanceof AggregateError) return e.errors.length > 0 && e.errors.every(isOutOfMemory)
  return e instanceof Error && e.message === "Out of memory"
}

/** Normalize a caught value into the reportable modal used for unexpected failures. */
export function showReportableError(
  raw: unknown,
  context: string,
  options: { title?: string; message?: string; retry?: ErrorModalPayload["retry"] } = {},
): void {
  const outOfMemory = outOfMemoryCopy(raw)
  if (outOfMemory) {
    showErrorModal({ ...outOfMemory, detail: (raw as Error).stack, showReport: true, context })
    return
  }
  const sponsorship = sponsorshipErrorCopy(raw, context)
  if (sponsorship) {
    showErrorModal({ ...sponsorship, context })
    return
  }
  if (isWedgedTabError(raw)) {
    showErrorModal({
      title: "Passkey request still open",
      message: (raw as Error).message,
      context,
      retry: { label: "Reload page", run: () => void reloadPage() },
    })
    return
  }
  const error = raw instanceof Error ? raw : new Error(nonErrorMessage(raw))
  showErrorModal({
    title: options.title ?? "Unexpected error",
    message: options.message ?? errorCopy(raw) ?? error.message,
    detail: error.stack,
    showReport: true,
    context,
    ...(options.retry ? { retry: options.retry } : {}),
  })
}

function nonErrorMessage(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return String(raw)
  try {
    return objectMessage(raw as Record<string, unknown>)
  } catch {
    return "Non-Error object that cannot be read"
  }
}

function objectMessage(raw: Record<string, unknown>): string {
  const { message, shortMessage, code } = raw
  const text = [message, shortMessage].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  )
  const codeText = typeof code === "number" || typeof code === "string" ? String(code) : undefined
  if (text) return codeText ? `${text} (code ${codeText})` : text
  if (codeText) return `Error code ${codeText}`
  const keys = Object.keys(raw).filter((k) => /^[A-Za-z_$][\w$]{0,31}$/.test(k))
  if (keys.length === 0) return "Non-Error object with no named keys"
  return `Non-Error object with keys: ${keys.slice(0, 10).join(", ")}`
}

export function subscribeErrorModal(l: (payload: ErrorModalPayload) => void): () => void {
  listener = l
  for (const p of pending.splice(0)) l(p)
  return () => {
    if (listener === l) listener = null
  }
}
