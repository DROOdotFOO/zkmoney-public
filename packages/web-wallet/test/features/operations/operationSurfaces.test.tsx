/**
 * The bell's panel lists operations straight off their records: running ones with a spinner,
 * ended ones as their outcome. Nothing is written for an operation, so a reload or an account
 * switch shows exactly what the store holds for the active account.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { provingProgress } from "@obsidion/proving-progress"
import {
  INTERRUPTED_ERRORS,
  OPERATIONS_STORAGE_KEY,
  reorgEvent,
  type OperationRecord,
} from "@obsidion/front-core"
import { clearActiveStorage, setActiveStorageId } from "../../../src/platform/storage/activeStorage"
import { PAYLINK_NOT_CLAIMABLE_YET_MESSAGE } from "../../../src/features/paylink/claimWindow"
import { getOperationStore } from "../../../src/features/operations/operations"
import {
  activeNamespace,
  closeSession,
  switchSession,
  session,
} from "../../../src/platform/session"
import { operationEntry } from "../../support/operations"
import {
  NotificationsPanel,
  useNotificationList,
} from "../../../src/ui/NotificationsPanel/NotificationsPanel"
import { OPERATION_COPY } from "../../../src/features/operations/operationCopy"
import { tabLineText } from "../../../src/features/operations/TabLine"
import copy from "../../../src/ui/notifications.copy"
import { fmt } from "../../../src/lib/fmt"

const hash = `0x${"ab".repeat(32)}`
const SUMMARY = "$25 to @alice"
const LINK = "$4 paylink"
/** An ended operation's description: its summary, then the words for how it ended. */
const described = (summary: string, words: string | null | undefined) => [summary, words].join(". ")
const stageLine = (stage: string) => fmt(copy.panel.operation, { summary: SUMMARY, stage })

let container: HTMLDivElement
let root: Root
let unread = -1

beforeEach(async () => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  closeSession()
  clearActiveStorage()
  // Every test starts from an empty panel for the visitor scope.
  await getOperationStore().dismissEnded(null)
})

async function begin(operationId: string, flow = "send", scope: string | null = null) {
  await act(async () => {
    await getOperationStore().begin({ operationId, flow, summary: SUMMARY, scope })
  })
}

function Unread() {
  unread = useNotificationList().unreadCount
  return null
}

// Opened as late as a boot would: the records an earlier page left are saved by then.
const renderPanel = () => {
  switchSession(activeNamespace())
  return act(async () =>
    root.render(
      <MemoryRouter>
        <Unread />
        <NotificationsPanel onClose={() => {}} />
      </MemoryRouter>,
    ),
  )
}
const items = () => [...container.querySelectorAll(".ww-notifications__item")]
const itemText = (text: string) => items().find((i) => i.textContent?.includes(text))
const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

