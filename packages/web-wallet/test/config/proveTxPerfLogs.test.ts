// @vitest-environment node
/** The `[Perf][ProveTx]` console line: off unless VITE_PROVE_TX_PERF_LOGS is "true". */
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => vi.unstubAllEnvs())

async function flagWith(value: string | undefined): Promise<boolean> {
  vi.stubEnv("VITE_PROVE_TX_PERF_LOGS", value)
  vi.resetModules()
  return (await import("../../src/config/features")).proveTxPerfLogsEnabled
}

describe("proveTxPerfLogsEnabled", () => {
  it("is off by default and for any value but true", async () => {
    expect(await flagWith(undefined)).toBe(false)
    expect(await flagWith("1")).toBe(false)
    expect(await flagWith("TRUE")).toBe(false)
  })

  it("is on for true", async () => {
    expect(await flagWith("true")).toBe(true)
  })
})
