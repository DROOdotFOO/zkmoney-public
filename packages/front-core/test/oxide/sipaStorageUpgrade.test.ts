// @vitest-environment node
/**
 * A wallet whose storage the previous deposit sync wrote, running this one: per-SIPA scan cursors,
 * unresolved sweep blocks and history flags, no deployment cursor. The real store, observation and
 * derivations run; only the chain's log and holdings reads are a fake chain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"

/** A sweep of `sipa`: the portal deposit, and the transfer out of the SIPA every sweep makes. */
type Deposit = {
  sipa: string
  commitment: Hex
  index: bigint
  amount: bigint
  blockNumber: bigint
  txHash: Hex
}

const chain = vi.hoisted(() => ({
  deposits: [] as Deposit[],
  /** Which SIPA a deposit's sweep was emitted by, by tx. */
  sweptBy: new Map<string, string>(),
  balances: new Map<string, bigint>(),
  failHistoryBelow: undefined as bigint | undefined,
}))

vi.mock("@obsidion/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@obsidion/sdk")>()
  return {
    ...actual,
    fetchSipaEvents: vi.fn(async () => []),
    readDepositSIPAImplementation: vi.fn(async () => "0x00000000000000000000000000000000000000d5"),
    readRegistrationSIPAImplementation: vi.fn(
      async () => "0x00000000000000000000000000000000000000d6",
    ),
    readDepositFee: vi.fn(async () => 10n),
    readBlockTimeMs: vi.fn(async (_c: unknown, block: bigint) => Number(block) * 1000),
    readPortalDeposits: vi.fn(
      async (_c: unknown, portals: Hex[], commitments: Hex[], from: bigint, to: bigint) => {
        if (chain.failHistoryBelow !== undefined && from < chain.failHistoryBelow)
          throw new Error("pruned history unavailable")
        const wanted = new Set(commitments.map((c) => c.toLowerCase()))
        return chain.deposits
          .filter((d) => wanted.has(d.commitment.toLowerCase()))
          .filter((d) => d.blockNumber >= from && d.blockNumber <= to)
          .map((d) => ({
            portal: portals[0],
            recipientCommitment: d.commitment.toLowerCase(),
            amount: d.amount,
            key: `0x${d.index.toString(16).padStart(64, "0")}`,
            index: d.index,
            blockNumber: d.blockNumber,
            txHash: d.txHash,
            logIndex: 0,
          }))
      },
    ),
    readTokenTransfers: vi.fn(
      async (_c: unknown, _t: unknown, side: string, sipas: string[], from: bigint, to: bigint) => {
        if (side !== "from") return []
        const wanted = new Set(sipas.map((a) => a.toLowerCase()))
        return chain.deposits
          .filter(
            (d) => wanted.has(d.sipa.toLowerCase()) && d.blockNumber >= from && d.blockNumber <= to,
          )
          .map((d) => ({
            token: DAI,
            from: d.sipa,
            to: TUPLE.portal,
            value: d.amount,
            blockNumber: d.blockNumber,
            txHash: d.txHash,
            logIndex: 1,
          }))
      },
    ),
    readSweepEmitters: vi.fn(async (_c: unknown, txHash: string) => {
      const sipa = chain.sweptBy.get(txHash)
      return sipa ? [sipa] : []
    }),
    // A stray's clone here is a registration SIPA with no code read.
    readSipaIntent: vi.fn(async () => actual.OxideSipaIntent.Registration),
    readSipaCloneImplementation: vi.fn(async () => "0x0000000000000000000000000000000000000000"),
    readSipaBalancesMany: vi.fn(
      async (_c: unknown, sipas: string[]) =>
        new Map(
          sipas.map((s) => [
            s.toLowerCase(),
            new Map([
              [DAI, chain.balances.get(s.toLowerCase()) ?? 0n],
              ["0x0000000000000000000000000000000000000000", 0n],
            ]),
          ]),
        ),
    ),
  }
})
vi.mock("@aztec-labs/aztec.js/messaging", () => ({ isL1ToL2MessageReady: vi.fn(async () => true) }))

import { computeStealthRecipientHash } from "@obsidion/sdk"
import { SIPADepositStore } from "../../src/core/services/deposits/SIPADepositStore"
import { deriveStealthKey } from "../../src/oxide/oxideAccountKeys"
import { syncSipaDeposits } from "../../src/oxide/sipaClaims"
import type { SipaRow } from "../../src/oxide/sipaRows"

