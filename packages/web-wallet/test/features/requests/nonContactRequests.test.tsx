/** The inbox for requests from people outside the contact book, and its Contacts entry. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PaymentRequest } from "@obsidion/front-core"

const inbox = vi.hoisted(() => ({
  requests: [] as PaymentRequest[],
  allowed: true,
  unavailable: false,
  setAllowed: vi.fn(),
}))
vi.mock("../../../src/features/requests/useNonContactRequests", () => ({
  useNonContactRequests: () => inbox,
}))
const declineRequestById = vi.hoisted(() => vi.fn(async (_id: string) => true))
/** Whether a send must wait for the upgrade, and every action a press asked for. */
const gate = vi.hoisted(() => ({ upgrade: false, asked: [] as string[] }))
vi.mock("../../../src/features/actionGate", () => ({
  useActionGuard: () => (action: string, run: () => void) => {
    gate.asked.push(action)
    if (!gate.upgrade) run()
  },
}))
vi.mock("../../../src/features/contacts/requestActions", () => ({ declineRequestById }))
vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  // The glass buttons need optics jsdom cannot render; these tests are about what they say.
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
}))

const { NonContactRequestsEntry, NonContactRequestsScreen } = await import(
  "../../../src/features/requests/NonContactRequestsScreen"
)

const request = (id: string, contactTag: string, note?: string): PaymentRequest => ({
  id,
  contactTag,
  amount: 42,
  asset: "DAI",
  direction: "incoming",
  status: "pending",
  createdAt: Date.now() - 2 * 60 * 60_000,
  kind: "contact",
  note,
})

function Where() {
  const location = useLocation()
  return (
    <output data-testid="where">{`${location.pathname} ${JSON.stringify(location.state)}`}</output>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  inbox.requests = [request("r1", "mina", "Dinner split"), request("r2", "paul_c")]
  inbox.allowed = true
  inbox.unavailable = false
  declineRequestById.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const mount = (path: string, element: React.ReactNode) =>
  act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path} element={element} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
const buttons = (name: string) =>
  [...document.querySelectorAll("button")].filter((b) => b.textContent === name)
const where = () => container.querySelector('[data-testid="where"]')?.textContent

describe("NonContactRequestsScreen", () => {
  it("lists each request with its sender, note and amount", async () => {
    await mount("/requests/non-contacts", <NonContactRequestsScreen />)
    expect(container.textContent).toContain("@mina.zk.money")
    expect(container.textContent).toContain("Dinner split · 2h ago")
    expect(container.textContent).toContain("No note · 2h ago")
    expect(container.textContent).toContain("$42.00")
  })

  it("declines one request, or all of them", async () => {
    await mount("/requests/non-contacts", <NonContactRequestsScreen />)
    await act(async () => buttons("Decline")[1].click())
    expect(declineRequestById).toHaveBeenCalledWith("r2")

    declineRequestById.mockClear()
    await act(async () => buttons("Decline all")[0].click())
    expect(declineRequestById.mock.calls.map(([id]) => id)).toEqual(["r1", "r2"])
  })

  it("warns in the detail sheet, and Send opens the pay flow for the request", async () => {
    await mount("/requests/non-contacts", <NonContactRequestsScreen />)
    await act(async () => buttons("View")[0].click())
    const sheet = document.querySelector("dialog")!
    expect(sheet.textContent).toContain("mina.zk.money is not in your contacts")
    expect(sheet.textContent).not.toContain("add mina.zk.money")

    await act(async () => buttons("Send")[0].click())
    expect(where()).toBe(
      `/contacts/mina/send ${JSON.stringify({
        request: { id: "r1", tag: "mina", amount: 42, note: "Dinner split" },
      })}`,
    )
  })

  it("asks to upgrade before paying a request", async () => {
    gate.upgrade = true
    gate.asked = []
    try {
      await mount("/requests/non-contacts", <NonContactRequestsScreen />)
      await act(async () => buttons("View")[0].click())
      await act(async () => buttons("Send")[0].click())
      expect(gate.asked).toEqual(["send"])
      expect(where() ?? "").not.toContain("/contacts/mina/send")
    } finally {
      gate.upgrade = false
    }
  })

  it("closes the detail sheet once its request leaves the list", async () => {
    await mount("/requests/non-contacts", <NonContactRequestsScreen />)
    await act(async () => buttons("View")[0].click())
    expect(document.querySelector("dialog")).not.toBeNull()

    inbox.requests = [request("r2", "paul_c")]
    await mount("/requests/non-contacts", <NonContactRequestsScreen />)
    expect(document.querySelector("dialog")).toBeNull()
    expect(buttons("Send")).toHaveLength(0)
  })

  it("says the requests can't be loaded instead of listing none", async () => {
    inbox.requests = []
    inbox.unavailable = true
    await mount("/requests/non-contacts", <NonContactRequestsScreen />)
    expect(container.textContent).toContain(
      "Requests sent to you can't be loaded right now. Trying again…",
    )
    expect(container.textContent).not.toContain("No requests from people outside your contacts.")
  })

  it("says the inbox is off and offers no Decline all", async () => {
    inbox.requests = []
    inbox.allowed = false
    await mount("/requests/non-contacts", <NonContactRequestsScreen />)
    expect(container.textContent).toContain(
      "Requests from people outside your contacts are turned off.",
    )
    expect(buttons("Decline all")).toHaveLength(0)
    await act(async () => buttons("Turn on requests from non-contacts in Settings")[0].click())
    expect(where()).toBe("/settings null")
  })
})

describe("NonContactRequestsEntry", () => {
  it("summarizes the requesters and opens the inbox", async () => {
    await mount("/contacts", <NonContactRequestsEntry />)
    const entry = container.querySelector("button")!
    expect(entry.textContent).toContain(
      "@mina.zk.money and @paul_c.zk.money requested funds from you.",
    )
    await act(async () => entry.click())
    expect(where()).toBe("/requests/non-contacts null")
  })

  it("renders nothing while the inbox is empty", async () => {
    inbox.requests = []
    await mount("/contacts", <NonContactRequestsEntry />)
    expect(container.querySelector("button")).toBeNull()
  })
})
