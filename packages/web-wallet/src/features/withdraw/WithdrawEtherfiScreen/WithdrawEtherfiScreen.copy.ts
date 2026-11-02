export default {
  title: "Withdraw to ether.fi",
  close: "Close",
  subtitle: "Funds land in your ether.fi Cash balance. {assets} for now.",
  assetNote: "ether.fi Cash credits {assets}.",
  steps: [
    "Open ether.fi Cash and go to Add funds, then Crypto, then Share address.",
    "Copy the Ethereum address it shows.",
    "Paste it below. Only USDC or USDT on Ethereum reach your Cash balance.",
  ],
  change: "Change",
  getAddress: "Get your ether.fi address",
  getAddressHint: "Opens ether.fi Cash in a new tab",
  field: "ether.fi Cash address",
  placeholder: "Paste the address from ether.fi",
  clear: "Clear address",
  paste: "Paste",
  notAnAddress: "That isn't an Ethereum address.",
  save: "Save as my ether.fi address",
  checking: "Checking with ether.fi…",
  screening: {
    checking: "Checking address…",
    blocked: "This address can't receive withdrawals.",
    error: "Couldn't verify this address. Check your internet connection or try another address.",
  },
  continue: "Continue",
  verdict: {
    confirmed: {
      title: "ether.fi Cash address confirmed",
      body: "ether.fi's deposit factory on Ethereum deployed this address.",
    },
    account: {
      title: "Confirm this ether.fi Cash address",
      body:
        "ether.fi created this Cash account, but it hasn't received funds on Ethereum before. Check " +
        "it matches the address in your ether.fi app before you continue.",
    },
    rejected: {
      title: "This isn't an ether.fi Cash address",
      body:
        "ether.fi has no record of it on Ethereum or Optimism. Funds sent here would not reach a " +
        "Cash balance. Copy the address from ether.fi's share-address page.",
    },
    unknown: {
      title: "Couldn't confirm this is an ether.fi address",
      body: "The check did not finish. Make sure the address came from ether.fi before you continue.",
    },
  },
} as const
