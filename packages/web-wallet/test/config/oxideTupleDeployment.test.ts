/** The deployment cache: one manifest fetch per profile, until the migration watch drops it. */
import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ loadOxideDeployment: vi.fn() }))
vi.mock("@obsidion/core/oxide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/core/oxide")>()),
  loadOxideDeployment: h.loadOxideDeployment,
}))

import { Network } from "@obsidion/core/constants"
import { getOxideDeployment, invalidateOxideDeployment } from "../../src/config/oxideTuple"
import type { WebWalletConfig } from "../../src/config/env"

const CONFIG = {
  oxideProfile: { manifestUrl: "https://oxide.example/manifest.json", portal: "0xabc" },
  network: Network.TESTNET,
} as unknown as WebWalletConfig

describe("getOxideDeployment", () => {
  it("fetches once per profile, and again after the cache is dropped", async () => {
    h.loadOxideDeployment
      .mockResolvedValueOnce({ deployment: { features: [] } })
      .mockResolvedValueOnce({ deployment: { features: [{ id: "fea-migration" }] } })

    expect(await getOxideDeployment(CONFIG)).toEqual({ deployment: { features: [] } })
    expect(await getOxideDeployment(CONFIG)).toEqual({ deployment: { features: [] } })
    expect(h.loadOxideDeployment).toHaveBeenCalledTimes(1)

    invalidateOxideDeployment()

    expect(await getOxideDeployment(CONFIG)).toEqual({
      deployment: { features: [{ id: "fea-migration" }] },
    })
    expect(h.loadOxideDeployment).toHaveBeenCalledTimes(2)
    // The first read may use the host cache; a read after the drop revalidates.
    expect(h.loadOxideDeployment.mock.calls[0]![0]).not.toHaveProperty("cache")
    expect(h.loadOxideDeployment.mock.calls[1]![0]).toMatchObject({ cache: "no-cache" })
  })
})
