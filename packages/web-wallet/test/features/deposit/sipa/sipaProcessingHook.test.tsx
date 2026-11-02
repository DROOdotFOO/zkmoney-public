/**
 * The sheets' hook carries the observer's original capacity key through a notification, including for a deposit
 * that is not waiting for its sweep, whose processing state stays undefined.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  key: { status: "unknown", retryable: true } as unknown,
  state: undefined as unknown,
  listeners: new Set<() => void>(),
}))

// One observer object, like the production singleton: the hook keys its subscription on its identity.
vi.mock("../../../../src/features/deposit/sipaProcessingObserver", () => {
  const observer = {
    stateFor: () => h.state,
    capacityKeyFor: () => h.key,
    subscribe: (listener: () => void) => {
      h.listeners.add(listener)
      return () => h.listeners.delete(listener)
    },
    retry: async () => undefined,
    refreshForSweep: async () => undefined,
  }
  return { sipaProcessingObserver: () => observer }
})

const { useSipaProcessing } = await import("../../../../src/features/deposit/sipaProcessing")

const SIPA = `0x${"0b".repeat(20)}`
const KNOWN = {
  status: "known",
  key: { chainId: 1, portal: `0x${"11".repeat(20)}`, token: `0x${"22".repeat(20)}` },
}

function Probe() {
  const { capacityKey } = useSipaProcessing(SIPA)
  return <span data-testid="key">{JSON.stringify(capacityKey)}</span>
}

describe("useSipaProcessing capacityKey", () => {
  let container: HTMLDivElement
  let root: Root
  const shown = () => container.querySelector('[data-testid="key"]')?.textContent
  const notify = () =>
    act(async () => {
      for (const listener of [...h.listeners]) listener()
    })

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    h.listeners.clear()
  })

  it.each([
    ["not waiting for its sweep", undefined, { status: "unknown", retryable: true }],
    [
      "waiting for its sweep",
      { reason: { kind: "checking" } },
      { status: "unknown", retryable: true },
    ],
  ])("updates on a notified key change for a deposit %s", async (_, state, before) => {
    h.state = state
    h.key = before
    await act(async () => root.render(<Probe />))
    expect(JSON.parse(shown()!)).toEqual(before)

    h.key = KNOWN
    await notify()
    expect(JSON.parse(shown()!)).toEqual(KNOWN)
  })
})
