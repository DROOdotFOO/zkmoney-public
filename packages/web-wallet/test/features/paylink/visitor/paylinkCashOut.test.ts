/**
 * The bearer cash-out's bookkeeping. The burn itself is the sdk's and is covered on a sandbox; what
 * is web-specific is what the browser persists about it — a withdrawal record nobody signed in
 * owns, in the same store as the wallet's own, so the tracker finalizes it like any other.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"
import {
  sendLikeTheWallet,
  watchWalletDb,
  type WalletSendOptions,
} from "../../../support/submitBoundary"

const L2_TX = `0x${"0a".repeat(32)}` as Hex
const RECIPIENT = `0x${"dd".repeat(20)}` as Address
/** The escrow's whole balance; the burn takes all of it and the portal's fee comes out of it. */
const ESCROW = parseUnits("25", 18)
const SOURCE = { portal: `0x${"70".repeat(20)}`, l2Token: `0x${"11".repeat(32)}` }
/** The source executor's withdrawal fee. */
const FEE = parseUnits("0.1", 18)
/** The L1 client every burn's sdk options carry. */
const L1 = { l1: true }

vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1ChainId: 11155111 }),
  l1Transport: () => ({}),
}))
// The portal alone resolves no withdrawal wiring, so the record carries no deployment and the chain
// watcher is skipped — the assertions here are about what the burn writes, not about finalization.
vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => SOURCE,
  l1PublicClient: () => L1,
}))
vi.mock("../../../../src/features/token/oxideToken", () => ({
  txAmountCap: async () => 5166n * 10n ** 18n,
  oxideTokenImmutablesOf: async () => ({ symbol: "DAI", decimals: 18 }),
}))
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => FEE,
  withdrawalExecutor: async () => ({ fee: FEE }),
}))
const { claimSponsorRail } = vi.hoisted(() => ({
  claimSponsorRail: vi.fn(async () => ({ sponsor: { railId: 2 }, rail: { railId: 2 } })),
}))
vi.mock("../../../../src/features/onboarding/claimSponsorship", () => ({ claimSponsorRail }))

vi.mock("../../../../src/features/migration/historicTokenContext", () => ({
  findHistoricTuple: vi.fn(async () => null),
  historicTeeSigner: vi.fn(async () => ({ _id: "enclave" })),
}))

vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({ getAuthService: vi.fn() }))

const PH = "f0".repeat(32)
const analytics = vi.hoisted(() => ({ enabled: true, firePaylinkEvent: vi.fn() }))
vi.mock("../../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/lib/analytics")>()),
  analyticsEnabled: () => analytics.enabled,
  firePaylinkEvent: analytics.firePaylinkEvent,
  paylinkPh: async () => PH,
}))

const SWAP_ESCROW = `0x${"ee".repeat(20)}` as Address
const COMMITMENT = `0x${"c0".repeat(32)}` as Hex
const { planSwapLeg, linkSecret } = vi.hoisted(() => ({
  planSwapLeg: vi.fn(async (_wallet: unknown, receiveAsset: string) =>
    receiveAsset === "DAI"
      ? undefined
      : {
          output: receiveAsset,
          source: SOURCE,
          plan: {
            escrow: `0x${"ee".repeat(20)}`,
            escrowArgs: {
              nonce: `0x${"07".repeat(32)}`,
              recoveryCommitment: `0x${"c0".repeat(32)}`,
              relayerTip: 5n,
            },
            recovery: { account: `0x${"dd".repeat(20)}`, salt: { toString: () => "0x5a" } },
          },
        },
  ),
  linkSecret: { toString: () => "test-secret" },
}))
vi.mock("../../../../src/features/withdraw/withdrawGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/withdrawGateway")>()),
  planSwapLeg,
}))

const { exitPaylinkWithVoucher, paylinkVoucherUses, readPaylinkEscrowNote } = vi.hoisted(() => ({
  exitPaylinkWithVoucher: vi.fn(async (_args: Record<string, unknown>) => ({
    txHash: L2_TX,
    blockNumber: 42,
    amount: ESCROW,
    l1Recipient: RECIPIENT,
  })),
  paylinkVoucherUses: vi.fn(async () => 1),
  // The escrow note the burn spends; the link itself carries no amount.
  readPaylinkEscrowNote: vi.fn(async () => ({
    amount: ESCROW,
    tokenAddress: { toString: () => SOURCE.l2Token },
  })),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  decodePaylinkInline: () => ({
    secret: linkSecret,
    paylinkType: "paylink_direct",
    classId: { toString: () => "0xclass" },
    chainId: 31337,
    rollupVersion: 1,
  }),
  exitPaylinkWithVoucher,
  paylinkVoucherUses,
  readPaylinkEscrowNote,
}))

