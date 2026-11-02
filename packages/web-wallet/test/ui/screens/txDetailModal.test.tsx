/**
 * The transaction detail sheet: chrome header, Amount / Note / Date / Tx hash / Status card,
 * and the "See all transactions" jump to the counterparty's chat (hidden inside that chat and on
 * pending rows). The explorer is reachable through the Tx hash row alone.
 */
import React, { act } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import {
  clearRefundInFlight,
  markRefundInFlight,
  type PaylinkTransaction,
} from "@obsidion/front-core"
import { provingProgress } from "@obsidion/proving-progress"
import { MemoryRouter, useLocation } from "react-router-dom"
import type { ActivityRowView } from "../../../src/ui/screens/activityView"
import { TxDetailModal } from "../../../src/ui/screens/TxDetailModal"
import { getOperationStore } from "../../../src/features/operations/operations"
import { seedBootConfig } from "../../support/seedBootConfig"

const h = vi.hoisted(() => ({
  deps: undefined as unknown,
  chainNow: undefined as number | undefined,
}))

// The live hooks need the PXE providers and a node to poll.
vi.mock("../../../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => h.deps }))
vi.mock("../../../src/features/paylink/chainTime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/paylink/chainTime")>()),
  usePolledChainSeconds: () => h.chainNow,
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const HASH = `0x${"93".repeat(32)}`

const plain: ActivityRowView = {
  id: HASH,
  counterparty: "Unknown sender",
  timestamp: "1 May, 12:00",
  timestampMs: Date.UTC(2026, 4, 1, 12, 0),
  amount: "+$100.00",
  status: "success",
  txHash: HASH,
}

const fromContact: ActivityRowView = {
  ...plain,
  counterparty: "Cypher Girl",
  contact: {
    id: "c_1",
    name: "Cypher Girl",
    tag: "cyphergirl",
    address: `0x${"aa".repeat(32)}`,
    addressKind: "aztec-l2",
  },
  amount: "+$45.00",
}

