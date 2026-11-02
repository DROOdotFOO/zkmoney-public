/**
 * A send whose allowance is proven spent (a stored zero on a rail that never renews) does not reach
 * the passkey prompt: the confirm button is disabled and the reason sits beside it. A zero that may
 * renew, a new account and a pending re-read are not blocked. A request sends no transaction.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deriveAllowanceState, type AllowanceSnapshot } from "@obsidion/front-core"
import type { ClaimFpcAllowance } from "@obsidion/sdk"

const { allowance } = vi.hoisted(() => ({
  allowance: { snapshot: undefined as unknown, refresh: vi.fn() },
}))
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => allowance,
}))
vi.mock("../../../src/features/operations/operations", () => ({ useBusyLabel: () => "Busy" }))
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: () => null,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button type="button" disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))

const { PayConfirmForm } = await import("../../../src/features/contacts/PayConfirmForm")

const snapshotOf = (read: ClaimFpcAllowance): AllowanceSnapshot => ({
  status: "ready",
  scope: "alice|sandbox",
  read: { fpcAddress: "0xf9c", railId: 1, payer: "alice", allowance: read },
  state: deriveAllowanceState(read),
  refreshing: false,
})

const ready = (over: Partial<ClaimFpcAllowance>): AllowanceSnapshot =>
  snapshotOf({ subscribed: true, uses: 0, maxTx: 100, refillPeriod: 86_400, ...over })

/** A stored zero on a rail that never renews: the one read that proves a send cannot be paid for. */
const spent = () => ready({ maxTx: 1, refillPeriod: 0 })

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  allowance.refresh.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = (isSend: boolean) =>
  act(async () =>
    root.render(
      <PayConfirmForm
        title="Send"
        amount={5}
        note=""
        ready
        busy={false}
        overspent={false}
        isSend={isSend}
        onConfirm={() => {}}
      />,
    ),
  )

const confirm = () => container.querySelector("button")!
const reason = () => container.querySelector('[data-testid="sponsored-action-blocked"]')

describe("sponsored action gate on the send confirmation", () => {
  it("disables a send the allowance proves it cannot pay for", async () => {
    allowance.snapshot = spent()
    await render(true)
    expect(confirm().disabled).toBe(true)
    expect(reason()?.textContent).toBe(
      "⚠ No sponsored transactions left. This allowance does not renew.",
    )
    expect(allowance.refresh).toHaveBeenCalled()
  })

  it("does not hold a send on a cached refusal while the new read is pending, and holds it again when the new read still refuses", async () => {
    allowance.snapshot = { ...(spent() as object), refreshing: true }
    await render(true)
    expect(confirm().disabled).toBe(false)
    expect(reason()).toBeNull()

    allowance.snapshot = spent()
    await render(true)
    expect(confirm().disabled).toBe(true)
  })

  it("lets a stored zero on a renewing rail through, since the send may renew it", async () => {
    allowance.snapshot = ready({})
    await render(true)
    expect(confirm().disabled).toBe(false)
    expect(reason()).toBeNull()
  })

  it("lets a new account through, so its first send can subscribe", async () => {
    allowance.snapshot = ready({ subscribed: false })
    await render(true)
    expect(confirm().disabled).toBe(false)
  })

  it("never gates a request", async () => {
    allowance.snapshot = spent()
    await render(false)
    expect(confirm().disabled).toBe(false)
    expect(reason()).toBeNull()
    expect(allowance.refresh).not.toHaveBeenCalled()
  })
})
