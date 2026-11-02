/** The browser's `[Perf][ProveTx]` switch reaches the sdk, which reads no build env, once config loads. */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ setPerfLogFlag: vi.fn() }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  setPerfLogFlag: h.setPerfLogFlag,
}))
// The provider tree past the config gate is not under test.
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  WagmiProvider: () => null,
}))
vi.mock("../../../src/features/deposit/wagmi", () => ({
  wagmiConfig: () => ({}),
  rainbowkitTheme: {},
}))
vi.mock("../../../src/features/savings/savingsGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/savings/savingsGateway")>()),
  prefetchLiveSavingsApy: () => {},
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1RpcUrl: "http://l1.test", l1Chain: {} }),
}))

vi.stubEnv("VITE_PROVE_TX_PERF_LOGS", "true")
const { App } = await import("../../../src/App")
const { openTestSession } = await import("../../support/session")
afterAll(() => vi.unstubAllEnvs())

it("hands VITE_PROVE_TX_PERF_LOGS to the sdk once the wallet's config loads", async () => {
  // The active tab opens the session before the app renders.
  openTestSession()
  const root = createRoot(document.createElement("div"))
  const activeTab = { node: {}, pxeBoot: { kind: "none" }, activeSince: 0 } as never
  await act(async () => root.render(<App boot={{} as never} activeTab={activeTab} />))
  await vi.waitFor(() => expect(h.setPerfLogFlag).toHaveBeenCalledWith(true))
  await act(async () => root.unmount())
})
