// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { keccak256, type Address, type Hex } from "viem"
import { secp256k1 } from "@noble/curves/secp256k1"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { encodeDepositIntentData } from "@oxide/l1-contracts"
import { computeSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { SIPADepositStore } from "../../src/core/services/deposits/SIPADepositStore"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"

const mocks = vi.hoisted(() => ({
  readAccountResolution: vi.fn(),
  fetchSipaEvents: vi.fn(),
}))

// The derivation runs for real. Only the chain reads are stubbed: the resolver's records, and the
// discovery pass's event and log reads.
vi.mock("@obsidion/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@obsidion/sdk")>()
  return {
    ...actual,
    readAccountResolution: mocks.readAccountResolution,
    fetchSipaEvents: mocks.fetchSipaEvents,
    readDepositSIPAImplementation: vi.fn(async (_client: unknown, factory: string) =>
      factory.toLowerCase() === SUSDS_FACTORY ? SUSDS_IMPLEMENTATION : DAI_IMPLEMENTATION,
    ),
    readDepositFee: vi.fn(async () => 10n),
    readFpcFundingCut: vi.fn(async () => 0n),
    readPortalDeposits: vi.fn(async () => []),
    readTokenTransfers: vi.fn(async () => []),
    readSipaBalancesMany: vi.fn(
      async (_c: unknown, sipas: string[]) =>
        new Map(sipas.map((s) => [s.toLowerCase(), new Map([[DAI, 5_000_000n]])])),
    ),
    readBlockTimeMs: vi.fn(async () => undefined),
  }
})

import { computeStealthRecipientHash, deriveSharedSecret } from "@obsidion/sdk"
import {
  RESOLVER_PAYMENT_MAX_BACKOFF_MS,
  RESOLVER_PAYMENT_POLL_MS,
  ResolverPaymentWatcher,
  readResolverDeployments,
  type ResolverDeployment,
  type ResolverDeploymentSource,
} from "../../src/oxide/resolverPayments"
import { syncSipaDeposits } from "../../src/oxide/sipaClaims"
import { isUnfundedSipaDeposit } from "../../src/core/services/deposits/SIPADepositStore"

const ZERO = "0x0000000000000000000000000000000000000000"
const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b"
const SUSDS = "0x5a1e0c2f3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f"
const DAI_PORTAL = "0xda10000000000000000000000000000000000001"
const SUSDS_PORTAL = "0x5005000000000000000000000000000000000002"
const DAI_TABLE = "0xda20000000000000000000000000000000000003"
const SUSDS_TABLE = "0x5006000000000000000000000000000000000004"
const DAI_FACTORY = "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2"
const SUSDS_FACTORY = "0x4a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b"
const DAI_IMPLEMENTATION = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4"
const SUSDS_IMPLEMENTATION = "0x6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"
const ACCOUNT_FACTORY = "0x8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c"
const REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f"
const RECOVERY_ACCOUNT = "0x4444444444444444444444444444444444444444" as Address
const RECIPIENT = AztecAddress.fromStringUnsafe(
  "0x0aa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
)
const ROLLUP_VERSION = 4127419662n

const point = (scalar: bigint) => {
  const p = secp256k1.ProjectivePoint.BASE.multiply(scalar).toAffine()
  return { x: p.x, y: p.y }
}
const STEALTH_SCALAR = 0x1f2e3d4c5b6a79881726354453627180918273645546372819a0b1c2d3e4f5a6n
const RESOLVER_SCALAR = 0x0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20212223242526272829n
const STEALTH_PUBLIC = point(STEALTH_SCALAR)
const RESOLVER_PUBLIC = point(RESOLVER_SCALAR)

const NOW = Date.UTC(2026, 0, 15, 12)
const TODAY = Math.floor(NOW / 1000 / 86_400)
const TIMESTAMP = BigInt(Math.floor(NOW / 1000))

const DAI_TOKEN = { address: DAI as Address, symbol: "DAI", decimals: 18 }
const SUSDS_TOKEN = { address: SUSDS as Address, symbol: "sUSDS", decimals: 18 }

