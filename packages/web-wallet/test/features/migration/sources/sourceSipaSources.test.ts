// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import {
  composeWireNameHash,
  deriveStealthKey,
  directDepositKey,
  registrationCommitments,
} from "@obsidion/front-core"
import { seedBootConfig } from "../../../support/seedBootConfig"

const h = vi.hoisted(() => ({
  identity: { current: null as { address: string; handle?: string } | null },
  keys: vi.fn(async () => [] as unknown[]),
}))
vi.mock("../../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => h.identity.current,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchHistoricalSipaResolverOperators: async () => [],
  fetchHistoricalResolverPublicKeys: h.keys,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deploymentScanRange: async () => ({ fromBlock: 1n, toBlock: 42n }),
}))

const { sourceSipaSources } = await import("../../../../src/features/migration/sourceSipaSources")

beforeAll(seedBootConfig)
beforeEach(() => {
  h.identity.current = null
  h.keys.mockReset().mockResolvedValue([])
})

const SECRET = new Fr(7n)
const ACCOUNT = `0x${"0e".repeat(32)}` as const
const TUPLE = {
  portal: "0xabc",
  accountMetadataRegistry: "0x" + "0a".repeat(20),
  registrationSIPAImplementation: "0x" + "0b".repeat(20),
  ensDomain: "zkmoney.eth",
}
const RESOLVER_KEY = deriveStealthKey(new Fr(9n)).publicKey

const scan = (announced: unknown[]) => {
  const sipaSources = vi.fn(async () => announced)
  return {
    sipaSources,
    params: {
      chain: { kind: "generation", session: { address: ACCOUNT, sipaSources } } as never,
      tuple: TUPLE as never,
      publicClient: {} as never,
      masterSecret: SECRET,
      scanHead: 42n,
    },
  }
}

describe("sourceSipaSources", () => {
  it("finds no SIPAs on a deployment without SIPA implementations", async () => {
    const { sipaSources, params } = scan([])
    await expect(
      sourceSipaSources({ ...params, tuple: { portal: "0xabc" } as never }),
    ).resolves.toEqual([])
    expect(sipaSources).not.toHaveBeenCalled()
  })

  it("finds a registration address no SIPA event announced by its commitment, under every salt", async () => {
    h.identity.current = { address: "0x01", handle: "phil" }
    h.keys.mockResolvedValue([RESOLVER_KEY])
    const { params } = scan([])

    const sources = await sourceSipaSources(params)

    const expected = await registrationCommitments(
      SECRET,
      composeWireNameHash("phil", TUPLE.ensDomain),
      ACCOUNT,
      [RESOLVER_KEY],
    )
    expect(expected).toHaveLength(2)
    expect(sources).toEqual(
      expected.map(({ salt, commitment }) => ({
        sipaAddress: directDepositKey(commitment),
        recipientL2Address: ACCOUNT,
        messageSecret: salt,
        recipientCommitment: commitment,
        direct: true,
      })),
    )
  })

  it("adds no registration source for an account with no handle", async () => {
    const { params } = scan([])
    expect(await sourceSipaSources(params)).toEqual([])
  })
})
