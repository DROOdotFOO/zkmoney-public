import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  session: vi.fn(),
  sourceChain: vi.fn(),
  historicTokenContext: vi.fn(),
  frozenSource: vi.fn(),
  localSource: vi.fn(),
  fromGeneration: vi.fn((runtime: unknown) => ({ converted: runtime })),
  sweptDeposits: vi.fn(),
  savingsDeposits: vi.fn(async () => [] as unknown[]),
  updateBalance: vi.fn(),
  readSavingsPrice: vi.fn(),
  readSavingsVault: vi.fn(),
  savingsValue: vi.fn(),
  escrows: vi.fn(),
  linkRows: vi.fn(async () => ["row"]),
  routeFor: vi.fn<(...args: unknown[]) => unknown>(),
  feeBridge: vi.fn(),
  deployment: vi.fn(),
}))

vi.mock("@obsidion/front-core", () => ({
  createMetadataMigrationSession: h.session,
  pubkeyToR1KeyArg: () => "r1",
  UpgradeActivity: { get: () => ({}) },
  SIPADepositStore: { get: () => ({}) },
  BalanceStorage: { get: () => ({ updateBalance: h.updateBalance }) },
  readSavingsPrice: h.readSavingsPrice,
  readSavingsVault: h.readSavingsVault,
  savingsValue: h.savingsValue,
  WalletSyncCoordinator: {},
}))
vi.mock("@obsidion/sdk", () => ({
  createLocalMetadataMigrationSource: h.localSource,
  FrozenMetadataMigrationSource: class {
    constructor(readonly options: unknown) {
      h.frozenSource(options)
    }
  },
  frozenRuntimeFromSourceGeneration: h.fromGeneration,
  migrationRouteFor: (...args: unknown[]) => h.routeFor(...args),
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", oxideProfile: { portal: "0xcurrent" } }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  l1MulticallClient: () => ({ getBlockNumber: async () => 9n }),
  getRetiredRollupSources: async () => [historic],
  getFeeTokenBridgeTuple: () => h.feeBridge(),
  getOxideDeployment: () => h.deployment(),
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => ({}) }))
vi.mock("../../../src/platform/storage/activeStorage", () => ({
  getActiveStorageId: () => "store",
  getActiveCredentialId: () => "cred",
}))
vi.mock("../../../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../../../src/platform/auth/sessionErrors", () => ({ SessionChangedError: class {} }))
vi.mock("../../../src/features/onboarding/oxideOnboarding", () => ({
  collectOnboardingKeys: async () => ({ secretKey: "msk", pubkeyHex: "0xpub" }),
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: vi.fn(),
}))
vi.mock("../../../src/features/onboarding/rails", () => ({ RAIL_REGISTERED: "registered" }))
vi.mock("../../../src/features/token/oxideToken", () => ({
  portalContract: () => ({ getUnderlying: async () => ({ toString: () => "0xdai" }) }),
}))
vi.mock("../../../src/features/migration/historicTokenContext", () => ({
  sourceChain: h.sourceChain,
  historicTokenContext: h.historicTokenContext,
}))
vi.mock("../../../src/features/migration/sourceSavingsDeposits", () => ({
  sourceSavingsDeposits: h.savingsDeposits,
}))
vi.mock("../../../src/features/migration/sourceFrozenEscrows", () => ({
  sourceFrozenEscrows: h.escrows,
  sourceLinkRows: h.linkRows,
}))
vi.mock("../../../src/features/migration/sourceSipaSources", () => ({
  sourceSweptDeposits: h.sweptDeposits,
}))
vi.mock("../../../src/features/migration/oldVersionBalance", () => ({
  oldVersionScope: () => "old-scope",
}))

const { createWebMetadataMigration, createWebMetadataMigrationQuietly } = await import(
  "../../../src/features/migration/createWebMetadataMigration"
)
const { ManifestUnavailableError } = await import("../../../src/features/migration/freezeWatch")

const account = { getAddress: () => "0xacct" } as never
const destinationDeployment = { features: [], bridges: [] }
const route = { executor: "0xroute", subsidy: "0xsubsidy" }
const current = { portal: "0xcurrent", rollupVersion: "7" } as never
const historic = { portal: "0xv5portal", rollupVersion: "5", l2Token: "0xsource-token" } as never
const context = {
  destination: { portal: "0xdestportal", operationExecutor: "0xexecutor" },
  registered: {},
} as never

