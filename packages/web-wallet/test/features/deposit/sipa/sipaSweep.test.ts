/**
 * The web side of the self-sweep exit: the pre-submit funding guard, the deposit intent's create2
 * args the deploy-and-sweep is bound to, and the two submission channels. `buildSipaSweepCall` runs
 * for real, so the target and calldata assertions are byte-exact against the SIPA-intents encoder
 * (the local mirror until it vendors).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  formatUnits,
  multicall3Abi,
  parseEther,
  type Address,
  type Hex,
} from "viem"
import {
  createPortalCapacityRegistry,
  createSipaProcessingObserver,
  type PortalCapacityKey,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"

const SIPA = `0x${"11".repeat(20)}` as Address
const OTHER_SIPA = `0x${"99".repeat(20)}` as Address
const TUPLE_TOKEN = `0x${"22".repeat(20)}` as Address
const RECORD_TOKEN = `0x${"33".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const TYPED = `0x${"55".repeat(20)}` as Address
const REGISTRY = `0x${"66".repeat(20)}` as Address
const SIPA_FACTORY = `0x${"77".repeat(20)}` as Address
const PORTAL = `0x${"cc".repeat(20)}` as Address
const FORWARDING_TABLE = `0x${"fb".repeat(20)}` as Address
const SUBSIDY = `0x${"aa".repeat(20)}` as Address
const COMMITMENT = `0x${"1f".repeat(32)}` as Hex
const RECOVERY_ADDRESS = `0x${"bb".repeat(20)}` as Address
const IMPL = `0x${"ee".repeat(20)}` as Address
const HASH = `0x${"ab".repeat(32)}` as Hex
const FEE = 10n
const TX_AMOUNT_CAP = 5166n * 10n ** 18n

const l1Clients = vi.hoisted(() => ({ getL1Clients: vi.fn() }))
const bridge = vi.hoisted(() => ({
  submitViaDesktopBridge: vi.fn(),
  isDesktopL1SubmitActive: vi.fn(() => false),
}))

vi.mock("../../../../src/features/deposit/l1Wallet", () => l1Clients)
vi.mock("../../../../src/platform/desktopBridge", () => bridge)

const { SELF_BROADCAST_RESWEEPABLE, buildDepositIntent, encodeSweep, MULTICALL3_ADDRESS } =
  await import("@obsidion/sdk")
const {
  AlreadySweptError,
  selfSweepDeposit,
  sweepChannel,
  sweepDeployArgs,
  sweepManifestFrom,
  SweepRefusedError,
} = await import("../../../../src/features/deposit/sipaSweep")
const { encodeErrorResult, toFunctionSelector } = await import("viem")
const { STUCK_SWEEP_MS } = await import("../../../../src/features/deposit/sipaRecovery")

/** The deposit intent this wallet's stealth `recipientHash` (COMMITMENT) commits to. */
const depositIntent = buildDepositIntent({ implementation: IMPL, recipientCommitment: COMMITMENT })

/**
 * The sweep calldata the encoder produces for `token` tipped to `relayer`, revealing the deposit
 * intent — byte equality against it pins the selector, the argument order, and the values in one
 * assertion.
 */
const sweepCalldata = (token: Address, relayer: Address): Hex =>
  encodeSweep({
    token,
    relayer,
    intentData: depositIntent.intentData,
    proofs: depositIntent.proofs,
  })

const NOW = 1_700_000_000_000

const record = (patch: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: SIPA,
    recipientL2Address: "0xaa",
    messageSecret: "0x1",
    recipientHash: COMMITMENT,
    recoveryAddress: RECOVERY_ADDRESS,
    l1ChainId: 11155111,
    amount: "0.5",
    tokenSymbol: "DAI",
    phase: "sweeping",
    startTime: NOW - STUCK_SWEEP_MS,
    ...patch,
  } as SIPADepositRecord)

const manifest = {
  sipaFactory: SIPA_FACTORY,
  forwardingTable: FORWARDING_TABLE,
  portal: PORTAL,
  rollupVersion: 4127419662n,
  token: TUPLE_TOKEN,
}

const tuple = {
  version: "t",
  gitSha: "0".repeat(40),
  timestamp: new Date(0).toISOString(),
  deployedAt: new Date(0).toISOString(),
  portal: PORTAL,
  token: TUPLE_TOKEN,
  l2Token: `0x${"dd".repeat(32)}`,
  enclaveUrl: "https://enclave.invalid",
  pcr0: "0".repeat(96),
  rollupVersion: "4127419662",
  registry: REGISTRY,
  sipaFactory: SIPA_FACTORY,
  forwardingTable: FORWARDING_TABLE,
  depositSubsidy: SUBSIDY,
} satisfies OxideEnvTuple

