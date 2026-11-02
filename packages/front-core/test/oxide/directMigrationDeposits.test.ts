// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"

const h = vi.hoisted(() => ({
  readPortalDeposits: vi.fn(),
  readTokenTransfers: vi.fn(),
  readSipaBalancesMany: vi.fn(),
}))
vi.mock("@obsidion/sdk", () => ({
  readPortalDeposits: h.readPortalDeposits,
  readTokenTransfers: h.readTokenTransfers,
  readSipaBalancesMany: h.readSipaBalancesMany,
}))

import { observeSipas } from "../../src/oxide/sipaObservation"
import { ensureDirectMigrationDepositRecords } from "../../src/oxide/directMigrationDeposits"
import {
  directDepositClaimed,
  directDepositKey,
  directDepositSettled,
  type SIPADepositRecord,
} from "../../src/core/services/deposits/SIPADepositStore"
import type { SipaRow } from "../../src/oxide/sipaRows"

const DAI_PORTAL = "0x00000000000000000000000000000000000000a0" as Address
const SUSDS_PORTAL = "0x00000000000000000000000000000000000000a5" as Address
const EXECUTOR = "0x00000000000000000000000000000000000000e5" as Address
const SUBSIDY = "0x00000000000000000000000000000000000000f5" as Address
const COMMITMENT = `0x${"0c".repeat(32)}` as Hex
const SECRET = 0x1234n
const RECIPIENT = `0x${"2a".repeat(32)}`

const token = (address: string, symbol: string) => ({
  address: address as Address,
  symbol,
  decimals: 18,
})
const ROWS: SipaRow[] = [
  {
    portal: DAI_PORTAL,
    l2Token: "0xdai",
    token: token("0x00000000000000000000000000000000000000d1", "DAI"),
    swapped: [],
    intents: ["deposit", "registration", "metadata"],
  },
  {
    portal: SUSDS_PORTAL,
    l2Token: "0xsusds",
    token: token("0x00000000000000000000000000000000000000d5", "sUSDS"),
    swapped: [],
    intents: ["deposit"],
  },
]
const direct = {
  executor: EXECUTOR,
  subsidy: SUBSIDY,
  day: 3,
  nonce: 9,
  recipientCommitment: COMMITMENT,
}

function makeStore() {
  const records = new Map<string, SIPADepositRecord>()
  return {
    records,
    load: vi.fn(async () => {}),
    get: (address: Address) => records.get(address.toLowerCase()) ?? null,
    create: vi.fn(async (address: Address, record: Omit<SIPADepositRecord, "sipaAddress">) => {
      if (records.has(address.toLowerCase())) return null
      const created = { ...record, sipaAddress: address } as SIPADepositRecord
      records.set(address.toLowerCase(), created)
      return created
    }),
    update: vi.fn(
      async (
        address: Address,
        patch: (current: SIPADepositRecord) => Partial<SIPADepositRecord> | null,
      ) => {
        const current = records.get(address.toLowerCase())
        const next = current && patch(current)
        if (!current || !next) return null
        const updated = { ...current, ...next } as SIPADepositRecord
        records.set(address.toLowerCase(), updated)
        return updated
      },
    ),
  }
}

const RUN = `metadata-migration/${SUSDS_PORTAL}/0xold/${RECIPIENT}`
/** What the batch deposits, raw units. */
const AMOUNT = "5000000000000000000"

function makeDeps(
  store = makeStore(),
  batches: { run: string; direct: typeof direct; fromBlock: string; amount: string }[] = [
    { run: RUN, direct, fromBlock: "1500", amount: AMOUNT },
  ],
) {
  const secret = vi.fn(async () => ({ recipientCommitment: COMMITMENT, sharedSecret: SECRET }))
  return {
    store,
    secret,
    deps: {
      store,
      batches: async () => batches,
      rows: ROWS,
      destinationPortal: (batch: { run: string }) => batch.run.split("/")[1] as Address,
      recipient: RECIPIENT,
      l1ChainId: 1,
      networkId: "0x00000000000000000000000000000000000000e1",
      secret,
    },
  }
}

