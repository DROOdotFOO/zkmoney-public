import { beforeEach, describe, expect, it, vi } from "vitest"

const FRAGMENT = "secretbearerfragment"
const PH = "ph".repeat(32)
const ROLLUP_ADDRESS = "0x" + "ab".repeat(20)
const SECRET_BYTES = new Uint8Array(32).fill(7)

const firePaylinkEvent = vi.fn()
const paylinkPh = vi.fn(async (..._args: unknown[]) => PH)
const amountBucket = vi.fn((..._args: unknown[]) => "<50")
const decodePaylinkInline = vi.fn()

vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  firePaylinkEvent: (...args: unknown[]) => firePaylinkEvent(...args),
  paylinkPh: (...args: unknown[]) => paylinkPh(...args),
  amountBucket: (...args: unknown[]) => amountBucket(...args),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  decodePaylinkInline: (...args: unknown[]) => decodePaylinkInline(...args),
}))

const { emitLinkOpened } = await import("../../../src/features/paylink/sponsoredPaylink")

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("emitLinkOpened", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    decodePaylinkInline.mockReturnValue({
      paylinkType: "0xsomedirecttype",
      secret: { toBuffer: () => SECRET_BYTES },
    })
  })

  it("emits one link_opened carrying only stage/flavor/hash — never the fragment or secret", async () => {
    emitLinkOpened(ROLLUP_ADDRESS, FRAGMENT)
    await flush()
    expect(firePaylinkEvent).toHaveBeenCalledTimes(1)
    // The amount lives on chain, so the funnel top carries no bucket.
    expect(firePaylinkEvent).toHaveBeenCalledWith({
      stage: "link_opened",
      flavor: "direct",
      amount_bucket: "unknown",
      paylink_ph: PH,
    })
    expect(amountBucket).not.toHaveBeenCalled()
    // The hash is derived from the secret + network identity, on-device.
    expect(paylinkPh).toHaveBeenCalledWith({
      rollupAddress: ROLLUP_ADDRESS,
      secret: expect.objectContaining({ toBuffer: expect.any(Function) }),
    })
    // Privacy: nothing in the wire payload contains the fragment or raw secret bytes.
    const wire = JSON.stringify(firePaylinkEvent.mock.calls)
    expect(wire).not.toContain(FRAGMENT)
    expect(wire).not.toContain("7,7,7")
  })
})