describe("sweepManifestFrom", () => {
  it("names the manifest field a thin deployment is missing", () => {
    const { sipaFactory: _dropped, ...thin } = tuple
    expect(() => sweepManifestFrom(thin)).toThrow(/sipaFactory/)
  })

  // The self-sweep claims no deposit subsidy, so a deployment that omits it still sweeps.
  it("builds without the deposit subsidy", () => {
    const { depositSubsidy: _dropped, ...thin } = tuple
    expect(sweepManifestFrom(thin)).toEqual(manifest)
  })

  it("refuses a non-numeric rollupVersion the CREATE2 derivation binds to", () => {
    expect(() => sweepManifestFrom({ ...tuple, rollupVersion: "v5" })).toThrow(/rollupVersion/)
  })
})

describe("sweepDeployArgs", () => {
  it("reproduces the deposit intent's create2 arguments from the record and the manifest", () => {
    // Field-for-field against the deposit intent the address was derived under: any drift here
    // deploys to a different address and the sweep reverts. `intentHash` binds the recipient
    // commitment, `implementation` the deposit intent type.
    expect(sweepDeployArgs(record(), manifest, IMPL)).toEqual({
      implementation: IMPL,
      intentHash: depositIntent.intentHash,
      recoveryAddress: RECOVERY_ADDRESS,
      rollupVersion: 4127419662n,
      resweepable: SELF_BROADCAST_RESWEEPABLE,
    })
  })

  it("keeps an account origin's forwarding table, which the address commits to", () => {
    const origin = {
      protocol: "account" as const,
      sipaFactory: SIPA_FACTORY,
      implementation: IMPL,
      intentHash: HASH,
      rollupVersion: "4127419662",
      resweepable: true,
      recoveryAccount: WALLET,
      recoveryCommitment: COMMITMENT,
      accountFactory: REGISTRY,
      forwardingTable: FORWARDING_TABLE,
    }
    expect(sweepDeployArgs(record({ origin }), manifest, IMPL)).toEqual({
      implementation: IMPL,
      intentHash: HASH,
      recoveryCommitment: COMMITMENT,
      rollupVersion: 4127419662n,
      resweepable: true,
      forwardingTable: FORWARDING_TABLE,
    })
  })
})

