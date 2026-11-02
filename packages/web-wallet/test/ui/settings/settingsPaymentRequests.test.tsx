import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "false"))

vi.mock("@obsidion/web-ds", () => ({
  ComingSoonPill: ({ label }: { label: string }) => <span>{label}</span>,
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  GradientToggle: ({ isOn, onChange }: { isOn: boolean; onChange: (on: boolean) => void }) => (
    <button role="switch" aria-checked={isOn} onClick={() => onChange(!isOn)} />
  ),
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  SettingsRow: ({
    label,
    description,
    trailing,
  }: {
    label: string
    description?: React.ReactNode
    trailing?: React.ReactNode
  }) => (
    <div data-row={label}>
      {description}
      {trailing}
    </div>
  ),
}))
// The real module underneath: this screen's import chain reads storage keys from it at import.
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useConfigValue: () => ({ value: false, setValue: vi.fn() }),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
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
vi.mock("../../../src/ui/FeedbackModals", () => ({
  BugReportModal: () => null,
  FeedbackModal: () => null,
}))
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: { status: "loading", scope: "s" }, refresh: vi.fn() }),
}))
vi.mock("../../../src/features/limits/AboutLimitsSheet", () => ({
  WalletAboutLimitsSheet: () => null,
}))
vi.mock("../../../src/ui/ContractAddressesModal", () => ({ ContractAddressesModal: () => null }))
vi.mock("../../../src/dev/ConfigProfileModal", () => ({ ConfigProfileModal: () => null }))
vi.mock("../../../src/ui/EndpointsModal", () => ({
  EndpointsModal: () => null,
  customEndpointsLabel: () => undefined,
}))
vi.mock("../../../src/ui/ResetScreen", () => ({ RESET_PATH: "/reset" }))
vi.mock("../../../src/features/deposit/StrandedRecoveryModal", () => ({
  StrandedRecoveryModal: () => null,
}))
const inbox = vi.hoisted(() => ({
  requests: [] as { id: string }[],
  allowed: true,
  setAllowed: vi.fn(async (_on: boolean) => {}),
}))
vi.mock("../../../src/features/requests/useNonContactRequests", () => ({
  useNonContactRequests: () => inbox,
}))

import { sent, signedRecord } from "../../support/backupAdd"
const { SettingsScreen } = await import("../../../src/ui/screens/SettingsScreen")
const { getBackupRotationStore, resetBackupRotationStoreForTests } = await import(
  "../../../src/features/backupPasskey/backupRotationStore"
)

const ROW = "Allow requests from people not in your contacts"

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  inbox.requests = [{ id: "a" }, { id: "b" }, { id: "c" }]
  inbox.allowed = true
  inbox.setAllowed.mockClear()
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
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
const row = () => container.querySelector(`[data-row="${ROW}"]`)!

describe("SettingsScreen Payment requests row", () => {
  it("links the pending count to the inbox", async () => {
    await mount()
    const pending = [...row().querySelectorAll("button")].find(
      (b) => b.textContent === "3 pending",
    )!
    await act(async () => pending.click())
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe(
      "/requests/non-contacts",
    )
  })

  it("turns requests from non-contacts off", async () => {
    await mount()
    const toggle = row().querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await act(async () => toggle.click())
    expect(inbox.setAllowed).toHaveBeenCalledWith(false)
  })
})

describe("SettingsScreen Passkeys row with the backup flag off", () => {
  const passkeys = () => container.querySelector('[data-row="Passkeys"]')!

  beforeEach(() => resetBackupRotationStoreForTests())

  it("marks a saved rotation Pending", async () => {
    await getBackupRotationStore().put(signedRecord({ phase: "funded", ...sent(1) }))
    await mount()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(passkeys().textContent).toBe("Pending")
  })
})
