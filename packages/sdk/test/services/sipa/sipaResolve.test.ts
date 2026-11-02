/**
 * SIPA name resolution — unit tests against a stub client (the CCIP-read
 * retry loop itself is viem's; what's ours is the call shape + decode + the
 * zero-address guard). The live acceptance is env-gated: LIVE_OXIDE=1 checks
 * the deployed SIPAFactory serves `predictSIPA`; LIVE_OXIDE_NAME additionally
 * runs a real gateway resolve (needs a name registered on the live registry).
 */

import { describe, expect, it } from "vitest"
import {
  BaseError,
  createPublicClient,
  HttpRequestError,
  http,
  type Address,
  type PublicClient,
} from "viem"
import { extractPinnedOxideEnvTuple } from "@obsidion/core/oxide"
import { readDepositSIPAImplementation } from "../../../src/services/sipa/sipaIntents.js"
import {
  predictSIPA,
  resolveSipaAddress,
  SipaNameUndepositableError,
} from "../../../src/services/sipa/sipaResolve.js"

const LIVE_MANIFEST_URL =
  process.env.OXIDE_MANIFEST_URL ?? "https://d1162cdsa8f9md.cloudfront.net/dev.v4.json"
const LIVE_PORTAL = process.env.OXIDE_PORTAL ?? ""
const REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f"
const SIPA = "0x1234567890abcdef1234567890abcdef12345678" as Address

/** DNS-packet encoding of "alice.oxidestaging.eth" (length-prefixed labels). */
const ALICE_PACKET = "0x05616c6963650c6f7869646573746167696e670365746800"
/** `addr(bytes32)` — the ENS getter the resolve payload wraps. */
const ADDR_SELECTOR = "0x3b3b57de"

const abiEncodedAddress = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}` as const

/** A read failing as viem's CCIP-read does when the gateway answers `status`. */
function gatewayRefusal(status: number) {
  return new BaseError("Offchain lookup failed", {
    cause: new HttpRequestError({ url: "https://gateway.test/{sender}/{data}", status }),
  })
}

function refusingClient(err: Error) {
  return { readContract: async () => Promise.reject(err) } as unknown as PublicClient
}

function stubClient(resolveResult: string) {
  const calls: { address: string; functionName: string; args: unknown[] }[] = []
  const client = {
    readContract: async (params: { address: string; functionName: string; args: unknown[] }) => {
      calls.push(params)
      if (params.functionName === "resolve") return resolveResult
      throw new Error(`unexpected read: ${params.functionName}`)
    },
  } as unknown as PublicClient
  return { client, calls }
}

describe("resolveSipaAddress", () => {
  it("resolves a name to the SIPA address via the Registry's resolve", async () => {
    const { client, calls } = stubClient(abiEncodedAddress(SIPA))
    const resolved = await resolveSipaAddress(client, REGISTRY, "alice.oxidestaging.eth")
    expect(resolved.toLowerCase()).toBe(SIPA.toLowerCase())

    expect(calls[0]!.address).toBe(REGISTRY)
    // name travels DNS-packet-encoded; the payload is the ENS addr(node) call
    expect(calls[0]!.args[0]).toBe(ALICE_PACKET)
    expect(String(calls[0]!.args[1]).startsWith(ADDR_SELECTOR)).toBe(true)
  })

  it("throws on a zero-address result instead of handing it to the send path", async () => {
    const { client } = stubClient(abiEncodedAddress(`0x${"0".repeat(40)}`))
    await expect(resolveSipaAddress(client, REGISTRY, "ghost.oxidestaging.eth")).rejects.toThrow(
      /zero address/,
    )
  })

  it("names a gateway 409 as an undepositable name", async () => {
    const refusal = gatewayRefusal(409)
    const err = await resolveSipaAddress(refusingClient(refusal), REGISTRY, "bob.oxidestaging.eth")
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SipaNameUndepositableError)
    expect((err as Error).cause).toBe(refusal)
  })

  it("passes any other gateway failure through unchanged", async () => {
    const refusal = gatewayRefusal(503)
    await expect(
      resolveSipaAddress(refusingClient(refusal), REGISTRY, "bob.oxidestaging.eth"),
    ).rejects.toBe(refusal)
  })
})

describe.runIf(process.env.LIVE_OXIDE === "1")("live SIPAFactory predictSIPA", () => {
  it("the deployed factory serves the CREATE2 predictor", async () => {
    const manifest = await (await fetch(LIVE_MANIFEST_URL)).json()
    const { tuple } = extractPinnedOxideEnvTuple(manifest, { portal: LIVE_PORTAL })
    if (!tuple.sipaFactory) {
      throw new Error("live dev.json lacks the SIPA surface")
    }
    const client = createPublicClient({
      transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"),
    }) as PublicClient

    if (!tuple.forwardingTable) throw new Error("live manifest lacks the forwarding table")
    const implementation = await readDepositSIPAImplementation(client, tuple.sipaFactory as Address)
    const predicted = await predictSIPA(
      client,
      tuple.sipaFactory as Address,
      implementation,
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      BigInt(tuple.rollupVersion),
      false,
      tuple.forwardingTable as Address,
    )
    expect(predicted).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(predicted.toLowerCase()).not.toBe(`0x${"0".repeat(40)}`)
  }, 60_000)

  it.runIf(Boolean(process.env.LIVE_OXIDE_NAME))(
    "resolves a registered name through the live gateway",
    async () => {
      const manifest = await (await fetch(LIVE_MANIFEST_URL)).json()
      const { tuple } = extractPinnedOxideEnvTuple(manifest, { portal: LIVE_PORTAL })
      const client = createPublicClient({
        transport: http(
          process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
        ),
      }) as PublicClient

      const resolved = await resolveSipaAddress(
        client,
        tuple.registry as never,
        process.env.LIVE_OXIDE_NAME as string,
      )
      expect(resolved).toMatch(/^0x[0-9a-fA-F]{40}$/)
    },
    120_000,
  )
})
