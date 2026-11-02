import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { FrozenMetadataMigrationSource } from "../../../src/services/migration/FrozenMetadataMigrationSource.js"

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const ROUTE = {
  executor: addr("e1"),
  subsidy: addr("5b"),
  payoutToken: addr("da"),
  sourcePortal: addr("51"),
  destinationPortal: addr("de"),
  operationExecutor: addr("0e"),
}

function fixture() {
  const build = vi.fn()
  const make = (route: typeof ROUTE | null = ROUTE) =>
    new FrozenMetadataMigrationSource({
      runtime: { identity: "frozen", migration: route ?? undefined, build },
      owner: addr("0a"),
      destinationAsset: addr("55"),
      destination: { portal: ROUTE.destinationPortal, factory: "0x01", rollupVersion: 5n },
      registered: { user: AztecAddress.ZERO, policy: {} },
    } as never)
  return { make, build }
}

describe("a source on the migration executor route", () => {
  it("moves only funds", async () => {
    const f = fixture()
    const source = f.make()
    expect(source.fundsOnly).toBe(true)
    expect(f.build).not.toHaveBeenCalled()
  })

  it("refuses to run once the destination drops the route", () => {
    const f = fixture()
    expect(() => f.make(null)).toThrow(
      "A frozen source moves funds only through the destination's migration executor",
    )
  })
})
