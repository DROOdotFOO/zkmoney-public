/**
 * What the web withdraw rail persists about a mined burn. The tip is the load-bearing part: the
 * executor pays it out of the burned amount, and the record is the only place the sheet can learn
 * what the recipient is left with, since nothing reads it back off chain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { custom, getAddress, parseUnits, type Address, type Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { ScannedWithdrawEvent } from "@obsidion/sdk"
import {
  deriveBootstrapKey,
  deriveSwapEscrowRecoverySalt,
  withdrawalAmounts,
} from "@obsidion/front-core"
import { LIMIT, LIMIT_USD } from "../../support/publicLimit"
import {
  sendLikeTheWallet,
  watchWalletDb,
  type WalletSendOptions,
} from "../../support/submitBoundary"

const L2_TX = `0x${"0a".repeat(32)}` as Hex
const TX_AMOUNT_CAP = 5166n * 10n ** 18n
// The tip a swap commits to is whatever the confirm step's simulation said; the gateway takes it as given.
const RELAYER_TIP = 3n * 10n ** 18n
const SWAP_COMMIT = { relayerTip: RELAYER_TIP, amountOut: 96_000_000n, decimals: 6 }
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
// The wallet's Oxide account, as the stubbed account factory predicts it.
const ACCOUNT = getAddress(`0x${"ac".repeat(20)}`)
const SWAP_TUPLE = {
  swapEscrowFactoryV2: `0x${"fa".repeat(20)}`,
  accountFactory: `0x${"af".repeat(20)}`,
  portal: `0x${"70".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  // Leading byte below the BN254 modulus — AztecAddress rejects anything at or above the field.
  l2Broadcaster: `0x${"1b".repeat(32)}`,
}

// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
const executorAt = vi.fn(async (..._args: unknown[]) => ({ fee: 0n }))
vi.mock("../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: (...args: unknown[]) => executorAt(...args),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
  // The tracker's rails build an L1 client this suite never reads.
  l1Transport: () => custom({ request: async () => undefined }),
}))
// The portal alone resolves no withdrawal wiring, so the chain watcher is skipped. Swap tests
// override the tuple per-test via mockTuple.
const PORTAL_ONLY = { portal: `0x${"70".repeat(20)}` }
const WIRED_TUPLE = {
  ...PORTAL_ONLY,
  token: SWAP_TUPLE.token,
  l2Token: `0x${"2a".repeat(32)}`,
  plainWithdrawalExecutor: `0x${"e8".repeat(20)}`,
}
const mockTuple = vi.fn<() => Record<string, string>>(() => ({ ...PORTAL_ONLY }))
// Only the seams that would dial the network are stubbed; `requireTupleField` stays REAL, so the
// thin-manifest tests below assert the message and the rejection rule production actually has.
// A swap asks the account factory for the wallet's account.
const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
  functionName === "predictAccountAddress" ? ACCOUNT : undefined,
)
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => mockTuple(),
  l1PublicClient: () => ({ readContract }),
}))
vi.mock("../../../src/features/token/oxideToken", () => ({
  currentTxAmountCap: async () => TX_AMOUNT_CAP,
  portalDomainOfToken: async () => ({}),
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ fpcAddress: {}, policy: {} }),
  noteSubscribed: vi.fn(),
}))
vi.mock("../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
// The escrow's recovery account and salt derive from the passkey secret; an unlocked session
// answers it.
const MASTER_SECRET = { toString: () => `0x${"11".repeat(32)}` }
const mockSecretKey = vi.fn(async () => MASTER_SECRET as never)
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: mockSecretKey }),
}))

// planSwapOnWithdraw stays real, which is what makes the escrow assertions below meaningful. The
// rescan's event source reads PXE; the test hands it the events directly.
const scannedEvents = vi.fn<
  (source: { readExecutor(address: Address): Promise<unknown> }) => Promise<ScannedWithdrawEvent[]>
>(async () => [])
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  createWithdrawEventSource: vi.fn((source) => ({
    headBlock: async () => 100,
    listWithdrawals: () => scannedEvents(source),
    blockTimestampMs: async () => 1_234_000,
  })),
}))

const { planSwapLeg, rescanWithdrawals, submitSponsoredWithdrawal } = await import(
  "../../../src/features/withdraw/withdrawGateway"
)

const { getOperationStore } = await import("../../../src/features/operations/operations")
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)
const withdrawals = () => session().withdrawals
const clearWithdrawals = () =>
  Promise.all(
    withdrawals()
      .list.get()
      .records.map((r) => withdrawals().remove(r.localId)),
  )

const deps = () =>
  ({
    wallet: { networkId: "0xnet", node: { getContract: async () => ({}) }, pxe: {} },
    account: { getAddress: () => ({ toString: () => "0xuser" }) },
    contractService: {},
    screener: { screen: async () => ({ compliant: true }) },
    tokenService: {
      fetchTokenInformation: async () => ({ symbol: "DAI", decimals: 18 }),
      getTokenContract: vi.fn(async () => ({} as never)),
      exitToL1PrivateSponsored: vi.fn(async () => ({
        txHash: L2_TX,
        blockNumber: 42,
        amount: parseUnits("120", 18),
        humanReadableAmount: "120",
        l1Recipient: RECIPIENT,
      })),
    },
  } as unknown as Parameters<typeof submitSponsoredWithdrawal>[0])

describe("submitSponsoredWithdrawal", () => {
  beforeEach(async () => {
    localStorage.clear()
    mockTuple.mockReturnValue({ ...PORTAL_ONLY })
  })

  it("records the relayer tip beside the amount the burn removed", async () => {
    const record = await submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn())

    expect(record.phase).toBe("l2_mined")
    expect(record.rawAmount).toBe(parseUnits("120", 18).toString())
    expect(record.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    const stored = await withdrawals().get(record.localId)
    expect(stored?.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
  })

  it("stamps the recipient alias onto the record", async () => {
    const record = await submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), "Rainbow")
    expect(record.recipientAlias).toBe("Rainbow")
  })

  it("saves the burn's hash on the record before the node takes it, so a reload can track it", async () => {
    const d = deps()
    const db = watchWalletDb()
    let heldAtNode: boolean | undefined
    d.tokenService.exitToL1PrivateSponsored = (async (...args: unknown[]) => {
      await sendLikeTheWallet(args[3] as WalletSendOptions, L2_TX, () => {
        heldAtNode = db.holds("withdrawals", L2_TX)
      })
      return { txHash: L2_TX, blockNumber: 42, amount: parseUnits("120", 18) }
    }) as never

    await submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())
    expect(heldAtNode).toBe(true)
  })

  it("sends nothing when the hash cannot be saved, and fails the burn", async () => {
    const d = deps()
    watchWalletDb().refuse("withdrawals", L2_TX)
    const node = vi.fn()
    d.tokenService.exitToL1PrivateSponsored = (async (...args: unknown[]) => {
      await sendLikeTheWallet(args[3] as WalletSendOptions, L2_TX, node)
      return { txHash: L2_TX, blockNumber: 42, amount: parseUnits("120", 18) }
    }) as never

    await expect(submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())).rejects.toThrow(
      "quota exceeded",
    )
    expect(node).not.toHaveBeenCalled()
    expect(
      [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)[0],
    ).toMatchObject({ phase: "failed" })
  })

  it("keeps a burn that reached the node when the call then fails", async () => {
    const d = deps()
    ;(d.wallet as unknown as { node: object }).node = {
      getTxReceipt: vi.fn(async () => ({ status: "pending" })),
    }
    d.tokenService.exitToL1PrivateSponsored = (async (...args: unknown[]) => {
      await sendLikeTheWallet(args[3] as WalletSendOptions, L2_TX, () => {})
      throw new Error("fetch failed")
    }) as never

    const record = await submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())
    expect(record).toMatchObject({ phase: "submitting", l2TxHash: L2_TX })
    expect((await withdrawals().get(record.localId))?.failure).toBeUndefined()
    // Left to the chain: the operation is sent, and no flow owns it any more.
    const ops = getOperationStore()
    expect(ops.get(record.operationId!)).toMatchObject({ state: "sent", txHash: L2_TX })
    expect(ops.isLive(record.operationId!)).toBe(false)
  })

  it("drops the seeded record when the stage callback cancels before the burn", async () => {
    const cancel = (stage: string) => {
      if (stage === "proving") throw new Error("Cancelled")
    }
    await expect(submitSponsoredWithdrawal(deps(), RECIPIENT, "120", cancel)).rejects.toThrow(
      /Cancelled/,
    )
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
  })

  it("burns and records the prover tip it is given, and none by default", async () => {
    const tip = parseUnits("2", 18)
    const d = deps()
    const record = await submitSponsoredWithdrawal(
      d,
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "DAI",
      undefined,
      tip,
    )
    const exit = d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect((exit.mock.calls[0]![3] as { proverTip?: bigint }).proverTip).toBe(tip)
    expect(record.proverTip).toBe(tip.toString())
    expect(withdrawalAmounts(record).netAtomic).toBe(
      parseUnits("120", 18) - tip - WITHDRAW_RELAYER_TIP,
    )

    const plain = deps()
    const untipped = await submitSponsoredWithdrawal(plain, RECIPIENT, "120", vi.fn())
    const plainExit = plain.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect((plainExit.mock.calls[0]![3] as { proverTip?: bigint }).proverTip).toBe(0n)
    expect(untipped.proverTip).toBeUndefined()
  })

  // A stale sheet or a direct caller reaches the gateway with whatever amount it holds.
  it(`burns exactly ${LIMIT_USD} and refuses one atomic unit more before screening, recording or burning`, async () => {
    const exact = deps()
    await submitSponsoredWithdrawal(exact, RECIPIENT, String(LIMIT), vi.fn())
    const exit = exact.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect(exit.mock.calls[0]![1]).toBe(parseUnits(String(LIMIT), 18).toString())
    await clearWithdrawals()

    const over = deps()
    const screen = vi.spyOn(over.screener, "screen")
    const run = submitSponsoredWithdrawal(over, RECIPIENT, `${LIMIT}.000000000000000001`, vi.fn())
    await expect(run).rejects.toThrow(
      `This withdrawal is over the ${LIMIT_USD} limit, fees included.`,
    )
    expect(screen).not.toHaveBeenCalled()
    expect(over.tokenService.exitToL1PrivateSponsored).not.toHaveBeenCalled()
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
    expect(
      getOperationStore()
        .list()
        .filter((op) => op.state === "local"),
    ).toHaveLength(0)
  })
})

describe("submitSponsoredWithdrawal — swap-on-withdraw", () => {
  beforeEach(async () => {
    localStorage.clear()
    mockTuple.mockReturnValue(SWAP_TUPLE)
  })

  it("burns to the planned escrow with the broadcast riding the same tx", async () => {
    const d = deps()
    const record = await submitSponsoredWithdrawal(
      d,
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "USDC",
      SWAP_COMMIT,
    )

    // The burn recipient is the escrow, never the user's wallet — that stays on the record.
    const exitCall = (d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>).mock
      .calls[0]!
    const burnRecipient = exitCall[0] as { toString(): string }
    expect(record.recipient).toBe(RECIPIENT)
    expect(record.swapEscrow?.toLowerCase()).toBe(burnRecipient.toString().toLowerCase())
    expect(record.swapEscrow?.toLowerCase()).not.toBe(RECIPIENT.toLowerCase())

    expect(record.swapOutput).toBe("USDC")
    expect(record.swapNonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(record.swapRelayerTip).toBe(RELAYER_TIP.toString())
    expect(record.phase).toBe("l2_mined")

    // The escrow commits to this wallet's Oxide account under a salt only its secret re-derives,
    // and to the factory its address came from — both stored, so a later recovery targets the same
    // escrow.
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SWAP_TUPLE.accountFactory,
        functionName: "predictAccountAddress",
        args: [deriveBootstrapKey(MASTER_SECRET).address],
      }),
    )
    expect(record.swapRecoveryCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(record.swapEscrowFactory).toBe(SWAP_TUPLE.swapEscrowFactoryV2)
    expect(record.swapEscrowLayout).toBe("v2")

    // The sdk pairs the escrow's swap with the release.
    expect((exitCall[3] as { withdrawal?: unknown }).withdrawal).toEqual({
      tuple: SWAP_TUPLE,
      // The sdk reads the executor's fee, and asks the factory to confirm the escrow before the burn.
      l1: expect.objectContaining({ readContract: expect.any(Function) }),
      swap: expect.objectContaining({
        escrow: record.swapEscrow,
        escrowArgs: {
          route: expect.any(Number),
          recipient: RECIPIENT,
          daiForGas: 0n,
          minEthForGas: 0n,
          recoveryCommitment: record.swapRecoveryCommitment,
          relayerTip: RELAYER_TIP,
          nonce: record.swapNonce,
        },
        recovery: {
          account: ACCOUNT,
          salt: deriveSwapEscrowRecoverySalt(MASTER_SECRET, record.swapNonce!),
        },
      }),
    })
    expect((exitCall[3] as { meta?: unknown }).meta).toBeUndefined()
  })

  it("plans the escrow net of the prover tip the burn carries", async () => {
    const tip = parseUnits("2", 18)
    const d = deps()
    const record = await submitSponsoredWithdrawal(
      d,
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "USDC",
      SWAP_COMMIT,
      tip,
    )
    const exit = d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>
    expect((exit.mock.calls[0]![3] as { proverTip?: bigint }).proverTip).toBe(tip)
    expect(record.proverTip).toBe(tip.toString())

    // A tip that leaves the escrow nothing to swap fails the plan before anything is stored.
    const eaten = parseUnits("120", 18) - WITHDRAW_RELAYER_TIP - RELAYER_TIP
    await clearWithdrawals()
    const rejected = deps()
    await expect(
      submitSponsoredWithdrawal(
        rejected,
        RECIPIENT,
        "120",
        vi.fn(),
        undefined,
        "USDC",
        SWAP_COMMIT,
        eaten,
      ),
    ).rejects.toThrow("nothing left to swap")
    expect(rejected.tokenService.exitToL1PrivateSponsored).not.toHaveBeenCalled()
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
  })

  it("rebuilds the records a rescan finds and skips the burns already stored", async () => {
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: `0x${"1a".repeat(32)}`, claimedAt: 0 }),
    )
    // The rescan reads the account's burns only where the withdrawal rails resolve.
    mockTuple.mockReturnValue(WIRED_TUPLE)
    const d = deps()
    const known = await submitSponsoredWithdrawal(d, RECIPIENT, "120", vi.fn())
    const ESCROW = getAddress(`0x${"e5".repeat(20)}`)
    const RETIRED_EXECUTOR = getAddress(`0x${"e9".repeat(20)}`)
    scannedEvents.mockResolvedValue([
      {
        txHash: known.l2TxHash!,
        blockNumber: 42,
        executor: getAddress(WIRED_TUPLE.plainWithdrawalExecutor),
        withdrawalFee: 0n,
        l1Recipient: RECIPIENT,
        amount: parseUnits("120", 18),
        proverTip: 0n,
        relayerTip: WITHDRAW_RELAYER_TIP,
      },
      {
        txHash: `0x${"0b".repeat(32)}`,
        blockNumber: 50,
        // An executor the bridge no longer lists: the burn's own is what the record keeps.
        executor: RETIRED_EXECUTOR,
        withdrawalFee: 7n,
        l1Recipient: ESCROW,
        amount: parseUnits("60", 18),
        proverTip: 0n,
        relayerTip: WITHDRAW_RELAYER_TIP,
      },
    ])

    const rebuilt = await rescanWithdrawals(d.wallet, [{ tokenService: d.tokenService }])

    expect(rebuilt).toHaveLength(1)
    // The events name the address the burn pays, so a rebuilt escrow burn shows the escrow.
    expect(rebuilt[0]).toMatchObject({
      l2TxHash: `0x${"0b".repeat(32)}`,
      phase: "l2_mined",
      amount: "60",
      recipient: ESCROW,
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      startTime: 1_234_000,
      deployment: {
        portal: WIRED_TUPLE.portal,
        l2Token: WIRED_TUPLE.l2Token,
        executor: RETIRED_EXECUTOR,
      },
      withdrawalFee: "7",
      rebuilt: true,
    })
    // A new record names the executor the bridge lists.
    expect(known.deployment?.executor).toBe(WIRED_TUPLE.plainWithdrawalExecutor)
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      2,
    )
    // Memoized per page load and token: a second call is the same pass, and a token a later call
    // adds is scanned then.
    const scans = scannedEvents.mock.calls.length
    scannedEvents.mockResolvedValue([])
    const savings = {
      fetchTokenInformation: async () => ({
        ...(await d.tokenService.fetchTokenInformation()),
        symbol: "sUSDS",
      }),
      getTokenContract: vi.fn(async () => ({} as never)),
    }
    const again = await rescanWithdrawals(d.wallet, [
      { tokenService: d.tokenService },
      {
        tokenService: savings,
        tuple: { ...WIRED_TUPLE, l2Token: `0x${"5a".repeat(32)}` } as never,
      },
    ])
    expect(again).toEqual(rebuilt)
    expect(scannedEvents.mock.calls.length).toBe(scans + 1)
  })

  it("scans a token again when its pass could not read a burn's executor", async () => {
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: `0x${"1a".repeat(32)}`, claimedAt: 0 }),
    )
    mockTuple.mockReturnValue(WIRED_TUPLE)
    const d = deps()
    const token = {
      tokenService: d.tokenService,
      tuple: { ...WIRED_TUPLE, l2Token: `0x${"5b".repeat(32)}` } as never,
    }
    scannedEvents.mockImplementation(async (source) => {
      await source.readExecutor(getAddress(WIRED_TUPLE.plainWithdrawalExecutor)).catch(() => {})
      return []
    })
    executorAt.mockRejectedValueOnce(new Error("L1 read timed out"))
    const scans = scannedEvents.mock.calls.length

    await rescanWithdrawals(d.wallet, [token])
    await rescanWithdrawals(d.wallet, [token])
    await rescanWithdrawals(d.wallet, [token])

    // The read that failed drops the pass; the next one reads its executor and is kept.
    expect(scannedEvents.mock.calls.length).toBe(scans + 2)
    scannedEvents.mockImplementation(async () => [])
  })

  it("fails a pass run without every executor, so the next call scans the token again", async () => {
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: `0x${"1a".repeat(32)}`, claimedAt: 0 }),
    )
    const d = deps()
    scannedEvents.mockResolvedValue([])
    const token = {
      tokenService: d.tokenService,
      tuple: { ...WIRED_TUPLE, l2Token: `0x${"6b".repeat(32)}` } as never,
    }
    const scans = scannedEvents.mock.calls.length

    await expect(rescanWithdrawals(d.wallet, [{ ...token, partial: true }])).rejects.toThrow(
      "without every executor",
    )
    await rescanWithdrawals(d.wallet, [token])
    await rescanWithdrawals(d.wallet, [token])

    expect(scannedEvents.mock.calls.length).toBe(scans + 2)
  })

  it("persists the confirm-time simulation for the detail sheet", async () => {
    const record = await submitSponsoredWithdrawal(
      deps(),
      RECIPIENT,
      "120",
      vi.fn(),
      undefined,
      "ETH",
      { relayerTip: RELAYER_TIP, amountOut: parseUnits("0.5", 18), decimals: 18 },
    )

    const stored = await withdrawals().get(record.localId)
    expect(stored?.swapRelayerTip).toBe(RELAYER_TIP.toString())
    expect(stored?.swapEstimatedOut).toBe(parseUnits("0.5", 18).toString())
    expect(stored?.swapOutputDecimals).toBe(18)
  })

  it("refuses a swap without a simulated tip, before any record exists", async () => {
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "USDC"),
    ).rejects.toThrow(/Swap fee unavailable/)
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
  })

  it("fails before any record exists while the wallet is locked — no recoverer, no escrow", async () => {
    mockSecretKey.mockResolvedValueOnce(undefined as never)
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "USDC", SWAP_COMMIT),
    ).rejects.toThrow(/Unlock your wallet/)
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
  })

  it("fails before any record exists when the manifest names no account factory", async () => {
    mockTuple.mockReturnValue({ ...SWAP_TUPLE, accountFactory: "" })
    await expect(
      submitSponsoredWithdrawal(deps(), RECIPIENT, "120", vi.fn(), undefined, "USDC", SWAP_COMMIT),
    ).rejects.toThrow(/accountFactory/)
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
  })
})

describe("planSwapLeg", () => {
  it("commits to a given recoverer, salted from its secret, without the wallet's", async () => {
    mockTuple.mockReturnValue(SWAP_TUPLE)
    mockSecretKey.mockClear()
    readContract.mockClear()
    const secret = { toString: () => `0x${"22".repeat(32)}` }
    const leg = await planSwapLeg(
      {} as never,
      "USDC",
      RECIPIENT,
      parseUnits("120", 18),
      SWAP_COMMIT,
      { account: RECIPIENT, secret },
    )

    expect(leg!.plan.recovery).toEqual({
      account: RECIPIENT,
      salt: deriveSwapEscrowRecoverySalt(secret, leg!.plan.escrowArgs.nonce),
    })
    expect(mockSecretKey).not.toHaveBeenCalled()
    expect(readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "predictAccountAddress" }),
    )
  })
})
