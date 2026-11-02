import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  rebuildPaylinks: vi.fn(),
  reconcile: vi.fn(),
  fetchTokenInformation: vi.fn(),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
  rebuildPaylinks: h.rebuildPaylinks,
  createTransferEventSource: () => ({}),
  checkSpentViaPaylinkService: () => async () => new Map(),
  PaylinkClaimReconciler: class {
    reconcile = h.reconcile
    reconcileTxHash = async () => {}
  },
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {},
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ nodeEndpointDigest: "digest" }) }))

const { PaylinkClaimMount } = await import(
  "../../../src/features/notifications/PaylinkClaimMount/PaylinkClaimMount"
)
const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")
const { getAuthService } = await import("../../../src/platform/auth/useAuthenticator")
beforeEach(() => {
  vi.spyOn(getAuthService(), "getSecretKey").mockResolvedValue("0xsecret" as never)
  const { milestones } = openTestSession({
    wallet: { networkId: NETWORK_ID },
    account: { getAddress: () => ({ toString: () => "0xaccount" }) },
    token: { fetchTokenInformation: h.fetchTokenInformation },
  })
  milestones.mark("firstBalance")
  milestones.mark("depositsReplayed")
})
afterEach(closeSession)
const { markPaylinksRescanned, rescanPaylinks, usePaylinksRescanned } = await import(
  "../../../src/features/paylink/paylinkRescanState"
)

const NETWORK_ID = `0x${"a".repeat(40)}`

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  markPaylinksRescanned("0xother", true)
  h.fetchTokenInformation.mockResolvedValue({ address: "0xtoken", symbol: "DAI", decimals: 18 })
  h.rebuildPaylinks.mockResolvedValue({ created: [], complete: true })
  h.reconcile.mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Mount and wait for the first pass: the sweep runs once the rescan has settled. */
async function mount() {
  await act(async () => {
    root.render(<PaylinkClaimMount />)
  })
  await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalled())
}

describe("PaylinkClaimMount", () => {
  it("rebuilds sent paylinks under the active network id", async () => {
    await mount()

    expect(h.rebuildPaylinks).toHaveBeenCalledTimes(1)
    expect(h.rebuildPaylinks.mock.calls[0][0]).toMatchObject({
      networkId: NETWORK_ID,
      endpointScope: "digest",
    })
  })

  it("marks the account's links rebuilt only after a pass that read every one", async () => {
    let rescanned: boolean | undefined
    function Probe() {
      rescanned = usePaylinksRescanned("0xACCOUNT")
      return null
    }
    h.rebuildPaylinks.mockResolvedValue({ created: [], complete: false })
    await act(async () => {
      root.render(
        <>
          <PaylinkClaimMount />
          <Probe />
        </>,
      )
    })
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalled())
    expect(rescanned).toBe(false)

    h.rebuildPaylinks.mockResolvedValue({ created: [], complete: true })
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await vi.waitFor(() => expect(rescanned).toBe(true))

    // A pass that throws is no complete read either.
    h.rebuildPaylinks.mockRejectedValue(new Error("node down"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await act(async () => rescanPaylinks())
    await vi.waitFor(() => expect(rescanned).toBe(false))
    expect(h.rebuildPaylinks).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})
