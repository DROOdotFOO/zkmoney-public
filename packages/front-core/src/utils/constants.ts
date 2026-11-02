import { DEFAULT_DECIMALS, tokenDecimalsForNetwork, type Network } from "@obsidion/sdk"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { daiLogo, unknownLogo } from "../assets"

// Transaction Toast Constants
export const AUTO_COLLAPSE_TIME = 5000 // 5 seconds
export const AUTO_CLOSE_TIME = 15000 // 15 seconds
export const ANIMATION_TIMEOUT = 1000 // 1 second safety timeout

// Token decimals are a flat 18 on every network; `tokenDecimalsForNetwork`
// keeps the asset table network-parameterized so a future per-network token is
// a one-line change. The named return type keeps `keyof` typing at consumer sites.
export const resolveAssetConstants = (network: Network) => ({
  // The key is a literal because `keyof AssetConstants` is derived from it;
  // the values come from the one identity declaration.
  DAI: {
    name: WALLET_TOKEN_SYMBOL,
    symbol: WALLET_TOKEN_SYMBOL,
    color: "green",
    logo: daiLogo,
    price: 1.0,
    change: 0,
    changeAmount: 0,
    decimals: tokenDecimalsForNetwork(network),
  },
  ANY: {
    name: "Unknown",
    symbol: "??",
    color: "gray",
    logo: unknownLogo,
    price: 1.0,
    change: 0,
    changeAmount: 0,
    decimals: DEFAULT_DECIMALS,
  },
})

export type AssetConstants = ReturnType<typeof resolveAssetConstants>

/** Public URL of the wallet logo. */
export const getWalletLogoUrl = (): string => window.location.origin + "/wallet-logo.png"
