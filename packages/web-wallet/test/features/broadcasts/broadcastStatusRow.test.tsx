/** The status line under an address whose broadcast has not landed, read off the real ledger. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OperationStore } from "@obsidion/front-core"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import {
  WAITING_FOR_BALANCE_MOVE,
  WAITING_FOR_REGISTRATION,
  WAITING_FOR_UNLOCK,
  getBroadcastLedger,
  resetBroadcastsForTests,
} from "../../../src/features/broadcasts/broadcasts"
import { BroadcastStatusRow } from "../../../src/features/broadcasts/BroadcastStatusRow"
import { getOperationStore } from "../../../src/features/operations/operations"

const ADDRESS = "0x00000000000000000000000000000000000000c3"
let root: Root
let container: HTMLDivElement
const row = () => container.querySelector<HTMLElement>('[data-testid="broadcast-status"]')
const render = () => act(async () => root.render(<BroadcastStatusRow address={ADDRESS} />))

beforeEach(async () => {
  localStorage.clear()
  resetBroadcastsForTests()
  OperationStore.reset()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await getBroadcastLedger().enqueue({
    address: ADDRESS,
    kind: "deposit",
    scope: null,
    source: { type: "slot", cacheKey: "k", day: 1, nonce: 0 },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("BroadcastStatusRow", () => {
  it("names the proving stage, then disappears once it lands", async () => {
    const ledger = getBroadcastLedger()
    await getOperationStore().begin({
      operationId: "op",
      flow: "deposit",
      summary: "Deposit address",
      scope: null,
      resumable: true,
      background: true,
    })
    await ledger.setOperation(ADDRESS, "op")
    await ledger.markProving(ADDRESS)
    provingProgress.emitStageStart(ProvingStage.Proving, "op")
    await render()
    expect(row()?.textContent).toBe("Proving privately…")

    await act(async () => void (await ledger.markLanded(ADDRESS)))
    expect(row()).toBeNull()
  })

  it.each([
    [WAITING_FOR_UNLOCK, "Unlock your wallet to publish this address"],
    [WAITING_FOR_REGISTRATION, "Publishes once your tag is registered"],
    [WAITING_FOR_BALANCE_MOVE, "Publishes once your balance has moved"],
  ])("says what a deferred broadcast waits for (%s)", async (reason, line) => {
    await getBroadcastLedger().defer(ADDRESS, Date.now() + 30_000, reason)
    await render()
    expect(row()?.textContent).toBe(line)
  })

  it("reads as pending before the ledger holds the address", async () => {
    await act(async () =>
      root.render(<BroadcastStatusRow address="0x00000000000000000000000000000000000000c4" />),
    )
    expect(row()?.textContent).toBe("Publishing your address shortly")
  })

  it("says a failed broadcast is retried, however often it failed, and re-broadcasts it at once on a press", async () => {
    const ledger = getBroadcastLedger()
    const retry = () => row()?.querySelector<HTMLButtonElement>('[data-testid="broadcast-retry"]')
    await ledger.markFailed(ADDRESS, "offline")
    await render()
    expect(row()?.textContent).toContain("Couldn't publish yet. Trying again soon")
    await act(async () => {
      for (let i = 0; i < 5; i++) await ledger.markFailed(ADDRESS, "offline")
    })
    expect(row()?.textContent).toContain("Couldn't publish yet. Trying again soon")
    expect(retry()?.textContent).toBe("Re-broadcast")
    await act(async () => retry()!.click())
    await vi.waitFor(() =>
      expect(ledger.get(ADDRESS)).toMatchObject({ failures: 0, retryAt: undefined }),
    )
  })

  it("offers a re-broadcast while any other wait holds the address", async () => {
    await getBroadcastLedger().defer(ADDRESS, Date.now() + 30_000, "The address no longer derives")
    await render()
    expect(row()?.querySelector('[data-testid="broadcast-retry"]')).not.toBeNull()
  })
})
