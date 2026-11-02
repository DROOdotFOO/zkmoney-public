/**
 * The web side of the swap escrow exits: who is offered them and on what grounds, and how each is
 * wired — the channel it signs over, the address it pays, and for a recovery the account, salt and
 * passkey it opens the escrow's commitment with. The calls and the store write belong to
 * front-core's `runSwapEscrowExecute` / `runSwapEscrowRecovery`; the recovery runs for real only
 * where the wiring must open a real commitment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pad, toHex, type Address, type Hex } from "viem"
import type { WithdrawalRecord } from "@obsidion/front-core"

const RECIPIENT = `0x${"dd".repeat(20)}` as Address
const TYPED = `0x${"55".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const TOKEN = `0x${"22".repeat(20)}` as Address
const ACCOUNT = `0x${"ac".repeat(20)}` as Address
const OTHER_ACCOUNT = `0x${"bc".repeat(20)}` as Address
const FACTORY = `0x${"fa".repeat(20)}` as Address
const HASH = `0x${"ab".repeat(32)}` as Hex
const L2_TX = `0x${"0a".repeat(32)}` as Hex
const NONCE = `0x${"77".repeat(32)}` as Hex
const RELAYER_TIP = 5n * 10n ** 18n
const CHAIN_NOW = 1_700_000_000n
const SECRET = { toString: () => `0x${"11".repeat(32)}` }
const PASSKEY_KEY = { qx: `0x${"01".repeat(32)}` as Hex, qy: `0x${"02".repeat(32)}` as Hex }
const AUTH = {
  r: `0x${"03".repeat(32)}` as Hex,
  s: `0x${"04".repeat(32)}` as Hex,
  challengeIndex: 1n,
  typeIndex: 2n,
  authenticatorData: "0x" as Hex,
  clientDataJSON: "{}",
}

const h = vi.hoisted(() => ({
  runSwapEscrowExecute: vi.fn(),
  runSwapEscrowRecovery: vi.fn(),
  injectedWalletChannel: vi.fn(),
  desktopBridgeChannel: vi.fn(),
  ownSwapRecoverer: vi.fn(),
  oxideAccountPasskey: vi.fn(),
  provider: { kind: "webauthn" },
  getCode: vi.fn(),
  readAuthKeys: vi.fn(),
  sign: vi.fn(),
  signMessage: vi.fn(),
  connected: { current: "" as string },
  sendTransaction: vi.fn(),
  bridgeActive: { current: false },
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  runSwapEscrowExecute: h.runSwapEscrowExecute,
  runSwapEscrowRecovery: h.runSwapEscrowRecovery,
  createOxideL1Reader: () => ({ getCode: h.getCode, readAuthKeys: h.readAuthKeys }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  L1SwapEscrowReader: class {
    constructor(public client: unknown, public config: unknown) {}
    async daiBalance() {
      return RELAYER_TIP
    }
    async isDeployed() {
      return true
    }
  },
  decodePaylinkInline: () => ({ secret: SECRET }),
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({
  getL1Clients: async () => ({
    walletClient: { signMessage: h.signMessage },
    account: h.connected.current,
  }),
}))
vi.mock("../../../src/features/deposit/sipaRecovery", () => ({
  injectedWalletChannel: h.injectedWalletChannel,
  desktopBridgeChannel: h.desktopBridgeChannel,
}))
vi.mock("../../../src/platform/desktopBridge", () => ({
  isDesktopL1SubmitActive: () => h.bridgeActive.current,
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    sessionKeys: async () => ({ secretKey: SECRET, authProvider: h.provider }),
  }),
}))
vi.mock("../../../src/platform/auth/oxideAccountPasskey", () => ({
  oxideAccountPasskey: h.oxideAccountPasskey,
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: TOKEN }),
  l1PublicClient: () => ({
    kind: "public-client",
    getBlock: async () => ({ timestamp: CHAIN_NOW }),
  }),
}))
vi.mock("../../../src/features/withdraw/withdrawGateway", () => ({
  ownSwapRecoverer: h.ownSwapRecoverer,
}))

const { swapExitReasonFor } = await import("@obsidion/front-core")
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/platform/session"
)
afterEach(closeSession)
const { executeSwapWithdrawal, recoverSwapWithdrawal } = await import(
  "../../../src/features/withdraw/swapRecovery"
)
const { SWAP_ESCROW_RECOVERY_DEADLINE_S, SWAP_STUCK_THRESHOLD_MS, deriveSwapEscrowRecoverySalt } =
  await import("@obsidion/front-core")
const { runSwapEscrowRecovery: runRecoveryForReal } = await vi.importActual<
  typeof import("@obsidion/front-core")
>("@obsidion/front-core")
const { planSwapOnWithdraw } = await import("@obsidion/sdk")

/** The escrow a burn by `account`, salted from `secret`, commits to. */
const planFor = (account: Address, secret = SECRET) =>
  planSwapOnWithdraw({
    swapEscrowFactoryV2: FACTORY,
    output: "USDC",
    l1Recipient: RECIPIENT,
    recovery: { account, salt: deriveSwapEscrowRecoverySalt(secret, NONCE) },
    amount: 210n * 10n ** 18n,
    withdrawalFee: 0n,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    relayerTip: RELAYER_TIP,
    nonce: NONCE,
  })
