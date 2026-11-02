/**
 * U2 — per-op benchmark registry.
 *
 * Pins: order-independent auto-finalize when both legs report; finalize math
 * (total = Σ the six phases, enclave from the TEE leg, everything else from
 * the prove leg); incomplete status when the prove leg's stats were missing;
 * partial-leak guard (abandon surfaces a single-leg orphan as incomplete, no
 * false finalize / no leak).
 */
import { describe, it, expect, beforeEach } from "vitest"
import type { BenchmarkSample, SimFunctionTiming } from "@obsidion/core/types"
import {
  benchmarkRegistry,
  type ProveLegContribution,
  type TeeLegContribution,
} from "../../../src/obsidion/benchmark/benchmarkRegistry.js"

const TEE: TeeLegContribution = { flow: "send", enclave: 8 }
const PROVE: ProveLegContribution = {
  flow: "send",
  sync: 12,
  simulation: 5,
  userWitgen: 40,
  kernelWitgen: 60,
  proving: 200,
  unaccounted: 2,
  incomplete: false,
}

function collect(): BenchmarkSample[] {
  const out: BenchmarkSample[] = []
  benchmarkRegistry.setSampleSink((s) => out.push(s))
  return out
}

describe("benchmarkRegistry", () => {
  beforeEach(() => {
    benchmarkRegistry.setSampleSink(undefined)
  })

  it("auto-finalizes when TEE leg arrives before prove leg", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("op1", TEE)
    expect(out).toHaveLength(0) // one leg → no finalize yet
    benchmarkRegistry.contributeProve("op1", PROVE)
    expect(out).toHaveLength(1)
    const s = out[0]!
    expect(s.status).toBe("ok")
    expect(s.flow).toBe("send")
    expect(s.phases.sync).toBe(12)
    expect(s.phases.simulation).toBe(5)
    expect(s.phases.enclave).toBe(8)
    expect(s.phases.userWitgen).toBe(40)
    expect(s.phases.kernelWitgen).toBe(60)
    expect(s.phases.proving).toBe(200)
    expect(s.total).toBe(12 + 5 + 8 + 40 + 60 + 200) // 325
    expect(s.unaccounted).toBe(2)
  })

  it("auto-finalizes when prove leg arrives before TEE leg (order-independent)", () => {
    const out = collect()
    benchmarkRegistry.contributeProve("op2", { ...PROVE, flow: "withdraw" })
    expect(out).toHaveLength(0)
    benchmarkRegistry.contributeTee("op2", { ...TEE, flow: "withdraw" })
    expect(out).toHaveLength(1)
    expect(out[0]!.flow).toBe("withdraw")
    expect(out[0]!.status).toBe("ok")
  })

  it("finalizes as incomplete when the prove leg flagged missing stats", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("op3", TEE)
    benchmarkRegistry.contributeProve("op3", { ...PROVE, incomplete: true })
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe("incomplete")
  })

  it("does not cross-contaminate distinct operationIds", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("opA", { ...TEE, enclave: 1 })
    benchmarkRegistry.contributeTee("opB", { ...TEE, enclave: 99 })
    benchmarkRegistry.contributeProve("opA", PROVE)
    expect(out).toHaveLength(1)
    expect(out[0]!.phases.enclave).toBe(1) // opA, not opB's 99
  })

  it("abandon surfaces a TEE-only orphan as incomplete (no leak, no false finalize)", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("orphanTee", TEE)
    benchmarkRegistry.abandon("orphanTee")
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe("incomplete")
    expect(out[0]!.flow).toBe("send")
    // A second abandon is a no-op (entry already evicted) — no leak.
    benchmarkRegistry.abandon("orphanTee")
    expect(out).toHaveLength(1)
  })

  it("abandon surfaces a prove-only orphan as incomplete", () => {
    const out = collect()
    benchmarkRegistry.contributeProve("orphanProve", PROVE)
    benchmarkRegistry.abandon("orphanProve")
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe("incomplete")
  })

  it("abandon after a successful finalize is a no-op (entry already gone)", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("done", TEE)
    benchmarkRegistry.contributeProve("done", PROVE)
    expect(out).toHaveLength(1)
    benchmarkRegistry.abandon("done")
    expect(out).toHaveLength(1) // no spurious second sample
  })
})

const SF: SimFunctionTiming[] = [
  { name: "ObsidionAccountAlphaSimulated:entrypoint", witgenMs: 50, oracleMs: 5 },
]

describe("benchmarkRegistry simFunctions passthrough (U3)", () => {
  beforeEach(() => {
    benchmarkRegistry.setSampleSink(undefined)
  })

  it("carries the prove leg's simFunctions onto the finalized sample as a flat array", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("both", TEE)
    benchmarkRegistry.contributeProve("both", { ...PROVE, simFunctions: SF })
    expect(out[0]!.simFunctions).toEqual(SF)
  })

  it("omits simFunctions entirely when the prove leg has none (no empty placeholder)", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("none", TEE)
    benchmarkRegistry.contributeProve("none", PROVE) // no simFunctions
    expect("simFunctions" in out[0]!).toBe(false)
  })

  it("preserves a present-but-empty array (distinct from omitted)", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("empty", TEE)
    benchmarkRegistry.contributeProve("empty", { ...PROVE, simFunctions: [] })
    expect(out[0]!.simFunctions).toEqual([])
  })

  it("orphan: prove-only abandon carries the simFunctions, stays incomplete", () => {
    const out = collect()
    benchmarkRegistry.contributeProve("orphPre", { ...PROVE, simFunctions: SF })
    benchmarkRegistry.abandon("orphPre")
    expect(out[0]!.status).toBe("incomplete")
    expect(out[0]!.simFunctions).toEqual(SF)
  })

  it("orphan: TEE-only abandon has no simFunctions (the breakdown is prove-leg data)", () => {
    const out = collect()
    benchmarkRegistry.contributeTee("orphTee", TEE)
    benchmarkRegistry.abandon("orphTee")
    expect(out[0]!.status).toBe("incomplete")
    expect("simFunctions" in out[0]!).toBe(false)
  })

  it("cap-eviction surfaces single-leg orphans carrying their simFunctions", () => {
    const out = collect()
    // MAX_PARTIALS is 32; pushing well past it with distinct single-leg ops
    // evicts the oldest as incomplete orphans, each carrying its simFunctions.
    // (Asserted on the orphans that carry simFunctions rather than an exact
    // count — the registry is a process-wide singleton, so an unrelated prior
    // test may leave its own simFunctions-less partial that also evicts here.)
    for (let i = 0; i < 40; i++) {
      benchmarkRegistry.contributeProve(`cap${i}`, { ...PROVE, simFunctions: SF })
    }
    const evictedWithSf = out.filter((s) => s.simFunctions !== undefined)
    expect(evictedWithSf.length).toBeGreaterThan(0)
    for (const s of evictedWithSf) {
      expect(s.status).toBe("incomplete")
      expect(s.simFunctions).toEqual(SF)
    }
  })
})
