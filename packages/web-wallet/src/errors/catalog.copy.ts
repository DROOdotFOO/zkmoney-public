import type { ErrorCode } from "@obsidion/front-core"

export default {
  "account.unlockFailed": "Authentication failed. Tap retry to unlock your account.",
  "account.creationCancelled": "Security-key wallet creation was cancelled",
  "account.replaceUnconfirmed":
    "This device already has a wallet. Recovering a different security key here would replace it — " +
    "confirm 'replace this device's wallet' to proceed.",
  "wallet.notReady": "The wallet is still starting. Try again in a moment.",
  "wallet.missing": "wallet not found",
  "contact.unavailable": "Contact or wallet identity unavailable",
  "contact.unregistered": "@{tag} is no longer registered",
  "contact.requestMismatch": "@{tag} no longer matches this payment request — payment cancelled",
  "contact.cannotReceive": "This contact can't receive requests yet",
  "request.undelivered": "Request delivery failed: {reason}",
  "messaging.anotherTab": "Wallet open in another tab — messaging paused here",
  "messaging.unsupported": "Messaging isn't supported in this browser — contacts still work",
  "messaging.failed": "Messaging couldn't start — it will retry when you return to this tab",
  "messaging.starting": "Messaging is still starting up — try again in a moment",
  "passkey.unasked": "The passkey that answered is not the one this browser asked for",
  "deposit.registrationMoved":
    "This deposit's registration has moved on, so the sweep was stopped before signing. Close and reopen the deposit for its current options.",
} as const satisfies Partial<Record<ErrorCode, string>>
