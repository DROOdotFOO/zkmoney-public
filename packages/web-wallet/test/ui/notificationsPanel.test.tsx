/**
 * The bell panel over the real notification stores: an unread entry shows its dot, a row tap
 * clears its entry and hands the activity feed the router state that opens its detail, the
 * old-version funds row is only marked read, a scoped panel touches only its scope, and the bell
 * toasts what is first seen while it is up.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scannedRow, type NotificationEntry, type NotificationEvent } from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession, session } from "../../src/platform/session"
import { useMigrationDialogRequest } from "../../src/features/migration/migrationDialog"
import { NotificationsBell } from "../../src/ui/NotificationsBell/NotificationsBell"
import {
  NotificationsPanel,
  freshToasts,
  toastKey,
} from "../../src/ui/NotificationsPanel/NotificationsPanel"
import { testWalletDbs } from "../support/fakeWalletDb"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

function Activity() {
  return <p>{useLocation().pathname}</p>
}

const contact = (address: string): NotificationEvent => ({
  id: `contact:added:${address}`,
  at: Date.now(),
  kind: "contactAdded",
  data: { address, contactId: address },
})
const residuals: NotificationEvent = {
  id: "migration:residuals",
  at: Date.now(),
  kind: "migrationResiduals",
  data: { items: [{ kind: "transit", count: 1 }] },
}

/** Records an event as its writer would; the bell's writer stamps it. */
const report = (event: NotificationEvent) => act(async () => session().notifications.record(event))
const state = (id: string) => session().notifications.state.get().get(id)
const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>(".ww-notifications__row"),
]

/** A transfer the chain scan read, saved. */
const scan = (txHash: string, action: "send" | "receive" = "receive") =>
  act(async () => {
    await session().activity.record(
      scannedRow({
        networkId: "0xnet",
        action,
        txHash,
        from: "alice",
        senderL2Address: "0xa11ce",
        to: "me",
        token: {
          address: "0xt",
          name: "DAI",
          symbol: "DAI",
          decimals: 18,
          logo: "",
          amount: 1,
          price: 1,
        },
        amountAtomic: 10n ** 18n,
        timestamp: Date.now(),
      }),
    )
  })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  switchSession(activeNamespace())
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  closeSession()
})

const panel = (scope?: Parameters<typeof NotificationsPanel>[0]["scope"]) =>
  act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<NotificationsPanel onClose={() => {}} scope={scope} />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/contacts/:id" element={<Activity />} />
        </Routes>
      </MemoryRouter>,
    ),
  )

describe("NotificationsPanel", () => {
  it("shows an unread entry, then clears it on a tap and opens its target", async () => {
    await report(contact("0xa1"))
    await panel()
    expect(container.querySelectorAll(".ww-notifications__dot")).toHaveLength(1)
    await act(async () => rows(container)[0].click())
    expect(state("contact:added:0xa1")?.dismissedAt).toBeDefined()
    expect(container.textContent).toContain("/contacts/0xa1")
  })

  it("opens the migration dialog from the old-version funds row, which stays until dismissed", async () => {
    await report(residuals)
    let requests = 0
    function Requests() {
      requests = useMigrationDialogRequest()
      return null
    }
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NotificationsPanel onClose={() => {}} />
          <Requests />
        </MemoryRouter>,
      ),
    )
    const before = requests
    await act(async () => rows(container)[0].click())
    expect(requests).toBe(before + 1)
    expect(state(residuals.id)).toMatchObject({ readAt: expect.any(Number) })
    expect(state(residuals.id)?.dismissedAt).toBeUndefined()
    await act(async () => session().notifications.dismiss([residuals.id]))
    expect(rows(container)).toHaveLength(0)
  })

  it("a scoped panel lists and clears only its scope", async () => {
    await report(contact("0xa1"))
    await report(contact("0xb2"))
    await panel({
      entry: (e) => e.id === "contact:added:0xa1",
      operation: () => false,
    })
    expect(rows(container)).toHaveLength(1)
    const clear = container.querySelector<HTMLButtonElement>(".ww-notifications__clear")!
    await act(async () => clear.click())
    expect(state("contact:added:0xa1")?.dismissedAt).toBeDefined()
    expect(state("contact:added:0xb2")?.dismissedAt).toBeUndefined()
  })
})

