import { afterEach, describe, expect, it } from "vitest"
import {
  beforeApproval,
  grantApproval,
  resetApprovals,
} from "../../../src/features/migration/approvalGate"

afterEach(() => resetApprovals())

describe("upgrade approval gate", () => {
  it("lets one prompt through per tap, and asks for the next", async () => {
    grantApproval()
    await beforeApproval(0, 2)
    let opened = false
    const next = beforeApproval(1, 2).then(() => (opened = true))
    await Promise.resolve()
    expect(opened).toBe(false)
    grantApproval()
    await next
    expect(opened).toBe(true)
  })

  it("cancels the asked prompt and drops unused taps", async () => {
    grantApproval()
    grantApproval()
    resetApprovals()
    const asked = beforeApproval(0, 1)
    resetApprovals()
    await expect(asked).rejects.toThrow("Cancelled")
  })

  it("rejects the asked prompt on abort, and asks no more after it", async () => {
    const run = new AbortController()
    const asked = beforeApproval(0, 2, run.signal)
    run.abort(new Error("Left"))
    await expect(asked).rejects.toThrow("Left")
    grantApproval()
    await expect(beforeApproval(1, 2, run.signal)).rejects.toThrow("Left")
  })
})
