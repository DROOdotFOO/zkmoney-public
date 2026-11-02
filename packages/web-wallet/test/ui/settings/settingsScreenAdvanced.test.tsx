import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const DEFAULT = { source: "default", isDefault: true }
const CUSTOM = { source: "settings", isDefault: false }
const state = vi.hoisted(() => ({
  endpoints: {} as Record<"node" | "l1Rpc" | "enclave", { source: string; isDefault: boolean }>,
}))

vi.mock("@obsidion/web-ds", () => ({
  ComingSoonPill: () => null,
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  GradientToggle: () => null,
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  SettingsRow: ({
    label,
    onClick,
    trailing,
  }: {
    label: string
    onClick?: () => void
    trailing?: React.ReactNode
  }) => (
    <button onClick={onClick}>
      <span>{label}</span>
      {trailing}
    </button>
  ),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useConfigValue: () => ({ value: false, setValue: vi.fn() }),
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", endpoints: state.endpoints }),
}))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => undefined,
}))
vi.mock("../../../src/features/onboarding/openRegistration", () => ({
  useNameClaimPending: () => false,
  useRegistrationTagChangeable: () => false,
}))
vi.mock("../../../src/features/onboarding/ChooseNameSheet", () => ({ ChooseNameSheet: () => null }))
vi.mock("../../../src/lib/analytics", () => ({ appVersion: "0.0.0" }))
vi.mock("../../../src/ui/prefs", () => ({ useHideBalances: () => [false, vi.fn()] }))
vi.mock("../../../src/features/backupPasskey/backupRotationStore", () => ({
  useBackupRotation: () => null,
}))
vi.mock("../../../src/features/requests/useNonContactRequests", () => ({
  useNonContactRequests: () => ({ requests: [], allowed: true, setAllowed: vi.fn() }),
}))
vi.mock("../../../src/ui/FeedbackModals", () => ({
  BugReportModal: () => null,
  FeedbackModal: () => null,
}))
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: { status: "loading", scope: "s" }, refresh: vi.fn() }),
}))
vi.mock("../../../src/features/limits/AboutLimitsSheet", () => ({
  WalletAboutLimitsSheet: ({ topic }: { topic?: string }) => (
    <div data-testid="about-limits-sheet" data-topic={topic ?? "all"} />
  ),
}))
vi.mock("../../../src/ui/ContractAddressesModal", () => ({
  ContractAddressesModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="contract-addresses">
      <button onClick={onClose}>close</button>
    </div>
  ),
}))
vi.mock("../../../src/ui/PasskeysModal", () => ({
  PasskeysModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="passkeys">
      <button onClick={onClose}>close</button>
    </div>
  ),
}))
vi.mock("../../../src/ui/EndpointsModal", async (original) => ({
  ...(await original<typeof import("../../../src/ui/EndpointsModal")>()),
  EndpointsModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="endpoints">
      <button onClick={onClose}>close</button>
    </div>
  ),
}))

vi.mock("../../../src/ui/ResetScreen", () => ({ RESET_PATH: "/reset" }))
vi.mock("../../../src/features/deposit/StrandedRecoveryModal", () => ({
  StrandedRecoveryModal: () => null,
}))

const { SettingsScreen } = await import("../../../src/ui/screens/SettingsScreen")

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  state.endpoints = { node: DEFAULT, l1Rpc: DEFAULT, enclave: DEFAULT }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const mount = () =>
  act(async () =>
    root.render(
      <MemoryRouter>
        <SettingsScreen />
      </MemoryRouter>,
    ),
  )
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)
const row = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (el) => el.querySelector("span")?.textContent === label,
  )

describe("SettingsScreen Advanced section", () => {
  it("opens and closes the contract addresses sheet", async () => {
    await mount()
    expect(container.textContent).toContain("Advanced")
    expect(container.querySelector('[data-testid="contract-addresses"]')).toBeNull()
    await act(async () => button("Contract addresses")!.click())
    expect(container.querySelector('[data-testid="contract-addresses"]')).not.toBeNull()
    await act(async () => button("close")!.click())
    expect(container.querySelector('[data-testid="contract-addresses"]')).toBeNull()
  })

  it("opens and closes the passkeys sheet from General", async () => {
    await mount()
    expect(container.querySelector('[data-testid="passkeys"]')).toBeNull()
    await act(async () => row("Passkeys")!.click())
    expect(container.querySelector('[data-testid="passkeys"]')).not.toBeNull()
    await act(async () => button("close")!.click())
    expect(container.querySelector('[data-testid="passkeys"]')).toBeNull()
  })

  it("sends Clear local data to the reset page", async () => {
    await mount()
    const original = window.location
    const replace = vi.fn()
    Object.defineProperty(window, "location", { value: { replace }, writable: true })
    try {
      await act(async () => button("Clear local data")!.click())
      expect(replace).toHaveBeenCalledWith("/reset")
    } finally {
      Object.defineProperty(window, "location", { value: original, writable: true })
    }
  })

  it("lists the Endpoints row as Default when every endpoint is the default", async () => {
    await mount()
    expect(row("Endpoints")?.textContent).toBe("EndpointsDefault")
  })

  it("names the custom endpoints on the Endpoints row", async () => {
    state.endpoints = { node: CUSTOM, l1Rpc: DEFAULT, enclave: CUSTOM }
    await mount()
    expect(row("Endpoints")?.textContent).toBe("EndpointsCustom node, enclave")
  })

  it("opens and closes the endpoints sheet", async () => {
    await mount()
    expect(container.querySelector('[data-testid="endpoints"]')).toBeNull()
    await act(async () => row("Endpoints")!.click())
    expect(container.querySelector('[data-testid="endpoints"]')).not.toBeNull()
    await act(async () => button("close")!.click())
    expect(container.querySelector('[data-testid="endpoints"]')).toBeNull()
  })
})
