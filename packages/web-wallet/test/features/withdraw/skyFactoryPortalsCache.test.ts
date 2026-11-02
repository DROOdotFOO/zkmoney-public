import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"

const readContract = vi.hoisted(() => vi.fn())
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: vi.fn(),
  requireTupleField: vi.fn(),
  l1PublicClient: () => ({ readContract }),
}))

import { skyFactoryPortalsAt } from "../../../src/features/withdraw/withdrawalFee"

describe("skyFactoryPortalsAt", () => {
  it("reads a Sky escrow factory's two portals once per session", async () => {
    const FACTORY = `0x${"fa".repeat(20)}` as Address
    const portals = { DAI_PORTAL: `0x${"d1".repeat(20)}`, SUSDS_PORTAL: `0x${"d2".repeat(20)}` }
    readContract.mockImplementation(
      async ({ functionName }: { functionName: keyof typeof portals }) => portals[functionName],
    )
    const expected = { daiPortal: portals.DAI_PORTAL, sUsdsPortal: portals.SUSDS_PORTAL }
    expect(await skyFactoryPortalsAt(FACTORY)).toEqual(expected)
    expect(await skyFactoryPortalsAt(FACTORY.toUpperCase().replace("0X", "0x") as Address)).toEqual(
      expected,
    )
    expect(readContract).toHaveBeenCalledTimes(2)
  })
})
