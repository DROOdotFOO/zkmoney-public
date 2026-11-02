export default {
  failed: "Recovery could not continue. Try again.",
  label: "Registration refund",
  unfunded:
    "Nothing was sent to this address, and its price is not the earned one. Request a new address at the earned {price} price, then fund that new address.",
  restart:
    "Your deposit was recovered. Request a new address at the earned {price} price, then fund that new address. Your wallet access is unchanged.",
  recover:
    "This deposit cannot complete the old registration price. Recover it to your Ethereum wallet first, then register at the earned {price} price. Do not send more to this address. Recovery requires ETH for gas.",
  preparing: "Preparing…",
  register: "Register at earned price",
  recoverAction: "Recover deposit",
} as const