describe("the bell", () => {
  it("toasts no receive the boot's history replay lists, and one that arrives after it", async () => {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NotificationsBell openEntry={() => null} />
        </MemoryRouter>,
      ),
    )
    const toast = () => container.querySelector(".ww-notifications__toast")
    await scan("0x4e91a7")
    expect(state("transfer:receive:0x4e91a7")).toBeDefined()
    await act(async () => {
      const { milestones } = session()
      milestones.mark("firstBalance")
      milestones.mark("depositsReplayed")
      milestones.mark("historyAtHead")
      // Started after the bell's wait on the same milestones, so it ends after it.
      await milestones.after({
        firstBalance: 0,
        depositsReplayed: 0,
        movesReplayed: 0,
        historyAtHead: 0,
      })
    })
    expect(toast()).toBeNull()
    await scan("0x4e91a8")
    expect(toast()).not.toBeNull()
  })

  it("toasts an entry first seen while it is up, never the backlog or a dismissed one", async () => {
    const { milestones } = session()
    milestones.mark("firstBalance")
    milestones.mark("depositsReplayed")
    milestones.mark("historyAtHead")
    await report(contact("0xold"))
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NotificationsBell openEntry={() => null} />
        </MemoryRouter>,
      ),
    )
    const toast = () => container.querySelector(".ww-notifications__toast")
    expect(toast()).toBeNull()
    await report(contact("0xnew"))
    expect(toast()).not.toBeNull()
    await act(async () => session().notifications.dismiss(["contact:added:0xnew"]))
    expect(toast()).toBeNull()
  })
})

describe("freshToasts", () => {
  const entry = (patch: Partial<NotificationEntry>): NotificationEntry => ({
    id: "contact:added:0x1",
    about: { kind: "event", event: contact("0x1") },
    timestampMs: 1,
    severity: "success",
    icon: "",
    pending: false,
    read: false,
    firstSeenAt: 10,
    target: { type: "contact.added", contactId: "0x1" },
    ...patch,
  })

  it("never toasts a live row", () => {
    expect(freshToasts([entry({ pending: true })], new Set(), 0)).toEqual([])
  })

  it("toasts the outcome of a row it watched in flight", () => {
    const seen = new Set([toastKey(entry({ pending: true }))])
    expect(freshToasts([entry({})], seen, 0)).toHaveLength(1)
  })

  it("toasts a settled entry once, never one already read or first seen before the bell", () => {
    expect(freshToasts([entry({})], new Set([toastKey(entry({}))]), 0)).toEqual([])
    expect(freshToasts([entry({ read: true })], new Set(), 0)).toEqual([])
    expect(freshToasts([entry({})], new Set(), 11)).toEqual([])
  })

  it("toasts once a live row from before the bell that settles while it watches", () => {
    let seen = new Set([toastKey(entry({ pending: true }))])
    const settled = [entry({})]
    expect(freshToasts(settled, seen, 11)).toHaveLength(1)
    seen = new Set(settled.map(toastKey))
    expect(freshToasts(settled, seen, 11)).toEqual([])
    // One already settled when the bell mounted stays history.
    expect(freshToasts(settled, new Set(), 11)).toEqual([])
  })
})

// Last in the file: an activity row written here makes the next test's store close throw.
describe("the bell over records", () => {
  it("never toasts an entry its records listed before it mounted, though its stamp lands later", async () => {
    testWalletDbs().onApply = (_version, ops) => {
      if (ops.some(([key]) => key.includes("/notificationState/"))) throw new Error("disk full")
    }
    await scan("0xbacc", "receive")
    testWalletDbs().onApply = undefined
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NotificationsBell openEntry={() => null} />
        </MemoryRouter>,
      ),
    )
    await scan("0x5e9d", "send")
    expect(state("transfer:receive:0xbacc")).toBeDefined()
    expect(container.querySelector(".ww-notifications__toast")).toBeNull()
  })
})