const deployment = (asset: "DAI" | "sUSDS"): ResolverDeployment =>
  asset === "DAI"
    ? {
        portal: DAI_PORTAL as Address,
        sipaFactory: DAI_FACTORY as Address,
        forwardingTable: DAI_TABLE as Address,
        implementation: DAI_IMPLEMENTATION as Address,
        rollupVersion: ROLLUP_VERSION,
        resolverPublicKey: RESOLVER_PUBLIC,
        recoveryAccount: RECOVERY_ACCOUNT,
        accountFactory: ACCOUNT_FACTORY as Address,
        tokens: [DAI_TOKEN],
      }
    : {
        portal: SUSDS_PORTAL as Address,
        sipaFactory: SUSDS_FACTORY as Address,
        forwardingTable: SUSDS_TABLE as Address,
        implementation: SUSDS_IMPLEMENTATION as Address,
        rollupVersion: ROLLUP_VERSION,
        resolverPublicKey: RESOLVER_PUBLIC,
        recoveryAccount: RECOVERY_ACCOUNT,
        accountFactory: ACCOUNT_FACTORY as Address,
        tokens: [SUSDS_TOKEN],
      }

/**
 * What the oxide gateway hands out at `(day, nonce)`, computed from the resolver's side of the
 * ECDH: its private key against the account's registered public key.
 */
async function resolverHandsOut(d: ResolverDeployment, day: number, nonce: number) {
  const salt = deriveSharedSecret(STEALTH_PUBLIC, RESOLVER_SCALAR, day, nonce)
  const recipientCommitment = (await computeStealthRecipientHash(salt, RECIPIENT)).toString() as Hex
  const intentHash = keccak256(encodeDepositIntentData(recipientCommitment))
  const address = computeSIPAAddress({
    sipaFactory: EthAddress.fromString(d.sipaFactory),
    implementation: EthAddress.fromString(d.implementation),
    intentHash: Buffer.from(intentHash.slice(2), "hex"),
    recoveryCommitment: deriveRecoveryCommitment(salt, EthAddress.fromString(d.recoveryAccount)),
    forwardingTable: EthAddress.fromString(d.forwardingTable),
    rollupVersion: d.rollupVersion,
    resweepable: true,
  })
  return { address: address.toString().toLowerCase(), salt, recipientCommitment, intentHash }
}

function makeStore() {
  const records = new Map<string, Record<string, unknown>>()
  return {
    records,
    get: vi.fn((address: string) => (records.get(address.toLowerCase()) as never) ?? null),
    list: vi.fn(() => Array.from(records, ([sipaAddress, r]) => ({ ...r, sipaAddress })) as never),
    upsert: vi.fn(
      async (
        address: string,
        patch: Record<string, unknown>,
        fallback?: Record<string, unknown>,
      ) => {
        const key = address.toLowerCase()
        const existing = records.get(key)
        const base = existing ?? fallback ?? {}
        const next = { ...base, ...patch, sipaAddress: key }
        records.set(key, next)
        return next as never
      },
    ),
    create: vi.fn(async (address: string, record: Record<string, unknown>) => {
      const key = address.toLowerCase()
      if (records.has(key)) return null
      const next = { ...record, sipaAddress: key }
      records.set(key, next)
      return next as never
    }),
    remove: vi.fn(async (address: string) => {
      records.delete(address.toLowerCase())
    }),
  }
}

type Holdings = { sipa: string; tokens: readonly string[] }[]

/** A chain whose addresses hold `funded` (lowercased address → token → balance). */
function chain(funded: Record<string, Record<string, bigint>> = {}) {
  return vi.fn(async (holdings: Holdings) => ({
    timestamp: TIMESTAMP,
    balances: new Map(
      holdings.map(({ sipa }) => [
        sipa.toLowerCase(),
        new Map(Object.entries(funded[sipa.toLowerCase()] ?? {})),
      ]),
    ),
  }))
}

