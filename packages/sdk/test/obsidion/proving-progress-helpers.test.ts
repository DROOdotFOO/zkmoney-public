import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ProvingStage,
  provingProgress,
  type ProvingProgressEvent,
} from "@obsidion/proving-progress"
import type { PXE } from "@aztec-labs/pxe/client/lazy"
import {
  proveTxWithProgress,
  readPerfLogFlag,
  readTimingBenchFlag,
  setPerfLogFlag,
} from "../../src/obsidion/proving-progress-helpers.js"

beforeEach(() => {
  provingProgress.removeAllListeners()
  delete process.env.OBSIDION_PROVE_TX_PERF_LOGS
  delete process.env.OBSIDION_TX_TIMING_BENCH
})

afterEach(() => {
  provingProgress.removeAllListeners()
  setPerfLogFlag(undefined)
  delete process.env.OBSIDION_PROVE_TX_PERF_LOGS
  delete process.env.OBSIDION_TX_TIMING_BENCH
})

describe("proveTxWithProgress", () => {
  it("emits stage-start('simulating') exactly once before pxe.proveTx", async () => {
    const events: ProvingProgressEvent[] = []
    provingProgress.on("stage-start", (e: ProvingProgressEvent) => events.push(e))

    let proveTxCalled = false
    let emitsAtProveTxEntry = 0
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {},
      async proveTx() {
        proveTxCalled = true
        emitsAtProveTxEntry = events.length
        return { stub: true } as never
      },
    }

    await proveTxWithProgress(stubPxe, {} as never, { scopes: [] })
    expect(proveTxCalled).toBe(true)
    expect(emitsAtProveTxEntry).toBe(1)
    expect(events[0]?.stage).toBe(ProvingStage.Simulating)
  })

  it("propagates errors from pxe.proveTx without swallowing", async () => {
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {},
      async proveTx() {
        throw new Error("simulation reverted")
      },
    }
    await expect(proveTxWithProgress(stubPxe, {} as never, { scopes: [] })).rejects.toThrow(
      "simulation reverted",
    )
  })

  it("emits reset when pxe.proveTx fails so UI clears stranded stage state", async () => {
    let resetCount = 0
    provingProgress.on("reset", () => resetCount++)

    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {},
      async proveTx() {
        throw new Error("circuit failed")
      },
    }
    await expect(proveTxWithProgress(stubPxe, {} as never, { scopes: [] })).rejects.toThrow(
      "circuit failed",
    )
    expect(resetCount).toBe(1)
  })

  it("calls pxe.sync() before proveTx when opts.sync is set, and not otherwise", async () => {
    const calls: string[] = []
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {
        calls.push("sync")
      },
      async proveTx() {
        calls.push("proveTx")
        return { stub: true } as never
      },
    }

    await proveTxWithProgress(stubPxe, {} as never, { scopes: [] }, { sync: true })
    expect(calls).toEqual(["sync", "proveTx"])

    calls.length = 0
    await proveTxWithProgress(stubPxe, {} as never, { scopes: [] })
    expect(calls).toEqual(["proveTx"])
  })

  it("a failing opts.sync rejects, emits reset, and never reaches proveTx", async () => {
    let resetCount = 0
    provingProgress.on("reset", () => resetCount++)

    let proveTxCalled = false
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {
        throw new Error("sync failure")
      },
      async proveTx() {
        proveTxCalled = true
        return { stub: true } as never
      },
    }

    await expect(
      proveTxWithProgress(stubPxe, {} as never, { scopes: [] }, { sync: true }),
    ).rejects.toThrow("sync failure")
    expect(resetCount).toBe(1) // sync runs inside the try → catch clears the stage
    expect(proveTxCalled).toBe(false)
  })
})

describe("readPerfLogFlag", () => {
  it("returns false by default", () => {
    expect(readPerfLogFlag()).toBe(false)
  })

  it("returns true when OBSIDION_PROVE_TX_PERF_LOGS=true", () => {
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "true"
    expect(readPerfLogFlag()).toBe(true)
  })

  it("does not match arbitrary truthy values like 'TRUE' or '1'", () => {
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "1"
    expect(readPerfLogFlag()).toBe(false)
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "TRUE"
    expect(readPerfLogFlag()).toBe(false)
  })

  it("follows the runtime override over the env, both ways, until it is cleared", () => {
    setPerfLogFlag(true)
    expect(readPerfLogFlag()).toBe(true)
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "true"
    setPerfLogFlag(false)
    expect(readPerfLogFlag()).toBe(false)
    setPerfLogFlag(undefined)
    expect(readPerfLogFlag()).toBe(true)
  })
})

describe("readTimingBenchFlag", () => {
  it("returns false by default", () => {
    expect(readTimingBenchFlag()).toBe(false)
  })

  it("returns true when OBSIDION_TX_TIMING_BENCH=true", () => {
    process.env.OBSIDION_TX_TIMING_BENCH = "true"
    expect(readTimingBenchFlag()).toBe(true)
  })

  it("is independent of the perf-log flag", () => {
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "true"
    expect(readTimingBenchFlag()).toBe(false)
    process.env.OBSIDION_TX_TIMING_BENCH = "true"
    expect(readPerfLogFlag()).toBe(true)
    expect(readTimingBenchFlag()).toBe(true)
  })

  it("does not match arbitrary truthy values like 'TRUE' or '1'", () => {
    process.env.OBSIDION_TX_TIMING_BENCH = "1"
    expect(readTimingBenchFlag()).toBe(false)
    process.env.OBSIDION_TX_TIMING_BENCH = "TRUE"
    expect(readTimingBenchFlag()).toBe(false)
  })
})
