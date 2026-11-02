/**
 * The web side of the self-finalize exit: who it refuses, how each classified builder failure is
 * worded, who takes the relayer tip, the phase-preserving record patch, and the two submission
 * channels — including that the desktop one asks for no address, because the burn already named
 * the recipient.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import {
  memoryBackend,
  openDatabase,
  createWithdrawals,
  type WithdrawalRecord,
  type Withdrawals,
} from "@obsidion/front-core"

const PORTAL = `0x${"cc".repeat(20)}` as Address
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const BURN_TX = `0x${"0a".repeat(32)}` as Hex
const WITHDRAWAL_ID = `0x${"c1".repeat(32)}` as Hex
const L1_TX = `0x${"ab".repeat(32)}` as Hex
const CALLDATA = "0xdeadbeef" as Hex

const l1Clients = vi.hoisted(() => ({ getL1Clients: vi.fn() }))
const bridge = vi.hoisted(() => ({
  submitViaDesktopBridge: vi.fn(),
  isDesktopL1SubmitActive: vi.fn(() => false),
}))

const sdk = vi.hoisted(() => ({
  buildWithdrawFinalizationCall: vi.fn(),
  portalDomain: vi.fn(async (portal: string) => ({ l1Portal: portal })),
}))

vi.mock("../../../src/features/deposit/l1Wallet", () => l1Clients)
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  buildWithdrawFinalizationCall: sdk.buildWithdrawFinalizationCall,
}))
vi.mock("../../../src/features/token/oxideToken", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/token/oxideToken")>()),
  portalDomain: sdk.portalDomain,
}))
vi.mock("../../../src/platform/desktopBridge", () => bridge)
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
  l1Transport: () => () => ({ request: async () => null }),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({
    portal: `0x${"cc".repeat(20)}`,
    l2Token: `0x${"0b".repeat(32)}`,
    plainWithdrawalExecutor: `0x${"e8".repeat(20)}`,
  }),
}))

const { WithdrawFinalizationError } = await import("@obsidion/sdk")
const { finalizeChannel, selfFinalize, selfFinalizeWithdrawal } = await import(
  "../../../src/features/withdraw/selfFinalize"
)

const record = (patch: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  localId: "wdraw_1",
  recipient: RECIPIENT,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  phase: "finalizing_l1",
  startTime: 1_700_000_000_000,
  l2TxHash: BURN_TX,
  withdrawalId: WITHDRAWAL_ID,
  ...patch,
})

const { activeNamespace, closeSession, switchSession } = await import(
  "../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)

describe("selfFinalizeWithdrawal", () => {
  const channel = {
    target: WALLET,
    sendTransaction: vi.fn(async () => L1_TX),
    waitForReceipt: vi.fn(async () => true),
  }
  let store: Withdrawals
  /** What the store holds for the burn while the receipt is awaited. */
  const seed = (held: WithdrawalRecord) => store.create({ ...held, networkId: "0xnet" })

  const deps = (
    over: {
      spent?: boolean
      isSpent?: () => Promise<boolean>
      build?: () => Promise<unknown>
    } = {},
  ) => ({
    channel,
    portal: PORTAL,
    l1: {} as never,
    store,
    isSpent: vi.fn(over.isSpent ?? (async () => over.spent ?? false)),
    build: (over.build ??
      vi.fn(async () => ({ to: PORTAL, data: CALLDATA, withdrawalId: WITHDRAWAL_ID }))) as never,
  })

  const throwing = (err: unknown) => () => Promise.reject(err)

  beforeEach(async () => {
    vi.clearAllMocks()
    channel.sendTransaction.mockResolvedValue(L1_TX)
    channel.waitForReceipt.mockResolvedValue(true)
    store = createWithdrawals({ db: openDatabase(memoryBackend()) })
    await seed(record())
  })

  it("refuses a withdrawal with no burn transaction to re-derive from", async () => {
    const d = deps()
    await expect(selfFinalizeWithdrawal(record({ l2TxHash: undefined }), d)).rejects.toThrow(
      /nothing to finalize/,
    )
    expect(d.isSpent).not.toHaveBeenCalled()
  })

  it("aborts before the expensive build when the withdrawal is already released", async () => {
    const d = deps({ spent: true })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(/A relayer finalized this/)
    expect(d.build).not.toHaveBeenCalled()
    expect(d.isSpent).toHaveBeenCalledWith({}, PORTAL, WITHDRAWAL_ID)
  })

  it.each([
    ["already-finalized", /A relayer finalized this/],
    ["not-yet-finalizable", /can't be finalized yet/],
    ["enclave-unavailable", /signing service is unreachable/],
  ] as const)("words a %s build failure honestly", async (reason, message) => {
    const d = deps({ build: throwing(new WithdrawFinalizationError(reason, "raw")) })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(message)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("names the submitting channel's account as the relayer tip's recipient", async () => {
    const d = deps()
    await selfFinalizeWithdrawal(record(), d)
    expect(d.build).toHaveBeenCalledWith(BURN_TX, WALLET)
  })

  it("takes the phase and the epoch the store holds when the receipt returns, not the snapshot", async () => {
    // The tracker owns both, and it runs while the receipt is awaited: a release it confirmed must
    // not rewind to `finalizing_l1`, and a demote it wrote must keep fencing.
    await seed(record({ phase: "done", reorgEpoch: 2 }))
    await selfFinalizeWithdrawal(record({ reorgEpoch: 1 }), deps())
    expect(await store.get(BURN_TX)).toMatchObject({
      phase: "done",
      finalizeTxHash: L1_TX,
      reorgEpoch: 2,
    })
  })

  it("words a revert as a lost race when the withdrawal has since been released", async () => {
    // The portal reverts a finalize a relayer beat to the release.
    channel.waitForReceipt.mockResolvedValue(false)
    let reads = 0
    const d = deps({ isSpent: async () => reads++ > 0 })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(/A relayer finalized this/)
    expect((await store.get(BURN_TX))?.finalizeTxHash).toBeUndefined()
  })

  it("keeps the revert wording when the post-revert read fails", async () => {
    channel.waitForReceipt.mockResolvedValue(false)
    let reads = 0
    const d = deps({
      isSpent: async () => {
        if (reads++ > 0) throw new Error("rpc down")
        return false
      },
    })
    await expect(selfFinalizeWithdrawal(record(), d)).rejects.toThrow(/still finalizable/)
  })
})

describe("selfFinalize", () => {
  // A link's burn has no recovery events to build the calldata from.
  it("leaves a paylink claim's burn to the relayer, before asking for the wallet", async () => {
    await expect(selfFinalize(record({ source: "paylink" }), null)).rejects.toThrow(
      "A relayer releases a link's withdrawal.",
    )
    await expect(selfFinalize(record(), null)).rejects.toThrow(/Unlock your wallet/)
  })

  describe("the executor the release goes through", () => {
    const LISTED = `0x${"e8".repeat(20)}`
    const wallet = { node: {}, signer: {}, wallet: {}, owner: {} } as never

    beforeEach(() => {
      vi.clearAllMocks()
      bridge.isDesktopL1SubmitActive.mockReturnValue(false)
      l1Clients.getL1Clients.mockResolvedValue({
        walletClient: { sendTransaction: vi.fn(async () => L1_TX) },
        publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) },
        account: WALLET,
        chain: { id: 11155111 },
      })
      sdk.buildWithdrawFinalizationCall.mockRejectedValue(new Error("stop at the builder"))
    })

    const executorOf = async (patch: Partial<WithdrawalRecord>) => {
      await expect(
        selfFinalize(record({ withdrawalId: undefined, ...patch }), wallet, { from: WALLET }),
      ).rejects.toThrow("stop at the builder")
      return sdk.buildWithdrawFinalizationCall.mock.calls[0]![0].executor
    }

    it("is the record's own, after its bridge lists another", async () => {
      const burned = `0x${"e1".repeat(20)}` as Hex
      expect(
        await executorOf({ deployment: { portal: PORTAL, l2Token: "0x2a", executor: burned } }),
      ).toBe(burned)
    })

    it("is the listed one for a record from before executor stamps", async () => {
      expect(await executorOf({ deployment: { portal: PORTAL, l2Token: "0x2a" } })).toBe(LISTED)
      sdk.buildWithdrawFinalizationCall.mockClear()
      expect(await executorOf({})).toBe(LISTED)
    })

    it("releases a burn on a retired deployment on its own portal, through its own executor", async () => {
      const retired = `0x${"0d".repeat(20)}` as Address
      const burned = `0x${"e1".repeat(20)}` as Hex
      expect(
        await executorOf({ deployment: { portal: retired, l2Token: "0x2a", executor: burned } }),
      ).toBe(burned)
      expect(sdk.portalDomain).toHaveBeenCalledWith(retired)
      expect(sdk.buildWithdrawFinalizationCall.mock.calls[0]![0].portal).toEqual({
        l1Portal: retired,
      })
    })

    it("refuses a record from before executor stamps made on another deployment", async () => {
      const retired = `0x${"0d".repeat(20)}` as Address
      await expect(
        selfFinalize(
          record({ withdrawalId: undefined, deployment: { portal: retired, l2Token: "0x2a" } }),
          wallet,
          { from: WALLET },
        ),
      ).rejects.toThrow("made on an earlier deployment")
      expect(sdk.buildWithdrawFinalizationCall).not.toHaveBeenCalled()
    })
  })
})

