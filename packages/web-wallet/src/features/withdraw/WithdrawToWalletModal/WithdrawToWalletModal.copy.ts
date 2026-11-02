export default {
  title: "Withdraw",
  close: "Close",
  amountToSend: "Amount to send",
  available: "Available:",
  minimum: "Minimum $1",
  max: "MAX",
  limitInfo: "About the withdrawal limit",
  short: "Your balance can't cover the withdrawal fee ({fee}) plus the $1 minimum.",
  overspent: "Balance not enough",
  fee: "Withdrawal fee",
  contract: {
    title: "This address is a contract",
    body: "The ETH route pays it with a plain transfer, and a contract that rejects ETH would leave the funds stuck at the swap escrow. Pick a different address, or receive USDC or USDT instead.",
  },
  screening: {
    checking: "Checking address…",
    blocked: "This address can't receive withdrawals.",
    error: "Couldn't verify this address. Check your internet connection or try another address.",
  },
  review: "Review",
  confirm: "Confirm withdrawal",
  connecting: "Connecting…",
} as const
