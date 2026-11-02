/**
 * The leave prompt is the one thing between a running proof and a closed tab, so it is up exactly
 * while leaving would lose the transaction, and never otherwise.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../../../src/lib/analytics", () => ({ fireEvent }))

import { ProvingStage } from "@obsidion/proving-progress"
import { resetModulesAsActiveTab } from "../../support/activeTab"

/** Each test is a new page, running as the active tab. */
async function page() {
  await resetModulesAsActiveTab()
  const { provingProgress } = await import("@obsidion/proving-progress")
  const { trackSubmission } = await import("@obsidion/front-core")
  const { runOperation } = await import("../../../src/features/operations/operations")
  const { LeaveGuardMount } = await import("../../../src/features/operations/LeaveGuardMount")
  const { revokeTab } = await import("../../../src/platform/storage/activeTab")
  return { provingProgress, trackSubmission, runOperation, LeaveGuardMount, revokeTab }
}

let m: Awaited<ReturnType<typeof page>>
let container: HTMLDivElement
let root: Root
let finish: (() => void) | undefined

beforeEach(async () => {
  m = await page()
  const { LeaveGuardMount } = m
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<LeaveGuardMount />))
})

afterEach(async () => {
  await act(async () => finish?.())
  finish = undefined
  await act(async () => root.unmount())
  container.remove()
  fireEvent.mockClear()
})

function leave(): boolean {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

/** An operation that runs until `finish()`, with its submit boundary tracked like a real flow. */
async function start(operationId: string, flow: "send" | "withdraw" = "withdraw") {
  let done!: Promise<void>
  await act(async () => {
    done = m.runOperation({ operationId, flow, summary: "$25" }, () => {
      const submission = m.trackSubmission(operationId)
      return new Promise<void>((resolve) => {
        finish = () => {
          submission.stop()
          resolve()
        }
      })
    })
  })
  return () => done
}

describe("LeaveGuardMount", () => {
  it("lets the page go when nothing is proving", () => {
    expect(leave()).toBe(false)
    expect(fireEvent).not.toHaveBeenCalled()
  })

  it("raises the prompt while a proof runs and reports it with the flow", async () => {
    await start("op-1")
    expect(leave()).toBe(true)
    expect(fireEvent).toHaveBeenCalledWith("proving_leave_prompted", { flow: "withdraw" })
  })

  it("drops the prompt once the flow's record holds the tx hash", async () => {
    await start("op-2", "send")
    expect(leave()).toBe(true)
    await act(async () => {
      m.provingProgress.emitStageStart(ProvingStage.Mining, "op-2", "0x" + "ab".repeat(32))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(leave()).toBe(false)
  })

  it("lets the page go once another tab has taken over, even mid-proof", async () => {
    await start("op-4")
    expect(leave()).toBe(true)
    m.revokeTab()
    expect(leave()).toBe(false)
  })

  it("drops the prompt when the flow ends", async () => {
    const settled = await start("op-3")
    await act(async () => {
      finish?.()
      await settled()
    })
    finish = undefined
    expect(leave()).toBe(false)
  })
})