async function sourceFor(destination = current, withdrawal?: { tipRecipient?: `0x${string}` }) {
  await createWebMetadataMigration({
    wallet: {} as never,
    account,
    contractService: {} as never,
    toTokenService: {} as never,
    historic,
    current: destination,
    withdrawal: !!withdrawal,
    tipRecipient: withdrawal?.tipRecipient,
  })
  const { source } = h.session.mock.calls[0]![0]
  return source(context, "batches")
}

beforeEach(() => {
  vi.clearAllMocks()
  h.feeBridge.mockResolvedValue(current)
  h.deployment.mockResolvedValue({ deployment: destinationDeployment })
  h.routeFor.mockReset()
  h.routeFor.mockReturnValue(route)
  h.session.mockResolvedValue("session")
})

describe("createWebMetadataMigration — a source of another Aztec generation", () => {
  const runtime = { identity: "v5" }
  const refundRuntime = vi.fn<(o: unknown) => Promise<typeof runtime>>(async () => runtime)

  beforeEach(() => {
    h.sourceChain.mockResolvedValue({ kind: "generation", session: { refundRuntime } })
    h.sweptDeposits.mockResolvedValue({ descriptors: ["d"] })
    h.savingsDeposits.mockResolvedValue([])
  })

  it("refunds through the generation's runtime into the destination's executor", async () => {
    await sourceFor()
    expect(h.historicTokenContext).not.toHaveBeenCalled()
    expect(h.localSource).not.toHaveBeenCalled()
    const call = refundRuntime.mock.calls[0]![0] as {
      tuple: unknown
      tipRecipient: string
      depositDescriptors: () => Promise<unknown>
      paylinkRows: () => Promise<unknown>
    }
    expect(call.tuple).toBe(historic)
    expect(call.tipRecipient).toBe("0xexecutor")
    await expect(call.depositDescriptors()).resolves.toEqual(["d"])
    await expect(call.paylinkRows()).resolves.toEqual(["row"])
    expect(h.linkRows).toHaveBeenCalledWith({ tuple: historic, current, storageId: "store" })
    expect(h.sweptDeposits.mock.calls[0]![0].chain).toEqual({
      kind: "generation",
      session: { refundRuntime },
    })
    expect(h.frozenSource.mock.calls[0]![0]).toMatchObject({
      batches: "batches",
      destinationAsset: "0xdai",
      runtime: { converted: runtime },
    })
    // A frozen source refunds only through its destination's migration executor.
    expect((h.fromGeneration.mock.calls[0] as unknown[])[2]).toMatchObject({ route })
  })
})

describe("createWebMetadataMigration — a source this release reads", () => {
  it("keeps the local refund runtime and its token context", async () => {
    const chain = { kind: "pxe", wallet: "w", account: "a" }
    h.sourceChain.mockResolvedValue(chain)
    h.historicTokenContext.mockResolvedValue({ tokenService: "ts", teeSigner: "tee" })
    h.localSource.mockResolvedValue("local")
    await expect(sourceFor()).resolves.toBe("local")
    expect(h.historicTokenContext).toHaveBeenCalledWith("w", "a", historic)
    expect(h.localSource.mock.calls[0]![0]).toMatchObject({
      teeSigner: "tee",
      source: { tuple: historic, tokenService: "ts" },
      sourceChain: chain,
      destinationDeployment,
    })
    expect(h.frozenSource).not.toHaveBeenCalled()
    await h.localSource.mock.calls[0]![0].escrows()
    expect(h.linkRows).toHaveBeenCalledWith({ tuple: historic, current, storageId: "store" })
    expect(h.escrows).toHaveBeenCalledWith(
      expect.objectContaining({ chain, tuple: historic, rows: ["row"] }),
    )
  })
})

