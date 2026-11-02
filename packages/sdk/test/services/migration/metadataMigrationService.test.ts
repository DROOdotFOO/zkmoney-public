import { describe, expect, it, vi } from "vitest"
import {
  MetadataMigrationService,
  type MetadataMigrationSource,
} from "../../../src/services/migration/MetadataMigrationService.js"

function service() {
  const quote = vi.fn(async () => ({ movable: 1n, stranded: 0n, waiting: 0n }))
  const source = {
    fundsOnly: true,
    state: async () => "frozen",
    quote,
  } as unknown as MetadataMigrationSource
  const destination = { token: "0x0000000000000000000000000000000000000001" }
  return {
    service: new MetadataMigrationService({ source, registered: {}, destination } as never),
    quote,
  }
}

describe("a frozen source's quote", () => {
  it("counts one approval per batch and charges no fee", async () => {
    const f = service()
    f.quote.mockResolvedValue({ movable: 9n, stranded: 0n, waiting: 0n, batches: 2 } as never)
    expect(await f.service.quote()).toMatchObject({ movable: 9n, approvals: 2, fees: 0n })
    expect(f.quote).toHaveBeenCalledWith()
  })

  it("keeps the source's own approval count, which skips a link's batch", async () => {
    const f = service()
    f.quote.mockResolvedValue({
      movable: 9n,
      stranded: 0n,
      waiting: 0n,
      batches: 2,
      approvals: 1,
    } as never)
    expect(await f.service.quote()).toMatchObject({ approvals: 1, fees: 0n })
  })

  it("is movable exactly when the quote moves something", async () => {
    const f = service()
    expect(await f.service.movable()).toBe(true)
    f.quote.mockResolvedValue({ movable: 0n, stranded: 4n, waiting: 0n })
    expect(await f.service.movable()).toBe(false)
  })
})