/** A client that fails any read: the ensure step must make none. */
const noReads = new Proxy({} as Record<string, unknown>, {
  get: (_t, name) => () => {
    throw new Error(`unexpected L1 read: ${String(name)}`)
  },
})

const landed = {
  portal: SUSDS_PORTAL,
  recipientCommitment: COMMITMENT,
  amount: 5n * 10n ** 18n,
  key: `0x${"0e".repeat(32)}` as Hex,
  index: 42n,
  blockNumber: 1_600n,
  txHash: `0x${"ab".repeat(32)}` as Hex,
  logIndex: 3,
}

beforeEach(() => {
  h.readPortalDeposits.mockReset().mockResolvedValue([])
  h.readTokenTransfers.mockReset().mockResolvedValue([])
  h.readSipaBalancesMany.mockReset().mockResolvedValue(new Map())
})

describe("ensureDirectMigrationDepositRecords", () => {
  it("records a sent batch before its deposit lands, as an unpaid address, reading no chain", async () => {
    const { deps, store, secret } = makeDeps()

    expect(
      await ensureDirectMigrationDepositRecords({ ...deps, publicClient: noReads } as never),
    ).toBe(1)

    expect(secret).toHaveBeenCalledWith(direct)
    expect(h.readPortalDeposits).not.toHaveBeenCalled()
    const record = store.records.get(directDepositKey(COMMITMENT).toLowerCase())!
    expect(record).toMatchObject({
      phase: "broadcast",
      recipientL2Address: RECIPIENT,
      recipientHash: COMMITMENT,
      direct: { recipientCommitment: COMMITMENT, executor: EXECUTOR, expected: AMOUNT },
      amount: "0",
      fee: "0",
      tokenSymbol: "sUSDS",
      tokenAddress: ROWS[1]!.token.address,
      observedFrom: "1500",
      rescanFrom: "1500",
    })
    expect(record.inboxIndex).toBeUndefined()
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.pendingSweeps).toBeUndefined()
    // The claim's shared-secret salt, as an Fr.
    expect(BigInt(record.messageSecret)).toBe(SECRET)
  })

  it("writes nothing for a batch already recorded", async () => {
    const { deps, store } = makeDeps()
    await ensureDirectMigrationDepositRecords(deps)
    store.create.mockClear()

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(0)
    expect(store.create).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })

  it("gives a record written from the deposit's announcement the batch's amount", async () => {
    const { deps, store } = makeDeps()
    const key = directDepositKey(COMMITMENT).toLowerCase()
    store.records.set(key, {
      sipaAddress: key,
      phase: "claimed",
      claimedInboxIndexes: ["1"],
      direct: { recipientCommitment: COMMITMENT },
    } as never)

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(0)

    expect(store.create).not.toHaveBeenCalled()
    expect(store.records.get(key)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["1"],
      direct: { recipientCommitment: COMMITMENT, expected: AMOUNT },
    })
  })

  it("refuses a batch whose commitment its coordinates do not derive", async () => {
    const { deps, store, secret } = makeDeps()
    secret.mockResolvedValue({ recipientCommitment: `0x${"0d".repeat(32)}`, sharedSecret: SECRET })

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(0)
    expect(store.create).not.toHaveBeenCalled()
  })

  it("isolates a batch whose destination has no rail row", async () => {
    const other = `0x${"0f".repeat(32)}` as Hex
    const { deps, store } = makeDeps(makeStore(), [
      {
        run: "metadata-migration/0xunknown/0xold/0xacct",
        direct: { ...direct, recipientCommitment: other },
        fromBlock: "1",
        amount: AMOUNT,
      },
      { run: RUN, direct, fromBlock: "1500", amount: AMOUNT },
    ])

    expect(await ensureDirectMigrationDepositRecords(deps)).toBe(1)
    expect(store.records.has(directDepositKey(COMMITMENT).toLowerCase())).toBe(true)
  })

  it("joins the batched observation, which finds its deposit by the commitment topic", async () => {
    const { deps, store } = makeDeps()
    await ensureDirectMigrationDepositRecords(deps)
    const key = directDepositKey(COMMITMENT)
    const record = store.records.get(key.toLowerCase())!
    h.readPortalDeposits.mockResolvedValue([landed])

    const { observed } = await observeSipas({} as never, {
      portals: [DAI_PORTAL, SUSDS_PORTAL],
      tokens: [ROWS[0]!.token.address],
      head: 2_000n,
      subjects: [
        {
          address: key,
          commitment: record.recipientHash as Hex,
          fromBlock: BigInt(record.rescanFrom!),
          inflows: false,
          direct: true,
        },
      ],
    })

    expect(h.readPortalDeposits).toHaveBeenCalledWith(
      {},
      [DAI_PORTAL, SUSDS_PORTAL],
      [COMMITMENT],
      1_500n,
      2_000n,
    )
    expect(observed.get(key.toLowerCase())!.sweeps).toEqual([
      {
        portal: SUSDS_PORTAL,
        index: 42n,
        amount: landed.amount,
        messageKey: landed.key,
        blockNumber: 1_600n,
        txHash: landed.txHash,
      },
    ])
    expect(h.readTokenTransfers.mock.calls.every((c) => c[3].length === 0)).toBe(true)
    expect(h.readSipaBalancesMany).toHaveBeenCalledWith({}, [], [ROWS[0]!.token.address])
  })
})

