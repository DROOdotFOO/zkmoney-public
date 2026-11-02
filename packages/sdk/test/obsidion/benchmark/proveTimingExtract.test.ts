/**
 * U2 — prove-side timing extractor.
 *
 * Pins the perFunction kernel/user split, sync/proving/total/unaccounted
 * passthrough, the incomplete (null) signal when stats/proving are absent, and
 * the privacy guarantee (output is exactly the six numeric fields — no oracles).
 */
import { describe, it, expect } from "vitest"
import type { ProvingTimings } from "@aztec-labs/stdlib/tx"
import {
  extractProveTimings,
  formatProveTxPerfLine,
} from "../../../src/obsidion/benchmark/proveTimingExtract.js"

function timings(over: Partial<ProvingTimings> = {}): ProvingTimings {
  return {
    sync: 5,
    proving: 100,
    perFunction: [
      { functionName: "MyToken:transfer", time: 10 },
      { functionName: "private_kernel_init", time: 20 },
      { functionName: "private_kernel_inner", time: 15 },
      { functionName: "hiding_kernel", time: 7 },
    ],
    unaccounted: 3,
    total: 160,
    ...over,
  }
}

describe("extractProveTimings", () => {
  it("splits perFunction into user vs kernel witgen and passes scalars through", () => {
    const out = extractProveTimings(timings())
    expect(out).not.toBeNull()
    expect(out!.userWitgen).toBe(10) // MyToken:transfer
    expect(out!.kernelWitgen).toBe(42) // 20 + 15 + 7 (private_kernel_* + hiding_kernel)
    expect(out!.sync).toBe(5)
    expect(out!.proving).toBe(100)
    expect(out!.total).toBe(160)
    expect(out!.unaccounted).toBe(3)
  })

  it("returns null when timings is undefined (incomplete, never zeros-as-data)", () => {
    expect(extractProveTimings(undefined)).toBeNull()
  })

  it("returns null when proving is undefined (sim/fakeProofs build)", () => {
    expect(extractProveTimings(timings({ proving: undefined }))).toBeNull()
  })

  it("treats a missing sync as 0 (sync is optional, not incomplete)", () => {
    const out = extractProveTimings(timings({ sync: undefined }))
    expect(out).not.toBeNull()
    expect(out!.sync).toBe(0)
  })

  it("matches future private_kernel_* names by prefix", () => {
    const out = extractProveTimings(
      timings({
        perFunction: [
          { functionName: "private_kernel_reset_big", time: 11 },
          { functionName: "app_circuit", time: 4 },
        ],
      }),
    )
    expect(out!.kernelWitgen).toBe(11)
    expect(out!.userWitgen).toBe(4)
  })

  it("privacy: output has exactly the six declared numeric fields (no oracles)", () => {
    const out = extractProveTimings(
      timings({
        perFunction: [
          { functionName: "MyToken:transfer", time: 10, oracles: { getNotes: { times: [1, 2] } } },
        ],
      }),
    )!
    expect(Object.keys(out).sort()).toEqual(
      ["kernelWitgen", "proving", "sync", "total", "unaccounted", "userWitgen"].sort(),
    )
    expect(JSON.stringify(out)).not.toContain("oracles")
    expect(JSON.stringify(out)).not.toContain("getNotes")
  })
})

describe("formatProveTxPerfLine", () => {
  const base = { preProveMs: 12, simulationMs: 300.4, totalMs: 6100 }

  it("prints the PXE's split, rounded", () => {
    expect(formatProveTxPerfLine({ ...base, proveTimings: timings({ proving: 100.6 }) })).toBe(
      "[Perf][ProveTx] pre_prove=12ms sim=300ms sync=5ms user_witgen=10ms kernel_witgen=42ms proving=101ms pxe_total=160ms total=6100ms",
    )
  })

  it("keeps the witness split and says proving=none without a proof (fake proofs)", () => {
    const line = formatProveTxPerfLine({ ...base, proveTimings: timings({ proving: undefined }) })
    expect(line).toContain("user_witgen=10ms kernel_witgen=42ms proving=none")
  })

  it("says prove_stats=none when the PXE returned no stats", () => {
    expect(formatProveTxPerfLine({ ...base, proveTimings: undefined })).toBe(
      "[Perf][ProveTx] pre_prove=12ms sim=300ms prove_stats=none total=6100ms",
    )
  })

  it("never prints oracle data", () => {
    const line = formatProveTxPerfLine({
      ...base,
      proveTimings: timings({
        perFunction: [
          { functionName: "MyToken:transfer", time: 10, oracles: { getNotes: { times: [1] } } },
        ],
      }),
    })
    expect(line).not.toContain("getNotes")
  })
})
