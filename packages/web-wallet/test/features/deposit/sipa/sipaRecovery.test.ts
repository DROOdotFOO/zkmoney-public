/**
 * The web side of the recoverERC20 exit: the balance guard that keeps a recovery from settling a
 * deposit it never moved, and the two submission channels. The signature
 * and store write belong to front-core's `runSipaRecovery` and are covered there — here it is a
 * fake, so what these tests assert is the wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import type { SIPADepositRecord } from "@obsidion/front-core"
import { LIMIT_USD } from "../../../support/publicLimit"

const SIPA = `0x${"11".repeat(20)}` as Address
const TUPLE_TOKEN = `0x${"22".repeat(20)}` as Address
const RECORD_TOKEN = `0x${"33".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const TYPED = `0x${"55".repeat(20)}` as Address
const HASH = `0x${"ab".repeat(32)}` as Hex

const l1Clients = vi.hoisted(() => ({ getL1Clients: vi.fn() }))
const bridge = vi.hoisted(() => ({ submitViaDesktopBridge: vi.fn() }))

vi.mock("../../../../src/features/deposit/l1Wallet", () => l1Clients)
// The refund memo the recovery leaves lists the tokens the registration accepts, per network.
vi.mock("../../../../src/config/env", async (original) => ({
  ...(await original<object>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
}))
// The registration's table lists only its own token.
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../../support/depositTokens")
  return mockLoadDepositFacts(importOriginal, () => singleToken(RECORD_TOKEN))
})
vi.mock("../../../../src/platform/desktopBridge", () => ({
  isDesktopL1SubmitActive: () => false,
  ...bridge,
}))

const { desktopBridgeChannel, injectedWalletChannel, recoverSipaDeposit } = await import(
  "../../../../src/features/deposit/sipaRecovery"
)
type L1ExitStage = import("../../../../src/features/deposit/sipaRecovery").L1ExitStage
const { unsweepableCopy } = await import("../../../../src/features/deposit/unsweepableCopy")

const NOW = 1_700_000_000_000

const record = (patch: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: SIPA,
    recipientL2Address: "0xaa",
    messageSecret: "0x1",
    recipientHash: "0x2",
    recoveryAddress: "0x3",
    l1ChainId: 11155111,
    amount: "0.5",
    tokenSymbol: "DAI",
    phase: "recoverable",
    startTime: NOW,
    ...patch,
  } as SIPADepositRecord)

describe("recoverSipaDeposit", () => {
  const channel = {
    target: WALLET,
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const run = vi.fn(async () => HASH)
  const store = { get: vi.fn(() => null), upsert: vi.fn(), update: vi.fn() }
  const stealthKey = { scalar: 7n, publicKey: { x: 1n, y: 2n } }

  const deployment = {
    readDeployed: vi.fn(async () => true),
    candidates: [],
    predict: vi.fn(async () => SIPA),
  }
  const DAI = { address: TUPLE_TOKEN, symbol: "DAI", decimals: 18 }
  const USDC = { address: TYPED, symbol: "USDC", decimals: 6 }
  /** Answers each token's balance read from `held`, and zero for any other token. */
  const balances = (held: Record<Address, bigint> = {}) =>
    vi.fn(async (_sipa: Address, token: Address) => held[token] ?? 0n)
  const deps = (readBalance = balances(), tokens = [DAI], eth = 0n) => ({
    channel,
    chainId: 11155111,
    tokens: tokens as [typeof DAI, ...(typeof DAI)[]],
    readBalance,
    readEthBalance: vi.fn(async () => eth),
    readReceipt: async () =>
      ({
        status: "success",
        logs: [
          {
            address: RECORD_TOKEN,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: "Transfer",
              args: { from: SIPA, to: WALLET },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [5n * 10n ** 18n]),
          },
        ],
      } as never),
    deployment,
    store,
    stealthKey: async () => stealthKey as never,
    run: run as never,
  })

  beforeEach(() => {
    run.mockClear()
  })

  it("refuses a deposit whose note has not been discovered", async () => {
    const readBalance = balances({ [TUPLE_TOKEN]: 5n })
    await expect(
      recoverSipaDeposit(record({ messageSecret: "" }), deps(readBalance)),
    ).rejects.toThrow(/still looking up this deposit's details/)
    expect(readBalance).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("aborts on an empty SIPA rather than settling a deposit it never moved", async () => {
    await expect(
      recoverSipaDeposit(record({ tokenAddress: RECORD_TOKEN }), deps()),
    ).rejects.toThrow(/already been swept/)
    expect(run).not.toHaveBeenCalled()
  })

  it("flags the current-token fallback as inconclusive on a zero balance", async () => {
    // Without its own tokenAddress the read hit the CURRENT deployment's token — wrong contract
    // for a historic-generation SIPA, so zero must not read as "swept".
    await expect(recoverSipaDeposit(record(), deps())).rejects.toThrow(/predates token tracking/)
    expect(run).not.toHaveBeenCalled()
  })

  it("runs the recovery against the channel's target and the record's token", async () => {
    const readBalance = balances({ [RECORD_TOKEN]: 5n })
    const rec = record({ tokenAddress: RECORD_TOKEN })
    await expect(recoverSipaDeposit(rec, deps(readBalance))).resolves.toBe(HASH)
    // A token the list lacks is read too.
    expect(readBalance).toHaveBeenCalledWith(SIPA, RECORD_TOKEN)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        record: rec,
        target: WALLET,
        tokens: [RECORD_TOKEN],
        chainId: 11155111,
        stealthKey,
        store,
        deployment,
        sendTransaction: channel.sendTransaction,
        waitForReceipt: channel.waitForReceipt,
      }),
    )
  })

  const ETH_RECORD = { tokenAddress: zeroAddress, tokenSymbol: "ETH", tokenDecimals: 18 }
  const ACCOUNT = { origin: { protocol: "account" } as never }

  it("recovers ETH with recoverETH's zero-address token", async () => {
    const rec = record({ ...ETH_RECORD, ...ACCOUNT })
    await expect(recoverSipaDeposit(rec, deps(balances(), [DAI], 10n ** 16n))).resolves.toBe(HASH)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ record: rec, tokens: [zeroAddress] }),
    )
  })

  it("refuses an ETH deposit whose address holds no ETH", async () => {
    const rec = record({ ...ETH_RECORD, ...ACCOUNT })
    await expect(recoverSipaDeposit(rec, deps())).rejects.toThrow(/holds no ETH/)
    expect(run).not.toHaveBeenCalled()
  })

  it("recovers the tokens of an ETH record without the account protocol, and never its ETH", async () => {
    const d = deps(balances({ [TUPLE_TOKEN]: 5n }), [DAI], 1n)
    await expect(recoverSipaDeposit(record(ETH_RECORD), d)).resolves.toBe(HASH)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tokens: [TUPLE_TOKEN] }))
    expect(d.readEthBalance).not.toHaveBeenCalled()
    await expect(recoverSipaDeposit(record(ETH_RECORD), deps())).rejects.toThrow(
      /cannot recover ETH/,
    )
  })

  it("moves the accepted token that holds the funds, not the one the record names", async () => {
    const rec = record({ tokenAddress: TUPLE_TOKEN })
    const readBalance = balances({ [TYPED]: 5_000_000n })
    await expect(recoverSipaDeposit(rec, deps(readBalance, [DAI, USDC]))).resolves.toBe(HASH)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: [TYPED],
        record: expect.objectContaining({
          tokenAddress: TYPED,
          tokenSymbol: "USDC",
          tokenDecimals: 6,
        }),
      }),
    )
  })

  it("recovers every token with a balance in one run, the record's token first", async () => {
    const rec = record({ tokenAddress: TYPED, ...ACCOUNT })
    const readBalance = balances({ [TUPLE_TOKEN]: 5n, [TYPED]: 7n })
    await expect(recoverSipaDeposit(rec, deps(readBalance, [DAI, USDC], 1n))).resolves.toBe(HASH)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ record: rec, tokens: [TYPED, TUPLE_TOKEN, zeroAddress] }),
    )
  })

  describe("a token named in Settings", () => {
    const stranded = { address: RECORD_TOKEN, symbol: "WETH", decimals: 18 }
    const readBalance = () => balances({ [TUPLE_TOKEN]: 5n, [RECORD_TOKEN]: 7n })
    /** One stored record; `update` writes a patch unless it answers null, as the real store does. */
    const liveStore = (phase: SIPADepositRecord["phase"]) => {
      const live = record({ phase, tokenAddress: TUPLE_TOKEN })
      return {
        live,
        get: () => live,
        upsert: vi.fn(),
        update: vi.fn(async (_sipa: Address, patch: (r: SIPADepositRecord) => object | null) => {
          const next = patch(live)
          return next ? Object.assign(live, next) : null
        }),
      }
    }
    /** A run that writes `recovered` once its transaction confirms, as runSipaRecovery does. */
    const runWrites = (onSigned?: () => void) =>
      vi.fn(
        async (d: { store: { upsert: (sipa: Address, patch: object) => Promise<unknown> } }) => {
          onSigned?.()
          await d.store.upsert(SIPA, { phase: "recovered" })
          return HASH
        },
      )

    it("is recovered with the deposit tokens", async () => {
      const store = liveStore("recoverable")
      const run = runWrites()
      const d = { ...deps(readBalance()), store, stranded, run: run as never }
      await expect(recoverSipaDeposit(store.live, d)).resolves.toBe(HASH)
      expect(run.mock.lastCall?.[0]).toMatchObject({ tokens: [TUPLE_TOKEN, RECORD_TOKEN] })
      expect(store.live.phase).toBe("recovered")
    })

    it("leaves a settled record as it was, even one settled while the recovery was signed", async () => {
      const settled = liveStore("claimed")
      const d = { ...deps(readBalance()), stranded }
      await recoverSipaDeposit(settled.live, { ...d, store: settled, run: runWrites() as never })
      expect(settled.live.phase).toBe("claimed")

      const settling = liveStore("recoverable")
      const signedThenClaimed = runWrites(() => (settling.live.phase = "claimed"))
      await recoverSipaDeposit(settling.live, {
        ...d,
        store: settling,
        run: signedThenClaimed as never,
      })
      expect(settling.live.phase).toBe("claimed")
      expect(settling.upsert).not.toHaveBeenCalled()
    })

    it("refuses when the address no longer holds it", async () => {
      const store = liveStore("claimed")
      const d = { ...deps(balances({ [TUPLE_TOKEN]: 5n })), store, stranded }
      await expect(recoverSipaDeposit(store.live, d)).rejects.toThrow(/no longer holds any WETH/)
    })
  })

  it("remembers a registration deposit's recovery as its refund, whatever surface ran it", async () => {
    const { getPendingStore } = await import("../../../../src/features/onboarding/webRegistration")
    const { registrationRefunded } = await import(
      "../../../../src/features/onboarding/registrationQuoteRecovery"
    )
    localStorage.clear()
    const pending = await getPendingStore().upsert(
      WALLET,
      {},
      {
        tag: "demo",
        nameHash: HASH,
        l2Address: "0xaa",
        l1ChainId: 11155111,
        sipaAddress: SIPA,
        fee: "1",
        beneficiary: WALLET,
        depositToken: RECORD_TOKEN,
        broadcast: true,
        phase: "funded",
        fundedAt: NOW,
        retries: 0,
        startTime: NOW,
      },
    )
    expect(registrationRefunded(pending)).toBe(false)
    // Another token recovered off the address is not the registration's refund.
    await recoverSipaDeposit(record(), deps(balances({ [TUPLE_TOKEN]: 5n })))
    expect(registrationRefunded(pending)).toBe(false)
    expect(getPendingStore().get(WALLET)?.phase).toBe("funded")
    // The refund is read off an accepted token even when the recovery names ETH first.
    await recoverSipaDeposit(
      record({ ...ETH_RECORD, ...ACCOUNT }),
      deps(
        balances({ [RECORD_TOKEN]: 5n }),
        [DAI, { address: RECORD_TOKEN, symbol: "DAI", decimals: 18 }],
        1n,
      ),
    )
    expect(registrationRefunded(pending)).toBe(true)
    expect(getPendingStore().get(WALLET)).toMatchObject({ phase: "awaiting_deposit" })
  })
})

