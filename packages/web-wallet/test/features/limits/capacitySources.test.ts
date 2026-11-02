import { describe, expect, it, vi } from "vitest"
import type { PortalCapacityKey } from "@obsidion/front-core"
import { sourceFromTarget } from "../../../src/features/limits/capacitySources"

const ORIGINAL: PortalCapacityKey = { chainId: 1, portal: "0xoriginal", token: "0xdai" }

describe("sourceFromTarget", () => {
  it("maps each address resolution to a source that never names the active bucket unasked", () => {
    const retry = vi.fn()
    expect(sourceFromTarget({ resolution: "resolved", key: ORIGINAL, retry })).toEqual({
      kind: "key",
      key: ORIGINAL,
    })
    expect(sourceFromTarget({ resolution: "pending", retry })).toEqual({ kind: "pending" })
    expect(sourceFromTarget({ resolution: "resolved", retry })).toEqual({ kind: "pending" })
    // A failed read of the original terms retries through the address's own reader.
    expect(sourceFromTarget({ resolution: "failed", retry })).toEqual({ kind: "unresolved", retry })
    // Nothing proves the portal (an embedded request address, a record with no origin): no retry.
    expect(sourceFromTarget({ resolution: "missing", retry })).toEqual({ kind: "unresolved" })
  })
})
