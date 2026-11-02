/** The ticket prover reports its proof's phases on the signup stream, with no device class. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NoirProofLap } from "../../../../src/platform/noirProver"
import { stubProvingDevice } from "../../../support/provingDevice"

const h = vi.hoisted(() => ({ prove: vi.fn(), fire: vi.fn() }))
vi.mock("../../../../src/platform/noirProver", () => ({ proveNoirCircuit: h.prove }))
vi.mock("../../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fireOnboardingEvent: h.fire,
}))
vi.mock("../../../../../contracts/src/artifacts/target/golden_ticket/golden_ticket.json", () => ({
  default: { bytecode: "", abi: {} },
}))

const { proveGoldenTicketInBrowser } = await import("../../../../src/features/paylink/goldenTicketProver")

type OnLap = (lap: NoirProofLap, ms: number) => void

/** A prover that reaches these laps, then proves or fails. */
function prover(laps: [NoirProofLap, number][], fail?: Error) {
  h.prove.mockImplementation(async (_circuit, _inputs, _label, onLap: OnLap) => {
    for (const [lap, ms] of laps) onLap(lap, ms)
    if (fail) throw fail
    return { proof: new Uint8Array([1]), publicInputs: [] }
  })
}

/** The event's props as they go on the wire. */
const sent = () => {
  expect(h.fire).toHaveBeenCalledOnce()
  const [event, props] = h.fire.mock.calls[0]!
  expect(event).toBe("golden_ticket_proof")
  return JSON.parse(JSON.stringify(props)) as Record<string, unknown>
}

let restore: () => void
beforeEach(() => {
  h.prove.mockReset()
  h.fire.mockReset()
})
afterEach(() => restore())

describe("proveGoldenTicketInBrowser", () => {
  it("reports the phases a failed proof finished and still fails", async () => {
    restore = stubProvingDevice(false, 4)
    const oom = new RangeError("Out of memory")
    prover(
      [
        ["wasm", 90],
        ["witness", 1_000],
      ],
      oom,
    )
    await expect(proveGoldenTicketInBrowser({})).rejects.toBe(oom)
    expect(sent()).toEqual({
      status: "failed",
      wasm_ms: 90,
      witness_ms: 910,
      total_ms: expect.any(Number),
    })
  })
})
