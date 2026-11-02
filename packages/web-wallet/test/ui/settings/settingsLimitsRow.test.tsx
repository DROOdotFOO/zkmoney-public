import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
    <div data-row={label}>
      <button onClick={onClick}>{label}</button>
      {trailing}
    </div>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))
vi.mock("@obsidion/front-core", () => ({
  useConfigValue: () => ({ value: false, setValue: vi.fn() }),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
const name = vi.hoisted(() => ({ owed: false }))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "brave-otter-42" }),
}))
vi.mock("../../../src/features/onboarding/openRegistration", () => ({
  useNameClaimPending: () => false,
  useRegistrationTagChangeable: () => name.owed,
}))
vi.mock("../../../src/features/onboarding/ChooseNameSheet", () => ({
  ChooseNameSheet: ({ tag }: { tag: string }) => <div data-testid="choose-name">{tag}</div>,
}))
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
const allowance = vi.hoisted(() => ({
  snapshot: { status: "loading", scope: "s" } as unknown,
  refresh: vi.fn(),
}))
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: allowance.snapshot, refresh: allowance.refresh }),
}))
vi.mock("../../../src/ui/ContractAddressesModal", () => ({ ContractAddressesModal: () => null }))
vi.mock("../../../src/ui/PasskeysModal", () => ({ PasskeysModal: () => null }))
vi.mock("../../../src/dev/ConfigProfileModal", () => ({ ConfigProfileModal: () => null }))
vi.mock("../../../src/ui/EndpointsModal", () => ({
  EndpointsModal: () => null,
  customEndpointsLabel: () => undefined,
}))
vi.mock("../../../src/ui/ResetScreen", () => ({ RESET_PATH: "/reset" }))
vi.mock("../../../src/features/deposit/StrandedRecoveryModal", () => ({
  StrandedRecoveryModal: () => null,
}))
// The wallet container reads the chain; the row only needs a real sheet to open and close.
vi.mock("../../../src/features/limits/AboutLimitsSheet", async () => {
  const { Modal } = await import("../../../src/ui/Modal")
  const { SHEET_TITLE } = await import("../../../src/features/limits/limitsCopy")
  return {
    WalletAboutLimitsSheet: ({
      onClose,
      topic,
      capacity,
    }: {
      onClose: () => void
      topic?: string
      capacity?: false
    }) => (
      <Modal title={SHEET_TITLE} onClose={onClose}>
        <div
          data-testid="about-limits-sheet"
          data-topic={topic ?? "all"}
          data-capacity={String(capacity ?? "shown")}
        />
      </Modal>
    ),
  }
})

const { SettingsScreen } = await import("../../../src/ui/screens/SettingsScreen")
const { SHEET_TITLE } = await import("../../../src/features/limits/limitsCopy")

let root: Root
let container: HTMLDivElement

const ready = (state: unknown) => ({
  status: "ready",
  scope: "s",
  read: { allowance: { refillPeriod: 86_400 } },
  state,
  refreshing: false,
})

beforeEach(async () => {
  allowance.refresh.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <SettingsScreen />
      </MemoryRouter>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const row = () =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === "Limits")!
const dialog = () =>
  document.querySelector<HTMLDialogElement>(`dialog[aria-label="${SHEET_TITLE}"]`)

describe("SettingsScreen Limits row", () => {
  it("opens the About limits sheet and returns focus to the row on Escape", async () => {
    row().focus()
    await act(async () => row().click())
    expect(dialog()?.open).toBe(true)
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(row())
  })
})

describe("SettingsScreen Sponsored transactions row", () => {
  const sponsored = () =>
    [...container.querySelectorAll("button")].find(
      (el) => el.textContent === "Sponsored transactions",
    )!
  const value = () => container.querySelector('[data-row="Sponsored transactions"]')!.textContent
  const rerender = (snapshot: unknown) => {
    allowance.snapshot = snapshot
    return act(async () =>
      root.render(
        <MemoryRouter>
          <SettingsScreen />
        </MemoryRouter>,
      ),
    )
  }

  it("reads the allowance again on each visit", () => {
    expect(allowance.refresh).toHaveBeenCalledTimes(1)
  })

  it("shows the remaining count, and keeps a proven none apart from unknown", async () => {
    await rerender(ready({ kind: "available", available: 42, renews: true }))
    expect(value()).toContain("42 left")
    // Only a rail that never renews proves none are left.
    await rerender(ready({ kind: "does-not-renew" }))
    expect(value()).toContain("0 left")
    // A stored zero that may renew is not stated as used up, and names no time; the sheet explains.
    await rerender(ready({ kind: "renewal-unknown", maxTx: 100 }))
    expect(value()).toContain("Unknown")
    expect(value()).not.toContain("0 left")
    await rerender(ready({ kind: "not-subscribed", maxTx: 100, renews: true }))
    expect(value()).toContain("Not started")
    await rerender({ status: "unavailable", scope: "s", error: new Error("pxe") })
    expect(value()).toContain("Unavailable")
    await rerender({ status: "loading", scope: "s" })
    expect(value()).toContain("Checking…")
  })

  it("opens the shared sheet on sponsorship, while Limits opens every section", async () => {
    sponsored().focus()
    await act(async () => sponsored().click())
    const sheet = document.querySelector<HTMLElement>('[data-testid="about-limits-sheet"]')!
    expect(sheet.dataset.topic).toBe("sponsorship")
    // Settings has no deposit in view, so neither entry shows capacity.
    expect(sheet.dataset.capacity).toBe("false")
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(document.activeElement).toBe(sponsored())
    await act(async () => row().click())
    const limits = document.querySelector<HTMLElement>('[data-testid="about-limits-sheet"]')!
    expect(limits.dataset.topic).toBe("all")
    expect(limits.dataset.capacity).toBe("false")
  })
})

describe("SettingsScreen Tag row", () => {
  const change = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Change")
  const render = () =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <SettingsScreen />
        </MemoryRouter>,
      ),
    )
  afterEach(() => {
    name.owed = false
  })

  it("offers Change while the registration is owed its deposit, and it opens the name sheet", async () => {
    name.owed = true
    await render()
    await act(async () => change()!.click())
    expect(container.querySelector('[data-testid="choose-name"]')?.textContent).toBe(
      "brave-otter-42",
    )
  })

  it("keeps the tag locked once the first deposit has landed", () => {
    expect(container.querySelector('[data-row="Tag"]')?.textContent).toBe("Tag@brave-otter-42")
    expect(change()).toBeUndefined()
  })
})