describe("finalizeChannel", () => {
  const config = { l1ChainId: 11155111, l1RpcUrl: "http://l1" } as never

  beforeEach(() => {
    vi.clearAllMocks()
    bridge.isDesktopL1SubmitActive.mockReturnValue(false)
  })

  it("takes no address in the desktop launcher — the burn already named the recipient", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    bridge.submitViaDesktopBridge.mockResolvedValue(L1_TX)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }))
    // No `destination` option exists to pass, and none is required.
    const channel = await finalizeChannel({
      config,
      record: record(),
      publicClient: { waitForTransactionReceipt } as never,
      opts: {},
    })

    // The helper page's account is unknown when the calldata is built, so the recipient is tipped.
    expect(channel.target).toBe(RECIPIENT)
    await expect(channel.sendTransaction(PORTAL, CALLDATA)).resolves.toBe(L1_TX)
    const params = bridge.submitViaDesktopBridge.mock.calls[0]![0]
    expect(params.tx).toEqual({ to: PORTAL, data: CALLDATA, chainId: 11155111 })
    expect(params.display.title).toBe("Finalize your zk.money withdrawal")
    expect(Object.fromEntries(params.display.lines)).toEqual({
      Amount: "210 DAI",
      Recipient: RECIPIENT,
      Network: "Sepolia",
    })
    await expect(channel.waitForReceipt(L1_TX)).resolves.toBe(true)
  })

  it("tips a swap's recipient in the desktop launcher, never the escrow the burn pays", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    const escrow = `0x${"e5".repeat(20)}` as Address
    const channel = await finalizeChannel({
      config,
      record: record({ swapOutput: "USDC", swapEscrow: escrow }),
      publicClient: {} as never,
      opts: {},
    })
    expect(channel.target).toBe(RECIPIENT)
  })
})
