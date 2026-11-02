/** Why something failed, as data. Copy for each code lives with the views. */
export type ErrorCode =
  | "tx.interrupted"
  | "tx.failed"
  | "balance.unread"
  | "scan.incomplete"
  | "refund.unchecked"
  | "withdrawal.interrupted"
  | "withdrawal.reorged"
  | "withdrawal.dropped"
  | "withdrawal.inactiveTab"
  | "withdrawal.failed"
  | "sponsorship.paused"
  | "sponsorship.feesTooHigh"
  | "sponsorship.allowanceExhausted"
  | "account.unlockFailed"
  | "account.creationCancelled"
  | "account.replaceUnconfirmed"
  | "wallet.notReady"
  | "wallet.missing"
  | "contact.unavailable"
  | "contact.unregistered"
  | "contact.requestMismatch"
  | "contact.cannotReceive"
  | "request.undelivered"
  | "messaging.anotherTab"
  | "messaging.unsupported"
  | "messaging.failed"
  | "messaging.starting"
  | "passkey.unasked"
  | "deposit.registrationMoved"
  | "savings.feeUnsettled"
  | "config.invalid"
  | "timeout"
  | "aborted"
  /** A broken programmer assumption; `detail` names it. */
  | "invariant"
  | "unknown"

/** What a record keeps of a failure. `detail` is debug text and is never rendered. */
export interface Failure {
  code: ErrorCode
  detail?: string
}

export class WalletError extends Error {
  /** Values for the `{name}` placeholders in the code's copy. */
  readonly data?: Readonly<Record<string, string>>
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    options?: { cause?: unknown; data?: Record<string, string> },
  ) {
    super(detail ?? code, options)
    this.name = "WalletError"
    this.data = options?.data
  }
}

/** `e` as a failure: a `WalletError` keeps its code, anything else takes `fallback`. */
export function toFailure(e: unknown, fallback: ErrorCode = "unknown"): Failure {
  if (e instanceof WalletError)
    return e.detail ? { code: e.code, detail: e.detail } : { code: e.code }
  return { code: fallback, detail: e instanceof Error ? e.message : String(e) }
}

/** Work whose failure must not fail the caller: it is logged under `code`, never dropped silently. */
export async function bestEffort<T>(code: ErrorCode, work: Promise<T>): Promise<T | undefined> {
  try {
    return await work
  } catch (e) {
    console.warn(`[${code}]`, e)
    return undefined
  }
}
