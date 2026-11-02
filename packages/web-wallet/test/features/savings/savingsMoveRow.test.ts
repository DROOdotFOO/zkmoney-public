import { describe, expect, it } from "vitest"
import {
  isSavingsMoveSettled,
  type SavingsMoveRecord,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  recoveredTo,
  savingsMoveFigure,
  savingsMoveStatus,
} from "../../../src/features/savings/SavingsMoveRow"
import { savingsEtaCopy } from "../../../src/features/savings/savingsMoveTiming"

const move = (extra: Partial<SavingsMoveRecord> = {}) =>
  ({ direction: "in", withdrawalLocalId: "w1", startTime: 1, ...extra } as SavingsMoveRecord)
const burn = (phase: WithdrawalRecord["phase"]) => ({ localId: "w1", phase } as WithdrawalRecord)

const ONE = 10n ** 18n
const PRICE = (107n * ONE) / 100n

describe("savingsMoveFigure", () => {
  it("credits Savings with what the move put in, fixed from its record, whatever the shares are worth", () => {
    const landed = move({
      amount: (25n * ONE).toString(),
      value: (25n * ONE).toString(),
      net: ((2335n * ONE) / 100n).toString(),
      deposit: { inboxIndex: "1", amount: (23n * ONE).toString(), claimed: true },
    })
    expect(savingsMoveFigure(landed, "savings", PRICE)).toBe((2335n * ONE) / 100n)
    expect(savingsMoveFigure(landed, "savings")).toBe((2335n * ONE) / 100n)
    // Main gave up the quote's DAI value.
    expect(savingsMoveFigure(landed, "main", PRICE)).toBe(25n * ONE)
    // Without a record figure (the basis itself is savingsMoveBasis's test), the landed shares at the price.
    const rebuilt = move({ ...landed, value: undefined, net: undefined })
    expect(savingsMoveFigure(rebuilt, "savings", PRICE)).toBe((2461n * ONE) / 100n)
    expect(savingsMoveFigure(rebuilt, "savings")).toBeUndefined()
  })

  it("prices a move out: the shares at the vault's price on Savings, the DAI that lands on Main", () => {
    const out = move({ direction: "out", amount: (10n * ONE).toString() })
    expect(savingsMoveFigure(out, "savings", PRICE)).toBe((107n * ONE) / 10n)
    expect(savingsMoveFigure(out, "savings")).toBeUndefined()
    const quoted = move({
      ...out,
      value: ((1070n * ONE) / 100n).toString(),
      net: (9n * ONE).toString(),
    })
    expect(savingsMoveFigure(quoted, "savings", PRICE)).toBe((107n * ONE) / 10n)
    expect(savingsMoveFigure(quoted, "main", PRICE)).toBe(9n * ONE)
    const landed = move({
      ...quoted,
      deposit: { inboxIndex: "2", amount: ((95n * ONE) / 10n).toString(), claimed: false },
    })
    expect(savingsMoveFigure(landed, "main", PRICE)).toBe((95n * ONE) / 10n)
  })

  it("debits Savings for a move out with what the vault paid, once read, whatever the price is now", () => {
    const read = move({
      direction: "out",
      amount: (10n * ONE).toString(),
      value: ((1070n * ONE) / 100n).toString(),
      vault: {
        txHash: "0x01",
        assets: ((1060n * ONE) / 100n).toString(),
        shares: (10n * ONE).toString(),
      },
    })
    expect(savingsMoveFigure(read, "savings", PRICE)).toBe((1060n * ONE) / 100n)
    expect(savingsMoveFigure({ ...read, value: undefined }, "savings", PRICE * 2n)).toBe(
      (1060n * ONE) / 100n,
    )
  })
})

describe("savingsEtaCopy", () => {
  it("counts a leg down, or names a typical duration, in the speed picker's words", () => {
    expect(savingsEtaCopy({ seconds: 12 * 60 + 20, remaining: true })).toBe("About 12 min left")
    expect(savingsEtaCopy({ seconds: 25 * 60, remaining: false })).toBe("Usually about 25 min")
    expect(savingsEtaCopy({ seconds: 90 * 60, remaining: true })).toBe("About 1 h 30 min left")
    expect(savingsEtaCopy({ seconds: 5, remaining: true })).toBe("About 1 min left")
  })
})

describe("savingsMoveStatus", () => {
  it("ends a move an old version's record left unfinished, as one that needs recovery", () => {
    const retired = move({ retired: true })
    expect(savingsMoveStatus(retired, burn("done"))).toBe("Needs recovery")
    expect(isSavingsMoveSettled(retired, burn("done"))).toBe(true)
    // A move with no old record, and an old move that finished, keep their states.
    expect(savingsMoveStatus(move(), burn("done"))).toBe("Moving to Savings")
    const claimed = move({
      retired: true,
      deposit: { inboxIndex: "1", amount: "1", claimed: true },
    })
    expect(savingsMoveStatus(claimed, burn("done"))).toBeUndefined()
  })

  it("ends a move whose escrow's DAI was recovered, and says where it went", () => {
    const recovered = move({
      recovered: { to: "0x1234000000000000000000000000000000abcd", txHashes: ["0x01"] },
    })
    expect(savingsMoveStatus(recovered, burn("done"))).toBe("Recovered")
    expect(isSavingsMoveSettled(recovered, burn("done"))).toBe(true)
    expect(recoveredTo(recovered)).toBe("Recovered to 0x12340…0abcd")
    expect(isSavingsMoveSettled(move(), burn("done"))).toBe(false)
  })

  it("keeps one state from submit until the deposit is claimed, then nothing", () => {
    for (const phase of [
      "submitting",
      "l2_mined",
      "awaiting_proven",
      "finalizing_l1",
      "done",
    ] as const) {
      expect(savingsMoveStatus(move(), burn(phase))).toBe("Moving to Savings")
      expect(savingsMoveStatus(move({ direction: "out" }), burn(phase))).toBe(
        "Moving to Main Account",
      )
    }
    expect(
      savingsMoveStatus(
        move({ deposit: { inboxIndex: "1", amount: "2", claimed: false } }),
        burn("done"),
      ),
    ).toBe("Moving to Savings")
    expect(
      savingsMoveStatus(
        move({ deposit: { inboxIndex: "1", amount: "2", claimed: true } }),
        burn("done"),
      ),
    ).toBeUndefined()
  })

  it("reads a failed burn as failed, and a move with no burn record as still moving", () => {
    expect(savingsMoveStatus(move(), burn("failed"))).toBe("Failed")
    expect(savingsMoveStatus(move())).toBe("Moving to Savings")
  })
})
