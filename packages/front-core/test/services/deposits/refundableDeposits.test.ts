import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"

const observation = vi.hoisted(() => ({ observeSipas: vi.fn() }))
vi.mock("../../../src/oxide/sipaObservation", () => observation)

import {
  scanRefundableDeposits,
  scanSweptDeposits,
  type RefundableSipaSource,
} from "../../../src/core/services/deposits/refundableDeposits"

const RECIPIENT = `0x${"22".repeat(32)}`
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address
const PORTAL = "0x00000000000000000000000000000000000000e1" as Address
const A = "0x00000000000000000000000000000000000000aa"
const B = "0x00000000000000000000000000000000000000bb"
const TARGET = {
  publicClient: {} as never,
  portal: PORTAL,
  token: TOKEN,
  fromBlock: 10n,
  head: 99n,
}

const source = (sipaAddress: string, n: number): RefundableSipaSource => ({
  sipaAddress,
  recipientL2Address: RECIPIENT,
  messageSecret: `0x${n.toString(16).padStart(64, "0")}`,
  recipientCommitment: `0x${(n + 100).toString(16).padStart(64, "0")}`,
})
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const sweep = (index: bigint, amount: bigint) => ({
  index,
  amount,
  messageKey: key(Number(index)),
  blockNumber: 50n + index,
  txHash: key(1000 + Number(index)),
})
const seen = (sweeps: ReturnType<typeof sweep>[], balance = 0n) => ({
  sweeps,
  outflows: [],
  recoveries: [],
  balances: new Map([[TOKEN, balance]]),
})

function observe(observed: Record<string, ReturnType<typeof seen>>, strays: unknown[] = []) {
  observation.observeSipas.mockResolvedValue({
    observed: new Map(Object.entries(observed)),
    strays,
  })
}

beforeEach(() => observation.observeSipas.mockReset())

describe("scanRefundableDeposits", () => {
  it("reads every source in one observation of the portal, from the deployment's start", async () => {
    observe({ [A]: seen([]), [B]: seen([]) })

    await scanRefundableDeposits(TARGET, [source(A, 1), source(B, 2)])

    expect(observation.observeSipas).toHaveBeenCalledTimes(1)
    expect(observation.observeSipas).toHaveBeenCalledWith(TARGET.publicClient, {
      portals: [PORTAL],
      tokens: [TOKEN],
      head: 99n,
      subjects: [
        {
          address: A,
          commitment: source(A, 1).recipientCommitment,
          fromBlock: 10n,
          inflows: false,
        },
        {
          address: B,
          commitment: source(B, 2).recipientCommitment,
          fromBlock: 10n,
          inflows: false,
        },
      ],
    })
  })

  it("yields every sweep at its own inbox index and credited amount, and what still sits at the SIPAs", async () => {
    observe({ [A]: seen([sweep(1n, 90n), sweep(2n, 40n)]), [B]: seen([], 7n) })

    const scan = await scanRefundableDeposits(TARGET, [source(A, 1), source(B, 2)])

    expect(scan.refundable).toEqual([
      {
        sipaAddress: A,
        l2Recipient: RECIPIENT,
        messageSecret: source(A, 1).messageSecret,
        messageKey: key(1),
        messageLeafIndex: 1n,
        amount: 90n,
        sweepBlockNumber: 51n,
      },
      expect.objectContaining({ sipaAddress: A, messageLeafIndex: 2n, amount: 40n }),
    ])
    expect(scan.inTransit).toEqual([{ source: source(B, 2), balance: 7n }])
  })

  it("drops what L2 already spent, asking once for every deposit in order", async () => {
    observe({ [A]: seen([sweep(1n, 90n), sweep(2n, 40n)]), [B]: seen([sweep(3n, 5n)]) })
    const consumed = vi.fn(async () => [false, true, false])

    const scan = await scanRefundableDeposits(TARGET, [source(A, 1), source(B, 2)], consumed)

    expect(consumed).toHaveBeenCalledTimes(1)
    expect(consumed.mock.calls[0]![0].map((d) => d.messageKey)).toEqual([key(1), key(2), key(3)])
    expect(scan.refundable.map((d) => d.messageLeafIndex)).toEqual([1n, 3n])
  })

  it("never reads a gap as empty: a failed window, an unread balance or a stray deposit throws", async () => {
    observe({ [A]: seen([]) })
    await expect(scanRefundableDeposits(TARGET, [source(A, 1), source(B, 2)])).rejects.toThrow(
      `${B} was not observed`,
    )

    observe({ [A]: { ...seen([]), balances: undefined } as never })
    await expect(scanRefundableDeposits(TARGET, [source(A, 1)])).rejects.toThrow("balance")

    observe({ [A]: seen([]) }, [{ commitment: source(A, 1).recipientCommitment }])
    await expect(scanRefundableDeposits(TARGET, [source(A, 1)])).rejects.toThrow("did not derive")
  })

  it("finds a commitment-only source's sweeps without reading a balance at its placeholder", async () => {
    observe({ [A]: { ...seen([sweep(5n, 60n)]), balances: new Map() } })

    const scan = await scanRefundableDeposits(TARGET, [{ ...source(A, 1), direct: true }])

    expect(observation.observeSipas.mock.calls[0]![1].subjects[0]).toMatchObject({ direct: true })
    expect(scan.refundable).toEqual([
      expect.objectContaining({ messageLeafIndex: 5n, amount: 60n }),
    ])
    expect(scan.inTransit).toEqual([])
  })

  it("reads nothing for an account with no sources", async () => {
    expect(await scanRefundableDeposits(TARGET, [])).toEqual({ refundable: [], inTransit: [] })
    expect(observation.observeSipas).not.toHaveBeenCalled()
  })
})

describe("scanSweptDeposits", () => {
  it("turns every sweep into a frozen refund descriptor, claimed on L2 or not", async () => {
    observe({ [A]: seen([sweep(4n, 30n)], 9n) })

    const { descriptors, inTransit } = await scanSweptDeposits(TARGET, [source(A, 1)])

    expect(descriptors).toEqual([
      {
        messageKey: key(4),
        messageLeafIndex: "4",
        l1BlockNumber: "54",
        sharedSecretSalt: source(A, 1).messageSecret,
        amount: "30",
      },
    ])
    expect(inTransit).toEqual([{ source: source(A, 1), balance: 9n }])
  })
})
