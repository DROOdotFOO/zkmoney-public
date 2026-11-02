import { memoryBackend } from "../../src/engine/memoryBackend"
import { openDatabase } from "../../src/engine/database"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts/escrow.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"

const mocks = vi.hoisted(() => ({
  buildSwapEscrowExecuteCall: vi.fn(),
  buildSwapEscrowRecoverCall: vi.fn(),
}))

vi.mock("@obsidion/sdk", () => ({
  buildSwapEscrowExecuteCall: mocks.buildSwapEscrowExecuteCall,
  buildSwapEscrowRecoverCall: mocks.buildSwapEscrowRecoverCall,
  swapRouteForOutput: (output: string) => ({ USDC: 0, USDT: 1, ETH: 2 }[output]),
}))

import { runSwapEscrowExecute, runSwapEscrowRecovery } from "../../src/oxide/swapEscrowRecovery"
import { createWithdrawals } from "../../src/engine/withdrawals"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { OnNetwork } from "../../src/types/networkStamp"

const ESCROW = "0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"
const FACTORY = "0xfafafafafafafafafafafafafafafafafafafafa"
const RECOVERY = {
  account: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
  salt: new Fr(0x5a17n),
} as const
const COMMITMENT = deriveRecoveryCommitment(
  RECOVERY.salt,
  EthAddress.fromString(RECOVERY.account),
).toString()
const SIGNATURE = `0x${"cd".repeat(65)}`
const RECIPIENT = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"
const TARGET = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b"
const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b"
const NONCE = `0x${"77".repeat(32)}`
const L2TX = `0x${"11".repeat(32)}`
const HASH = `0x${"ab".repeat(32)}`
const CHAIN_NOW = 1_800_000_000n
const DEADLINE = 1_800_003_600n
const RECOVERY_NONCE = `0x${"07".repeat(32)}` as const

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const store = createWithdrawals({ db: openDatabase(memoryBackend()) })
  const reader = {
    daiBalance: vi.fn(async () => 95n * 10n ** 18n),
    isDeployed: vi.fn(async () => false),
  }
  const channel = {
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const signAccount = vi.fn(async () => SIGNATURE)
  const deps = {
    record: {
      localId: "w1",
      l2TxHash: L2TX,
      phase: "recoverable",
      reorgEpoch: 2,
      recipient: RECIPIENT,
      swapOutput: "USDC",
      swapEscrow: ESCROW,
      swapEscrowFactory: FACTORY,
      swapNonce: NONCE,
      swapRecoveryCommitment: COMMITMENT,
      swapRelayerTip: "5000000000000000000",
    },
    channel,
    reader,
    store,
    recovery: RECOVERY,
    signAccount,
    target: TARGET,
    dai: DAI,
    chainId: 11155111,
    makeNonce: () => new Uint8Array(32).fill(7),
    chainNow: async () => CHAIN_NOW,
    ...overrides,
  }
  const seeded = { amount: "95", tokenSymbol: "DAI", tokenDecimals: 18, startTime: 1 }
  await store.create({
    ...seeded,
    ...deps.record,
    networkId: "0xnet",
  } as OnNetwork<WithdrawalRecord>)
  return { deps: deps as never, store, reader, channel, signAccount }
}

const ARGS = {
  route: 0,
  recipient: RECIPIENT,
  recoveryCommitment: COMMITMENT,
  relayerTip: 5000000000000000000n,
  nonce: NONCE,
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.buildSwapEscrowExecuteCall.mockReturnValue({ to: FACTORY, data: "0xdeadbeef" })
  mocks.buildSwapEscrowRecoverCall.mockReturnValue({ to: ESCROW, data: "0xfeedface" })
})