describe("createWebMetadataMigration — retired holdings", () => {
  beforeEach(() => {
    h.sourceChain.mockResolvedValue({ kind: "pxe", wallet: "w", account: "a" })
    h.historicTokenContext.mockResolvedValue({ tokenService: "ts", teeSigner: "tee" })
  })

  it("keeps the pinned deployment's holdings in DAI units", async () => {
    await sourceFor()
    await h.session.mock.calls[0]![0].holdings(10n, 9n)
    expect(h.updateBalance).toHaveBeenCalledWith(expect.any(String), "0xsource-token", 10n, 9n, {
      strict: true,
    })
    expect(h.readSavingsPrice).not.toHaveBeenCalled()
  })

  it("records a savings destination's holdings at its share price", async () => {
    h.readSavingsVault.mockResolvedValue("0xvault")
    h.readSavingsPrice.mockResolvedValue({ sharePrice: 120n })
    h.savingsValue.mockReturnValue(12n)
    await sourceFor({ portal: "0xsavings" } as never)
    await h.session.mock.calls[0]![0].holdings(10n, 9n)
    expect(h.readSavingsVault).toHaveBeenCalledWith(expect.anything(), "0xsavings")
    expect(h.readSavingsPrice).toHaveBeenCalledWith(expect.anything(), "0xvault")
    expect(h.savingsValue).toHaveBeenCalledWith(10n, 120n)
    expect(h.updateBalance).toHaveBeenCalledWith(expect.any(String), "0xsource-token", 12n, 9n, {
      strict: true,
    })
  })
})

it("passes an ordinary-recovery queue role through to the shared session", async () => {
  h.sourceChain.mockResolvedValue({ kind: "generation", session: {} })
  await createWebMetadataMigration({
    wallet: {} as never,
    account,
    contractService: {} as never,
    toTokenService: {} as never,
    historic,
    current,
    recoveryOnly: true,
  })
  expect(h.session.mock.calls[0]![0]).toMatchObject({ recoveryOnly: true })
})

describe("an unusable migration feature", () => {
  beforeEach(() => {
    h.routeFor.mockImplementation(() => {
      throw new Error("More than one migration feature serves the portal")
    })
  })

  it("refuses a source of another generation before it reads the source", async () => {
    const refundRuntime = vi.fn(async () => ({ identity: "v5" }))
    h.sourceChain.mockResolvedValue({ kind: "generation", session: { refundRuntime } })
    await expect(sourceFor()).rejects.toThrow()
    expect(refundRuntime).not.toHaveBeenCalled()
    expect(h.frozenSource).not.toHaveBeenCalled()
  })
})

describe("a manifest that can't be read", () => {
  const params = {
    wallet: {} as never,
    account,
    contractService: {} as never,
    toTokenService: {} as never,
    historic,
    current,
  }

  it("fails as a manifest read, never as a reportable error, for the route and the fee bridge", async () => {
    h.sourceChain.mockResolvedValue({ kind: "generation", session: { refundRuntime: vi.fn() } })
    h.deployment.mockRejectedValue(new Error("fetch failed"))
    await expect(sourceFor()).rejects.toBeInstanceOf(ManifestUnavailableError)
    h.feeBridge.mockRejectedValue(new Error("fetch failed"))
    await expect(createWebMetadataMigration(params)).rejects.toBeInstanceOf(
      ManifestUnavailableError,
    )
  })

  it("tries again quietly until it can be read, and stops on abort", async () => {
    vi.useFakeTimers()
    try {
      h.feeBridge.mockRejectedValueOnce(new Error("fetch failed"))
      const made = createWebMetadataMigrationQuietly(params, new AbortController().signal, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(made).resolves.toMatchObject({ lock: expect.any(Function) })
      expect(h.feeBridge).toHaveBeenCalledTimes(2)

      h.feeBridge.mockRejectedValue(new Error("fetch failed"))
      const stop = new AbortController()
      const stopped = createWebMetadataMigrationQuietly(params, stop.signal, 1_000)
      const settled = expect(stopped).rejects.toBeDefined()
      await vi.advanceTimersByTimeAsync(0)
      stop.abort()
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it("lets any other error through at once", async () => {
    const down = new Error("rpc down")
    h.session.mockRejectedValueOnce(down)
    await expect(
      createWebMetadataMigrationQuietly(params, new AbortController().signal, 1_000),
    ).rejects.toBe(down)
  })
})