const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b"
const HEAD = 1_000_000n
const START = 400_000n
const RECIPIENT = AztecAddress.fromBigIntUnsafe(0xbeefn)
const TUPLE = {
  sipaFactory: "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2",
  portal: "0x92308ce04e2416f20b03e941a14f9238c3603334",
  forwardingTable: "0x00000000000000000000000000000000000000d1",
  token: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b",
  rollupVersion: "4127419662",
  l2Token: "0x0000000000000000000000000000000000000000000000000000000000001234",
} as unknown as OxideEnvTuple
const TOKEN = { address: DAI as Address, symbol: "DAI", decimals: 18 }
const ROW = {
  portal: TUPLE.portal as Address,
  l2Token: TUPLE.l2Token,
  token: TOKEN,
  swapped: [],
  intents: ["deposit", "registration", "metadata"],
} as SipaRow

let storage: InMemoryStorageAdapter
const store = () => SIPADepositStore.get(storage)

/** Restart the app: the store reads back what was persisted. */
async function restart() {
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  await store().load()
}

/** A self-initiated record exactly as the previous sync persisted it, scan fields included. */
async function oldRecord(salt: bigint, address: Address, fields: Record<string, unknown>) {
  const secret = new Fr(salt)
  const commitment = (await computeStealthRecipientHash(secret, RECIPIENT)).toString() as Hex
  await store().upsert(address, { phase: "broadcast", ...fields } as never, {
    recipientL2Address: RECIPIENT.toString(),
    messageSecret: secret.toString(),
    recipientHash: commitment,
    recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
    l1ChainId: 11155111,
    networkId: "0xnet",
    amount: "0",
    tokenSymbol: "DAI",
    tokenAddress: DAI as Address,
    startTime: 1,
  })
  return { secret, commitment }
}

function sync(
  tokenService = { claimSweptDeposit: vi.fn(async () => undefined) },
  over: Partial<Parameters<typeof syncSipaDeposits>[0]> = {},
) {
  return {
    tokenService,
    run: (historyStartBlock: () => Promise<bigint> = async () => START) =>
      syncSipaDeposits({
        publicClient: {
          getBlockNumber: vi.fn(async () => HEAD),
          getBalance: vi.fn(async () => 0n),
        } as never,
        node: {} as never,
        wallet: {} as never,
        tokenServiceFor: async () => tokenService,
        store: store(),
        tuple: TUPLE,
        recipient: RECIPIENT,
        stealthPublicKey: deriveStealthKey(new Fr(7n)).publicKey,
        rows: [ROW],
        txAmountCap: async () => 5166n * 10n ** 18n,
        l1ChainId: 11155111,
        networkId: "0xnet",
        historyStartBlock,
        ...over,
      }),
  }
}

const SIPA_A = "0x00000000000000000000000000000000000000aa" as Address
const SIPA_B = "0x00000000000000000000000000000000000000bb" as Address
const SIPA_C = "0x00000000000000000000000000000000000000cc" as Address

beforeEach(async () => {
  storage = new InMemoryStorageAdapter()
  chain.deposits = []
  chain.sweptBy = new Map()
  chain.balances = new Map()
  chain.failHistoryBelow = undefined
  await restart()
})

