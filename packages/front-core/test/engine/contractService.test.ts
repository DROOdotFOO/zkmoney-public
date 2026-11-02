// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONTRACTS, Network, type ObsidionWallet } from "@obsidion/sdk"
import {
  contractServiceResource,
  type ContractServiceDeps,
  type ContractServiceSingleton,
} from "../../src/engine/contractService"
import { fixed, resource, valueOf } from "../../src/engine/resource"

const flush = () => vi.advanceTimersByTimeAsync(0)

const wallet = { node: { _id: "node" }, pxe: { _id: "pxe" } } as unknown as ObsidionWallet

const profileOptions = (overrides: Record<string, unknown> = {}) =>
  ({ source: "profile", config: { network: Network.TESTNET }, ...overrides } as never)

/** `ContractService`'s singleton: it records each construction and serves the one instance. */
function fakeSingleton() {
  const registered = vi.fn(async () => {})
  const l1Reads = vi.fn(async () => ({ token: "0xtok", portal: "0xportal" }))
  const fake = {
    instance: null as unknown,
    constructions: [] as unknown[][],
    registered,
    l1Reads,
    getInstance: (...args: unknown[]) => {
      if (args.length === 0) {
        if (!fake.instance) throw new Error("First call to getInstance requires storage or network")
        return fake.instance
      }
      fake.constructions.push(args)
      return (fake.instance = {
        getNetwork: () => "testnet",
        getL1Addresses: l1Reads,
        registerContractWithName: registered,
        getContractAddress: async () => ({ toString: () => "0xfpc" }),
      })
    },
  }
  return fake
}

let singleton: ReturnType<typeof fakeSingleton>

function build(o: Partial<ContractServiceDeps> = {}) {
  return contractServiceResource(
    {
      wallet: fixed("wallet", wallet),
      network: Network.TESTNET,
      storage: {} as never,
      options: profileOptions(),
      ...o,
    },
    singleton as unknown as ContractServiceSingleton,
  )
}

describe("contractServiceResource", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    singleton = fakeSingleton()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("builds once a late wallet arrives", async () => {
    let ready!: (w: ObsidionWallet) => void
    const late = resource(
      "wallet",
      { from: [], backoff: "manual" },
      () => new Promise<ObsidionWallet>((r) => (ready = r)),
    )
    const service = build({ wallet: late })
    await flush()
    expect(service.get().status).toBe("pending")
    expect(singleton.constructions).toHaveLength(0)
    ready(wallet)
    await flush()
    expect(valueOf(service)).toBe(singleton.instance)
  })

  it("constructs over the wallet's node and PXE from the snapshot, with no registry URL", async () => {
    const service = build()
    await flush()
    expect(valueOf(service)).toBe(singleton.instance)
    // storage, node, pxe, network, options — and deliberately no positional registry URL.
    expect(singleton.constructions).toEqual([
      [
        {},
        wallet.node,
        wallet.pxe,
        Network.TESTNET,
        expect.objectContaining({ source: "profile" }),
      ],
    ])
  })

  it("loads L1 addresses from the built service", async () => {
    const onL1AddressesLoaded = vi.fn()
    build({ options: profileOptions({ onL1AddressesLoaded }) })
    await flush()
    expect(onL1AddressesLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ portal: "0xportal" }),
    )
  })

  it("registers the sponsor FPC, unless the host pays no fee through it", async () => {
    build()
    await flush()
    expect(singleton.registered).toHaveBeenCalledWith(DEFAULT_CONTRACTS.sponsorFPC)
    singleton = fakeSingleton()
    const skipped = build({ registerSponsorFpc: false })
    await flush()
    expect(valueOf(skipped)).toBe(singleton.instance)
    expect(singleton.registered).not.toHaveBeenCalled()
  })

  it("fails on a snapshot for another network, and retries with a backoff", async () => {
    const service = build({ options: profileOptions({ config: { network: Network.SANDBOX } }) })
    await flush()
    expect(service.get()).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "invariant" }),
      retryAt: expect.any(Number),
    })
    expect(singleton.constructions).toHaveLength(0)
  })

  it("adopts an instance already installed, whatever the deps say", async () => {
    const installed = {
      registerContractWithName: singleton.registered,
      getContractAddress: async () => ({}),
    }
    singleton.instance = installed
    const service = build()
    await flush()
    expect(valueOf(service)).toBe(installed)
    expect(singleton.registered).toHaveBeenCalledWith(DEFAULT_CONTRACTS.sponsorFPC)
    expect(singleton.constructions).toHaveLength(0)
    expect(singleton.l1Reads).not.toHaveBeenCalled()
  })
})
