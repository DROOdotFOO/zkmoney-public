import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"

const readContract = vi.hoisted(() => vi.fn())
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ readContract }),
}))

import { executorSubsidyAt } from "../../../src/features/withdraw/withdrawalFee"

const EXECUTOR = `0x${"44".repeat(20)}` as Address
const SUBSIDY = `0x${"55".repeat(20)}` as Address

describe("executorSubsidyAt", () => {
  it("reads an executor's subsidy once per session, and again after a failed read", async () => {
    readContract.mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(SUBSIDY)
    await expect(executorSubsidyAt(EXECUTOR)).rejects.toThrow("rpc down")
    expect(await executorSubsidyAt(EXECUTOR)).toBe(SUBSIDY)
    expect(await executorSubsidyAt(EXECUTOR.toLowerCase() as Address)).toBe(SUBSIDY)
    expect(readContract).toHaveBeenCalledTimes(2)
  })
})
