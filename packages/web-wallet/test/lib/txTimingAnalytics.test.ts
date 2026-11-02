import { afterEach, describe, expect, it, vi } from "vitest"
import { benchmarkRegistry, readTimingBenchFlag, setTimingBenchFlag } from "@obsidion/sdk"
import type { BenchmarkSample } from "@obsidion/core/types"
import { stubProvingDevice } from "../support/provingDevice"

vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
const { bindAnalyticsConsent } = await import("../../src/lib/analytics")
const { txTimingProps, wireTxTimingAnalytics } = await import("../../src/lib/txTimingAnalytics")

afterEach(() => {
  setTimingBenchFlag(undefined)
  benchmarkRegistry.setSampleSink(undefined)
  bindAnalyticsConsent(() => false)
})

describe("txTimingProps", () => {
  it("flattens a sample to rounded per-phase durations", () => {
    const sample: BenchmarkSample = {
      flow: "paylink-create",
      phases: {
        sync: 100.4,
        simulation: 2000.6,
        enclave: 300.5,
        userWitgen: 4000.2,
        kernelWitgen: 5000.9,
        proving: 12000.1,
      },
      total: 23402.7,
      unaccounted: 12.3,
      cold: false,
      status: "ok",
      notesUsed: 3,
    }
    expect(txTimingProps(sample)).toEqual({
      flow: "paylink-create",
      status: "ok",
      notes_used: 3,
      sync_ms: 100,
      simulation_ms: 2001,
      enclave_ms: 301,
      user_witgen_ms: 4000,
      kernel_witgen_ms: 5001,
      proving_ms: 12000,
      total_ms: 23403,
    })
  })
})

describe("wireTxTimingAnalytics", () => {
  it("captures only under consent, and sends each finished transaction's phases with the device class", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response())
    const restore = stubProvingDevice(true, 8)
    let consent = false
    bindAnalyticsConsent(() => consent)
    try {
      wireTxTimingAnalytics()
      expect(readTimingBenchFlag()).toBe(false)
      consent = true
      expect(readTimingBenchFlag()).toBe(true)

      benchmarkRegistry.contributeTee("op-device", { flow: "send", enclave: 300, notesUsed: 2 })
      benchmarkRegistry.contributeProve("op-device", {
        flow: "send",
        sync: 100,
        simulation: 2_000,
        userWitgen: 4_000,
        kernelWitgen: 5_000,
        proving: 12_000,
        unaccounted: 0,
        incomplete: false,
      })
      const bodies = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      expect(
        bodies.map(({ event, props: { viewport: _viewport, ...props } }) => [event, props]),
      ).toEqual([
        [
          "tx_timing",
          {
            flow: "send",
            status: "ok",
            notes_used: 2,
            sync_ms: 100,
            simulation_ms: 2_000,
            enclave_ms: 300,
            user_witgen_ms: 4_000,
            kernel_witgen_ms: 5_000,
            proving_ms: 12_000,
            total_ms: 23_400,
            cross_origin_isolated: true,
            hardware_concurrency: 8,
          },
        ],
      ])
    } finally {
      restore()
      fetchSpy.mockRestore()
    }
  })
})