function makeWatcher(
  readHoldings: ReturnType<typeof chain>,
  deployments: ResolverDeployment[] = [deployment("DAI")],
  store = makeStore(),
) {
  const onFunded = vi.fn()
  const watcher = new ResolverPaymentWatcher({
    deployments: async () => deployments,
    keys: async () => ({ stealthScalar: STEALTH_SCALAR, recipient: RECIPIENT }),
    readHoldings,
    store,
    l1ChainId: 11155111,
    networkId: "0xnet",
    onFunded,
    now: () => NOW,
  })
  return { watcher, store, onFunded }
}

const polled = (read: ReturnType<typeof chain>, call = 0) =>
  (read.mock.calls[call]![0] as Holdings).map((h) => h.sipa.toLowerCase())

async function handedOut(d: ResolverDeployment, day: number, nonces: number[]) {
  return Promise.all(nonces.map(async (n) => (await resolverHandsOut(d, day, n)).address))
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

beforeEach(() => {
  mocks.readAccountResolution.mockReset()
  mocks.fetchSipaEvents.mockReset()
})

describe("ResolverPaymentWatcher", () => {
  it("polls the addresses each deployment's resolver hands out for yesterday and today, in one read", async () => {
    const read = chain()
    const dai = deployment("DAI")
    const susds = deployment("sUSDS")
    const { watcher } = makeWatcher(read, [dai, susds])

    expect(await watcher.tick()).toBe(RESOLVER_PAYMENT_POLL_MS)

    expect(read).toHaveBeenCalledOnce()
    const nonces = range(0, 8)
    expect(polled(read)).toEqual([
      ...(await handedOut(dai, TODAY - 1, nonces)),
      ...(await handedOut(dai, TODAY, nonces)),
      ...(await handedOut(susds, TODAY - 1, nonces)),
      ...(await handedOut(susds, TODAY, nonces)),
    ])
    // Each address is read in its own deployment's tokens.
    const holdings = read.mock.calls[0]![0] as Holdings
    expect(holdings[0]!.tokens).toEqual([DAI])
    expect(holdings[16]!.tokens).toEqual([SUSDS])
  })

  it("records a funded address as an incoming deposit on the tick that sees it", async () => {
    const dai = deployment("DAI")
    const paid = await resolverHandsOut(dai, TODAY, 2)
    const read = chain({ [paid.address]: { [DAI]: 25n * 10n ** 18n } })
    const { watcher, store, onFunded } = makeWatcher(read)

    await watcher.tick()

    expect(store.records.size).toBe(1)
    const record = store.get(paid.address) as never as Record<string, unknown>
    expect(record).toMatchObject({
      phase: "sweeping",
      amount: "25",
      tokenAddress: DAI,
      tokenSymbol: "DAI",
      recipientL2Address: RECIPIENT.toString(),
      messageSecret: paid.salt.toString(),
      recipientHash: paid.recipientCommitment,
      origin: {
        protocol: "account",
        sipaFactory: DAI_FACTORY,
        implementation: DAI_IMPLEMENTATION,
        intentHash: paid.intentHash,
        resweepable: true,
        recoveryAccount: RECOVERY_ACCOUNT,
      },
    })
    expect(isUnfundedSipaDeposit(record as never)).toBe(false)
    expect(onFunded).toHaveBeenCalledWith([expect.objectContaining({ sipaAddress: paid.address })])
  })

  it("leaves a record the store had not loaded yet", async () => {
    const dai = deployment("DAI")
    const paid = await resolverHandsOut(dai, TODAY, 2)
    const storage = new InMemoryStorageAdapter()
    const singleton = SIPADepositStore as unknown as { instance: SIPADepositStore | null }
    resetSingleton(singleton)
    await SIPADepositStore.get(storage).upsert(
      paid.address as Address,
      { phase: "claimed" },
      {
        recipientL2Address: RECIPIENT.toString(),
        messageSecret: paid.salt.toString(),
        recipientHash: paid.recipientCommitment,
        recoveryAddress: "",
        l1ChainId: 11155111,
        networkId: "0xnet",
        amount: "25",
        tokenSymbol: "DAI",
        startTime: 1,
      },
    )
    resetSingleton(singleton)
    const store = SIPADepositStore.get(storage)
    const read = chain({ [paid.address]: { [DAI]: 25n * 10n ** 18n } })
    const onFunded = vi.fn()
    const watcher = new ResolverPaymentWatcher({
      deployments: async () => [dai],
      keys: async () => ({ stealthScalar: STEALTH_SCALAR, recipient: RECIPIENT }),
      readHoldings: read,
      store,
      l1ChainId: 11155111,
      networkId: "0xnet",
      onFunded,
      now: () => NOW,
    })

    await watcher.tick()

    expect(store.get(paid.address as Address)?.phase).toBe("claimed")
    expect(onFunded).not.toHaveBeenCalled()
  })

  it("records the asset that arrived: sUSDS on its own deployment, ETH on any", async () => {
    const dai = deployment("DAI")
    const susds = deployment("sUSDS")
    const savings = await resolverHandsOut(susds, TODAY - 1, 0)
    const ether = await resolverHandsOut(dai, TODAY, 1)
    const read = chain({
      [savings.address]: { [SUSDS]: 3n * 10n ** 18n },
      [ether.address]: { [ZERO]: 10n ** 17n },
    })
    const { watcher, store } = makeWatcher(read, [dai, susds])

    await watcher.tick()

    expect(store.get(savings.address)).toMatchObject({
      amount: "3",
      tokenAddress: SUSDS,
      tokenSymbol: "sUSDS",
      origin: { sipaFactory: SUSDS_FACTORY, implementation: SUSDS_IMPLEMENTATION },
    })
    expect(store.get(ether.address)).toMatchObject({
      amount: "0.1",
      tokenAddress: ZERO,
      tokenSymbol: "ETH",
    })
  })

  it("moves the window past each used nonce and stops polling the recorded address", async () => {
    const dai = deployment("DAI")
    const first = await resolverHandsOut(dai, TODAY, 2)
    const read = chain({ [first.address]: { [DAI]: 10n ** 18n } })
    const { watcher } = makeWatcher(read)

    await watcher.tick()
    await watcher.tick()

    // Nonces 0 and 1 were handed out before 2 and may still be paid; 3..10 are the look-ahead.
    const today = polled(read, 1).slice(8)
    expect(today).toEqual(await handedOut(dai, TODAY, [0, 1, ...range(3, 11)]))
    expect(polled(read, 1).slice(0, 8)).toEqual(await handedOut(dai, TODAY - 1, range(0, 8)))
  })

  it("never derives past the per-day bound however far the used nonces reach", async () => {
    const dai = deployment("DAI")
    const store = makeStore()
    for (const nonce of range(0, 40)) {
      const { address, salt } = await resolverHandsOut(dai, TODAY, nonce)
      store.records.set(address, { messageSecret: salt.toString(), phase: "claimed" })
    }
    const read = chain()
    const { watcher } = makeWatcher(read, [dai], store)

    await watcher.tick()

    expect(polled(read)).toEqual(await handedOut(dai, TODAY - 1, range(0, 8)))
  })

  it("moves to the next day even when every watched address is recorded", async () => {
    const dai = deployment("DAI")
    const store = makeStore()
    for (const day of [TODAY - 1, TODAY])
      for (const nonce of range(0, 40)) {
        const { address, salt } = await resolverHandsOut(dai, day, nonce)
        store.records.set(address, { messageSecret: salt.toString(), phase: "claimed" })
      }
    const read = vi.fn(async (_holdings: Holdings) => ({
      timestamp: TIMESTAMP + 86_400n,
      balances: new Map<string, Map<string, bigint>>(),
    }))
    const { watcher } = makeWatcher(read as never, [dai], store)

    await watcher.tick()
    await watcher.tick()

    expect(read.mock.calls[0]![0]).toEqual([])
    expect(polled(read as never, 1)).toEqual(await handedOut(dai, TODAY + 1, range(0, 8)))
  })

  it("derives new addresses when a refreshed deployment changes an input", async () => {
    const deployments = [deployment("DAI")]
    const read = chain()
    const { watcher } = makeWatcher(read, deployments)

    await watcher.tick()
    deployments[0] = { ...deployments[0]!, implementation: SUSDS_IMPLEMENTATION as Address }
    await watcher.tick()

    expect(polled(read, 1)).toEqual([
      ...(await handedOut(deployments[0], TODAY - 1, range(0, 8))),
      ...(await handedOut(deployments[0], TODAY, range(0, 8))),
    ])
  })

  it("records nothing for an address discovery already holds under the same salt", async () => {
    const dai = deployment("DAI")
    const paid = await resolverHandsOut(dai, TODAY, 0)
    const store = makeStore()
    // A record discovery wrote under another address for this salt.
    store.records.set("0x1111111111111111111111111111111111111111", {
      messageSecret: paid.salt.toString(),
      phase: "broadcast",
    })
    const read = chain({ [paid.address]: { [DAI]: 10n ** 18n } })
    const { watcher } = makeWatcher(read, [dai], store)

    await watcher.tick()

    expect(store.records.size).toBe(1)
    expect(polled(read)).not.toContain(paid.address)
  })

  it("is the same record discovery finds when the resolver's event arrives", async () => {
    const dai = deployment("DAI")
    const paid = await resolverHandsOut(dai, TODAY, 3)
    const read = chain({ [paid.address]: { [DAI]: 5n * 10n ** 18n } })
    const { watcher, store } = makeWatcher(read)
    await watcher.tick()

    const tuple = {
      portal: DAI_PORTAL,
      sipaFactory: DAI_FACTORY,
      forwardingTable: DAI_TABLE,
      accountFactory: ACCOUNT_FACTORY,
      l2Token: "0x0f1c7a8b2b8a1f6de4b6a2c1c7e8d9f0a1b2c3d4e5f60718293a4b5c6d7e8f90",
      rollupVersion: ROLLUP_VERSION.toString(),
      sipaRecoveryProtocol: "account",
    } as unknown as OxideEnvTuple
    const event = { sharedSecretSalt: paid.salt, resweepable: true, intentHash: paid.intentHash }
    mocks.fetchSipaEvents.mockResolvedValue([event])
    const sync = (target: ReturnType<typeof makeStore>) =>
      syncSipaDeposits({
        publicClient: {
          getBlockNumber: vi.fn(async () => 100n),
          getBalance: vi.fn(async () => 0n),
        } as never,
        node: {} as never,
        wallet: {} as never,
        tokenServiceFor: async () => ({ claimSweptDeposit: vi.fn() }),
        store: target,
        tuple,
        recipient: RECIPIENT,
        stealthPublicKey: STEALTH_PUBLIC,
        recoveryAccount: RECOVERY_ACCOUNT,
        rows: [
          {
            portal: DAI_PORTAL as Address,
            l2Token: tuple.l2Token,
            token: DAI_TOKEN,
            swapped: [],
            intents: ["deposit", "registration", "metadata"],
          },
        ],
        l1ChainId: 11155111,
        networkId: "0xnet",
      })

    await sync(store)

    expect(store.records.size).toBe(1)
    expect(store.get(paid.address)).toMatchObject({
      messageSecret: paid.salt.toString(),
      origin: { intentHash: paid.intentHash },
    })
    expect(store.get(paid.address)).not.toHaveProperty("replayed")
    // Discovery alone, on a device that never polled, lands on the same address.
    const fresh = makeStore()
    await sync(fresh)
    expect([...fresh.records.keys()]).toEqual([paid.address])
    // And the watcher does not poll or record it again.
    await watcher.tick()
    expect(polled(read, 1)).not.toContain(paid.address)
    expect(store.records.size).toBe(1)
  })

  it("backs off on failed reads and returns to the poll cadence once a read succeeds", async () => {
    let fail = true
    const ok = chain()
    const read = vi.fn(async (holdings: Holdings) => {
      if (fail) throw new Error("rpc down")
      return ok(holdings)
    })
    const { watcher } = makeWatcher(read as never)

    const delays = []
    for (let i = 0; i < 7; i++) delays.push(await watcher.tick())
    fail = false
    delays.push(await watcher.tick())

    expect(delays).toEqual([
      24_000,
      48_000,
      96_000,
      192_000,
      RESOLVER_PAYMENT_MAX_BACKOFF_MS,
      RESOLVER_PAYMENT_MAX_BACKOFF_MS,
      RESOLVER_PAYMENT_MAX_BACKOFF_MS,
      RESOLVER_PAYMENT_POLL_MS,
    ])
    expect(read).toHaveBeenCalledTimes(8)
  })

  it("reads nothing while the wallet is locked", async () => {
    const read = chain()
    const watcher = new ResolverPaymentWatcher({
      deployments: async () => [deployment("DAI")],
      keys: async () => null,
      readHoldings: read,
      store: makeStore(),
      l1ChainId: 11155111,
      networkId: "0xnet",
    })

    expect(await watcher.tick()).toBe(RESOLVER_PAYMENT_POLL_MS)
    expect(read).not.toHaveBeenCalled()
  })
})

describe("readResolverDeployments", () => {
  const daiTuple = {
    portal: DAI_PORTAL,
    sipaFactory: DAI_FACTORY,
    forwardingTable: DAI_TABLE,
    accountFactory: ACCOUNT_FACTORY,
    accountMetadataRegistry: REGISTRY,
  } as unknown as OxideEnvTuple
  const susdsTuple = {
    ...daiTuple,
    portal: SUSDS_PORTAL,
    sipaFactory: SUSDS_FACTORY,
    forwardingTable: SUSDS_TABLE,
  }
  const sources: ResolverDeploymentSource[] = [
    { tuple: daiTuple, tokens: [DAI_TOKEN] },
    { tuple: susdsTuple, tokens: [SUSDS_TOKEN] },
  ]
  const resolution = (forwardingTable: string, publicKey = STEALTH_PUBLIC) => ({
    l2Address: RECIPIENT.toString(),
    rollupVersion: ROLLUP_VERSION,
    publicKey,
    operator: {
      owner: "0x0e00000000000000000000000000000000000003",
      l2Address: "0x01",
      url: "https://resolver.test/{sender}/{data}.json",
      forwardingTable,
      resolverPublicKey: RESOLVER_PUBLIC,
    },
  })
  const read = (s: ResolverDeploymentSource[]) =>
    readResolverDeployments({
      publicClient: {} as never,
      sources: s,
      recoveryAccount: RECOVERY_ACCOUNT,
      recipient: RECIPIENT,
      stealthPublicKey: STEALTH_PUBLIC,
    })

  it("serves only the forwarding table the account's operator names, with that deployment's tokens", async () => {
    mocks.readAccountResolution.mockResolvedValue(resolution(DAI_TABLE))

    expect(await read(sources)).toEqual([deployment("DAI")])
    // One registry, read once.
    expect(mocks.readAccountResolution).toHaveBeenCalledOnce()
  })

  it("serves a second asset whose own registry names an operator on its forwarding table", async () => {
    const own = {
      ...susdsTuple,
      accountMetadataRegistry: "0x7777777777777777777777777777777777777777",
    }
    mocks.readAccountResolution.mockImplementation(async (_c: unknown, registry: string) =>
      resolution(registry === REGISTRY ? DAI_TABLE : SUSDS_TABLE),
    )

    expect(await read([sources[0]!, { tuple: own, tokens: [SUSDS_TOKEN] }])).toEqual([
      deployment("DAI"),
      deployment("sUSDS"),
    ])
  })

  it("skips an account with no record, or one recorded under another key", async () => {
    mocks.readAccountResolution.mockResolvedValueOnce(null)
    expect(await read(sources)).toEqual([])
    mocks.readAccountResolution.mockResolvedValueOnce(resolution(DAI_TABLE, RESOLVER_PUBLIC))
    expect(await read(sources)).toEqual([])
  })
})