describe("injectedWalletChannel", () => {
  const config = { l1ChainId: 11155111, l1RpcUrl: "http://l1" } as never

  it("pays the connected account and reports a reverted tx", async () => {
    const chain = { id: 11155111 }
    const sendTransaction = vi.fn(async () => HASH)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "reverted" }))
    const estimateGas = vi.fn(async () => 1_000_001n)
    const getBlock = vi.fn(async () => ({ gasLimit: 60_000_000n }))
    l1Clients.getL1Clients.mockResolvedValue({
      walletClient: { sendTransaction },
      account: WALLET,
      chain,
    })
    const stages: L1ExitStage[] = []
    const channel = await injectedWalletChannel(config, {
      onStage: (s) => stages.push(s),
      readClient: { waitForTransactionReceipt, estimateGas, getBlock } as never,
    })

    expect(channel.target).toBe(WALLET)
    await expect(channel.sendTransaction(SIPA, "0xdeadbeef")).resolves.toBe(HASH)
    expect(sendTransaction).toHaveBeenCalledWith({
      to: SIPA,
      data: "0xdeadbeef",
      account: WALLET,
      chain,
      gas: 1_200_002n,
    })
    expect(estimateGas).toHaveBeenCalledWith({
      to: SIPA,
      data: "0xdeadbeef",
      account: WALLET,
      gas: 16_777_216n,
    })
    // The receipt is the only signal the funds actually moved.
    await expect(channel.waitForReceipt(HASH)).resolves.toBe(false)
    expect(stages).toEqual(["signing", "confirming"])
  })

  it.each([
    [11155111, 60_000_000n, 15_000_000n, 16_777_216n],
    [1, 60_000_000n, 16_777_216n, 16_777_216n],
    [11155111, 10_000_000n, 9_000_000n, 10_000_000n],
    [31337, 30_000_000n, 20_000_000n, 24_000_000n],
  ])(
    "bounds the margin by chain %s's transaction and block limits",
    async (chainId, blockLimit, estimate, expected) => {
      const sendTransaction = vi.fn(async () => HASH)
      l1Clients.getL1Clients.mockResolvedValue({
        walletClient: { sendTransaction },
        account: WALLET,
        chain: { id: chainId },
      })
      const channel = await injectedWalletChannel({ l1ChainId: chainId } as never, {
        readClient: {
          getBlock: vi.fn(async () => ({ gasLimit: blockLimit })),
          estimateGas: vi.fn(async () => estimate),
        } as never,
      })
      await channel.sendTransaction(SIPA, "0xdeadbeef")
      expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ gas: expected }))
    },
  )

  it.each(["revert", "oversized"])(
    "does not ask the wallet to sign after a %s estimate",
    async (failure) => {
      const sendTransaction = vi.fn(async () => HASH)
      const onStage = vi.fn()
      const revert = new Error("execution reverted: registration fee exceeds deposit")
      l1Clients.getL1Clients.mockResolvedValue({
        walletClient: { sendTransaction },
        account: WALLET,
        chain: { id: 11155111 },
      })
      const channel = await injectedWalletChannel(config, {
        onStage,
        readClient: {
          getBlock: vi.fn(async () => ({ gasLimit: 60_000_000n })),
          estimateGas: vi.fn(async () => {
            if (failure === "revert") throw revert
            return 21_000_000n
          }),
        } as never,
      })
      const submission = channel.sendTransaction(SIPA, "0xdeadbeef")
      if (failure === "revert") await expect(submission).rejects.toBe(revert)
      else await expect(submission).rejects.toThrow(/exceeds.*gas limit/i)
      expect(sendTransaction).not.toHaveBeenCalled()
      expect(onStage).not.toHaveBeenCalled()
    },
  )
})

