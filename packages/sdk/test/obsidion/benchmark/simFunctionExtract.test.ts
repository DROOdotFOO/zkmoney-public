/**
 * U2 — sim-side per-function extractor + first-party name allowlist
 * (docs/plans/2026-06-04-001).
 *
 * Pins: witgen + aggregate-oracle mapping, the undefined-vs-[] contract,
 * aggregation by normalized name, the no-`oracleMs <= witgenMs` invariant, the
 * exact-full-name allowlist (no bare/suffix leak), the kernel prefix rule, the
 * privacy shape (only name/witgenMs/oracleMs), and the allowlist membership
 * source-of-truth against a representative first-party fixture.
 */
import { describe, it, expect } from "vitest"
import type { SimulationTimings } from "@aztec-labs/stdlib/tx"
import {
  extractSimFunctions,
  normalizeFunctionName,
  NON_ALLOWLISTED,
  ALLOWLISTED_NAMES,
} from "../../../src/obsidion/benchmark/simFunctionExtract.js"

function simTimings(perFunction: SimulationTimings["perFunction"]): SimulationTimings {
  return { sync: 1, perFunction, unaccounted: 0, total: 0 }
}

/**
 * The COMPLETE expected first-party allowlist, enumerated explicitly (not via the
 * same flatMap the implementation uses) so any drift — accidental expansion OR a
 * dropped entry — fails the exact-equality membership test below. This is the
 * reviewed privacy source of truth; keep it in lock-step with `ALLOWLISTED_NAMES`.
 */
const EXPECTED_ALLOWLIST = [
  // OxideToken
  "OxideToken:transfer",
  "OxideToken:withdraw",
  "OxideToken:publish_da",
  "OxideToken:claim",
  "OxideToken:recurse_subtract_balance_internal",
  // ObsidionAccountAlpha (real)
  "ObsidionAccountAlpha:entrypoint",
  "ObsidionAccountAlpha:entrypoint_with_intent",
  // ObsidionAccountAlphaSimulated (stub)
  "ObsidionAccountAlphaSimulated:entrypoint",
  "ObsidionAccountAlphaSimulated:entrypoint_with_intent",
  // ObsidionAccountAlphaTest
  "ObsidionAccountAlphaTest:entrypoint",
  "ObsidionAccountAlphaTest:entrypoint_with_intent",
  // Paylink contracts
  "PaylinkDirect:claim",
  "PaylinkDirect:refund",
  "PaylinkDirect:deposit",
  "PaylinkEmail:claim",
  "PaylinkEmail:refund",
  "PaylinkEmail:deposit",
  // Fee-paying contracts
  "SponsorFPC:fee_entrypoint_private",
  "SponsorFPC:fee_entrypoint_public",
  "PasswordFPC:fee_entrypoint_private",
]

