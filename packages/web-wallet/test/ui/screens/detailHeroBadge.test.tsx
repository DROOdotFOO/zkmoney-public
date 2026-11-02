/**
 * The status a detail sheet's hero badge shows, against the badge the feed row shows for the same
 * record. A creator paylink row's hero is the link's own lifecycle, so an expired link that is still
 * awaiting its reclaim never reads as finished; a plain transaction's hero is the transaction's own
 * state. The agreement is pinned against the shared label maps, not against the words themselves.
 */
import { act } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import type { Hex } from "viem"
import {
  PAYLINK_STATUS_LABEL,
  globalEventEmitter,
  type PaylinkStatusKind,
  type PaylinkTransaction,
  type TransactionStatus,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import type { ActivityRowView } from "../../../src/ui/screens/activityView"
import { TxDetailModal } from "../../../src/ui/screens/TxDetailModal"
import { WithdrawalDetailModal } from "../../../src/ui/screens/WithdrawalDetailModal"
import { seedBootConfig } from "../../support/seedBootConfig"

// The live hook needs the PXE providers; a sheet with no deps reads the row's stored status.
vi.mock("../../../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => undefined }))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const CREATED_MS = Date.UTC(2026, 4, 1, 12, 0)

const creatorRow = (
  paylinkStatus: PaylinkStatusKind,
  status: TransactionStatus = "success",
): ActivityRowView => ({
  id: "row_1",
  counterparty: "Sent via paylink",
  timestamp: "1 May, 12:00",
  timestampMs: CREATED_MS,
  amount: "-$30.00",
  status,
  statusLabel:
    status === "pending"
      ? "Pending"
      : status === "failed"
      ? "Failed"
      : PAYLINK_STATUS_LABEL[paylinkStatus],
  txHash: `0x${"66".repeat(32)}`,
  // No decodable fragment would strand the sheet's share block, which the hero renders above.
  paylink: "https://zk.money/link#frag",
  paylinkStatus,
  paylinkRow: {
    action: "Pay To Email",
    flavor: "direct",
    status,
    timestamp: CREATED_MS,
    obsidionAccountAddress: `0x${"3f".repeat(32)}`,
    fromClaimable: 0,
    untilClaimable: Math.floor(CREATED_MS / 1000) + 86_400,
    token: { symbol: "DAI", amount: 30 },
  } as unknown as PaylinkTransaction,
})

const withdrawal = (phase: WithdrawalRecord["phase"]): WithdrawalRecord =>
  ({
    localId: "wdraw_1",
    recipient: `0x${"dd".repeat(20)}`,
    recipientProvenance: "saved-recipient",
    amount: "120",
    tokenSymbol: "DAI",
    phase,
    startTime: CREATED_MS,
    l2TxHash: `0x${"0a".repeat(32)}` as Hex,
  } as WithdrawalRecord)

describe("detail sheet hero badge", () => {
  let container: HTMLDivElement
  let root: Root

  const hero = () => container.querySelector(".zkm-status-badge")?.textContent

  beforeAll(seedBootConfig)

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const { openTestSession } = await import("../../support/session")
    openTestSession()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const showTx = (row: ActivityRowView) =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <TxDetailModal row={row} onClose={vi.fn()} />
        </MemoryRouter>,
      )
    })

  it("never calls an expired link finished — it is still awaiting its reclaim", async () => {
    await showTx(creatorRow("expired"))

    expect(hero()).toBe(PAYLINK_STATUS_LABEL.expired)
  })

  it("speaks for the transaction first, while the link's own state is not yet settled", async () => {
    for (const status of ["pending", "failed"] as const) {
      const row = creatorRow("awaitingClaim", status)
      await showTx(row)
      expect(hero(), status).toBe(row.statusLabel)
    }
  })

  it("takes the claimed status once the shared reconciler flips the row", async () => {
    const row = creatorRow("awaitingClaim")
    await showTx(row)

    await act(async () => globalEventEmitter.emitPaylinkClaimed({ txHash: row.txHash! }))
    expect(hero()).toBe(PAYLINK_STATUS_LABEL.claimed)
  })

  it("ignores another row's claim", async () => {
    await showTx(creatorRow("awaitingClaim"))

    await act(async () => globalEventEmitter.emitPaylinkClaimed({ txHash: `0x${"99".repeat(32)}` }))
    expect(hero()).toBe(PAYLINK_STATUS_LABEL.awaitingClaim)
  })

  it.each(["submitting", "l2_mined", "finalizing_l1", "failed", "done"] as const)(
    "names the leg a %s withdrawal is on in its Status row",
    async (phase) => {
      await act(async () => {
        root.render(
          <WithdrawalDetailModal record={withdrawal(phase)} amount="-120 DAI" onClose={vi.fn()} />,
        )
      })

      const status = Array.from(container.querySelectorAll(".ww-sheet__fact"))
        .find((row) => row.querySelector("span")?.textContent === "Status")
        ?.querySelector("b")
        ?.textContent?.trim()
      // The sheet is finer-grained than the feed row: a released withdrawal reads Paid, a failed one
      // Failed, and every in-flight leg names what it waits on.
      expect(status).toBe(
        {
          submitting: "Waiting for Aztec confirmation",
          l2_mined: "Releasing to Ethereum",
          finalizing_l1: "Releasing to Ethereum",
          done: "Paid",
          failed: "Failed",
        }[phase],
      )
    },
  )

  it("says the proof runs on the device until the burn has a hash", async () => {
    await act(async () => {
      root.render(
        <WithdrawalDetailModal
          record={{ ...withdrawal("submitting"), l2TxHash: undefined }}
          amount="-120 DAI"
          onClose={vi.fn()}
        />,
      )
    })
    const status = Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((row) => row.querySelector("span")?.textContent === "Status")
      ?.querySelector("b")
      ?.textContent?.trim()
    expect(status).toBe("Proving privately")
  })

  it("names the user's own finalization once its tx is in flight", async () => {
    await act(async () => {
      root.render(
        <WithdrawalDetailModal
          record={{ ...withdrawal("finalizing_l1"), finalizeTxHash: `0x${"0b".repeat(32)}` }}
          amount="-120 DAI"
          onClose={vi.fn()}
        />,
      )
    })
    const status = Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((row) => row.querySelector("span")?.textContent === "Status")
      ?.querySelector("b")
      ?.textContent?.trim()
    expect(status).toBe("Waiting for your finalization")
  })
})
