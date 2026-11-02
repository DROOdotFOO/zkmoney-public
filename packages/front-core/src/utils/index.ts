import { logger } from "./logger"

export * from "./shortenAddr"
export * from "./explorer"
export * from "./constants"
export * from "./compAddrToAztecAddr"
export * from "./completeAddressWireFormat"
export * from "./environment"
export * from "./validate"
export * from "./amountInput"
export * from "./normalizeTag"
export * from "./recentContacts"
export * from "./tokenIdentity"
export * from "./escrowAmount"
export * from "./tokenAmount"
export * from "./logger"
export * from "./makeLimiter"

export function isDefined<T>(value: T, name: string): value is NonNullable<T> {
  if (value === undefined || value === null) {
    const stack = new Error().stack
    const callerLine = stack?.split("\n")[2] || "Unknown location"
    logger.log("Undefined value:", name, "\nCalled:", callerLine.trim())
    return false
  }
  return true
}
