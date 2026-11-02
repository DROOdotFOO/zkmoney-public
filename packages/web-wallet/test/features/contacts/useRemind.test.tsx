import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const remindRequestById = vi.fn<(id: string, token?: string) => Promise<boolean>>()
vi.mock("../../../src/features/contacts/requestActions", () => ({
  remindRequestById: (id: string, token?: string) => remindRequestById(id, token),
}))

const { REMIND_TITLE, useRemind } = await import("../../../src/features/contacts/useRemind")
const { REMIND_INTERVAL_MS } = await import("@obsidion/front-core")

let hook: ReturnType<typeof useRemind>
function Probe() {
  hook = useRemind("0xtoken")
  return null
}

let root: Root
beforeEach(() => {
  remindRequestById.mockReset()
  root = createRoot(document.createElement("div"))
  act(() => root.render(<Probe />))
})
afterEach(() => act(() => root.unmount()))

it("spins while the reminder sends, then blocks another for 12 hours", async () => {
  let deliver!: (ok: boolean) => void
  remindRequestById.mockReturnValue(new Promise((resolve) => (deliver = resolve)))
  act(() => hook.remind("r1"))
  act(() => hook.remind("r1"))
  expect(remindRequestById).toHaveBeenCalledOnce()
  expect(hook.stateOf("r1")).toBe("sending")
  await act(async () => deliver(true))
  expect(hook.stateOf("r1")).toBe("sent")
  expect(REMIND_TITLE[hook.stateOf("r1")]).toBe("Reminder sent")
})

it("offers a retry when the reminder is not delivered", async () => {
  remindRequestById.mockResolvedValue(false)
  await act(async () => hook.remind("r1"))
  expect(hook.stateOf("r1")).toBe("failed")
  expect(REMIND_TITLE.failed).toBe("Try again")
  remindRequestById.mockRejectedValue(new Error("offline"))
  await act(async () => hook.remind("r2"))
  expect(hook.stateOf("r2")).toBe("failed")
})

it("reads an earlier reminder off the stored request", () => {
  expect(hook.stateOf("r1", Date.now() - 60_000)).toBe("sent")
  expect(hook.stateOf("r1", Date.now() - REMIND_INTERVAL_MS)).toBe("idle")
})
