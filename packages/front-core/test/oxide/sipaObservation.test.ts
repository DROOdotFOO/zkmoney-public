// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"

const h = vi.hoisted(() => ({
  readPortalDeposits: vi.fn(),
  readTokenTransfers: vi.fn(),
  readSipaBalancesMany: vi.fn(),
  readSweepEmitters: vi.fn(),
}))
vi.mock("@obsidion/sdk", () => ({
  readPortalDeposits: h.readPortalDeposits,
  readTokenTransfers: h.readTokenTransfers,
  readSipaBalancesMany: h.readSipaBalancesMany,
  readSweepEmitters: h.readSweepEmitters,
}))

import { observeSipas } from "../../src/oxide/sipaObservation"

const PORTAL = "0x00000000000000000000000000000000000000a0" as Address
const DAI = "0x00000000000000000000000000000000000000d1" as Address
const RELAYER = "0x00000000000000000000000000000000000000e1" as Address
const SIPA_A = "0x00000000000000000000000000000000000000aa" as Address
const SIPA_B = "0x00000000000000000000000000000000000000bb" as Address
const SIPA_C = "0x00000000000000000000000000000000000000cc" as Address
const COMMIT_A = `0x${"0a".repeat(32)}` as Hex
const COMMIT_B = `0x${"0b".repeat(32)}` as Hex
const HEAD = 1_000n

const deposit = (
  commitment: Hex,
  index: bigint,
  txHash: Hex,
  blockNumber = 900n,
  portal: Address = PORTAL,
) => ({
  portal,
  recipientCommitment: commitment,
  amount: 10n * index,
  key: `0x${index.toString(16).padStart(64, "0")}` as Hex,
  index,
  blockNumber,
  blockHash: `0xb${blockNumber}` as Hex,
  txHash,
  logIndex: 0,
})
const transfer = (from: Address, to: Address, txHash: Hex, value = 5n) => ({
  token: DAI,
  from,
  to,
  value,
  blockNumber: 900n,
  txHash,
  logIndex: 1,
})

beforeEach(() => {
  h.readPortalDeposits.mockReset().mockResolvedValue([])
  h.readTokenTransfers.mockReset().mockResolvedValue([])
  h.readSipaBalancesMany.mockReset().mockResolvedValue(new Map())
  h.readSweepEmitters.mockReset().mockResolvedValue([])
})