const { cashOutLink } = await import("../../../../src/features/paylink/paylinkExit")
const { getOperationStore } = await import("../../../../src/features/operations/operations")
const { reportPaylinkClaims } = await import("../../../../src/features/paylink/paylinkClaimReport")
const { webStorage } = await import("../../../../src/platform/storage/WebStorageAdapter")
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../../src/platform/session"
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

const deps = (compliant = true) =>
  ({
    wallet: {
      networkId: "0xnet",
      node: { getTxReceipt: vi.fn(async () => ({ status: TxStatus.PENDING })) },
      pxe: {},
    },
    contractService: { getContractAddress: async () => ({ toString: () => "0xtoken" }) },
    teeSigner: { _id: "enclave" },
    rollupAddress: `0x${"ab".repeat(20)}`,
    screener: { screen: async () => ({ compliant, reason: { message: "Sanctioned address" } }) },
  } as unknown as Parameters<typeof cashOutLink>[0])

const claimedEvents = () =>
  analytics.firePaylinkEvent.mock.calls.filter(
    ([e]) => (e as { stage: string }).stage === "claimed",
  )

describe("cashOutLink", () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it("burns a swap cash-out to the planned escrow, with its escrow args for the sdk's broadcast", async () => {
    const quote = { relayerTip: 5n, amountOut: 24_500_000n, decimals: 6 as const }
    const record = await cashOutLink(deps(), "fragment", RECIPIENT, undefined, "USDC", quote)
    // A bearer has no account: recovery commits to the destination, salted from the link secret.
    expect(planSwapLeg).toHaveBeenCalledWith(
      expect.anything(),
      "USDC",
      RECIPIENT,
      ESCROW,
      quote,
      { account: RECIPIENT, secret: linkSecret },
      SOURCE,
    )
    const args = exitPaylinkWithVoucher.mock.calls[0]![0] as {
      l1Recipient: { toString(): string }
      withdrawal: { tuple: unknown; l1: unknown; swap?: unknown }
    }
    expect(args.l1Recipient.toString().toLowerCase()).toBe(SWAP_ESCROW)
    expect(args.withdrawal).toEqual({
      tuple: SOURCE,
      l1: L1,
      swap: expect.objectContaining({
        escrowArgs: expect.objectContaining({ relayerTip: 5n }),
        recovery: expect.objectContaining({ account: RECIPIENT }),
      }),
    })
    expect(record).toMatchObject({
      recipient: RECIPIENT,
      swapOutput: "USDC",
      swapEscrow: SWAP_ESCROW,
      swapRecoveryCommitment: COMMITMENT,
      swapEstimatedOut: "24500000",
    })
  })

  it("records the burn as a paylink cash-out, with what the recipient is left with", async () => {
    const record = await cashOutLink(deps(), "fragment", RECIPIENT)

    expect(record.phase).toBe("l2_mined")
    expect(record.recipient).toBe(RECIPIENT)
    // Labelled like the account holder's own paylink burn, so the feed, the detail sheet and the
    // notifications say "paylink" for both.
    expect(record.source).toBe("paylink")
    expect(record.recipientProvenance).toBe("saved-recipient")
    // The escrow the burn spent — how the link page finds this record again.
    expect(record.paylinkId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(record.l2TxHash).toBe(L2_TX)
    // Gross is the escrow; the display amount is what lands once the executor's fee and the relayer
    // tip come out.
    expect(record.rawAmount).toBe(ESCROW.toString())
    expect(record.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    expect(record.withdrawalFee).toBe(FEE.toString())
    expect(record.amount).toBe(formatUnits(ESCROW - FEE - WITHDRAW_RELAYER_TIP, 18))
  })

  it("burns through the voucher rail with the link's escrow as the only identity", async () => {
    await cashOutLink(deps(), "fragment", RECIPIENT)

    expect(claimSponsorRail).toHaveBeenCalledWith(expect.anything(), "voucher", { tuple: SOURCE })
    const args = exitPaylinkWithVoucher.mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(args.sponsor).toEqual({ railId: 2 })
    expect(args.signer).toEqual({ _id: "enclave" })
    expect((args.l1Recipient as { toString(): string }).toString()).toBe(RECIPIENT)
  })

  it("refuses a blocked recipient before anything is burned or written", async () => {
    await expect(cashOutLink(deps(false), "fragment", RECIPIENT)).rejects.toThrow(
      /Sanctioned address/,
    )

    expect(exitPaylinkWithVoucher).not.toHaveBeenCalled()
    expect([...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(
      0,
    )
  })

  // The burn spends the whole escrow, so a link over the limit has no smaller amount to send.
  it(`cashes out a link of exactly ${LIMIT_USD} and refuses one atomic unit more before burning or writing`, async () => {
    const LIMIT_ATOMIC = parseUnits(String(LIMIT), 18)
    const note = (amount: bigint) => ({ amount, tokenAddress: { toString: () => SOURCE.l2Token } })
    try {
      readPaylinkEscrowNote.mockResolvedValue(note(LIMIT_ATOMIC))
      await cashOutLink(deps(), "fragment-at-limit", RECIPIENT)
      expect(exitPaylinkWithVoucher).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(claimedEvents()).toHaveLength(1))
      await clearWithdrawals()

      readPaylinkEscrowNote.mockResolvedValue(note(LIMIT_ATOMIC + 1n))
      await expect(cashOutLink(deps(), "fragment-over-limit", RECIPIENT)).rejects.toThrow(
        `This link holds more than the ${LIMIT_USD} withdrawal limit, so it cannot be claimed to an Ethereum wallet.`,
      )
      expect(exitPaylinkWithVoucher).toHaveBeenCalledTimes(1)
      expect(
        [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
      ).toHaveLength(0)
      expect(
        getOperationStore()
          .list()
          .filter((op) => op.state === "local"),
      ).toHaveLength(0)
      // Nothing was owed for the refused link.
      await reportPaylinkClaims(
        [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
        webStorage,
      )
      expect(claimedEvents()).toHaveLength(1)
    } finally {
      readPaylinkEscrowNote.mockResolvedValue(note(ESCROW))
    }
  })

  it("preserves a broadcast hash when waiting for its receipt fails", async () => {
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, () => {})
      throw new Error("Receipt timed out")
    })
    const record = await cashOutLink(deps(), "fragment", RECIPIENT)
    expect(record.phase).toBe("submitting")
    expect(record.l2TxHash).toBe(L2_TX)
    expect(record.failure).toBeUndefined()
    const op = getOperationStore().get(record.operationId!)
    expect(op).toMatchObject({ state: "sent", txHash: L2_TX, flow: "paylink-claim-l1" })
    expect(getOperationStore().isLive(record.operationId!)).toBe(false)
  })

  it("saves the burn's hash before the node takes it, and sends nothing when it cannot", async () => {
    const db = watchWalletDb()
    let heldAtNode: boolean | undefined
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, () => {
        heldAtNode = db.holds("withdrawals", L2_TX)
      })
      return { txHash: L2_TX, blockNumber: 42, amount: ESCROW, l1Recipient: RECIPIENT }
    })
    await cashOutLink(deps(), "fragment", RECIPIENT)
    expect(heldAtNode).toBe(true)

    db.refuse("withdrawals", L2_TX)
    const node = vi.fn()
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, node)
      return { txHash: L2_TX, blockNumber: 42, amount: ESCROW, l1Recipient: RECIPIENT }
    })
    await expect(cashOutLink(deps(), "fragment", RECIPIENT)).rejects.toThrow("quota exceeded")
    expect(node).not.toHaveBeenCalled()
  })

  it("makes a rejected broadcast retryable instead of returning a pending withdrawal", async () => {
    exitPaylinkWithVoucher.mockImplementationOnce(async (args) => {
      await sendLikeTheWallet(args as WalletSendOptions, L2_TX, () => {})
      throw new Error("Node rejected withdrawal")
    })
    const dependencies = deps()
    vi.mocked(dependencies.wallet.node.getTxReceipt).mockResolvedValue({
      status: TxStatus.DROPPED,
    } as never)
    await expect(cashOutLink(dependencies, "fragment", RECIPIENT)).rejects.toThrow(/Node rejected/)
    expect(
      [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime)[0]?.phase,
    ).toBe("failed")
  })
})

