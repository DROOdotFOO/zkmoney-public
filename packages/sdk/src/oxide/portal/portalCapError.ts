/**
 * Recognizes the portal refusals a deposit sweep can hit: the shared capacity is short, the amount is
 * over the per-operation ceiling, or the portal is frozen. Only structured revert data is read, never
 * message text.
 *
 * `SIPA.sweep` calls `OxidePortal.deposit` without a try/catch, so a direct sweep of a deployed SIPA
 * carries the portal's revert data, nested inside whatever viem, the RPC node or a wallet wraps
 * around it. A SIPA with no code is swept through a Multicall3 deploy-and-sweep batch, and Multicall3
 * replaces the failing call's data with its own `Error("Multicall3: call failed")`; that returns
 * undefined, so callers need another signal for why such a sweep would fail.
 */
import { decodeErrorResult, type Hex } from "viem"
import { OxidePortalAbi } from "@oxide/l1-contracts"

export type PortalCapErrorKind = "global-limit" | "tx-limit" | "frozen"

const KIND_BY_ERROR = new Map<string, PortalCapErrorKind>([
  ["Caps__GlobalLimitSurpassed", "global-limit"],
  ["Caps__TxLimitSurpassed", "tx-limit"],
  ["OxidePortal__FrozenPortal", "frozen"],
])

/** Where viem errors, JSON-RPC error objects and wallet providers keep revert data or the next error. */
const NESTED_KEYS = ["cause", "data", "originalError", "raw"] as const

const REVERT_DATA = /^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/

/** The portal refusal carried anywhere in `err`, or undefined when there is none. */
export function classifyPortalCapError(err: unknown): PortalCapErrorKind | undefined {
  const seen = new Set<object>()
  const visit = (value: unknown): PortalCapErrorKind | undefined => {
    if (typeof value === "string") return kindOf(value)
    if (!value || typeof value !== "object" || seen.has(value)) return undefined
    seen.add(value)
    for (const key of NESTED_KEYS) {
      const kind = visit((value as Record<string, unknown>)[key])
      if (kind) return kind
    }
    return undefined
  }
  return visit(err)
}

function kindOf(data: string): PortalCapErrorKind | undefined {
  if (!REVERT_DATA.test(data)) return undefined
  try {
    const hex = data.toLowerCase() as Hex
    return KIND_BY_ERROR.get(decodeErrorResult({ abi: OxidePortalAbi, data: hex }).errorName)
  } catch {
    return undefined
  }
}