describe("a wallet with the previous sync's storage", () => {
  it("reads every record's history once, claims nothing twice, and then rides the cursor", async () => {
    const claimed = await oldRecord(0x11n, SIPA_A, {
      phase: "claimed",
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      netAmount: "990000",
      sweepTxHash: "0x07",
      sweeps: [{ inboxIndex: "7", sweepTxHash: "0x07", netAmount: "990000" }],
      fee: "10",
      lastScannedBlock: (HEAD - 50n).toString(),
      historyScanned: true,
      lastScanAt: 5,
    })
    chain.deposits.push({
      sipa: SIPA_A,
      commitment: claimed.commitment,
      index: 7n,
      amount: 990_000n,
      blockNumber: 500_000n,
      txHash: "0x07",
    })
    await restart()
    const { run, tokenService } = sync()

    expect(await run()).toMatchObject({ claimed: 0, failed: 0 })
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store().get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      observedFrom: HEAD.toString(),
    })
    expect(await store().observedThrough(TUPLE.portal as Address, RECIPIENT.toString())).toBe(HEAD)

    await run()
    const { readPortalDeposits } = await import("@obsidion/sdk")
    const windows = vi.mocked(readPortalDeposits).mock.calls.map((c) => c[3])
    expect(windows).toEqual([START, HEAD - 128n])
  })

  it("claims a sweep the previous sync left unresolved below its cursor", async () => {
    const pending = await oldRecord(0x22n, SIPA_B, {
      phase: "pendingClaim",
      inboxIndex: "9",
      netAmount: "500000",
      sweepTxHash: "0x09",
      lastScannedBlock: (HEAD - 10n).toString(),
      unresolvedSweepBlocks: ["600000"],
      lastScanAt: 5,
    })
    chain.deposits.push({
      sipa: SIPA_B,
      commitment: pending.commitment,
      index: 9n,
      amount: 500_000n,
      blockNumber: 600_000n,
      txHash: "0x09",
    })
    await restart()
    const { run, tokenService } = sync()

    expect(await run()).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 9n, amount: 500_000n }),
    )
    expect(store().get(SIPA_B)).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["9"] })
  })

  it("claims a second payment to a claimed address that the previous sync never saw", async () => {
    const repaid = await oldRecord(0x33n, SIPA_C, {
      phase: "claimed",
      inboxIndex: "3",
      claimedInboxIndexes: ["3"],
      netAmount: "100000",
      sweepTxHash: "0x03",
      sweeps: [{ inboxIndex: "3", sweepTxHash: "0x03", netAmount: "100000" }],
      fee: "10",
      lastScannedBlock: (HEAD - 100_000n).toString(),
      historyScanned: true,
      lastScanAt: 5,
    })
    chain.deposits.push(
      {
        sipa: SIPA_C,
        commitment: repaid.commitment,
        index: 3n,
        amount: 100_000n,
        blockNumber: 450_000n,
        txHash: "0x03",
      },
      {
        sipa: SIPA_C,
        commitment: repaid.commitment,
        index: 12n,
        amount: 200_000n,
        blockNumber: HEAD - 5n,
        txHash: "0x0c",
      },
    )
    await restart()
    const { run, tokenService } = sync()

    expect(await run()).toMatchObject({ claimed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 12n }),
    )
    expect(store().get(SIPA_C)).toMatchObject({ claimedInboxIndexes: ["3", "12"] })
  })

  it("keeps a recoverable record recoverable", async () => {
    await oldRecord(0x44n, SIPA_A, {
      phase: "recoverable",
      amount: "0.000000000000000005",
      lastScannedBlock: (HEAD - 10n).toString(),
      lastScanAt: 5,
    })
    chain.balances.set(SIPA_A.toLowerCase(), 5n)
    await restart()

    expect(await sync().run()).toMatchObject({ recoverable: 1, failed: 0 })
    expect(store().get(SIPA_A)?.phase).toBe("recoverable")
  })

  it("marks nothing read when the history cannot be read, and reads it on a later pass", async () => {
    const pending = await oldRecord(0x55n, SIPA_B, {
      phase: "pendingClaim",
      inboxIndex: "9",
      netAmount: "500000",
      lastScannedBlock: (HEAD - 10n).toString(),
      unresolvedSweepBlocks: ["600000"],
    })
    chain.deposits.push({
      sipa: SIPA_B,
      commitment: pending.commitment,
      index: 9n,
      amount: 500_000n,
      blockNumber: 600_000n,
      txHash: "0x09",
    })
    chain.failHistoryBelow = HEAD - 1_000n
    await restart()
    const { run, tokenService } = sync()

    expect(await run()).toMatchObject({ claimed: 0, failed: 1 })
    expect(store().get(SIPA_B)?.observedFrom).toBeUndefined()

    chain.failHistoryBelow = undefined
    expect(await run()).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
  })

  it("tracks a SIPA this device never derived once it sweeps to one of its commitments, then claims", async () => {
    const registration = await oldRecord(0x66n, SIPA_A, {
      intent: "registration",
      lastScannedBlock: (HEAD - 10n).toString(),
    })
    // The same name's registration at another fee: same salt and commitment, another address.
    chain.deposits.push({
      sipa: SIPA_C,
      commitment: registration.commitment,
      index: 21n,
      amount: 700_000n,
      blockNumber: 800_000n,
      txHash: "0x15",
    })
    chain.sweptBy.set("0x15", SIPA_C)
    await restart()
    const { run, tokenService } = sync()

    await run()
    expect(store().get(SIPA_C)).toMatchObject({
      intent: "registration",
      messageSecret: registration.secret.toString(),
      recipientHash: registration.commitment,
    })

    // Attributed to the address now tracked: its history is read and the sweep claimed.
    expect(await run()).toMatchObject({ claimed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 21n, amount: 700_000n }),
    )
    expect(store().get(SIPA_C)).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["21"] })
  })

  it("takes the cursor kept for the portal alone, once, for the account the pass names", async () => {
    const legacyKey = `@obsidion/sipa-deposits/observed-through/${TUPLE.portal.toLowerCase()}`
    await oldRecord(0x88n, SIPA_A, { phase: "resolved", observedFrom: (HEAD - 5_000n).toString() })
    await storage.setItem(legacyKey, (HEAD - 10n).toString())
    await restart()
    const { readPortalDeposits } = await import("@obsidion/sdk")
    const windows = () => vi.mocked(readPortalDeposits).mock.calls.map((c) => c[3])
    vi.mocked(readPortalDeposits).mockClear()

    expect(await sync(undefined, { adoptLegacyCursor: true }).run()).toMatchObject({ failed: 0 })

    expect(windows()).toEqual([HEAD - 10n - 128n])
    expect(await store().observedThrough(TUPLE.portal as Address, RECIPIENT.toString())).toBe(HEAD)
    expect(await storage.getItem(legacyKey)).toBeNull()

    // Another account's pass starts from its history: the adopted cursor was never its own.
    const other = AztecAddress.fromBigIntUnsafe(0xcafen)
    const secret = new Fr(0x99n)
    await store().upsert(
      SIPA_B,
      { phase: "broadcast" },
      {
        recipientL2Address: other.toString(),
        messageSecret: secret.toString(),
        recipientHash: (await computeStealthRecipientHash(secret, other)).toString(),
        recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
        l1ChainId: 11155111,
        networkId: "0xnet",
        amount: "0",
        tokenSymbol: "DAI",
        tokenAddress: DAI as Address,
        startTime: 1,
      },
    )
    vi.mocked(readPortalDeposits).mockClear()

    expect(await sync(undefined, { recipient: other }).run()).toMatchObject({ failed: 0 })

    expect(windows()).toEqual([START])
    expect(await store().observedThrough(TUPLE.portal as Address, other.toString())).toBe(HEAD)
  })

  it("leaves the portal-only cursor to the account that owns it when a pass does not adopt it", async () => {
    const legacyKey = `@obsidion/sipa-deposits/observed-through/${TUPLE.portal.toLowerCase()}`
    await oldRecord(0x88n, SIPA_A, { phase: "resolved", observedFrom: (HEAD - 5_000n).toString() })
    await storage.setItem(legacyKey, (HEAD - 10n).toString())
    await restart()
    const { readPortalDeposits } = await import("@obsidion/sdk")
    vi.mocked(readPortalDeposits).mockClear()

    expect(await sync().run()).toMatchObject({ failed: 0 })

    expect(vi.mocked(readPortalDeposits).mock.calls.map((c) => c[3])).toEqual([START])
    expect(await storage.getItem(legacyKey)).toBe((HEAD - 10n).toString())
    expect(await store().observedThrough(TUPLE.portal as Address, RECIPIENT.toString())).toBe(HEAD)
  })

  it("re-reads a stray's block on the next pass when tracking its SIPA failed", async () => {
    const registration = await oldRecord(0x77n, SIPA_A, { intent: "registration" })
    chain.deposits.push({
      sipa: SIPA_C,
      commitment: registration.commitment,
      index: 31n,
      amount: 700_000n,
      blockNumber: 800_000n,
      txHash: "0x1f",
    })
    chain.sweptBy.set("0x1f", SIPA_C)
    await restart()
    const { readSweepEmitters } = await import("@obsidion/sdk")
    vi.mocked(readSweepEmitters).mockRejectedValueOnce(new Error("receipt unavailable"))
    const { run } = sync()

    await run()
    expect(store().get(SIPA_C)).toBeNull()
    expect(store().get(SIPA_A)).toMatchObject({
      rescanFrom: "800000",
      observedFrom: HEAD.toString(),
    })

    await run()
    expect(store().get(SIPA_C)).toMatchObject({ intent: "registration" })
  })
})
