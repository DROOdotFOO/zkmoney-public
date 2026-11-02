/**
 * The Savings source's move flow up to the burn: a move out connects its co-signer then, and tries
 * again after a failed connect; a move whose fees rose since its review stops before burning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SavingsMoveStorage,
  SkyFactoryMismatchError,
  type SavingsQuote,
} from "@obsidion/front-core"
import { InMemoryStorageAdapter } from "../../support/memoryStorage"
import {
  executorSubsidyAt,
  withdrawalExecutorAt,
} from "../../../src/features/withdraw/withdrawalFee"

const h = vi.hoisted(() => ({
  signerLoad: vi.fn(),
  signerToken: vi.fn(),
  loadTuple: vi.fn(),
  settle: vi.fn(),
  bridges: vi.fn(),
  manifestDeployments: vi.fn(),
  quote: vi.fn(),
  setTeeSigner: vi.fn(),
  runBurn: vi.fn(),
  factoryPortals: vi.fn(),
  exit: vi.fn(),
}))
const moves = new SavingsMoveStorage(new InMemoryStorageAdapter())
const TX_AMOUNT_CAP = 5166n * 10n ** 18n
const TUPLE = {
  portal: `0x${"71".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  l2Token: `0x${"2b".repeat(32)}`,
  l2Broadcaster: `0x${"2c".repeat(32)}`,
  plainWithdrawalExecutor: `0x${"e7".repeat(20)}`,
}
const SKY_EXECUTOR = `0x${"5e".repeat(20)}`
const FACTORY = "0xnew"

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  TokenService: {
    create: async () => ({
      getBalance: async () => 10n ** 30n,
      setTeeSigner: h.setTeeSigner,
      fetchTokenInformation: async () => ({ symbol: "sUSDS", decimals: 18 }),
    }),
  },
  registerBroadcaster: async () => ({}),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  quoteSavingsMove: h.quote,
  loadOxideManifestTuple: h.loadTuple,
  settleSavingsMoves: h.settle,
  skyBridgesOfFactory: h.bridges,
  readSavingsVault: async () => `0x${"cc".repeat(20)}`,
  resolveSkySavings: async () => ({
    deployments: { main: TUPLE, savings: TUPLE, skyExecutor: SKY_EXECUTOR },
    factory: { address: FACTORY },
  }),
  buildSavingsMove: async () => ({
    escrow: `0x${"ee".repeat(20)}`,
    nonce: `0x${"01".repeat(32)}`,
    recipientCommitment: `0x${"02".repeat(32)}`,
    skyMove: {},
    escrowOptions: {},
  }),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({
    network: "sandbox",
    l1ChainId: 31337,
    enclaveUrl: "/svc/enclave",
    oxideProfile: { manifestUrl: "http://manifest.test/sandbox.json" },
  }),
}))
vi.mock("../../../src/features/withdraw/withdrawalFee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/withdraw/withdrawalFee")>()),
  skyFactoryPortalsAt: h.factoryPortals,
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => TUPLE,
  getOxideDeployment: async () => ({ deployment: {} }),
  getManifestDeployments: h.manifestDeployments,
  oxideProfileKey: () => "profile",
  ASSET_TUPLE_TIMEOUT_MS: 20_000,
  getPortalTuple: (_config: unknown, portal: string) => h.loadTuple({ portal }),
  l1PublicClient: () => ({ getBlockNumber: async () => 100n }),
}))
vi.mock("../../../src/features/token/oxideToken", () => ({
  txAmountCap: async () => TX_AMOUNT_CAP,
  teeSignerOfToken: (token: string) => {
    h.signerToken(token)
    return h.signerLoad()
  },
}))
vi.mock("../../../src/features/limits/withdrawalLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/limits/withdrawalLimit")>()),
  assertWithinWithdrawalLimit: () => {},
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({}),
}))
vi.mock("../../../src/features/operations/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/operations/operations")>()),
  runOperation: (_meta: unknown, run: (op: unknown) => unknown) => run({ operationId: "op-1" }),
}))
vi.mock("../../../src/features/withdraw/withdrawGateway", () => ({
  noteSponsoredMine: () => {},
  ownSwapRecoverer: async () => ({ secret: {}, account: {} }),
  runBurn: h.runBurn,
  withdrawalOptions: () => ({}),
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => ({}) }),
}))
vi.mock("../../../src/features/savings/savingsMoveStore", () => ({
  getSavingsMoveStore: () => moves,
}))

const { createSavingsSource, savingsFinalizeDeployment } = await import(
  "../../../src/features/savings/savingsGateway"
)
const { SavingsQuoteChangedError } = await import("../../../src/features/savings/quoteChanged")
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)

const quoteOf = (net: bigint): SavingsQuote => ({
  direction: "in",
  amount: 100n,
  unit: `0x${"d1".repeat(20)}`,
  value: 100n,
  withdrawalFee: 0n,
  releaseTip: 1n,
  escrowTip: 1n,
  escrowFunding: 1n,
  net,
  fee: 100n - net,
})
const source = () =>
  createSavingsSource(
    {
      wallet: {},
      account: { getAddress: () => ({}), getCompleteAddress: () => "0xcomplete" },
      contractService: {},
      network: "sandbox",
      tokenService: {
        getBalance: async () => 10n ** 30n,
        fetchTokenInformation: async () => ({ symbol: "DAI" }),
        exitToL1PrivateSponsored: h.exit,
      },
    } as never,
    TUPLE as never,
  )

beforeEach(async () => {
  await moves.load()
  for (const fn of Object.values(h)) fn.mockReset()
  h.factoryPortals.mockResolvedValue({ daiPortal: TUPLE.portal, sUsdsPortal: TUPLE.portal })
  h.runBurn.mockResolvedValue({
    record: { localId: "w1", startTime: 1 },
    result: undefined,
  })
})

describe("createSavingsSource quote", () => {
  it("quotes through the session's cached executor reads", async () => {
    h.quote.mockResolvedValue(quoteOf(90n))
    await source().quote("in", 100n)
    expect(h.quote.mock.calls[0][0].executorReads).toEqual({
      executor: withdrawalExecutorAt,
      subsidy: executorSubsidyAt,
    })
  })
})

describe("createSavingsSource move", () => {
  it("connects the Savings co-signer before a move out, and tries again after a failed connect", async () => {
    const signer = { id: "tee" }
    h.signerLoad.mockRejectedValueOnce(new Error("TEE not registered")).mockResolvedValue(signer)
    h.quote.mockResolvedValue(quoteOf(90n))
    const savings = source()
    await savings.readPrice().catch(() => {})
    expect(h.signerLoad).not.toHaveBeenCalled()
    await expect(savings.move("out", 100n, () => {})).rejects.toThrow(
      "The Savings co-signer isn't reachable. Try again in a moment.",
    )
    expect(h.runBurn).not.toHaveBeenCalled()
    await savings.move("out", 100n, () => {})
    expect(h.setTeeSigner).toHaveBeenCalledWith(signer)
    expect(h.runBurn).toHaveBeenCalledTimes(1)
  })

  it("stops a move whose fees rose since its review, with the new quote, and burns at the reviewed fees", async () => {
    const savings = source()
    h.quote.mockResolvedValue(quoteOf(90n))
    await savings.quote("in", 100n)
    h.quote.mockResolvedValue(quoteOf(80n))
    const refused = savings.move("in", 100n, () => {})
    await expect(refused).rejects.toBeInstanceOf(SavingsQuoteChangedError)
    await expect(refused).rejects.toMatchObject({ quote: { net: 80n } })
    expect(h.runBurn).not.toHaveBeenCalled()
    // The refused move's quote is now the one reviewed: confirming it again burns.
    await savings.move("in", 100n, () => {})
    expect(h.runBurn).toHaveBeenCalledTimes(1)
  })

  it("refuses a move out over the network's maximum per burn before anything is signed", async () => {
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue(quoteOf(90n))
    await expect(source().move("out", TX_AMOUNT_CAP + 1n, () => {})).rejects.toThrow(
      "over the network's maximum per withdrawal",
    )
    expect(h.runBurn).not.toHaveBeenCalled()
  })

  it("names a move's dollar value on its burn, for the bell to show instead of a share count", async () => {
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue({ ...quoteOf(90n), value: 105n })
    await source().move("out", 100n, () => {})
    expect(h.runBurn.mock.calls[0][0].record.skyMove).toMatchObject({ value: "105" })
    // The move's record names the executor its burn pays: a move out's is the Sky executor.
    expect(h.runBurn.mock.calls[0][0].record.deployment).toEqual({
      portal: TUPLE.portal,
      l2Token: TUPLE.l2Token,
      executor: SKY_EXECUTOR,
    })
  })

  // `runBurn`'s tests hold that the hash is saved before the node, and a failed save sends nothing.
  it("hands the sdk the burn's hash save, awaited before the node takes the burn", async () => {
    h.quote.mockResolvedValue(quoteOf(90n))
    await source().move("in", 100n, () => {})
    const stamp = async () => {}
    await h.runBurn.mock.calls[0][0].burn({}, stamp)
    expect(h.exit.mock.calls[0][3]).toMatchObject({ onTxHash: stamp })
  })

  it("burns a move in through Main's plain executor", async () => {
    h.quote.mockResolvedValue(quoteOf(90n))
    await source().move("in", 100n, () => {})
    expect(h.runBurn.mock.calls[0][0].record.deployment.executor).toBe(
      TUPLE.plainWithdrawalExecutor,
    )
  })

  it("checks the factory's portals before each burn, and burns when they are Main's and Savings'", async () => {
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue(quoteOf(90n))
    const savings = source()
    await savings.move("in", 100n, () => {})
    await savings.move("out", 100n, () => {})
    expect(h.factoryPortals).toHaveBeenCalledTimes(2)
    expect(h.factoryPortals).toHaveBeenCalledWith(FACTORY)
    expect(h.runBurn).toHaveBeenCalledTimes(2)
  })

  it("refuses a move either way when the factory deposits elsewhere, before any co-signer or burn", async () => {
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue(quoteOf(90n))
    h.factoryPortals.mockResolvedValue({
      daiPortal: TUPLE.portal,
      sUsdsPortal: `0x${"9e".repeat(20)}`,
    })
    const savings = source()
    for (const direction of ["in", "out"] as const) {
      await expect(savings.move(direction, 100n, () => {})).rejects.toBeInstanceOf(
        SkyFactoryMismatchError,
      )
    }
    expect(h.signerLoad).not.toHaveBeenCalled()
    expect(h.quote).not.toHaveBeenCalled()
    expect(h.runBurn).not.toHaveBeenCalled()
  })

  it("connects the Savings co-signer for the Savings token", async () => {
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue(quoteOf(90n))
    await source().move("out", 100n, () => {})
    expect(h.signerToken).toHaveBeenCalledWith(TUPLE.l2Token)
  })

  it("finalizes an older move on the Savings deployment its burn was made on, else the current one", async () => {
    const old = { ...TUPLE, portal: `0x${"0d".repeat(20)}`, l2Token: `0x${"0e".repeat(32)}` }
    h.loadTuple.mockResolvedValue(old)
    h.signerLoad.mockResolvedValue({ id: "tee" })
    const older = await savingsFinalizeDeployment({
      deployment: { portal: old.portal as `0x${string}`, l2Token: old.l2Token },
    })
    expect(h.loadTuple).toHaveBeenCalledWith(expect.objectContaining({ portal: old.portal }))
    expect(older.tuple).toBe(old)
    expect(h.signerToken).toHaveBeenLastCalledWith(old.l2Token)
    h.loadTuple.mockClear()
    const current = await savingsFinalizeDeployment({})
    expect(current.tuple).toBe(TUPLE)
    expect(h.loadTuple).not.toHaveBeenCalled()
  })

  it("settles an older move on the bridge its factory's feature binds, and a current one on the current", async () => {
    const OLD = `0x${"0b".repeat(20)}`
    const older = { ...TUPLE, portal: OLD, l2Token: `0x${"0c".repeat(32)}` }
    const listed = [{ label: "older" }]
    h.manifestDeployments.mockResolvedValue(listed)
    h.bridges.mockImplementation(async (_client: unknown, deployments: unknown, factory: string) =>
      deployments === listed && factory === "0xold" ? { main: TUPLE, savings: older } : undefined,
    )
    await source().settle()
    const { destinationFor } = h.settle.mock.calls[0][1] as {
      destinationFor: (move: object) => Promise<{ portal: string }>
    }
    await expect(destinationFor({ direction: "in", factory: "0xold" })).resolves.toMatchObject({
      portal: OLD,
    })
    await expect(destinationFor({ direction: "out", factory: "0xold" })).resolves.toMatchObject({
      portal: TUPLE.portal,
    })
    h.manifestDeployments.mockClear()
    const current = await destinationFor({ direction: "in", factory: FACTORY })
    expect(current.portal).toBe(TUPLE.portal)
    expect(h.manifestDeployments).not.toHaveBeenCalled()
  })

  it("fails the search of a move whose factory no deployment lists, and looks again on the next pass", async () => {
    h.manifestDeployments.mockResolvedValue([])
    h.bridges.mockReturnValue(undefined)
    await source().settle()
    const { destinationFor } = h.settle.mock.calls.at(-1)![1] as {
      destinationFor: (move: object) => Promise<{ portal: string }>
    }
    await expect(destinationFor({ direction: "in", factory: "0xgone" })).rejects.toThrow(
      "No deployment lists the Sky escrow factory 0xgone",
    )
    h.bridges.mockReturnValue({ main: TUPLE, savings: TUPLE })
    await expect(destinationFor({ direction: "in", factory: "0xgone" })).resolves.toMatchObject({
      portal: TUPLE.portal,
    })
  })
})
