import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SavingsMoveRecord, WithdrawalRecord } from "@obsidion/front-core"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  ActivityListRow: ({
    counterparty,
    timestamp,
    statusLabel,
    amount,
  }: {
    counterparty: string
    timestamp: string
    statusLabel?: string
    amount: string
  }) => (
    <div className="row">
      {counterparty} <small>{timestamp}</small> {statusLabel} {amount}
    </div>
  ),
  Spinner: () => null,
  GradientText: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))
vi.mock("../../../src/ui/Modal", () => ({
  Modal: ({ children, label }: { children: ReactNode; label: string }) => (
    <div role="dialog" aria-label={label}>
      {children}
    </div>
  ),
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", nodeUrl: "http://node", l1ChainId: 31337 }),
}))
vi.mock("../../../src/features/operations/TabLine", () => ({ TabLine: () => null }))
const sources = vi.hoisted(() => ({ list: [] as { savings: boolean }[] }))
vi.mock("../../../src/features/migration/oldVersionWithdraw", () => ({
  useWithdrawableSources: () => sources.list,
}))
import { SavingsMoveDetailModal } from "../../../src/features/savings/SavingsMoveDetailModal"
import { SavingsMoveRow } from "../../../src/features/savings/SavingsMoveRow"

const ONE = 10n ** 18n
const PRICE = (107n * ONE) / 100n
const move = (extra: Partial<SavingsMoveRecord> = {}): SavingsMoveRecord =>
  ({
    direction: "in",
    withdrawalLocalId: "w1",
    escrow: "0x00000000000000000000000000000000000000ee",
    nonce: `0x${"03".repeat(32)}`,
    recipientCommitment: `0x${"01".repeat(32)}`,
    amount: (25n * ONE).toString(),
    startTime: 1_700_000_000_000,
    value: (25n * ONE).toString(),
    net: ((2335n * ONE) / 100n).toString(),
    ...extra,
  } as SavingsMoveRecord)
const burn = (phase: WithdrawalRecord["phase"]) =>
  ({ localId: "w1", phase, l2TxHash: `0x${"5a".repeat(32)}` } as WithdrawalRecord)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  sources.list = []
})

describe("SavingsMoveDetailModal", () => {
  it.each([
    ["no old Savings source", [], undefined],
    ["an escrow that never ran", [{ savings: true }], undefined],
    [
      "a Main source for a move into Savings",
      [{ savings: false }],
      { inboxIndex: "1", amount: "1", claimed: false },
    ],
  ])(
    "says an old version closed before the move finished, without Withdraw for %s",
    (_, list, deposit) => {
      sources.list = list
      act(() =>
        root.render(
          <SavingsMoveDetailModal
            move={move({ retired: true, deposit })}
            burn={burn("done")}
            onWithdraw={() => {}}
            onClose={() => {}}
          />,
        ),
      )
      expect(host.textContent).toContain("Didn't finish")
      expect(host.textContent).toContain("This version can't return them yet.")
      expect([...host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
        "Withdraw",
      )
    },
  )

  it("offers Withdraw for a stranded move whose deposit reached an old Savings portal", () => {
    sources.list = [{ savings: true }]
    const onWithdraw = vi.fn()
    const deposit = { inboxIndex: "1", amount: "1", claimed: false }
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move({ retired: true, deposit })}
          burn={burn("done")}
          onWithdraw={onWithdraw}
          onClose={() => {}}
        />,
      ),
    )
    expect(host.textContent).toContain("Withdraw sends them to an Ethereum address.")
    act(() =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Withdraw")!.click(),
    )
    expect(onWithdraw).toHaveBeenCalled()
  })

  it("shows a recovered move as finished: where it went and the recovery tx, no wait and no check", () => {
    const onCheckAgain = vi.fn()
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move({
            recovered: {
              to: "0x1234000000000000000000000000000000abcd",
              txHashes: [`0x${"7e".repeat(32)}`],
            },
          })}
          burn={burn("done")}
          onCheckAgain={onCheckAgain}
          onClose={() => {}}
        />,
      ),
    )
    expect(host.textContent).toContain("Recovered to 0x12340…0abcd")
    expect(host.textContent).toContain("Recovery tx")
    expect(host.textContent).not.toContain("Moving to")
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Check again",
    )
  })

  it("offers the exit it is given for a burn the relayer has not released", () => {
    const onStart = vi.fn()
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move()}
          burn={burn("finalizing_l1")}
          exit={{ title: "Finalize manually", onStart }}
          onClose={() => {}}
        />,
      ),
    )
    const finalize = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Finalize manually",
    )!
    act(() => finalize.click())
    expect(onStart).toHaveBeenCalledOnce()
  })

  it("describes a crediting move: its legs, the refusal, and a way to check again", () => {
    const onCheckAgain = vi.fn()
    const crediting = move({
      deposit: { inboxIndex: "103781376", amount: (23n * ONE).toString(), claimed: false },
      lastCheck: { at: 1_700_000_100_000, message: "claim refused: No L1 to L2 message found" },
    })
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={crediting}
          burn={burn("done")}
          sharePrice={PRICE}
          onCheckAgain={onCheckAgain}
          onClose={() => {}}
        />,
      ),
    )
    const text = host.textContent!
    expect(text).toContain("Main Account → Savings")
    expect(text).toContain("Moving to Savings")
    expect(text).not.toContain("Claiming")
    expect(text).toContain("Amount moved$25.00")
    expect(text).toContain("L1 fee-$1.65")
    expect(text).toContain("Savings receives$23.35")
    expect(text).toContain("Shares23 sUSDS")
    expect(text).toContain("Last check")
    expect(text).toContain("Deposit found, waiting for it to reach Aztec")
    expect(text).not.toContain("claim refused")
    expect(text).not.toContain("To0x")
    act(() =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Check again")!.click(),
    )
    expect(onCheckAgain).toHaveBeenCalled()
  })

  it("reads a claimed move as credited with no check, and a burn in flight by its leg", () => {
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move({
            deposit: { inboxIndex: "1", amount: (23n * ONE).toString(), claimed: true },
          })}
          burn={burn("done")}
          sharePrice={PRICE}
          onCheckAgain={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    expect(host.textContent).toContain("Credited")
    expect(host.textContent).toContain("Savings received$23.35")
    expect(host.textContent).not.toContain("Check again")
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move()}
          burn={burn("awaiting_proven")}
          eta={{ seconds: 740, remaining: true }}
          onClose={() => {}}
        />,
      ),
    )
    expect(host.textContent).toContain("Moving to Savings")
    expect(host.textContent).toContain("TimeAbout 12 min left")
    expect(host.textContent).not.toContain("Ethereum")
    expect(host.textContent).toContain("Savings receives≈ $23.35")
  })
})