describe("TxDetailModal", () => {
  let container: HTMLDivElement
  let root: Root

  let pathname: string
  const labels = () =>
    Array.from(container.querySelectorAll(".zkm-confirm-detail-row__label")).map(
      (el) => el.textContent,
    )
  const value = (label: string) =>
    Array.from(container.querySelectorAll(".zkm-confirm-detail-row"))
      .find((row) => row.querySelector(".zkm-confirm-detail-row__label")?.textContent === label)
      ?.querySelector(".zkm-confirm-detail-row__value")?.textContent
  const links = () => Array.from(container.querySelectorAll("a")).map((a) => a.href)
  const badge = () => container.querySelector(".zkm-status-badge")?.textContent
  const reason = () => container.querySelector(".ww-status-reason > small")?.textContent
  const seeAll = () => container.querySelector<HTMLButtonElement>(".ww-txd__all")

  beforeAll(seedBootConfig)

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const { openTestSession } = await import("../../support/session")
    openTestSession()
    h.deps = undefined
    h.chainNow = undefined
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const Location = () => {
    pathname = useLocation().pathname
    return null
  }
  const show = (node: React.ReactElement, at = "/") =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={[at]}>
          {node}
          <Location />
        </MemoryRouter>,
      )
    })

  it("plain receive: Received header, four rows, dialog with a working close", async () => {
    const onClose = vi.fn()
    await show(<TxDetailModal row={plain} onClose={onClose} />)

    expect(container.querySelector(".ww-pay__title")?.textContent).toBe("Received")
    expect(container.querySelector(".ww-pay__handle")?.textContent).toBe("Unknown sender")
    expect(labels()).toEqual(["Amount", "Date", "Tx hash", "Status"])
    expect(value("Amount")).toBe("$100.00")
    expect(value("Status")).toBe("Completed")
    expect(links()).toHaveLength(1)
    expect(links()[0]).toMatch(new RegExp(`${HASH}$`))
    expect(seeAll()).toBeNull()

    const dialog = container.querySelector("[role='dialog']")
    expect(dialog?.getAttribute("aria-label")).toBe("Received $100.00")
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Close']")!.click(),
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("contact row from Home: handle subtitle, Note override, See all jumps to the chat", async () => {
    const onClose = vi.fn()
    await show(<TxDetailModal row={fromContact} note="Pizza dinner" onClose={onClose} />)

    expect(container.querySelector(".zkm-avatar")?.textContent).toBe("C")
    expect(container.querySelector(".ww-pay__handle")?.textContent).toBe("cyphergirl.zk.money")
    expect(labels()).toEqual(["Amount", "Note", "Date", "Tx hash", "Status"])
    expect(value("Note")).toBe("Pizza dinner")

    expect(seeAll()?.textContent).toBe("See all transactions")
    await act(async () => seeAll()!.click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(pathname).toBe("/contacts/c_1")
  })

  it("a send to someone not saved still opens their conversation by tag", async () => {
    const onClose = vi.fn()
    await show(
      <TxDetailModal
        row={{
          ...plain,
          counterparty: "@pleaswork",
          counterpartyTag: "pleaswork",
          amount: "-$1.00",
        }}
        onClose={onClose}
      />,
    )

    await act(async () => seeAll()!.click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(pathname).toBe("/contacts/pleaswork")
  })

  it("inside that contact's chat: the row's own note, no See all", async () => {
    await show(
      <TxDetailModal row={{ ...fromContact, amount: "-$45.00", note: "Rent" }} onClose={vi.fn()} />,
      "/contacts/c_1",
    )

    expect(value("Note")).toBe("Rent")
    expect(seeAll()).toBeNull()
  })

  it("failed send: titled by the action, never as sent", async () => {
    await show(
      <TxDetailModal
        row={{ ...fromContact, amount: "-$5.00", status: "failed", txHash: undefined }}
        onClose={vi.fn()}
      />,
    )

    expect(container.querySelector(".ww-pay__title")?.textContent).toBe("Send")
    expect(value("Status")).toBe("Failed")
  })

  it("reverted receive: titled by the action, Failed with the reorg beneath", async () => {
    const error = "Reverted by the network. It isn't in your balance."
    await show(
      <TxDetailModal
        row={{ ...plain, status: "failed", statusLabel: "Failed", error }}
        onClose={vi.fn()}
      />,
    )

    expect(container.querySelector(".ww-pay__title")?.textContent).toBe("Receive")
    expect(badge()).toBe("Failed")
    expect(reason()).toBe(error)
    expect(labels()).not.toContain("Reason")
  })

  it("pending send: -- date and hash, Pending badge, no See all", async () => {
    await show(
      <TxDetailModal
        row={{ ...fromContact, amount: "-$5.00", status: "pending", txHash: undefined }}
        onClose={vi.fn()}
      />,
    )

    expect(container.querySelector(".ww-pay__title")?.textContent).toBe("Send")
    expect(value("Date")).toBe("--")
    expect(value("Tx hash")).toBe("--")
    expect(value("Status")).toBe("Pending")
    expect(links()).toEqual([])
    expect(seeAll()).toBeNull()
  })

  const paylink = "https://wallet/link#frag"
  const linkRow = (
    status: ActivityRowView["status"],
    over: Partial<PaylinkTransaction> = {},
  ): ActivityRowView => ({
    ...plain,
    id: "queue-1",
    counterparty: status === "success" ? "Sent via paylink" : "Paylink",
    amount: "-$25.00",
    status,
    txHash: status === "success" ? HASH : undefined,
    paylink,
    paylinkStatus: "awaitingClaim",
    paylinkRow: {
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      flavor: "direct",
      status,
      timestamp: plain.timestampMs,
      paylink,
      untilClaimable: Math.floor(Date.now() / 1000) + 86_400,
      ...over,
    } as PaylinkTransaction,
  })

  it("pending creator paylink: the banner follows the link's operation, not the row", async () => {
    const store = getOperationStore()
    await store.begin({
      operationId: "op-link",
      flow: "paylink-create",
      summary: "$25",
      scope: null,
    })
    const pendingLink = linkRow("pending", { operationId: "op-link" })
    await show(<TxDetailModal row={pendingLink} onClose={vi.fn()} />)

    const keep = () => container.querySelector(".ww-txd__notice--live")
    const safe = () => container.querySelector(".ww-txd__notice--safe")
    expect(keep()?.textContent).toContain("Keep this tab open until it's finished creation")
    expect(keep()?.querySelector(".zkm-spinner-icon")).toBeNull()
    expect(safe()).toBeNull()
    expect(container.textContent).toContain("Copy paylink")
    expect(container.querySelector(".ww-pay__title")?.textContent).toBe("Paylink")
    expect(value("Status")).toBe("Pending")

    await act(async () => {
      provingProgress.emitTxHashSaved("op-link", HASH)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(keep()).toBeNull()
    expect(safe()?.textContent).toContain("Sent. You can close this tab.")
    expect(safe()?.querySelector(".zkm-spinner-icon")).toBeNull()

    // Settled: the banner leaves with the operation, whatever the row still says.
    await act(async () => {
      store.release("op-link")
      await store.settle("op-link", HASH)
    })
    expect(keep()).toBeNull()
    expect(safe()).toBeNull()
  })

  it("failed creator paylink: no Share or Copy, no expiry, and its reason", async () => {
    await show(
      <TxDetailModal
        row={{ ...linkRow("failed"), error: "The send was interrupted" }}
        onClose={vi.fn()}
      />,
    )

    expect(container.querySelector(".ww-pay__title")?.textContent).toBe("Paylink")
    expect(badge()).toBe("Failed")
    expect(reason()).toBe("The send was interrupted")
    expect(labels()).not.toContain("Reason")
    expect(labels()).not.toContain("Link expiry")
    expect(container.querySelectorAll("button:not([aria-label])")).toHaveLength(0)
  })

  it("creator paylink this page is refunding: Cancelling until the refund ends", async () => {
    const secret = `0x${"66".repeat(32)}`
    await show(
      <TxDetailModal row={linkRow("success", { payToEmailSecret: secret })} onClose={vi.fn()} />,
    )
    expect(value("Status")).toBe("Unclaimed")

    await act(async () => markRefundInFlight(secret))
    expect(value("Status")).toBe("Cancelling")
    expect(container.textContent).not.toContain("Copy paylink")

    await act(async () => clearRefundInFlight(secret))
    expect(value("Status")).toBe("Unclaimed")
    expect(container.textContent).toContain("Copy paylink")
  })

  it("creator paylink: copying it closes the sheet, a refused copy keeps it open", async () => {
    const copyButton = () =>
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy paylink")!
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const onClose = vi.fn()
    await getOperationStore().begin({
      operationId: "op-copy",
      flow: "paylink-create",
      summary: "$25",
      scope: null,
    })
    const row = linkRow("pending", { operationId: "op-copy" })
    await show(<TxDetailModal row={row} onClose={onClose} />)
    await act(async () => copyButton().click())
    expect(writeText).toHaveBeenCalledWith(paylink)
    expect(onClose).toHaveBeenCalledOnce()

    writeText.mockRejectedValue(new Error("denied"))
    document.execCommand = () => false
    onClose.mockClear()
    await show(<></>)
    await show(<TxDetailModal row={row} onClose={onClose} />)
    await act(async () => copyButton().click())
    expect(onClose).not.toHaveBeenCalled()
    Reflect.deleteProperty(navigator, "clipboard")
    await getOperationStore().remove("op-copy")
  })

  it("creator paylink another account made: Copy paylink, and no Cancel link", async () => {
    // A backup passkey add moves the wallet onto a new account; the escrow refunds only its maker.
    const nowSec = Math.floor(Date.now() / 1000)
    const oneKey = `0x${"11".repeat(32)}`
    const actAs = (account: string) => {
      h.deps = { account: { getAddress: () => ({ toString: () => account }) }, wallet: {} }
    }
    h.chainNow = nowSec
    const row = linkRow("success", {
      obsidionAccountAddress: oneKey,
      payToEmailSecret: `0x${"44".repeat(32)}`,
      fallbackSecret: `0x${"55".repeat(32)}`,
      fromClaimable: 0,
      refundableUntil: nowSec + 3_600,
    })

    actAs(`0x${"22".repeat(32)}`)
    await show(<TxDetailModal row={row} onClose={vi.fn()} />)
    expect(value("Status")).toBe("Unclaimed")
    expect(container.textContent).toContain("Copy paylink")
    expect(container.textContent).not.toContain("Cancel link")

    actAs(oneKey)
    await show(<></>)
    await show(<TxDetailModal row={row} onClose={vi.fn()} />)
    expect(container.textContent).toContain("Cancel link")
  })

  it("creator paylink with a refund in flight: Cancelling, and nothing to tap", async () => {
    const refundTxHash = `0x${"77".repeat(32)}`
    await show(
      <TxDetailModal
        row={{ ...linkRow("success", { refundTxHash }), refundTxHash, refundStatus: "pending" }}
        onClose={vi.fn()}
      />,
    )

    expect(container.querySelector(".ww-pay__title")?.textContent).toBe("Send via paylink")
    expect(value("Status")).toBe("Cancelling")
    expect(container.textContent).not.toContain("Copy paylink")
    expect(container.textContent).not.toContain("Cancel paylink")
  })
})