const PLAN = planFor(ACCOUNT)

const NOW = 1_700_000_000_000

const record = (patch: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  localId: "wdraw_1",
  recipient: RECIPIENT,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  phase: "swapping",
  startTime: NOW - SWAP_STUCK_THRESHOLD_MS,
  phaseEnteredAt: NOW - SWAP_STUCK_THRESHOLD_MS,
  l2TxHash: L2_TX,
  swapOutput: "USDC",
  swapEscrow: PLAN.escrow,
  swapEscrowFactory: FACTORY,
  swapNonce: NONCE,
  swapRecoveryCommitment: PLAN.escrowArgs.recoveryCommitment,
  swapRelayerTip: RELAYER_TIP.toString(),
  ...patch,
})

beforeEach(async () => {
  h.runSwapEscrowExecute.mockReset().mockResolvedValue(HASH)
  h.runSwapEscrowRecovery.mockReset().mockResolvedValue(HASH)
  h.injectedWalletChannel.mockReset().mockResolvedValue({
    target: WALLET,
    kind: "injected",
    sendTransaction: h.sendTransaction,
    waitForReceipt: async () => true,
  })
  h.desktopBridgeChannel.mockReset().mockReturnValue({ target: TYPED, kind: "bridge" })
  h.ownSwapRecoverer.mockReset().mockResolvedValue({ account: ACCOUNT, secret: SECRET })
  h.oxideAccountPasskey.mockReset().mockResolvedValue({ key: PASSKEY_KEY, sign: h.sign })
  h.getCode.mockReset().mockResolvedValue("0x01")
  h.readAuthKeys.mockReset().mockResolvedValue([{ key: PASSKEY_KEY, metadata: "0x" }])
  h.sign.mockReset().mockResolvedValue(AUTH)
  h.signMessage.mockReset().mockResolvedValue(`0x${"05".repeat(65)}`)
  h.connected.current = RECIPIENT
  h.sendTransaction.mockReset().mockResolvedValue(HASH)
  await switchSession(activeNamespace()).withdrawals.create({ ...record(), networkId: "0xnet" })
  h.bridgeActive.current = false
})

describe("swapExitReasonFor", () => {
  it("always offers recovery to an escrow whose route cannot fill", () => {
    expect(swapExitReasonFor(record({ phase: "recoverable", phaseEnteredAt: NOW }), NOW)).toBe(
      "unswappable",
    )
  })
})

describe("executeSwapWithdrawal", () => {
  it("signs over the injected wallet and hands the runner the escrow reader and store", async () => {
    await expect(executeSwapWithdrawal(record(), { from: WALLET })).resolves.toBe(HASH)
    expect(h.injectedWalletChannel).toHaveBeenCalledWith(
      expect.objectContaining({ l1ChainId: 11155111 }),
      expect.objectContaining({ from: WALLET }),
    )
    const deps = h.runSwapEscrowExecute.mock.calls[0]![0] as Record<string, unknown>
    expect(deps.channel).toEqual(expect.objectContaining({ kind: "injected" }))
    expect(deps.reader).toEqual(expect.objectContaining({ config: { dai: TOKEN } }))
    expect(deps.store).toBe(session().withdrawals)
    expect(deps.record).toEqual(record())
  })
})

