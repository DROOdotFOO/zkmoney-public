/**
 * A visitor with no identity who opens "/" while the wallet starts is sent to the landing. The
 * redirect is no first screen, even with the shell's notice showing: the boot screen holds through
 * it, so a screen standing in for the landing stays until the landing itself shows.
 */
import { createRoot } from "react-dom/client"
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("../../../src/features/identity/walletIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/identity/walletIdentity")>()),
  loadOnboardedIdentity: () => null,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: undefined }),
}))
vi.mock("../../../src/ui/PxeBoot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/PxeBoot")>()),
  usePxeBoot: () => ({ bootStatus: "booting" }),
}))

const { WalletEntryGate } = await import("../../../src/App")
const { BootSplash, useFirstScreenShown } = await import("../../../src/ui/PxeBoot")

const reactEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const added: HTMLElement[] = []

afterEach(() => {
  reactEnv.IS_REACT_ACT_ENVIRONMENT = true
  for (const el of added.splice(0)) el.remove()
})

function element(id?: string): HTMLDivElement {
  const el = document.createElement("div")
  if (id) el.id = id
  document.body.append(el)
  added.push(el)
  return el
}

function Shell() {
  return (
    <>
      <p>This wallet is running on the configuration it shipped with</p>
      <Outlet />
    </>
  )
}

it("keeps the boot screen up through the redirect to the landing", async () => {
  const standIn = element("pre-boot")
  standIn.append(document.createElement("div"))
  const app = element("root")
  // Real scheduling: the redirect navigates from an effect, as it does in the browser.
  reactEnv.IS_REACT_ACT_ENVIRONMENT = false
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

  const seen: boolean[] = []
  function Probe() {
    seen.push(useFirstScreenShown())
    return null
  }
  createRoot(element()).render(<Probe />)
  const root = createRoot(app)
  root.render(<BootSplash key="config" />)
  await tick()
  await Promise.resolve().then(() =>
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Shell />}>
            <Route element={<WalletEntryGate />}>
              <Route index element={<p>Home</p>} />
            </Route>
            <Route path="claim" element={<BootSplash key="hold" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  await tick()
  await tick()

  expect(seen).not.toContain(true)
  expect(document.body.dataset.booting).toBe("full")
  root.unmount()
})
