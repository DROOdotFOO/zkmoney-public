export default {
  "withdrawal.interrupted":
    "This withdrawal was interrupted before it finished. The amount is still in your balance.",
  "withdrawal.reorged": "Withdrawal transaction dropped in a reorg",
  "withdrawal.dropped": "The withdrawal transaction was dropped or reverted. You can try again.",
  "withdrawal.droppedLink":
    "The withdrawal transaction was dropped or reverted. You can retry the link.",
  // Proposed: the error this replaces named the tab's state after the colon.
  "withdrawal.inactiveTab": "This tab is not the active zk.money tab.",
  "withdrawal.failed": "Withdrawal failed",
  "sponsorship.paused": "This transaction was not sent. Please try again later.",
  "sponsorship.feesTooHigh":
    "This transaction was not sent. Aztec network fees are too high for transactions to go " +
    "through. Your funds are safe, and full functionality will be available when network fees " +
    "stabilize.",
  "sponsorship.allowanceExhausted":
    "This transaction was not sent: the account has no sponsored transactions left right " +
    "now. Settings > Sponsored transactions shows how the allowance renews.",
} as const