describe("cashOutLink claim reporting", () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
    analytics.enabled = true
  })

  it("reports the spent escrow as one claimed link, with no address, amount or hash", async () => {
    await cashOutLink(deps(), "fragment", RECIPIENT)
    await vi.waitFor(() => expect(claimedEvents()).toHaveLength(1))
    expect(claimedEvents()[0]).toEqual([
      { stage: "claimed", flavor: "direct", amount_bucket: "<50", paylink_ph: PH },
    ])
    const wire = JSON.stringify(analytics.firePaylinkEvent.mock.calls).toLowerCase()
    expect(wire).not.toContain("dd".repeat(20))
    expect(wire).not.toContain("0a".repeat(32))
    expect(wire).not.toContain(ESCROW.toString())
    // The withdrawals view reporting again finds nothing owed.
    await reportPaylinkClaims(
      [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
      webStorage,
    )
    expect(claimedEvents()).toHaveLength(1)
  })

  it("reports nothing from a browser without analytics consent", async () => {
    analytics.enabled = false
    await cashOutLink(deps(), "fragment", RECIPIENT)
    analytics.enabled = true
    await reportPaylinkClaims(
      [...(await withdrawals().all())].sort((a, b) => b.startTime - a.startTime),
      webStorage,
    )
    expect(claimedEvents()).toHaveLength(0)
  })
})