describe("recoverSwapWithdrawal", () => {
  it("opens the escrow's commitment and signs with the account's installed passkey", async () => {
    h.runSwapEscrowRecovery.mockImplementation(runRecoveryForReal)
    await expect(recoverSwapWithdrawal(record(), { from: WALLET })).resolves.toBe(HASH)
    expect(h.oxideAccountPasskey).toHaveBeenCalledWith(h.provider)
    expect(h.readAuthKeys).toHaveBeenCalledWith(ACCOUNT, 64)
    expect(h.sign).toHaveBeenCalledOnce()
    expect(h.sendTransaction).toHaveBeenCalledWith(PLAN.escrow, expect.stringMatching(/^0x/))
    const deadline = pad(toHex(CHAIN_NOW + SWAP_ESCROW_RECOVERY_DEADLINE_S)).slice(2)
    expect(h.sendTransaction.mock.calls[0]![1]).toContain(deadline)
    expect(await session().withdrawals.get(L2_TX)).toMatchObject({
      phase: "recovered",
      recoveryTarget: RECIPIENT,
    })
  })

  it("refuses an account still on its bootstrap key before any transaction", async () => {
    h.runSwapEscrowRecovery.mockImplementation(runRecoveryForReal)
    h.getCode.mockResolvedValue("0x")
    await expect(recoverSwapWithdrawal(record(), { from: WALLET })).rejects.toThrow(
      /Finish setting up your account's passkey/,
    )
    expect(h.sign).not.toHaveBeenCalled()
    expect(h.sendTransaction).not.toHaveBeenCalled()
  })

  describe("a paylink visitor's cash-out", () => {
    const LINK = "frag"
    // The visitor's escrow commits to the recipient, salted by the link secret.
    const visitor = () =>
      record({ swapRecoveryCommitment: planFor(RECIPIENT).escrowArgs.recoveryCommitment })

    it("is signed by the connected recipient wallet, with no account or passkey", async () => {
      h.runSwapEscrowRecovery.mockImplementation(runRecoveryForReal)
      await expect(
        recoverSwapWithdrawal(visitor(), { from: RECIPIENT, linkFragment: LINK }),
      ).resolves.toBe(HASH)
      expect(h.signMessage).toHaveBeenCalledWith({
        account: RECIPIENT,
        message: { raw: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
      })
      expect(h.ownSwapRecoverer).not.toHaveBeenCalled()
      expect(h.oxideAccountPasskey).not.toHaveBeenCalled()
      expect(h.sendTransaction).toHaveBeenCalledWith(PLAN.escrow, expect.stringMatching(/^0x/))
      expect(await session().withdrawals.get(L2_TX)).toMatchObject({
        phase: "recovered",
        recoveryTarget: RECIPIENT,
      })
    })

    it("refuses to sign from any wallet but the recipient's", async () => {
      h.runSwapEscrowRecovery.mockImplementation(runRecoveryForReal)
      h.connected.current = OTHER_ACCOUNT
      await expect(
        recoverSwapWithdrawal(visitor(), { from: OTHER_ACCOUNT, linkFragment: LINK }),
      ).rejects.toThrow(new RegExp(`Connect ${RECIPIENT}`))
      expect(h.signMessage).not.toHaveBeenCalled()
      expect(h.sendTransaction).not.toHaveBeenCalled()
    })

    it("has no desktop launcher path: the recipient's wallet must be in the browser", async () => {
      h.bridgeActive.current = true
      await expect(recoverSwapWithdrawal(visitor(), { linkFragment: LINK })).rejects.toThrow(
        /Open this link in a browser/,
      )
      expect(h.desktopBridgeChannel).not.toHaveBeenCalled()
    })
  })

  it("refuses a record without its escrow details before asking for the account", async () => {
    await expect(recoverSwapWithdrawal(record({ swapNonce: undefined }))).rejects.toThrow(
      /weren't stored/,
    )
    expect(h.ownSwapRecoverer).not.toHaveBeenCalled()
  })

  it("refuses a malformed destination and a locked wallet before touching a channel", async () => {
    await expect(
      recoverSwapWithdrawal(record(), { destination: "0x1234" as Address }),
    ).rejects.toThrow(/Ethereum address/)
    h.ownSwapRecoverer.mockRejectedValue(
      new Error("Unlock your wallet with your passkey and try again."),
    )
    await expect(recoverSwapWithdrawal(record())).rejects.toThrow(/Unlock your wallet/)
    expect(h.injectedWalletChannel).not.toHaveBeenCalled()
    expect(h.runSwapEscrowRecovery).not.toHaveBeenCalled()
  })
})
