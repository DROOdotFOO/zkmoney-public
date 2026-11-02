/** A portal's manifest tuple is fetched once, and a fetch that stalls is dropped for the next read. */
import { describe, expect, it, vi } from "vitest"

const load = vi.hoisted(() => vi.fn())
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  loadOxideManifestTuple: load,
}))
const { ASSET_TUPLE_TIMEOUT_MS, getPortalTuple } = await import("../../src/config/oxideTuple")

const config = {
  network: "testnet",
  oxideProfile: { manifestUrl: "http://manifest.test/staging.json", portal: "0xdai" },
} as never

describe("getPortalTuple", () => {
  it("drops a stalled fetch once it times out, so the next read fetches again", async () => {
    vi.useFakeTimers()
    try {
      load.mockReturnValueOnce(new Promise(() => {}))
      const stalled = getPortalTuple(config, "0xOLD")
      const settled = expect(stalled).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS)
      await settled
      load.mockResolvedValueOnce({ portal: "0xold" })
      await expect(getPortalTuple(config, "0xold")).resolves.toEqual({ portal: "0xold" })
      // Fetched once it answers, whatever the address case.
      expect(load).toHaveBeenCalledTimes(2)
      await getPortalTuple(config, "0xOLD")
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
