import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"

/** True for the wallet's token symbol, case-insensitively. */
export function isWalletTokenSymbol(symbol: string | undefined | null): boolean {
  return !!symbol && symbol.toUpperCase() === WALLET_TOKEN_SYMBOL.toUpperCase()
}

