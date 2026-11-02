import { describe, it, expect } from "vitest"
import {
  PhaseTimer,
  aggregatePhase,
  aggregateReps,
  dominantPhase,
  assertNoSecrets,
  buildColdClaimReport,
  MIN_PERCENTILE_SAMPLES,
  type PhaseSample,
} from "./coldClaimTimers.js"

describe("coldClaimTimers (offline)", () => {
  describe("PhaseTimer", () => {
    it("records a duration between begin and end", async () => {
      const t = new PhaseTimer()
      t.begin("sync")
      await new Promise((r) => setTimeout(r, 5))
      t.end("sync")
      const result = t.result()
      expect(result.sync).toBeGreaterThan(0)
    })

    it("time() records the wrapped phase and returns its value", async () => {
      const t = new PhaseTimer()
      const value = await t.time("simulate", async () => 42)
      expect(value).toBe(42)
      expect(t.result().simulate).toBeGreaterThanOrEqual(0)
    })

    it("end() before begin throws", () => {
      const t = new PhaseTimer()
      expect(() => t.end("never-started")).toThrow(/before begin/)
    })
  })

  describe("aggregatePhase", () => {
    it("computes min/median/max and flags small samples (no p10/p90)", () => {
      const stats = aggregatePhase("sync", [30, 10, 20])
      expect(stats.min).toBe(10)
      expect(stats.median).toBe(20)
      expect(stats.max).toBe(30)
      expect(stats.samples).toEqual([30, 10, 20])
      expect(stats.smallSample).toBe(true)
      expect(stats.p10).toBeUndefined()
      expect(stats.p90).toBeUndefined()
    })

    it("emits p10/p90 once N is large enough", () => {
      const samples = Array.from({ length: MIN_PERCENTILE_SAMPLES }, (_, i) => (i + 1) * 10)
      const stats = aggregatePhase("sync", samples)
      expect(stats.smallSample).toBe(false)
      expect(stats.p10).toBeDefined()
      expect(stats.p90).toBeDefined()
      expect(stats.p10!).toBeLessThan(stats.p90!)
    })

    it("N=1 yields median = the single sample", () => {
      const stats = aggregatePhase("prove", [99])
      expect(stats.min).toBe(99)
      expect(stats.median).toBe(99)
      expect(stats.max).toBe(99)
      expect(stats.smallSample).toBe(true)
    })
  })

  describe("aggregateReps", () => {
    it("aggregates across the union of phase labels", () => {
      const reps: PhaseSample[] = [
        { sync: 100, prove: 50 },
        { sync: 200, prove: 60 },
      ]
      const stats = aggregateReps(reps)
      const sync = stats.find((s) => s.phase === "sync")!
      const prove = stats.find((s) => s.phase === "prove")!
      expect(sync.median).toBe(150)
      expect(prove.median).toBe(55)
    })
  })

  describe("dominantPhase", () => {
    it("representative ranking excludes the WASM prove phase even when prove is largest", () => {
      const stats = aggregateReps([{ sync: 100, prove: 9000, simulate: 40 }])
      const representative = dominantPhase(stats, { excludeNonRepresentative: true })
      const raw = dominantPhase(stats, { excludeNonRepresentative: false })
      expect(representative?.phase).toBe("sync")
      expect(raw?.phase).toBe("prove")
    })
  })

  describe("assertNoSecrets", () => {
    it("throws on a long hex (address/secret/key)", () => {
      expect(() => assertNoSecrets({ x: "0x" + "a".repeat(40) })).toThrow(/secret\/URL/)
    })

    it("throws on a URL (paylink link is a bearer instrument)", () => {
      expect(() => assertNoSecrets({ link: "https://example.com/p#abc" })).toThrow(/secret\/URL/)
    })

    it("passes a clean timing report (labels + numbers only)", () => {
      expect(() =>
        assertNoSecrets({ phase: "sync", median: 1234, samples: [1, 2, 3] }),
      ).not.toThrow()
    })
  })

  describe("buildColdClaimReport", () => {
    it("leads with the representative dominant (excludes prove) and flags the raw prove winner", () => {
      const report = buildColdClaimReport({
        coldReps: [
          { sync: 1000, prove: 8000, simulate: 50 },
          { sync: 1200, prove: 8200, simulate: 60 },
        ],
        warmReps: [
          { sync: 200, prove: 8000, simulate: 50 },
          { sync: 250, prove: 8100, simulate: 55 },
        ],
        coldDiagnostics: [
          { anchorBlock: 100, blocksWalked: 5 },
          { anchorBlock: 101, blocksWalked: 4 },
        ],
        warmDiagnostics: [{ anchorBlock: 100 }, { anchorBlock: 101 }],
      })
      expect(report.representativeDominant?.phase).toBe("sync")
      expect(report.rawDominant?.phase).toBe("prove")
      expect(report.notes.some((n) => n.includes("host-WASM"))).toBe(true)
      // warm sync is faster than cold sync → positive delta
      expect(report.coldVsWarmDelta.sync).toBeGreaterThan(0)
    })

    it("produces a report with no secrets (fail-closed)", () => {
      expect(() =>
        buildColdClaimReport({
          coldReps: [{ sync: 100 }],
          warmReps: [{ sync: 50 }],
          coldDiagnostics: [{ anchorBlock: 1 }],
          warmDiagnostics: [{ anchorBlock: 1 }],
        }),
      ).not.toThrow()
    })

    it("notes small-sample at N below the percentile floor", () => {
      const report = buildColdClaimReport({
        coldReps: [{ sync: 100 }, { sync: 110 }, { sync: 120 }],
        warmReps: [{ sync: 50 }, { sync: 55 }, { sync: 60 }],
        coldDiagnostics: [{}, {}, {}],
        warmDiagnostics: [{}, {}, {}],
      })
      expect(report.notes.some((n) => n.includes("not tail estimates"))).toBe(true)
    })
  })
})
