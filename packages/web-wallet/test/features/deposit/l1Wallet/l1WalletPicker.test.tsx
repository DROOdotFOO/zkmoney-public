/**
 * The deposit screen holds a funding click only while the wallet picker is up, so the adapter has
 * to say when it is: `pickerOpen` mirrors RainbowKit's connect-modal state, and `connect` raises
 * that modal while nothing is connected.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const rk = vi.hoisted(() => ({
  connectModalOpen: false,
  openConnectModal: vi.fn(() => {
    rk.connectModalOpen = true
  }),
}))
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({
    connectModalOpen: rk.connectModalOpen,
    openConnectModal: rk.openConnectModal,
  }),
  // Disconnected: RainbowKit offers no account modal.
  useAccountModal: () => ({ accountModalOpen: false, openAccountModal: undefined }),
}))
vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnecting: false, isReconnecting: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
}))
vi.mock("wagmi/actions", () => ({
  getAccount: () => ({}),
  switchChain: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock("../../../../src/features/deposit/wagmi", () => ({ wagmiConfig: () => ({}) }))

const { useL1Wallet } = await import("../../../../src/features/deposit/l1Wallet")

let latest: ReturnType<typeof useL1Wallet> | undefined
function Probe() {
  latest = useL1Wallet({ expectedChainId: 1 })
  return null
}

describe("useL1Wallet — picker state", () => {
  let container: HTMLDivElement
  let root: Root
  const render = () => act(async () => root.render(<Probe />))

  beforeEach(() => {
    vi.clearAllMocks()
    rk.connectModalOpen = false
    latest = undefined
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("reports the picker as open from connect() until RainbowKit closes it", async () => {
    await render()
    expect(latest!.account).toBeNull()
    expect(latest!.pickerOpen).toBe(false)

    await act(async () => latest!.connect())
    expect(rk.openConnectModal).toHaveBeenCalledOnce()
    await render()
    expect(latest!.pickerOpen).toBe(true)

    rk.connectModalOpen = false
    await render()
    expect(latest!.pickerOpen).toBe(false)
  })
})
