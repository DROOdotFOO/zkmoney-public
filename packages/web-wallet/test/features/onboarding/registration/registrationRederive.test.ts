/**
 * A fresh device's registration discovery: every fee and salt derived through the multicall client
 * and checked with one balance multicall, after the boot's deposit replay, once per page load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const TOKEN = "0x00000000000000000000000000000000000000d1"
const RESOLVER_KEY = { x: 1n, y: 2n }
const L2 = `0x${"0e".repeat(32)}`

const sipaAt = (fee: bigint, salt?: string) =>
  `0x${salt ? "1" : "0"}${fee.toString(16).padStart(39, "0")}`

const h = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  bootReady: Promise.resolve(),
  balances: vi.fn(),
  seed: vi.fn(),
  legacySalt: vi.fn(() => "0x5a17"),
  depsClient: vi.fn(),
  deployed: vi.fn(),
}))

vi.mock("@obsidion/front-core", () => ({
  BOOT_WAIT_MS: 300_000,
  DEPOSITS_WAIT_MS: 60_000,
  composeWireNameHash: () => `0x${"0d".repeat(32)}`,
  deriveBootstrapKey: () => ({ address: "0x00000000000000000000000000000000000000b0" }),
  deriveRegistrationAddress: async (
    _deps: unknown,
    _owner: unknown,
    _name: unknown,
    fee: bigint,
    salt?: string,
  ) => ({
    derivation: { sipaAddress: sipaAt(fee, salt) },
    seed: { sipaAddress: sipaAt(fee, salt), registrationFee: fee },
  }),
  legacyRegistrationSalt: h.legacySalt,
}))
vi.mock("@obsidion/sdk", () => ({
  readSipaBalancesMany: h.balances,
  readSipaDeployedMany: h.deployed,
}))
vi.mock("@obsidion/core/constants", () => ({ REGISTRATION_SIGNED_FEES: [0n, 5n, 10n] }))
vi.mock("../../../../src/config/oxideTuple", () => ({
  l1MulticallClient: () => "multicall-client",
  oxideEnvFor: async () => ({
    env: { feeToken: TOKEN },
    publicClient: {},
    resolver: { resolverPublicKey: RESOLVER_KEY },
  }),
}))
vi.mock("../../../../src/features/onboarding/oxideOnboarding", () => ({
  registrationAddressDeps: async (...args: unknown[]) => (
    h.depsClient(args[5]),
    {
      env: { factory: "0xfa", ensDomain: "zk.money" },
      l1: { predictAccountAddress: async () => "0x00000000000000000000000000000000000000c3" },
      scheduleFee: async () => 5n,
      seedSipaDeposit: h.seed,
    }
  ),
}))
vi.mock("../../../../src/features/deposit/loadDepositFacts", () => ({
  sipaFundingTokens: () => [{ address: TOKEN, symbol: "TEST", decimals: 18 }],
}))
vi.mock("../../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "alice", address: L2 }),
}))
vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => ({ secret: 7n }) }),
}))
vi.mock("../../../../src/platform/storage/walletStorage", () => ({
  walletStorage: {
    getItem: (k: string) => h.storage.get(k) ?? null,
    setItem: (k: string, v: string) => h.storage.set(k, v),
  },
}))
vi.mock("../../../../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))

const held = (funded: Record<string, bigint>) => async (_client: unknown, sipas: string[]) =>
  new Map(sipas.map((s) => [s.toLowerCase(), new Map([[TOKEN, funded[s] ?? 0n]])]))

let discover: typeof import("../../../../src/features/onboarding/registrationRederive")["discoverRegistrationDeposits"]
const CONFIG = { network: "testnet" } as never
const boot = { after: () => h.bootReady.then(() => true) }

beforeEach(async () => {
  vi.resetModules()
  h.storage.clear()
  h.bootReady = Promise.resolve()
  h.balances.mockReset().mockImplementation(held({}))
  h.seed.mockReset()
  h.legacySalt.mockClear()
  h.depsClient.mockClear()
  h.deployed.mockReset().mockResolvedValue(new Set())
  discover = (await import("../../../../src/features/onboarding/registrationRederive"))
    .discoverRegistrationDeposits
})

const BOTH_SALTS = [undefined, "salt"].flatMap((salt) =>
  [5n, 0n, 10n].map((fee) => sipaAt(fee, salt)),
)

describe("discoverRegistrationDeposits", () => {
  it("seeds every funded address, under either salt", async () => {
    h.balances.mockImplementation(held({ [sipaAt(10n)]: 1n, [sipaAt(0n, "salt")]: 2n }))
    await expect(discover(CONFIG, "0xnet", boot)).resolves.toBe(2)
    expect(h.seed.mock.calls.map(([seed]) => seed.sipaAddress)).toEqual([
      sipaAt(10n),
      sipaAt(0n, "salt"),
    ])
  })

  it("seeds a swept address that holds nothing", async () => {
    h.deployed.mockResolvedValue(new Set([sipaAt(0n, "salt").toLowerCase()]))
    await expect(discover(CONFIG, "0xnet", boot)).resolves.toBe(1)
    expect(h.deployed.mock.calls[0][1]).toEqual(BOTH_SALTS)
    expect(h.seed).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: sipaAt(0n, "salt") }),
    )
  })

  it("searches again on the next page load until it finds an address", async () => {
    await expect(discover(CONFIG, "0xnet", boot)).resolves.toBe(0)
    expect([...h.storage.keys()]).toEqual([])
    vi.resetModules()
    h.balances.mockImplementation(held({ [sipaAt(5n)]: 1n }))
    discover = (await import("../../../../src/features/onboarding/registrationRederive"))
      .discoverRegistrationDeposits
    await expect(discover(CONFIG, "0xnet", boot)).resolves.toBe(1)
    expect([...h.storage.keys()]).toHaveLength(1)
    await expect(discover(CONFIG, "0xnet", boot)).resolves.toBe(0)
    expect(h.balances).toHaveBeenCalledTimes(2)
  })

  it("takes a failed balance read as a failed run, retried on the next page load only", async () => {
    h.balances.mockImplementation(async () => new Map())
    await expect(discover(CONFIG, "0xnet", boot)).rejects.toThrow("couldn't read the balance")
    await expect(discover(CONFIG, "0xnet", boot)).rejects.toThrow("couldn't read the balance")
    expect(h.balances).toHaveBeenCalledOnce()
    expect([...h.storage.keys()]).toEqual([])
  })

  it("shares one run between overlapping calls and waits for the boot's deposit replay", async () => {
    let ready!: () => void
    h.bootReady = new Promise<void>((resolve) => (ready = resolve))
    const first = discover(CONFIG, "0xnet", boot)
    const second = discover(CONFIG, "0xnet", boot)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.balances).not.toHaveBeenCalled()
    ready()
    await Promise.all([first, second])
    expect(h.balances).toHaveBeenCalledOnce()
  })
})
