/**
 * The deposit address holds none of the token a recovery would move. It has its own type so a
 * caller can treat it as "nothing to recover right now" rather than a failure; the message is the
 * Settings recovery's own.
 */
export class EmptyDepositError extends Error {
  constructor() {
    super("This deposit address holds none of that token.")
    this.name = "EmptyDepositError"
  }
}

/**
 * The Settings recovery's read of a deposit address failed. Its messages are written for the user, so
 * a caller can show them as is.
 */
export class DepositReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DepositReadError"
  }
}
