import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/ui/PasskeysModal", () => ({
  PasskeysModal: () => <div data-testid="passkeys-modal" />,
}))

import { RotationApprovalLine } from "../../../src/features/backupPasskey/RotationApprovalLine"
import { getRotationDriver } from "../../../src/features/backupPasskey/rotationDrive"
import { makeFlowDeps, receipt, sent, signedRecord, word } from "../../support/backupAdd"

let root: Root | undefined
let container: HTMLDivElement

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function show(record: ReturnType<typeof signedRecord>) {
  const made = makeFlowDeps()
  made.world.receipts.set(word(0x101), receipt(TxStatus.PENDING))
  await made.store.put(record)
  getRotationDriver().start({
    store: made.store,
    deps: async () => made.deps,
    owns: () => true,
    pollMs: 60_000,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<RotationApprovalLine />))
  await flush(5)
  return made
}

const line = () => container.querySelector('[data-testid="rotation-approval-line"]')

afterEach(async () => {
  getRotationDriver().stop()
  await act(async () => root?.unmount())
  container?.remove()
})

describe("RotationApprovalLine", () => {
  it("asks on Home for the move's approval and opens Settings › Passkeys on the tap", async () => {
    const made = await show(signedRecord({ phase: "rerooted", ...sent(5, { outcome: "swept" }) }))
    expect(line()?.textContent).toContain("Your backup passkey is almost ready")
    expect(line()?.textContent).toContain("Approve moving your balance to finish.")
    expect(made.deps.move.send).not.toHaveBeenCalled()
    const resume = [...line()!.querySelectorAll("button")].find(
      (b) => b.textContent === "Resume in Settings",
    )!
    await act(async () => resume.click())
    expect(container.querySelector('[data-testid="passkeys-modal"]')).not.toBeNull()
    expect(made.deps.move.send).not.toHaveBeenCalled()
  })

  it("asks for a paused move's retry too", async () => {
    await show(
      signedRecord({ phase: "attention", attention: "move", suspended: "rerooted", ...sent() }),
    )
    expect(line()).not.toBeNull()
  })

  it("asks for the retry of a move whose prompt was closed", async () => {
    const record = signedRecord({ phase: "rerooted", ...sent(5, { outcome: "swept" }) })
    await show({
      ...record,
      move: {
        runs: [
          {
            plannedAt: 1,
            m: 1,
            depositBound: false,
            declined: true,
            chunks: [{ token: "tok", amount: "1", state: "planned" }],
          },
        ],
      },
    })
    expect(getRotationDriver().getSnapshot().values().next().value?.resume?.wait).toBe("declined")
    expect(line()).not.toBeNull()
  })

  it("says nothing while the rotation waits on the chain", async () => {
    await show(signedRecord({ phase: "funded", ...sent() }))
    expect(getRotationDriver().getSnapshot().size).toBe(1)
    expect(line()).toBeNull()
  })
})