describe("desktopBridgeChannel", () => {
  it("hands the prepared tx to the helper page and waits on our own client", async () => {
    bridge.submitViaDesktopBridge.mockResolvedValue(HASH)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }))
    const onHelperOpened = vi.fn()
    const stages: L1ExitStage[] = []
    const channel = desktopBridgeChannel({
      destination: TYPED,
      chainId: 11155111,
      publicClient: { waitForTransactionReceipt } as never,
      display: {
        title: "Recover your zk.money deposit",
        lines: [
          ["Amount", "0.5 DAI"],
          ["Deposit address", SIPA],
          ["Recovered to", TYPED],
        ],
      },
      onHelperOpened,
      onStage: (s) => stages.push(s),
    })

    // The typed address receives the funds; the helper's wallet only pays the gas.
    expect(channel.target).toBe(TYPED)
    await expect(channel.sendTransaction(SIPA, "0xdeadbeef")).resolves.toBe(HASH)
    const params = bridge.submitViaDesktopBridge.mock.calls[0][0]
    expect(params.tx).toEqual({ to: SIPA, data: "0xdeadbeef", chainId: 11155111 })
    expect(params.onHelperOpened).toBe(onHelperOpened)
    expect(params.display.title).toBe("Recover your zk.money deposit")
    expect(Object.fromEntries(params.display.lines)).toMatchObject({
      "Amount": "0.5 DAI",
      "Deposit address": SIPA,
      "Recovered to": TYPED,
    })

    await expect(channel.waitForReceipt(HASH)).resolves.toBe(true)
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH })
    expect(stages).toEqual(["awaiting-browser", "confirming"])
  })
})

