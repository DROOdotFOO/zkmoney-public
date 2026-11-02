import { describe, expect, it } from "vitest"
import type { FeedItem, SavingsMoveRecord, WithdrawalRecord } from "@obsidion/front-core"
import { oldVersionLeftovers } from "../../../../src/features/migration/oldVersionLeftovers"

const ONE = 10n ** 18n

const move = (localId: string, cents: bigint, extra: Partial<SavingsMoveRecord> = {}) =>
  ({
    withdrawalLocalId: localId,
    direction: "in",
    amount: ((cents * ONE) / 100n).toString(),
    startTime: 1,
    ...extra,
  } as SavingsMoveRecord)

const link = (
  networkId: string,
  amount: number,
  paylinkStatus = "awaitingClaim",
  status = "success",
) =>
  ({
    kind: "tx",
    paylinkStatus,
    tx: { action: "Pay To Email", status, networkId, token: { amount, price: 1 } },
  } as unknown as FeedItem)

describe("old-version leftovers", () => {
  it("counts an old version's unfinished Savings moves and unclaimed paylinks, not this version's", () => {
    expect(
      oldVersionLeftovers({
        moves: [
          {
            move: move("old", 1022n, { retired: true }),
            burn: { phase: "done" } as WithdrawalRecord,
          },
          {
            move: move("ran", 300n, {
              retired: true,
              deposit: { inboxIndex: "1", amount: "1", claimed: false },
            }),
          },
          {
            move: move("done", 400n, {
              retired: true,
              deposit: { inboxIndex: "2", amount: "1", claimed: true },
            }),
          },
          { move: move("new", 500n) },
        ],
        items: [
          link("0xold", 10),
          link("0xold", 2, "expired"),
          link("0xnew", 3),
          link("0xold", 4, "claimed"),
          link("0xold", 5, "awaitingClaim", "failed"),
        ],
        network: "0xNEW",
      }),
    ).toEqual({
      savings: (1322n * ONE) / 100n,
      deposited: { main: false, savings: true },
      links: 12n * ONE,
      linkCount: 2,
    })
  })
})
