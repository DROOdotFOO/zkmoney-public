// Zone tracking is what makes the waterfall a causal tree rather than a flat list, so it gets its
// own file: importing zone.js patches Promise process-wide, and every other suite must keep seeing
// an unpatched one. Assertions chain `.then()` instead of awaiting, because vitest compiles this
// file to native async/await — exactly the fast-await path a profiling BUILD downlevels away
// (vite.config.ts), and which no test can undo from the inside.
import "zone.js"
import { describe, expect, it } from "vitest"
import { profiler } from "../../src/profiling"
import { zoneAvailable } from "../../src/profiling/context"

const later = <T>(value: T, ms = 5) => new Promise<T>((r) => setTimeout(() => r(value), ms))

function parentOf(records: { id: string; name: string; parentId: string | null }[], name: string) {
  const record = records.find((r) => r.name === name)
  return records.find((r) => r.id === record?.parentId)?.name ?? null
}

describe("zone-tracked parent attribution", () => {
  it("is what the report claims it is", () => {
    expect(zoneAvailable()).toBe(true)
  })

  it("attributes a span to the span that caused it, across an async boundary", () => {
    profiler.start("nesting")
    return (
      profiler.span("outer", "wallet", () =>
        later("x").then(() => profiler.span("inner", "pxe", () => later("y"))),
      ) as Promise<unknown>
    ).then(() => {
      const { records } = profiler.stop()
      expect(parentOf(records, "outer")).toBe(null)
      expect(parentOf(records, "inner")).toBe("outer")
    })
  })

  it("makes concurrent calls siblings, never one the child of the other", () => {
    profiler.start("concurrency")
    const run = (name: string, ms: number) =>
      profiler.span(name, "node", () => later(name, ms)) as Promise<string>

    // `slow` fully encloses `fast` in time — a containment heuristic would nest them.
    return Promise.all([run("slow", 30), run("fast", 5)]).then(() => {
      const { records } = profiler.stop()
      expect(parentOf(records, "slow")).toBe(null)
      expect(parentOf(records, "fast")).toBe(null)
    })
  })
})

describe("staged finalizer attribution", () => {
  it("nests the pre-enclave gathering reads under the finalize span", () => {
    const node = { getWitness: () => later("witness") }
    const wallet: any = {
      node,
      sendTx: (opts: any) => opts.finalize(),
    }
    profiler.instrumentWallet(wallet)
    profiler.start("staged")

    // The finalizer's own shape: gathering reads, then the enclave call.
    return (
      wallet.sendTx({
        finalize: () =>
          wallet.node
            .getWitness()
            .then(() => wallet.node.getWitness())
            .then(() => profiler.span("signTokenOperation", "tee", () => later("sig"))),
      }) as Promise<unknown>
    ).then(() => {
      const { records } = profiler.stop()
      // The gathering is what `finalize` costs beyond the enclave leg, so both have to hang off it.
      expect(parentOf(records, "finalize")).toBe("sendTx")
      expect(parentOf(records, "signTokenOperation")).toBe("finalize")
      expect(records.filter((r) => r.name === "getWitness").length).toBe(2)
      for (const r of records.filter((r) => r.name === "getWitness")) {
        expect(parentOf(records, r.name)).toBe("finalize")
      }
    })
  })
})
