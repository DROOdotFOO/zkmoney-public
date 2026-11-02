// The rollup identity as L1 states it: `OxidePortal.ROLLUP_VERSION()`, `ROLLUP()` and `INBOX()`
// on the profile's portal, read only after `eth_chainId` has confirmed the RPC is on the expected
// chain. The wallet checks the node against this and pins it; the node is never the source.
import { OxidePortalAbi } from "@oxide/l1-contracts"
import type { Hex, PublicClient } from "viem"
import type { ChainIdentity } from "@obsidion/core/types"

export type PortalIdentityCall = "eth_chainId" | "ROLLUP_VERSION" | "ROLLUP" | "INBOX"

/** The L1 RPC answered `eth_chainId` with another chain: a wrong RPC, named as the RPC's fault. */
export class PortalIdentityMismatchError extends Error {
  readonly field: "l1RpcChainId"
  readonly expected: number
  readonly got: number

  constructor({ field, expected, got }: { field: "l1RpcChainId"; expected: number; got: number }) {
    super(`L1 RPC is on chain ${got}, expected ${expected}`)
    this.name = "PortalIdentityMismatchError"
    this.field = field
    this.expected = expected
    this.got = got
    Object.setPrototypeOf(this, PortalIdentityMismatchError.prototype)
  }
}

/**
 * L1 yielded no usable identity. One outcome for every failure — transport, HTTP status, revert,
 * no code, undecodable answer — because viem drops the evidence on several of those paths and the
 * caller's policy does not depend on which it was. `cause` keeps the original error for the log.
 */
export class L1IdentityUnavailableError extends Error {
  readonly call: PortalIdentityCall

  constructor({ call, cause }: { call: PortalIdentityCall; cause: unknown }) {
    super(`L1 identity read failed at ${call}`, { cause })
    this.name = "L1IdentityUnavailableError"
    this.call = call
    Object.setPrototypeOf(this, L1IdentityUnavailableError.prototype)
  }
}

async function guard<T>(call: PortalIdentityCall, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (cause) {
    throw new L1IdentityUnavailableError({ call, cause })
  }
}

/**
 * Read the rollup identity through the portal. Throws `PortalIdentityMismatchError` when the RPC's
 * chain is not `expectedL1ChainId` (the getters are never invoked) and `L1IdentityUnavailableError`
 * when any call fails.
 */
export async function readPortalChainIdentity(
  client: PublicClient,
  portal: Hex,
  expectedL1ChainId: number,
): Promise<ChainIdentity> {
  const l1ChainId = await guard("eth_chainId", () => client.getChainId())
  if (l1ChainId !== expectedL1ChainId) {
    throw new PortalIdentityMismatchError({
      field: "l1RpcChainId",
      expected: expectedL1ChainId,
      got: l1ChainId,
    })
  }

  const contract = { address: portal, abi: OxidePortalAbi } as const
  const [rollupVersion, rollupAddress, inboxAddress] = await Promise.all([
    guard("ROLLUP_VERSION", () =>
      client.readContract({ ...contract, functionName: "ROLLUP_VERSION" }),
    ),
    guard("ROLLUP", () => client.readContract({ ...contract, functionName: "ROLLUP" })),
    guard("INBOX", () => client.readContract({ ...contract, functionName: "INBOX" })),
  ])
  return {
    l1ChainId,
    rollupVersion: rollupVersion.toString(),
    rollupAddress: rollupAddress.toLowerCase(),
    inboxAddress: inboxAddress.toLowerCase(),
  }
}