describe("observeSipas", () => {
  it("gives each SIPA the deposits to its commitment, with their claim inputs", async () => {
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      deposit(COMMIT_B, 8n, "0x02"),
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01"), transfer(SIPA_B, RELAYER, "0x02")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_B, fromBlock: 800n, inflows: false },
      ],
    })

    expect(h.readPortalDeposits).toHaveBeenCalledOnce()
    expect(h.readPortalDeposits).toHaveBeenCalledWith(
      {},
      [PORTAL],
      [COMMIT_A, COMMIT_B],
      800n,
      HEAD,
    )
    expect(observed.get(SIPA_A)!.sweeps).toEqual([
      {
        portal: PORTAL,
        index: 7n,
        amount: 70n,
        messageKey: deposit(COMMIT_A, 7n, "0x01").key,
        blockNumber: 900n,
        blockHash: "0xb900",
        txHash: "0x01",
      },
    ])
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([8n])
  })

  it("reads every portal in one read per window and names the portal each sweep deposited to", async () => {
    const OTHER = "0x00000000000000000000000000000000000000a2" as Address
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      deposit(COMMIT_A, 9n, "0x02", 900n, OTHER),
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01"), transfer(SIPA_A, RELAYER, "0x02")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portals: [PORTAL, OTHER],
      tokens: [DAI],
      head: HEAD,
      subjects: [{ address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false }],
    })

    expect(h.readPortalDeposits).toHaveBeenCalledOnce()
    expect(h.readPortalDeposits).toHaveBeenCalledWith({}, [PORTAL, OTHER], [COMMIT_A], 800n, HEAD)
    expect(observed.get(SIPA_A)!.sweeps.map((s) => [s.portal, s.index])).toEqual([
      [PORTAL, 7n],
      [OTHER, 9n],
    ])
  })

  it("names the SIPA that swept a shared commitment by the transfer out in the deposit's transaction", async () => {
    h.readPortalDeposits.mockResolvedValue([deposit(COMMIT_A, 7n, "0x01")])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_B, RELAYER, "0x01")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
      ],
    })

    expect(observed.get(SIPA_A)!.sweeps).toEqual([])
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([7n])
  })

  it("tells SIPAs swept together in one transaction apart by the Sweep log each emits", async () => {
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      { ...deposit(COMMIT_A, 8n, "0x01"), logIndex: 2 },
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01"), transfer(SIPA_B, RELAYER, "0x01")] : [],
    )
    h.readSweepEmitters.mockImplementation(async (_c: unknown, _tx: unknown, index: bigint) =>
      index === 7n ? [SIPA_B] : [SIPA_A],
    )
    const params = {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
      ],
    }

    const { observed } = await observeSipas({} as never, params)

    expect(h.readSweepEmitters).toHaveBeenCalledTimes(2)
    expect(h.readSweepEmitters).toHaveBeenCalledWith({}, "0x01", 7n)
    expect(observed.get(SIPA_A)!.sweeps.map((s) => s.index)).toEqual([8n])
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([7n])

    // A forged log ahead of the real one does not move a deposit off the sender that emitted one.
    h.readSweepEmitters.mockImplementation(async (_c: unknown, _tx: unknown, index: bigint) =>
      index === 7n ? [SIPA_C, SIPA_B] : [SIPA_C, SIPA_A],
    )
    const forged = await observeSipas({} as never, params)
    expect(forged.observed.get(SIPA_A)!.sweeps.map((s) => s.index)).toEqual([8n])
    expect(forged.observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([7n])
    expect(forged.strays).toEqual([])

    // Without the logs, neither sender is observed this pass: their window is read again.
    h.readSweepEmitters.mockRejectedValue(new Error("receipt unavailable"))
    const again = await observeSipas({} as never, params)
    expect(again.observed.has(SIPA_A)).toBe(false)
    expect(again.observed.has(SIPA_B)).toBe(false)

    // A log from no sender, or no log at that index, leaves the deposit a stray.
    h.readSweepEmitters.mockImplementation(async (_c: unknown, _tx: unknown, index: bigint) =>
      index === 7n ? [SIPA_C] : [],
    )
    const third = await observeSipas({} as never, params)
    expect(third.strays.map((d) => d.index)).toEqual([7n, 8n])
    expect(third.observed.get(SIPA_A)!.sweeps).toEqual([])
    expect(third.observed.get(SIPA_B)!.sweeps).toEqual([])
  })

  it("reads a transfer out with no sweep in its transaction as a recovery", async () => {
    h.readPortalDeposits.mockResolvedValue([deposit(COMMIT_A, 7n, "0x01")])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from"
        ? [
            transfer(SIPA_A, RELAYER, "0x01"),
            transfer(SIPA_A, "0x00000000000000000000000000000000000000f0", "0x02"),
          ]
        : [],
    )

    const { observed } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [{ address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false }],
    })

    expect(observed.get(SIPA_A)!.outflows).toHaveLength(2)
    expect(observed.get(SIPA_A)!.recoveries.map((r) => r.txHash)).toEqual(["0x02"])
  })

  it("reads what funded only the SIPAs that ask, and leaves the rest without inflows", async () => {
    h.readTokenTransfers.mockImplementation(
      async (_c: unknown, _t: unknown, side: string, sipas: Address[]) =>
        side === "to"
          ? sipas.map((sipa) =>
              transfer("0x00000000000000000000000000000000000000c0", sipa, "0x03"),
            )
          : [],
    )

    const { observed } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: true },
        { address: SIPA_B, commitment: COMMIT_B, fromBlock: 800n, inflows: false },
      ],
    })

    const inflowReads = h.readTokenTransfers.mock.calls.filter((c) => c[2] === "to")
    expect(inflowReads.map((c) => c[3])).toEqual([[SIPA_A]])
    expect(observed.get(SIPA_A)!.inflows).toHaveLength(1)
    expect(observed.get(SIPA_B)!.inflows).toBeUndefined()
  })

  it("reads each window once for all its SIPAs, and SIPAs sharing a commitment from the earliest", async () => {
    await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 990n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_A, fromBlock: 10n, inflows: false },
        {
          address: "0x00000000000000000000000000000000000000cc",
          commitment: COMMIT_B,
          fromBlock: 990n,
          inflows: false,
        },
      ],
    })

    const windows = h.readPortalDeposits.mock.calls.map((c) => [c[2], c[3]])
    expect(windows.sort((a, b) => Number(a[1] - b[1]))).toEqual(
      expect.arrayContaining([
        [[COMMIT_A, COMMIT_A], 10n],
        [[COMMIT_B], 990n],
      ]),
    )
    expect(h.readSipaBalancesMany).toHaveBeenCalledOnce()
  })

  it("leaves out the SIPAs of a window that failed, and observes the rest", async () => {
    h.readPortalDeposits.mockImplementation(
      async (_c: unknown, _p: unknown, _commitments: Hex[], from: bigint) => {
        if (from === 10n) throw new Error("request failed")
        return [deposit(COMMIT_B, 8n, "0x02")]
      },
    )
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_B, RELAYER, "0x02")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 10n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_B, fromBlock: 990n, inflows: false },
      ],
    })

    expect(observed.has(SIPA_A)).toBe(false)
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([8n])
  })

  it("hands back a deposit to a tracked commitment that no tracked SIPA sent", async () => {
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      deposit(COMMIT_A, 8n, "0x02"),
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01")] : [],
    )

    const { observed, strays } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_B, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
      ],
    })

    expect(observed.get(SIPA_A)!.sweeps.map((s) => s.index)).toEqual([7n])
    expect(strays.map((d) => d.index)).toEqual([8n])
  })

  it("leaves holdings unknown when their read fails, and still observes the logs", async () => {
    h.readSipaBalancesMany.mockRejectedValue(new Error("rpc down"))
    h.readPortalDeposits.mockResolvedValue([deposit(COMMIT_A, 7n, "0x01")])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01")] : [],
    )

    const { observed } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [{ address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false }],
    })

    expect(observed.get(SIPA_A)!.balances).toBeUndefined()
    expect(observed.get(SIPA_A)!.sweeps).toHaveLength(1)
  })

  it("gives a direct deposit's record the deposits to its commitment, and reads nothing at its key", async () => {
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      deposit(COMMIT_B, 8n, "0x02"),
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_B, RELAYER, "0x02")] : [],
    )

    const { observed, strays } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false, direct: true },
        { address: SIPA_B, commitment: COMMIT_B, fromBlock: 800n, inflows: true },
      ],
    })

    expect(observed.get(SIPA_A)!.sweeps.map((s) => s.index)).toEqual([7n])
    expect(observed.get(SIPA_A)!.balances).toEqual(new Map())
    expect(observed.get(SIPA_B)!.sweeps.map((s) => s.index)).toEqual([8n])
    expect(strays).toEqual([])
    for (const call of h.readTokenTransfers.mock.calls) expect(call[3]).not.toContain(SIPA_A)
    expect(h.readSipaBalancesMany.mock.calls[0]![1]).toEqual([SIPA_B])
  })

  it("gives a direct record only the deposits to its commitment that no tracked SIPA sent", async () => {
    h.readPortalDeposits.mockResolvedValue([
      deposit(COMMIT_A, 7n, "0x01"),
      deposit(COMMIT_A, 8n, "0x02"),
    ])
    h.readTokenTransfers.mockImplementation(async (_c: unknown, _t: unknown, side: string) =>
      side === "from" ? [transfer(SIPA_A, RELAYER, "0x01")] : [],
    )

    const { observed, strays } = await observeSipas({} as never, {
      portals: [PORTAL],
      tokens: [DAI],
      head: HEAD,
      subjects: [
        { address: SIPA_A, commitment: COMMIT_A, fromBlock: 800n, inflows: false },
        { address: SIPA_C, commitment: COMMIT_A, fromBlock: 800n, inflows: false, direct: true },
      ],
    })

    expect(observed.get(SIPA_A)!.sweeps.map((s) => s.index)).toEqual([7n])
    expect(observed.get(SIPA_C)!.sweeps.map((s) => s.index)).toEqual([8n])
    expect(strays).toEqual([])
  })
})
