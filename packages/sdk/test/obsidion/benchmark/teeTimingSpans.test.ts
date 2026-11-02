/**
 * U3 acceptance — TEE-leg / prove-leg correlation per flow.
 *
 * The staged-execution finalizer built by `buildTeeOperation` (TEE leg: the
 * `enclave` phase) and `ObsidionWallet.sendTx` (prove leg: `sync`,
 * `simulation`, and the prove phases) each contribute to `benchmarkRegistry`
 * under the `options.operationId` threaded onto the `buildTeeOperation` ctx.
 * This test pins the per-flow correlation contract those spans feed: with
 * both legs reporting for one id, EVERY flow yields a well-formed 6-phase
 * sample with `total = Σ phases`, and distinct ids never cross-contaminate.
 *
 * The span instrumentation INSIDE the finalizer/`sendTx` (flag-gating,
 * `performance.now()` deltas, the entry-sync span hoist) is integration-level
 * — it's exercised end-to-end by the on-device driver, not unit-mocked here
 * (mocking the full TEE pipeline — BatchCall, the wallet sim,
 * signTokenOperation, capsules — would be brittle and low-value). What's
 * unit-pinned is the registry contract the legs must satisfy, plus the
 * type-level guarantee (build) that every flow's call site can thread
 * `operationId` + `benchmarkFlow` onto the ctx.
 */
import { describe, it, expect, beforeEach } from "vitest"
import type { BenchmarkFlow, BenchmarkSample } from "@obsidion/core/types"
import { benchmarkRegistry } from "../../../src/obsidion/benchmark/benchmarkRegistry.js"

const FLOWS: BenchmarkFlow[] = [
  "send",
  "withdraw",
  "paylink-create",
  "paylink-claim",
  "paylink-refund",
]

describe("TEE+prove leg correlation per flow (U3 acceptance)", () => {
  beforeEach(() => benchmarkRegistry.setSampleSink(undefined))

  it("produces a full 6-phase sample for every flow with total = Σ phases", () => {
    const out: BenchmarkSample[] = []
    benchmarkRegistry.setSampleSink((s) => out.push(s))

    FLOWS.forEach((flow, i) => {
      const opId = `op-${flow}-${i}`
      benchmarkRegistry.contributeTee(opId, { flow, enclave: 8 })
      benchmarkRegistry.contributeProve(opId, {
        flow,
        sync: 12,
        simulation: 5,
        userWitgen: 40,
        kernelWitgen: 60,
        proving: 200,
        unaccounted: 2,
        incomplete: false,
      })
    })

    expect(out).toHaveLength(5)
    for (const s of out) {
      expect(s.status).toBe("ok")
      expect(s.phases.sync).toBe(12)
      expect(s.phases.simulation).toBe(5)
      expect(s.phases.enclave).toBe(8)
      expect(s.phases.userWitgen).toBe(40)
      expect(s.phases.kernelWitgen).toBe(60)
      expect(s.phases.proving).toBe(200)
      expect(s.total).toBe(12 + 5 + 8 + 40 + 60 + 200) // 325
    }
    // Each flow represented exactly once — the flow union round-trips.
    expect(new Set(out.map((s) => s.flow))).toEqual(new Set(FLOWS))
  })

  it("threads the prove leg's simFunctions into the finalized sample", () => {
    const out: BenchmarkSample[] = []
    benchmarkRegistry.setSampleSink((s) => out.push(s))

    benchmarkRegistry.contributeTee("sf-op", { flow: "send", enclave: 8 })
    benchmarkRegistry.contributeProve("sf-op", {
      flow: "send",
      sync: 0,
      simulation: 5,
      userWitgen: 0,
      kernelWitgen: 0,
      proving: 0,
      unaccounted: 0,
      incomplete: false,
      simFunctions: [{ name: "OxideToken:publish_da", witgenMs: 30, oracleMs: 1 }],
    })

    expect(out).toHaveLength(1)
    expect(out[0]!.simFunctions).toEqual([
      { name: "OxideToken:publish_da", witgenMs: 30, oracleMs: 1 },
    ])
    // Absence is tolerated — a sample without the field is unaffected.
    expect(out[0]!.status).toBe("ok")
  })

  it("keeps two interleaved flows separate (no cross-contamination)", () => {
    const out: BenchmarkSample[] = []
    benchmarkRegistry.setSampleSink((s) => out.push(s))

    benchmarkRegistry.contributeTee("send-1", { flow: "send", enclave: 1 })
    benchmarkRegistry.contributeTee("wd-1", { flow: "withdraw", enclave: 9 })
    // Prove legs arrive in the opposite order.
    const proveZero = {
      sync: 0,
      simulation: 2,
      userWitgen: 0,
      kernelWitgen: 0,
      proving: 0,
      unaccounted: 0,
      incomplete: false,
    }
    benchmarkRegistry.contributeProve("wd-1", { flow: "withdraw", ...proveZero })
    benchmarkRegistry.contributeProve("send-1", { flow: "send", ...proveZero })

    const wd = out.find((s) => s.flow === "withdraw")!
    const send = out.find((s) => s.flow === "send")!
    expect(wd.phases.enclave).toBe(9)
    expect(send.phases.enclave).toBe(1)
  })
})