describe("SavingsMoveDetailModal, failed", () => {
  const reason = () => host.querySelector(".ww-status-reason > small")?.textContent

  it("says why the burn failed under Failed: a reorg, another drop by the network, or a local error", () => {
    const reorged = {
      ...burn("failed"),
      droppedBurn: true,
      endTime: 1_700_000_260_000,
      failure: { code: "withdrawal.reorged" },
    } as WithdrawalRecord
    act(() =>
      root.render(<SavingsMoveDetailModal move={move()} burn={reorged} onClose={() => {}} />),
    )
    expect(host.querySelector(".ww-status-reason b")?.textContent).toContain("Failed")
    expect(reason()).toBe("Reverted by the network. Funds still in Main Account.")
    expect(host.querySelectorAll(".ww-sheet__note")).toHaveLength(0)
    expect(host.textContent).not.toContain("Check again")

    const dropped = {
      ...burn("failed"),
      burnDroppedAt: 1_700_000_200_000,
      failure: { code: "withdrawal.dropped", detail: "Tx dropped by P2P node" },
    } as WithdrawalRecord
    act(() =>
      root.render(<SavingsMoveDetailModal move={move()} burn={dropped} onClose={() => {}} />),
    )
    expect(reason()).toBe("The withdrawal transaction was dropped or reverted. You can try again.")
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move()}
          burn={{ ...dropped, failure: undefined } as WithdrawalRecord}
          onClose={() => {}}
        />,
      ),
    )
    expect(reason()).toBe("Dropped by the network.")

    const local = {
      ...burn("failed"),
      failure: { code: "withdrawal.failed", detail: "Balance not enough" },
    } as WithdrawalRecord
    act(() => root.render(<SavingsMoveDetailModal move={move()} burn={local} onClose={() => {}} />))
    expect(reason()).toBe("Withdrawal failed")
  })

  it("says the move was not sent when the burn has no hash, naming the account the funds stayed in", () => {
    const neverSent = {
      ...burn("failed"),
      l2TxHash: undefined,
      endTime: 1_700_000_260_000,
      failure: { code: "withdrawal.interrupted" },
    } as WithdrawalRecord
    act(() =>
      root.render(<SavingsMoveDetailModal move={move()} burn={neverSent} onClose={() => {}} />),
    )
    expect(reason()).toBe(
      "Transaction not sent. Funds still in Main Account.",
    )
    expect(host.textContent).not.toContain("withdrawal")
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move({ direction: "out" })}
          burn={neverSent}
          onClose={() => {}}
        />,
      ),
    )
    expect(reason()).toBe(
      "Transaction not sent. Funds still in Savings.",
    )

    const takenOver = {
      ...neverSent,
      failure: { code: "withdrawal.inactiveTab" },
    } as WithdrawalRecord
    act(() =>
      root.render(<SavingsMoveDetailModal move={move()} burn={takenOver} onClose={() => {}} />),
    )
    expect(reason()).toBe(
      "Another zk.money tab took over before this move was sent. Funds still in Main Account.",
    )
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move({ direction: "out" })}
          burn={takenOver}
          onClose={() => {}}
        />,
      ),
    )
    expect(reason()).toBe(
      "Another zk.money tab took over before this move was sent. Funds still in Savings.",
    )
    expect(host.textContent).not.toContain("revoked")
    // A burn without a hash but with no error at all reads the same: it was never sent.
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move()}
          burn={{ ...neverSent, failure: undefined } as WithdrawalRecord}
          onClose={() => {}}
        />,
      ),
    )
    expect(reason()).toBe(
      "Transaction not sent. Funds still in Main Account.",
    )
  })
})

describe("SavingsMoveRow", () => {
  it("carries the time left in its subline, and keeps the last check for the sheet", () => {
    act(() =>
      root.render(
        <SavingsMoveRow
          move={move({
            lastCheck: {
              at: 1_700_000_100_000,
              message: "claim refused: No L1 to L2 message found",
            },
          })}
          burn={burn("done")}
          perspective="savings"
          eta={{ seconds: 150, remaining: false }}
          onOpen={() => {}}
        />,
      ),
    )
    // The note sits inside the row, in its subline, with nothing wrapped around the card.
    expect(host.firstElementChild?.className).toBe("row")
    expect(host.querySelector("small")?.textContent).toMatch(/^Usually about 3 min · /)
    expect(host.textContent).toContain("Moving to Savings")
    expect(host.textContent).not.toContain("Last check")
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Check again",
    )
    act(() =>
      root.render(
        <SavingsMoveRow
          move={move()}
          burn={burn("awaiting_proven")}
          perspective="main"
          onOpen={() => {}}
        />,
      ),
    )
    expect(host.querySelector("small")?.textContent).toMatch(/^Main Account → Savings · /)
  })
})