describe("unsweepableCopy", () => {
  const ONE_DAI = "1000000000000000000"
  const TX_AMOUNT_CAP = 5166n * 10n ** 18n
  const copy = (patch: Partial<SIPADepositRecord>) => unsweepableCopy(record(patch), TX_AMOUNT_CAP)

  it("names the fee when the deposit is at or below the floor", () => {
    for (const amount of ["0.4", "1"]) {
      const text = copy({ amount, fee: ONE_DAI })
      expect(text).toContain("at or below the network's deposit fee (1 DAI)")
      expect(text).toContain("holds more than 1 DAI in total")
      // Two ways out, read as a choice.
      expect(text).toContain("Alternatively, you can recover the funds")
    }
  })

  it("names the ceiling case only where the amount the pool would forward exceeds it", () => {
    const over = copy({ amount: "8400", fee: ONE_DAI })
    expect(over).toContain("larger than the network can process in one deposit")
    expect(over).toContain("Waiting won't change this.")
    expect(over).not.toContain("deposit fee (")
    expect(over).not.toContain("same deposit address")
    expect(over).toContain("You can recover the funds")
    // The pool keeps the fee, so a gross of exactly ceiling + fee forwards exactly the ceiling.
    expect(copy({ amount: "5167", fee: ONE_DAI })).not.toContain("larger than the network")
    expect(copy({ amount: "5168", fee: ONE_DAI })).toContain("larger than the network")
    // With no fee on the record the gross is all there is to measure against.
    expect(copy({ amount: "5166" })).not.toContain("larger than the network")
    expect(copy({ amount: "5167" })).toContain("larger than the network")
    // An unread cap names no cause at that end.
    expect(unsweepableCopy(record({ amount: "8400", fee: ONE_DAI }))).not.toContain(
      "larger than the network",
    )
  })

  it("never shows the internal ceiling or a wait, and points to the published limit", () => {
    for (const tokenSymbol of ["DAI", "USDC", "TEST"]) {
      const text = copy({ amount: "8400", fee: ONE_DAI, tokenSymbol })
      expect(text).not.toMatch(/5[,.]?166/)
      expect(text).not.toMatch(/\b(minute|hour|refill|later)\b/i)
      expect(text).toContain(`Each deposit is limited to ${LIMIT_USD} sent, including fees.`)
      expect(text).toContain(`The limit counts 1 ${tokenSymbol} as $1.`)
    }
  })

  it("names the fee in the token sent", () => {
    const floor = copy({ amount: "0.4", fee: ONE_DAI, tokenSymbol: "USDC" })
    expect(floor).toContain("deposit fee (1 USDC)")
    expect(floor).toContain("holds more than 1 USDC in total")
    const small = copy({ amount: "0.2", fee: "250000000000000000", tokenSymbol: "USDC" })
    expect(small).toContain("deposit fee (0.25 USDC)")
  })

  it.each([
    ["between the fee and the cap", { amount: "95", fee: ONE_DAI }],
    ["for a record with no persisted fee", { amount: "0.4", fee: undefined }],
  ])("claims no cause it cannot prove %s", (_, patch) => {
    const text = copy(patch)
    expect(text).toContain("can't be moved into your private balance")
    expect(text).not.toContain("deposit fee (")
    expect(text).not.toContain("larger than the network")
    expect(text).toContain("recover the funds")
  })

  it("promises no recovery to a deposit discovered without its note secret", () => {
    const text = copy({ amount: "0.4", fee: ONE_DAI, messageSecret: "" })
    expect(text).toContain("at or below the network's deposit fee")
    expect(text).toContain("hasn't discovered yet")
  })
})