describe("selfSweepDeposit", () => {
  const channel = {
    target: WALLET,
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const store = { upsert: vi.fn(), get: vi.fn(() => null as SIPADepositRecord | null) }
  const predict = vi.fn(async () => SIPA)

  const deps = (
    over: {
      balance?: bigint
      /** `10^(feeDecimals - sentDecimals)`, as `readSipaFundingStatus` is given it. */
      scale?: bigint
      fee?: bigint
      deployed?: boolean
      predicted?: Address
    } = {},
  ) => {
    const balance = over.balance ?? 1_000n
    const scaledBalance = balance * (over.scale ?? 1n)
    const fee = over.fee ?? FEE
    return {
      channel,
      manifest,
      implementation: IMPL,
      txAmountCap: TX_AMOUNT_CAP,
      readDeployed: vi.fn(async () => over.deployed ?? false),
      readFunding: vi.fn(async () => ({
        balance,
        scaledBalance,
        fee,
        // The fee comes off first, and only what is forwarded meets the cap.
        sweepable: scaledBalance > fee && scaledBalance - fee <= TX_AMOUNT_CAP,
      })),
      predict: predict.mockResolvedValue(over.predicted ?? SIPA),
      store,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    channel.sendTransaction.mockResolvedValue(HASH)
    channel.waitForReceipt.mockResolvedValue(true)
    store.get.mockReturnValue(null)
  })

  it("refuses a deposit whose derived address inputs are missing", async () => {
    const d = deps()
    await expect(selfSweepDeposit(record({ recipientHash: "" }), d)).rejects.toThrow(
      /still looking up this deposit's details/,
    )
    expect(d.readFunding).not.toHaveBeenCalled()
  })

  it("aborts on an empty SIPA — the relayer won the race", async () => {
    await expect(
      selfSweepDeposit(record({ tokenAddress: RECORD_TOKEN }), deps({ balance: 0n })),
    ).rejects.toBeInstanceOf(AlreadySweptError)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("keeps an empty read on a record without its own token reportable", async () => {
    const sweep = selfSweepDeposit(record(), deps({ balance: 0n }))
    await expect(sweep).rejects.not.toBeInstanceOf(AlreadySweptError)
    await expect(sweep).rejects.toThrow(/predates token tracking/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("aborts on a balance that no longer clears the deposit fee, and says so", async () => {
    const floor = selfSweepDeposit(record(), deps({ balance: FEE }))
    await expect(floor).rejects.toBeInstanceOf(SweepRefusedError)
    await expect(floor).rejects.toThrow(
      /at or below the network's deposit fee, so it can't be moved into your private balance/,
    )
    expect(channel.sendTransaction).not.toHaveBeenCalled()
    // One unit above the fee is the first balance that moves.
    await expect(selfSweepDeposit(record(), deps({ balance: FEE + 1n }))).resolves.toBe(HASH)
  })

  it("names the ceiling, not the fee, on a balance topped up past it, as a refusal", async () => {
    // Over the ceiling by one unit: the portal credits `balance − fee`, so the window's top is the
    // fee above the ceiling.
    const over = deps({ balance: TX_AMOUNT_CAP + FEE + 1n })
    const sweep = selfSweepDeposit(record(), over)
    await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
    await expect(sweep).rejects.toThrow(
      /larger than the network can process in one deposit, so it can't be swept\. Recover it/,
    )
    await expect(sweep).rejects.not.toThrow(/cap|2[,.]?583/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
    // Exactly at it still sweeps.
    await expect(selfSweepDeposit(record(), deps({ balance: TX_AMOUNT_CAP + FEE }))).resolves.toBe(
      HASH,
    )
  })

  it("names the ceiling on a 6-decimal deposit measured against the 18-decimal fee it swaps into", async () => {
    // 50,000 USDC. In raw token units the balance reads as dust below the fee floor; in the fee's
    // own denomination it is far over the cap, which is what the sender has to be told.
    const usdc = deps({
      balance: 50_000_000_000n,
      scale: 10n ** 12n,
      fee: parseEther("0.25"),
    })
    await expect(selfSweepDeposit(record(), usdc)).rejects.toThrow(
      /larger than the network can process in one deposit/,
    )
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("deploy-and-sweeps an undeployed SIPA through Multicall3, tipping the channel's target", async () => {
    const d = deps({ deployed: false })
    await expect(selfSweepDeposit(record({ tokenAddress: RECORD_TOKEN }), d)).resolves.toBe(HASH)
    expect(d.readFunding).toHaveBeenCalledWith(SIPA, RECORD_TOKEN)

    const [to, data] = channel.sendTransaction.mock.calls[0] as unknown as [Address, Hex]
    expect(to).toBe(MULTICALL3_ADDRESS)
    const decoded = decodeFunctionData({ abi: multicall3Abi, data })
    const [calls] = decoded.args as unknown as [{ target: Address; callData: Hex }[]]
    expect(calls.map((c) => c.target.toLowerCase())).toEqual([SIPA_FACTORY, SIPA])
    // The tip returns to the submitter, not to a relayer.
    expect(calls[1]!.callData).toBe(sweepCalldata(RECORD_TOKEN, WALLET))
  })

  it("sweeps a deployed SIPA directly, and never predicts an address it will not deploy", async () => {
    const d = deps({ deployed: true })
    await expect(selfSweepDeposit(record(), d)).resolves.toBe(HASH)
    const [to, data] = channel.sendTransaction.mock.calls[0] as unknown as [Address, Hex]
    expect(to).toBe(SIPA)
    // Falls back to the manifest token for a record predating `tokenAddress` tracking.
    expect(data).toBe(sweepCalldata(TUPLE_TOKEN, WALLET))
    expect(d.predict).not.toHaveBeenCalled()
  })

  it("refuses to deploy when the args predict a different address", async () => {
    const d = deps({ predicted: OTHER_SIPA })
    await expect(selfSweepDeposit(record(), d)).rejects.toThrow(/different address/)
    expect(d.predict).toHaveBeenCalledWith(sweepDeployArgs(record(), manifest, IMPL))
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  // A sweep only reaches the portal; the claim rides the next scan of this tx's Sweep log. Rewinding a
  // claim that landed while the receipt was awaited would never heal: later scans skip the claimed index.
  it.each([
    ["no newer record", null, "sweeping"],
    ["a claim that landed meanwhile", record({ phase: "claimed" }), "claimed"],
  ] as const)(
    "marks the sweep submitted over %s, leaving the phase %s",
    async (_, stored, phase) => {
      store.get.mockReturnValue(stored)
      await selfSweepDeposit(record(), deps())
      expect(store.upsert).toHaveBeenCalledWith(SIPA, { phase, sweepTxHash: HASH })
    },
  )

  it("reports a reverted sweep as unexplained, a race being one possibility, and writes nothing", async () => {
    channel.waitForReceipt.mockResolvedValue(false)
    await expect(selfSweepDeposit(record(), deps())).rejects.toThrow(
      /could not determine why\. A relayer may have swept this deposit first/,
    )
    expect(store.upsert).not.toHaveBeenCalled()
  })

  describe("network capacity", () => {
    const blocked = {
      reason: {
        kind: "capacity" as const,
        requiredAtomic: 2n,
        availableAtomic: 1n,
        refill: { status: "unknown" as const },
        decimals: 18,
        observedAt: 1,
      },
      blocker: { kind: "capacity" as const, observedAt: 1 },
    }
    const unread = {
      reason: { kind: "unavailable" as const, cause: "capacity-unread" as const },
    }
    // A no-argument custom error's revert data is its selector.
    const revert = (
      errorName:
        | "Caps__GlobalLimitSurpassed"
        | "Caps__TxLimitSurpassed"
        | "OxidePortal__FrozenPortal",
    ) =>
      Object.assign(new Error("execution reverted"), {
        cause: { data: toFunctionSelector(`${errorName}()`) },
      })

    it("keeps a known blocker when the fresh read fails", async () => {
      const failedWithBlocker = { ...unread, blocker: blocked.blocker }
      await expect(
        selfSweepDeposit(record(), { ...deps(), checkCapacity: async () => failedWithBlocker }),
      ).rejects.toBeInstanceOf(SweepRefusedError)
      expect(channel.sendTransaction).not.toHaveBeenCalled()
    })

    it("does not block on a missing read when no blocker is known", async () => {
      await selfSweepDeposit(record(), { ...deps(), checkCapacity: async () => unread })
      expect(channel.sendTransaction).toHaveBeenCalledOnce()
    })

    it("names a portal refusal decoded from the estimate", async () => {
      for (const [error, copy] of [
        [
          "Caps__GlobalLimitSurpassed",
          /capacity is currently insufficient for this deposit, so the sweep did not go through/,
        ],
        ["Caps__TxLimitSurpassed", /larger than the network can process in one deposit/],
        ["OxidePortal__FrozenPortal", /not accepting deposits right now/],
      ] as const) {
        channel.sendTransaction.mockRejectedValueOnce(revert(error))
        const sweep = selfSweepDeposit(record(), deps())
        await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
        await expect(sweep).rejects.toThrow(copy)
      }
    })

    it("passes an unexplained failure through unchanged, including a hidden batch revert", async () => {
      const batch = Object.assign(new Error("execution reverted"), {
        cause: {
          data: encodeErrorResult({
            abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
            errorName: "Error",
            args: ["Multicall3: call failed"],
          }),
        },
      })
      channel.sendTransaction.mockRejectedValueOnce(batch)
      await expect(selfSweepDeposit(record(), deps())).rejects.toBe(batch)
    })

    /** Sweeps `stored` through the production observer against a portal with 100 atomic left. */
    const sweepAgainstObserver = async (stored: SIPADepositRecord) => {
      const read = vi.fn(async (key: PortalCapacityKey) => ({
        ...key,
        decimals: 18,
        blockNumber: 1n,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        rateAtomicPerSecond: 0n,
        globalLimitAtomic: 10_000n,
        availableAtomic: 100n,
        txAmountCapAtomic: TX_AMOUNT_CAP,
      }))
      const registry = createPortalCapacityRegistry({
        read,
        visibility: { isVisible: () => true, onResume: () => () => {} },
        policy: { maxHeadAgeMs: Infinity },
      })
      const readTerms = vi.fn(async () => ({
        portal: PORTAL,
        token: TUPLE_TOKEN,
        depositFee: FEE,
        txAmountCap: TX_AMOUNT_CAP,
      }))
      const observer = createSipaProcessingObserver({
        deposits: {
          get: () => stored,
          list: () => [stored],
          onListChanged: () => () => {},
        } as never,
        capacity: (key) => registry.store(key),
        readTerms,
        l1ChainId: 11155111,
      })
      const sweep = selfSweepDeposit(stored, {
        ...deps({ balance: 1_000n }),
        checkCapacity: (live) => observer.refreshForSweep(SIPA, live),
      })
      await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
      // The deposit row of the table the address commits to.
      expect(readTerms).toHaveBeenCalledWith({ forwardingTable: FORWARDING_TABLE, intent: 1 })
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ portal: PORTAL, token: TUPLE_TOKEN }),
      )
      expect(channel.sendTransaction).not.toHaveBeenCalled()
    }
    // An account origin names the table the observer reads the deposit's portal from.
    const origin = {
      protocol: "account" as const,
      sipaFactory: SIPA_FACTORY,
      implementation: IMPL,
      intentHash: HASH,
      rollupVersion: "4127419662",
      resweepable: true,
      recoveryAccount: WALLET,
      recoveryCommitment: COMMITMENT,
      accountFactory: REGISTRY,
      forwardingTable: FORWARDING_TABLE,
    }

    it("reads capacity for a funded deposit the rail still records as unfunded", async () => {
      await sweepAgainstObserver(record({ phase: "broadcast", amount: "0", startTime: 0, origin }))
    })

    it("measures a topped-up deposit at the balance it just read, not the smaller stored amount", async () => {
      // 100 atomic stored would fit the 100 left; the 1,000 on chain does not.
      await sweepAgainstObserver(
        record({
          amount: formatUnits(100n, 18),
          tokenAddress: TUPLE_TOKEN,
          tokenDecimals: 18,
          origin,
        }),
      )
    })

    it("after a reverted receipt, states a current blocker without calling it the cause", async () => {
      channel.waitForReceipt.mockResolvedValue(false)
      const checkCapacity = vi
        .fn()
        .mockResolvedValueOnce({ reason: blocked.reason })
        .mockResolvedValueOnce(blocked)
      const sweep = selfSweepDeposit(record(), { ...deps(), checkCapacity })
      await expect(sweep).rejects.toThrow(
        /could not determine why\..* Network capacity is currently insufficient for this deposit\.$/,
      )
      await expect(sweep).rejects.not.toBeInstanceOf(SweepRefusedError)
      expect(store.upsert).not.toHaveBeenCalled()
    })
  })
})

describe("sweepChannel", () => {
  const config = { l1ChainId: 11155111, l1RpcUrl: "http://l1" } as never

  beforeEach(() => {
    vi.clearAllMocks()
    bridge.isDesktopL1SubmitActive.mockReturnValue(false)
  })

  it("tips the connected account in a browser with an injected wallet", async () => {
    l1Clients.getL1Clients.mockResolvedValue({
      walletClient: { sendTransaction: vi.fn(async () => HASH) },
      publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) },
      account: WALLET,
      chain: { id: 11155111 },
    })
    const channel = await sweepChannel({
      config,
      record: record(),
      publicClient: {} as never,
      opts: { from: WALLET },
    })
    expect(channel.target).toBe(WALLET)
    expect(l1Clients.getL1Clients).toHaveBeenCalledWith(11155111, WALLET)
  })

  it("tips the typed address through the desktop helper page", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    bridge.submitViaDesktopBridge.mockResolvedValue(HASH)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }))
    const channel = await sweepChannel({
      config,
      record: record(),
      publicClient: { waitForTransactionReceipt } as never,
      opts: { destination: TYPED },
    })

    expect(channel.target).toBe(TYPED)
    await expect(channel.sendTransaction(MULTICALL3_ADDRESS, "0xdeadbeef")).resolves.toBe(HASH)
    const params = bridge.submitViaDesktopBridge.mock.calls[0]![0]
    expect(params.tx).toEqual({ to: MULTICALL3_ADDRESS, data: "0xdeadbeef", chainId: 11155111 })
    expect(params.display.title).toBe("Finish your zk.money deposit")
    expect(Object.fromEntries(params.display.lines)).toMatchObject({
      "Deposit address": SIPA,
      "Network tip to": TYPED,
    })
    await expect(channel.waitForReceipt(HASH)).resolves.toBe(true)
  })

  it("refuses bridge mode without a valid address to tip", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    await expect(
      sweepChannel({ config, record: record(), publicClient: {} as never, opts: {} }),
    ).rejects.toThrow(/network tip/)
    await expect(
      sweepChannel({
        config,
        record: record(),
        publicClient: {} as never,
        opts: { destination: "0xnope" as Address },
      }),
    ).rejects.toThrow(/network tip/)
  })
})