describe("the panel", () => {
  // First, before anything loads the store: the records an earlier page left behind.
  it("after a reload, lists an operation that ended on the earlier page, unread", async () => {
    const ended: OperationRecord = {
      operationId: "op-earlier",
      flow: "send",
      summary: "$9 to @bob",
      scope: null,
      state: "settled",
      startedAt: 1,
      endedAt: 2,
      txHash: hash,
    }
    walletStorage.setItem(
      `obsidion.${OPERATIONS_STORAGE_KEY}`,
      JSON.stringify({ [ended.operationId]: ended }),
    )
    await renderPanel()
    expect(itemText("$9 to @bob")?.textContent).toContain("Sent")
    expect(itemText("$9 to @bob")?.querySelector('[aria-label="Unread"]')).not.toBeNull()
    expect(unread).toBeGreaterThanOrEqual(1)
  })

  it("lists a running operation with a spinner and no note, then its outcome", async () => {
    await begin("op-panel", "paylink-claim")
    await renderPanel()
    const running = container.querySelector('.ww-notifications__item[role="status"]')
    expect(running?.textContent).toContain("Receiving")
    expect(running?.textContent).toContain(tabLineText("keep"))
    expect(running?.querySelector('[role="note"]')).toBeNull()
    await act(async () => {
      provingProgress.emitTxHashSaved("op-panel", hash)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(running?.textContent).toContain(tabLineText("safe"))
    await act(async () => getOperationStore().settle("op-panel", hash))
    expect(container.querySelector('.ww-notifications__item[role="status"]')).toBeNull()
    expect(itemText("$25 to @alice")?.textContent).toContain("Received")
  })

  it("says which stage a running operation is at, off its record", async () => {
    await begin("op-stage", "paylink-claim")
    await renderPanel()
    const running = () => container.querySelector('.ww-notifications__item[role="status"]')
    expect(running()?.textContent).toContain(stageLine(copy.panel.preparing))
    await act(async () => getOperationStore().markProving("op-stage"))
    expect(running()?.textContent).toContain(stageLine(copy.panel.proving))
    await act(async () => getOperationStore().markSent("op-stage", hash))
    expect(running()?.textContent).not.toContain(copy.panel.proving)
    expect(running()?.textContent).toContain(tabLineText("safe"))
    await act(async () => getOperationStore().settle("op-stage", hash))
  })

  it("shows a boot-sweep failure with its cause", async () => {
    const store = getOperationStore()
    const lost = { operationId: "op-lost", flow: "send", summary: "$3 to @bob", scope: null }
    await store.begin(lost, 1)
    await store.markProving("op-lost", 1)
    store.release("op-lost")
    await renderPanel()
    await act(async () => store.failInterrupted(2))
    const row = itemText("$3 to @bob")?.textContent
    expect(row).toContain(OPERATION_COPY.send.failed)
    expect(row).toContain(INTERRUPTED_ERRORS.send)
  })

  it("hides an ended operation once dismissed, and marks it read once opened", async () => {
    await begin("op-dismiss")
    await act(async () => getOperationStore().settle("op-dismiss", hash))
    await renderPanel()
    await click(itemText("$25 to @alice")?.querySelector('[aria-label="Dismiss"]'))
    expect(itemText("$25 to @alice")).toBeUndefined()
    expect(getOperationStore().get("op-dismiss")?.dismissedAt).toBeDefined()

    await begin("op-open")
    await act(async () => getOperationStore().settle("op-open", hash))
    await click(itemText("$25 to @alice")?.querySelector(".ww-notifications__row"))
    expect(getOperationStore().get("op-open")?.readAt).toBeDefined()
  })

  it("clears ended operations and keeps running ones", async () => {
    await begin("op-cleared")
    await act(async () => getOperationStore().settle("op-cleared", hash))
    await begin("op-still-running")
    await renderPanel()
    const buttons = [...container.querySelectorAll("button")]
    const clear = buttons.find((b) => b.textContent === "Clear all")
    await click(clear)
    expect(getOperationStore().get("op-cleared")?.dismissedAt).toBeDefined()
    expect(container.querySelector('.ww-notifications__item[role="status"]')).not.toBeNull()
    await act(async () => getOperationStore().remove("op-still-running"))
  })

  it("keeps a reorg notice its failed send covers hidden once the send is cleared", async () => {
    await begin("op-dropped")
    await act(async () => getOperationStore().markSent("op-dropped", hash))
    await act(async () => getOperationStore().fail("op-dropped", "boom"))
    const notice = reorgEvent({ type: "failed", txHash: hash }, Date.now(), () => false)!
    await act(async () => switchSession(activeNamespace()).notifications.record(notice))
    await renderPanel()
    expect(items()).toHaveLength(1)
    await click(items()[0].querySelector('[aria-label="Dismiss"]'))
    expect(getOperationStore().get("op-dropped")?.dismissedAt).toBeDefined()
    expect(items()).toHaveLength(0)
    await act(async () => session().notifications.retract(notice.id))
  })

  it("never lists another account's operations", async () => {
    setActiveStorageId("acct-b")
    await begin("op-of-a", "send", "acct-a")
    await act(async () => getOperationStore().settle("op-of-a", hash))
    await begin("op-a-running", "send", "acct-a")
    await renderPanel()
    expect(items()).toHaveLength(0)
    await act(async () => setActiveStorageId("acct-a"))
    expect(items()).toHaveLength(2)
    await act(async () => getOperationStore().remove("op-a-running"))
    await getOperationStore().dismissEnded("acct-a")
  })

  it("shows no ended row for a flow whose own record reports its ending", async () => {
    await begin("op-burn", "withdraw")
    await renderPanel()
    expect(container.querySelector('.ww-notifications__item[role="status"]')).not.toBeNull()
    // A sent withdrawal is already its record's live row.
    await act(async () => getOperationStore().markSent("op-burn", hash))
    expect(items()).toHaveLength(0)
    await act(async () => getOperationStore().fail("op-burn", "boom"))
    expect(items()).toHaveLength(0)
  })
})

describe("an ended operation's entry", () => {
  const reclaimDropped = {
    title: OPERATION_COPY["paylink-reclaim"].failed,
    description: described(SUMMARY, OPERATION_COPY["paylink-reclaim"].causes.dropped),
  }
  const record = (patch: Partial<OperationRecord>): OperationRecord => ({
    operationId: "op",
    flow: "send",
    summary: SUMMARY,
    scope: null,
    state: "settled",
    startedAt: 1,
    endedAt: 2,
    ...patch,
  })

  it("opens a settled send's transaction, and is read once the panel showed it", () => {
    expect(operationEntry(record({ txHash: hash }))).toMatchObject({
      title: OPERATION_COPY.send.settled,
      description: SUMMARY,
      severity: "success",
      target: { type: "transfer.txDetail", txHash: hash },
      read: false,
    })
    expect(operationEntry(record({ readAt: 3 }))?.read).toBe(true)
    expect(operationEntry(record({ state: "local", endedAt: undefined }))).toBeNull()
  })

  it("words a thrown failure by flow, never with its raw message", () => {
    const failed = { state: "failed" as const, error: "Assertion failed: Balance too low" }
    const send = OPERATION_COPY.send
    expect(operationEntry(record(failed))).toMatchObject({
      title: send.failed,
      description: described(SUMMARY, send.thrown),
      severity: "error",
    })
    const claim = record({ ...failed, flow: "paylink-claim", summary: LINK })
    expect(operationEntry(claim)).toMatchObject({
      title: OPERATION_COPY["paylink-claim"].failed,
      description: described(LINK, OPERATION_COPY["paylink-claim"].thrown),
    })
    // A thrown failure the store also ended keeps its cause's words.
    const dropped = record({ ...failed, cause: "dropped" })
    expect(operationEntry(dropped)?.description).toBe(described(SUMMARY, send.causes.dropped))
  })

  it("words the cause by flow, a tab close as the activity row does", () => {
    const lost = (flow: string) =>
      operationEntry(record({ flow, state: "failed", summary: LINK, cause: "interrupted" }))
    expect(lost("send")?.description).toBe(described(LINK, INTERRUPTED_ERRORS.send))
    expect(lost("paylink-create")?.description).toBe(
      described(LINK, INTERRUPTED_ERRORS.paylinkCreate),
    )
    expect(lost("paylink-claim")?.description).toBe(
      described(LINK, INTERRUPTED_ERRORS.paylinkClaim),
    )
    const dropped = record({ flow: "paylink-reclaim", state: "failed", cause: "dropped" })
    expect(operationEntry(dropped)).toMatchObject(reclaimDropped)
  })

  it("tells a claimer a link is not claimable yet, not the revert", () => {
    const failed = record({
      flow: "paylink-claim",
      state: "failed",
      error: "Assertion failed: window not open",
      cause: "dropped",
    })
    expect(operationEntry(failed)?.description).toBe(PAYLINK_NOT_CLAIMABLE_YET_MESSAGE)
  })

  it("reads a dropped transaction off the store's resolver", async () => {
    const store = getOperationStore()
    await begin("op-dropped", "paylink-reclaim")
    // A field element, as a tx hash is.
    await store.markSent("op-dropped", `0x${"0a".repeat(32)}`)
    store.release("op-dropped")
    await store.resolveSent({ getTxReceipt: async () => ({ status: TxStatus.DROPPED } as never) })
    expect(operationEntry(store.get("op-dropped")!)).toMatchObject(reclaimDropped)
  })

  // The publish runs before the burn: one the store ended moved nothing, and the move comes back.
  it("lists nothing for an arrival publish the store ended, and the flow's own failure", () => {
    const arrival = { flow: "migration-arrival", state: "failed" as const, summary: "$85.00" }
    expect(operationEntry(record({ ...arrival, cause: "interrupted" }))).toBeNull()
    expect(operationEntry(record({ ...arrival, cause: "dropped" }))).toBeNull()
    const publish = OPERATION_COPY["migration-arrival"]
    const error = "node down"
    expect(operationEntry(record({ ...arrival, error }))).toMatchObject({
      title: publish.failed,
      description: publish.describeError?.(error),
    })
  })
})