describe("runSwapEscrowExecute", () => {
  it("submits factory.deployAndExecute for the record's args and settles the record done", async () => {
    const { deps, store, channel } = await makeDeps()
    await expect(runSwapEscrowExecute(deps)).resolves.toBe(HASH)
    expect(mocks.buildSwapEscrowExecuteCall).toHaveBeenCalledWith(
      FACTORY,
      expect.objectContaining({ layout: "legacy", args: ARGS }),
    )
    expect(channel.sendTransaction).toHaveBeenCalledWith(FACTORY, "0xdeadbeef")
    expect(await store.get(L2TX)).toMatchObject({
      phase: "done",
      swapExecuteTxHash: HASH,
      reorgEpoch: 2,
    })
  })

  it("refuses an emptied escrow before any wallet prompt", async () => {
    const { deps, channel, reader } = await makeDeps()
    reader.daiBalance.mockResolvedValue(0n)
    await expect(runSwapEscrowExecute(deps)).rejects.toThrow(/already completed/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("refuses a record that cannot rebuild its args", async () => {
    const { deps: base } = await makeDeps()
    const record = { ...(base as { record: object }).record, swapRecoveryCommitment: undefined }
    const { deps, channel } = await makeDeps({ record })
    await expect(runSwapEscrowExecute(deps)).rejects.toThrow(/weren't stored/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("leaves the record alone when the transaction reverts", async () => {
    const { deps, store, channel } = await makeDeps()
    channel.waitForReceipt.mockResolvedValue(false)
    await expect(runSwapEscrowExecute(deps)).rejects.toThrow(/reverted/)
    expect((await store.get(L2TX))?.phase).toBe("recoverable")
  })
})

describe("runSwapEscrowRecovery", () => {
  it("signs the escrow's recovery digest as the recovery account, submits, and flips the record to recovered", async () => {
    const { deps, store, channel, reader, signAccount } = await makeDeps()
    await expect(runSwapEscrowRecovery(deps)).resolves.toBe(HASH)

    expect(signAccount).toHaveBeenCalledWith(
      RECOVERY.account,
      escrowERC20RecoveryDigest(ESCROW, 11155111n, TARGET, DAI, RECOVERY_NONCE, DEADLINE),
    )
    expect(reader.isDeployed).toHaveBeenCalledWith(ESCROW)
    expect(mocks.buildSwapEscrowRecoverCall).toHaveBeenCalledWith({
      deployed: false,
      factory: FACTORY,
      escrow: ESCROW,
      commitment: expect.objectContaining({ layout: "legacy", args: ARGS }),
      recovery: RECOVERY,
      signature: SIGNATURE,
      target: TARGET,
      token: DAI,
      nonce: RECOVERY_NONCE,
      deadline: DEADLINE,
    })
    expect(channel.sendTransaction).toHaveBeenCalledWith(ESCROW, "0xfeedface")
    expect(await store.get(L2TX)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: HASH,
      recoveryTarget: TARGET,
      reorgEpoch: 2,
    })
  })

  it("passes the escrow's deployed state through, so a clone with code is recovered directly", async () => {
    const { deps, reader } = await makeDeps()
    reader.isDeployed.mockResolvedValue(true)
    await runSwapEscrowRecovery(deps)
    expect(mocks.buildSwapEscrowRecoverCall).toHaveBeenCalledWith(
      expect.objectContaining({ deployed: true }),
    )
  })

  it.each([
    ["account", { ...RECOVERY, account: TARGET }],
    ["salt", { ...RECOVERY, salt: new Fr(0x5a18n) }],
  ])("fails closed on a %s that does not open the committed recovery", async (_, recovery) => {
    const { deps, channel, reader, signAccount } = await makeDeps({ recovery })
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(
      "This wallet's account is not the recovery account of this withdrawal's escrow",
    )
    expect(reader.daiBalance).not.toHaveBeenCalled()
    expect(signAccount).not.toHaveBeenCalled()
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("surfaces a signer refusal without submitting", async () => {
    const { deps, store, channel, signAccount } = await makeDeps()
    signAccount.mockRejectedValue(
      new Error("Finish setting up your account's passkey, then try again"),
    )
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(/passkey/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
    expect((await store.get(L2TX))?.phase).toBe("recoverable")
  })

  it("refuses an emptied escrow before any wallet prompt", async () => {
    const { deps, channel, reader, signAccount } = await makeDeps()
    reader.daiBalance.mockResolvedValue(0n)
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(/already completed/)
    expect(signAccount).not.toHaveBeenCalled()
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("leaves the record alone when the transaction reverts", async () => {
    const { deps, store, channel } = await makeDeps()
    channel.waitForReceipt.mockResolvedValue(false)
    await expect(runSwapEscrowRecovery(deps)).rejects.toThrow(/reverted/)
    expect((await store.get(L2TX))?.phase).toBe("recoverable")
  })
})