describe("directDepositClaimed", () => {
  it("is the total the rail claimed under the commitment, with no deposit it has only seen", async () => {
    const store = makeStore()
    expect(await directDepositClaimed(store, COMMITMENT)).toBe(0n)

    const key = directDepositKey(COMMITMENT).toLowerCase()
    store.records.set(key, {
      phase: "pendingClaim",
      inboxIndex: "42",
      pendingSweeps: [{ inboxIndex: "42" }],
    } as never)
    expect(await directDepositClaimed(store, COMMITMENT)).toBe(0n)

    // Another sender's dust is claimed first; the batch's deposit waits for its claim.
    store.records.set(key, {
      phase: "pendingClaim",
      inboxIndex: "43",
      claimedInboxIndexes: ["42"],
      sweeps: [{ inboxIndex: "42", netAmount: "1" }],
      pendingSweeps: [{ inboxIndex: "43" }],
    } as never)
    expect(await directDepositClaimed(store, COMMITMENT)).toBe(1n)

    store.records.set(key, {
      phase: "claimed",
      inboxIndex: "43",
      claimedInboxIndexes: ["42", "43"],
      sweeps: [
        { inboxIndex: "42", netAmount: "1" },
        { inboxIndex: "43", netAmount: AMOUNT },
      ],
    } as never)
    expect(await directDepositClaimed(store, COMMITMENT)).toBe(BigInt(AMOUNT) + 1n)
    // The key is the commitment's, whatever its case.
    expect(
      await directDepositClaimed(store, COMMITMENT.toUpperCase().replace("0X", "0x") as Hex),
    ).toBe(BigInt(AMOUNT) + 1n)
    expect(store.load).toHaveBeenCalled()
  })
})

describe("directDepositSettled", () => {
  const record = (claimed: string[], expected?: string) =>
    ({
      phase: "claimed",
      claimedInboxIndexes: claimed,
      sweeps: claimed.map((inboxIndex) => ({
        inboxIndex,
        netAmount: inboxIndex === "1" ? "1" : AMOUNT,
      })),
      direct: { recipientCommitment: COMMITMENT, ...(expected ? { expected } : {}) },
    } as never)

  it("settles once the claimed total reaches the batch's amount, and never without one", () => {
    expect(directDepositSettled(record(["1"], AMOUNT))).toBe(false)
    expect(directDepositSettled(record(["1", "2"], AMOUNT))).toBe(true)
    expect(directDepositSettled(record(["2"], AMOUNT))).toBe(true)
    expect(directDepositSettled(record(["2"]))).toBe(false)
  })
})