describe("extractSimFunctions", () => {
  it("maps witgen + aggregate oracle ms for allowlisted full-debug-name functions", () => {
    const out = extractSimFunctions(
      simTimings([
        {
          functionName: "OxideToken:transfer",
          time: 4200,
          oracles: { getNotes: { times: [10, 20] }, getKey: { times: [5] } },
        },
        { functionName: "ObsidionAccountAlphaSimulated:entrypoint", time: 900 },
      ]),
    )!
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      name: "OxideToken:transfer",
      witgenMs: 4200,
      oracleMs: 35, // 10 + 20 + 5
    })
    expect(out[1]).toEqual({
      name: "ObsidionAccountAlphaSimulated:entrypoint",
      witgenMs: 900,
      oracleMs: 0,
    })
  })

  it("redacts a non-allowlisted name and collapses distinct ones into ONE bucket", () => {
    const out = extractSimFunctions(
      simTimings([
        { functionName: "PartnerThing:claim", time: 100, oracles: { o: { times: [1] } } },
        { functionName: "OtherThing:doStuff", time: 50, oracles: { o: { times: [2] } } },
      ]),
    )!
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ name: NON_ALLOWLISTED, witgenMs: 150, oracleMs: 3 })
  })

  it("does not leak via bare or suffix matching (exact full-name only)", () => {
    expect(normalizeFunctionName("claim")).toBe(NON_ALLOWLISTED)
    expect(normalizeFunctionName("SomethingElse:claim")).toBe(NON_ALLOWLISTED)
    expect(normalizeFunctionName("OxideToken:claim")).toBe("OxideToken:claim")
  })

  it("keeps kernel circuits by prefix, redacts near-misses", () => {
    expect(normalizeFunctionName("private_kernel_init")).toBe("private_kernel_init")
    expect(normalizeFunctionName("hiding_kernel_foo")).toBe("hiding_kernel_foo")
    expect(normalizeFunctionName("private_kernelish")).toBe(NON_ALLOWLISTED)
  })

  it("treats missing/empty oracles as 0 and sums across multiple oracles", () => {
    const out = extractSimFunctions(
      simTimings([
        { functionName: "OxideToken:withdraw", time: 10 },
        { functionName: "OxideToken:publish_da", time: 20, oracles: {} },
        {
          functionName: "OxideToken:claim",
          time: 30,
          oracles: { a: { times: [1, 2] }, b: { times: [3, 4] } },
        },
      ]),
    )!
    expect(out.find((r) => r.name === "OxideToken:withdraw")!.oracleMs).toBe(0)
    expect(out.find((r) => r.name === "OxideToken:publish_da")!.oracleMs).toBe(0)
    expect(out.find((r) => r.name === "OxideToken:claim")!.oracleMs).toBe(10)
  })

  it("returns undefined for absent timings, [] for present-but-empty perFunction", () => {
    expect(extractSimFunctions(undefined)).toBeUndefined()
    expect(extractSimFunctions(simTimings([]))).toEqual([])
  })

  it("output rows have exactly name/witgenMs/oracleMs — no oracle keys", () => {
    const out = extractSimFunctions(
      simTimings([
        {
          functionName: "OxideToken:claim",
          time: 5,
          oracles: { getNotes: { times: [1] } },
        },
      ]),
    )!
    expect(Object.keys(out[0]!).sort()).toEqual(["name", "oracleMs", "witgenMs"])
    expect(JSON.stringify(out)).not.toContain("getNotes")
    expect(JSON.stringify(out)).not.toContain("oracles")
  })

  it("passes through oracleMs > witgenMs unclamped (no subset invariant)", () => {
    const out = extractSimFunctions(
      simTimings([
        { functionName: "OxideToken:withdraw", time: 5, oracles: { o: { times: [99] } } },
      ]),
    )!
    expect(out[0]).toEqual({ name: "OxideToken:withdraw", witgenMs: 5, oracleMs: 99 })
  })

  it("allowlist membership: runtime Set equals the reviewed enumeration exactly", () => {
    // Exact equality both ways — catches accidental expansion AND dropped entries.
    expect([...ALLOWLISTED_NAMES].sort()).toEqual([...EXPECTED_ALLOWLIST].sort())
    expect(ALLOWLISTED_NAMES.size).toBe(EXPECTED_ALLOWLIST.length)
  })

  it("allowlist membership: every enumerated first-party name is kept verbatim", () => {
    for (const name of EXPECTED_ALLOWLIST) {
      expect(normalizeFunctionName(name)).toBe(name)
    }
    // A perFunction of every first-party name maps each to a verbatim entry
    // (none silently redacted to the bucket).
    const out = extractSimFunctions(
      simTimings(EXPECTED_ALLOWLIST.map((functionName) => ({ functionName, time: 1 }))),
    )!
    expect(out.some((r) => r.name === NON_ALLOWLISTED)).toBe(false)
    expect(out.map((r) => r.name).sort()).toEqual([...EXPECTED_ALLOWLIST].sort())
  })

  it("is defensively total against malformed upstream shapes (never throws)", () => {
    // Missing perFunction → present (not undefined) empty result.
    expect(extractSimFunctions({ sync: 1 } as unknown as SimulationTimings)).toEqual([])
    // Malformed rows: missing name skipped; non-numeric time → 0; bad oracles → 0.
    const out = extractSimFunctions({
      perFunction: [
        { time: 5 }, // no functionName → skipped
        { functionName: "OxideToken:withdraw", time: "x" }, // non-numeric time → 0
        { functionName: "OxideToken:claim", time: 7, oracles: { a: { times: null } } },
        { functionName: "OxideToken:publish_da", time: 3, oracles: null },
      ],
    } as unknown as SimulationTimings)!
    expect(out.find((r) => r.name === "OxideToken:withdraw")).toEqual({
      name: "OxideToken:withdraw",
      witgenMs: 0,
      oracleMs: 0,
    })
    expect(out.find((r) => r.name === "OxideToken:claim")!.oracleMs).toBe(0)
    expect(out.find((r) => r.name === "OxideToken:publish_da")!.oracleMs).toBe(0)
    // The nameless row was skipped, not crashed.
    expect(out).toHaveLength(3)
  })
})
