/**
 * The tag card itself, rendered for real: in the start role its Enter and Login share one gate, a
 * blur cannot disable the button under the click, edits are handed up normalised, and the rows and
 * the chooser wait for preparation; in the confirm role nothing changed.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignInStart } from "../../../../src/features/onboarding/steps/ConfirmTagModal"

vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    testId,
    isDisabled,
    isLoading,
    onClick,
  }: {
    title: string
    testId?: string
    isDisabled?: boolean
    isLoading?: boolean
    onClick?: () => void
  }) => (
    <button
      type="button"
      data-testid={testId ?? "primary"}
      disabled={isDisabled || isLoading}
      onClick={onClick}
    >
      {title}
    </button>
  ),
  Icon: () => <i />,
  IconCircle: () => <i />,
}))
vi.mock("../../../../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ onClose, children }: { onClose?: () => void; children?: React.ReactNode }) => (
    <div>
      {onClose && <button type="button" data-testid="card-close" onClick={onClose} />}
      {children}
    </div>
  ),
}))

const { ConfirmTagModal } = await import("../../../../src/features/onboarding/steps/ConfirmTagModal")

let container: HTMLDivElement
let root: Root
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Your tag"]')!
const type = async (value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const submit = async () => {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  )
}
const click = (id: string) => act(async () => byTestId(id)!.click())

const onConfirm = vi.fn()
const onShowPasskeys = vi.fn()
const onBack = vi.fn()
const onClose = vi.fn()
const onCandidate = vi.fn()
const onTagChange = vi.fn()
const onTagBlur = vi.fn()
const onDifferentPasskey = vi.fn()
const onPrepareAgain = vi.fn()
const onRowKey = vi.fn()
const onRowKeysAgain = vi.fn()
const onTagKey = vi.fn()

const ROW = {
  credentialId: "cred-alice",
  pubkeyHex: "ab".repeat(64),
  l2Address: `0x${"ac".repeat(32)}`,
  usertag: "alice",
  backup: false,
}

const start = (over: Partial<SignInStart> = {}): SignInStart => ({
  candidates: [],
  onCandidate,
  keyed: new Set(),
  onRowKey,
  onRowKeysAgain,
  onTagKey,
  value: "",
  onTagChange,
  onTagBlur,
  onDifferentPasskey,
  submitReady: false,
  resolving: false,
  prepared: "ready",
  onPrepareAgain,
  chooserFirst: false,
  busy: false,
  ...over,
})

const renderStart = (over: Partial<SignInStart> = {}) =>
  act(async () =>
    root.render(
      <ConfirmTagModal
        start={start(over)}
        onConfirm={onConfirm}
        onShowPasskeys={onShowPasskeys}
        onClose={onClose}
      />,
    ),
  )

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("the start role", () => {

  it("Enter submits nothing until the tag resolved; then Enter and Login each fire once", async () => {
    await renderStart({ value: "alice", submitReady: false })
    await submit()
    expect(onConfirm).not.toHaveBeenCalled()
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(true)

    await renderStart({ value: "alice", submitReady: true })
    await submit()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await click("sign-in-login")
    expect(onConfirm).toHaveBeenCalledTimes(2)
    expect(onConfirm).toHaveBeenLastCalledWith("alice")
  })

  it("the Login click lands after the field blurs: the blur is handed up, the button stays enabled", async () => {
    await renderStart({ value: "alice", submitReady: true })
    await act(async () => input().focus())
    await act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    expect(onTagBlur).toHaveBeenCalledTimes(1)
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(false)
    await click("sign-in-login")
    expect(onConfirm).toHaveBeenCalledWith("alice")
  })

  it("edits are handed up normalised — a leading @ dropped, lower-cased — and the field is controlled", async () => {
    await renderStart({ value: "ali" })
    await type("@Alice")
    expect(onTagChange).toHaveBeenLastCalledWith("alice")
    // The parent owns the value; until it re-renders, the field shows what it was given.
    expect(input().value).toBe("ali")
  })

  it("a row calls back with its account; rows, Login and Show passkeys wait for preparation and hold while busy", async () => {
    await renderStart({ candidates: [ROW], prepared: "pending", submitReady: true, value: "alice" })
    expect((byTestId("sign-in-account") as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId("sign-in-show-passkeys") as HTMLButtonElement).disabled).toBe(true)

    await renderStart({ candidates: [ROW], submitReady: true, value: "alice" })
    expect(byTestId("sign-in-account")?.getAttribute("aria-label")).toBe("Sign in as @alice")
    expect(byTestId("sign-in-account-backup")).toBeNull()
    await click("sign-in-account")
    expect(onCandidate).toHaveBeenCalledWith(ROW)

    // A backup passkey's row says so, in its label and under the tag.
    await renderStart({ candidates: [{ ...ROW, backup: true }], submitReady: true, value: "alice" })
    expect(byTestId("sign-in-account")?.getAttribute("aria-label")).toBe(
      "Sign in as @alice with the backup passkey",
    )
    expect(byTestId("sign-in-account-backup")?.textContent).toBe("Backup passkey")

    await renderStart({ candidates: [ROW], submitReady: true, value: "alice", busy: true })
    expect((byTestId("sign-in-account") as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(true)
  })

  const cards = (testId: string) => [
    ...container.querySelectorAll<HTMLButtonElement>(`[data-testid="${testId}"] button`),
  ]

  it("a resolved tag with more than one key shows its keys as cards in place of Login; Enter signs in with neither", async () => {
    const tagKeys = [
      { credentialId: "root", label: "Sign-up passkey" },
      { credentialId: "spare", label: "Backup passkey", provider: "YubiKey 5 NFC" },
    ]
    await renderStart({ value: "alice", submitReady: true, tagKeys })
    expect(byTestId("sign-in-login")).toBeNull()
    expect(container.textContent).toContain("Log in with")
    expect(container.textContent).toContain("Either passkey opens the same wallet.")
    const keys = cards("sign-in-tag-keys")
    expect(keys.map((k) => k.getAttribute("aria-label"))).toEqual([
      "Log in with the sign-up passkey",
      "Log in with the backup passkey, YubiKey 5 NFC",
    ])
    // A known provider names the card; the role is its second line.
    expect(keys[1]!.textContent).toBe("YubiKey 5 NFCBackup passkey")
    expect(keys[0]!.textContent).toBe("Sign-up passkey")
    // Show passkeys stays.
    expect(byTestId("sign-in-show-passkeys")).not.toBeNull()
    await submit()
    expect(onConfirm).not.toHaveBeenCalled()
    await act(async () => keys[1]!.click())
    expect(onTagKey).toHaveBeenCalledWith("spare")

    // Until the tag resolves, Login holds its place.
    await renderStart({ value: "alice", submitReady: false, tagKeys })
    expect(byTestId("sign-in-tag-keys")).toBeNull()
    expect(byTestId("sign-in-login")).not.toBeNull()

    // Cards wait for preparation and hold while busy, like the rows.
    await renderStart({ value: "alice", submitReady: true, tagKeys, busy: true })
    expect(cards("sign-in-tag-keys").every((k) => k.disabled)).toBe(true)

    // Three or more keys: the hint says any of them.
    await renderStart({
      value: "alice",
      submitReady: true,
      tagKeys: [...tagKeys, { credentialId: "spare-2", label: "Backup passkey 2" }],
    })
    expect(container.textContent).toContain("Any of them opens the same wallet.")
  })

  it("a row whose wallet has more than one key is selected, and its keys take Login's place", async () => {
    const keyed = new Set([ROW.credentialId])
    await renderStart({ candidates: [ROW], keyed })
    expect(byTestId("sign-in-account")?.getAttribute("aria-pressed")).toBe("false")
    await click("sign-in-account")
    expect(onCandidate).toHaveBeenCalledWith(ROW)

    const choices = [
      { credentialId: "cred-alice", label: "Sign-up passkey", provider: "iCloud Keychain" },
      { credentialId: "spare", label: "Backup passkey", lastUsed: true as const },
    ]
    await renderStart({
      candidates: [ROW],
      keyed,
      rowKeys: { credentialId: ROW.credentialId, choices },
    })
    expect(byTestId("sign-in-account")?.getAttribute("aria-pressed")).toBe("true")
    expect(byTestId("sign-in-account")?.className).toContain("ww-account-row--selected")
    // The cards sit in Login's place, under the field, not inside the account list.
    expect(byTestId("sign-in-login")).toBeNull()
    expect(
      byTestId("sign-in-accounts")?.querySelector('[data-testid="sign-in-account-keys"]'),
    ).toBeNull()
    expect(container.textContent).toContain("Log in as @alice with")
    const keys = cards("sign-in-account-keys")
    expect(keys.map((k) => k.getAttribute("aria-label"))).toEqual([
      "Log in with the sign-up passkey, iCloud Keychain",
      "Log in with the backup passkey, last used on this browser",
    ])
    await act(async () => keys[1]!.click())
    expect(onRowKey).toHaveBeenCalledWith("spare")
    // Enter signs in with neither.
    await submit()
    expect(onConfirm).not.toHaveBeenCalled()

    // The read naming a key this browser has no record of, in the same place.
    await renderStart({
      candidates: [ROW],
      keyed,
      rowKeys: { credentialId: ROW.credentialId, choices: [], reading: true },
    })
    expect(byTestId("sign-in-account-keys-reading")?.getAttribute("role")).toBe("status")
    expect(byTestId("sign-in-login")).toBeNull()
    await renderStart({
      candidates: [ROW],
      keyed,
      rowKeys: { credentialId: ROW.credentialId, choices: [], failed: true },
    })
    expect(byTestId("sign-in-account-keys-failed")).not.toBeNull()
    await click("sign-in-account-keys-again")
    expect(onRowKeysAgain).toHaveBeenCalledTimes(1)

    // A row that shows its keys is the account, not one passkey: no backup note.
    await renderStart({ candidates: [{ ...ROW, backup: true }], keyed })
    expect(byTestId("sign-in-account-backup")).toBeNull()
    expect(byTestId("sign-in-account")?.getAttribute("aria-label")).toBe("Sign in as @alice")

    // A one-key row has no selected state to announce.
    await renderStart({ candidates: [ROW] })
    expect(byTestId("sign-in-account")?.hasAttribute("aria-pressed")).toBe(false)
  })

  it("a notice renders inline under its own test id; a failed preparation offers only a re-prepare", async () => {
    await renderStart({ value: "alice", notice: { kind: "noKeyInstalled", tag: "alice" } })
    expect(byTestId("by-tag-noKeyInstalled")?.textContent).toContain("no passkey key installed")
    expect(byTestId("by-tag-noKeyInstalled")?.textContent).toContain("Show passkeys")

    await renderStart({ value: "alice", notice: { kind: "unreadable", tag: "alice" } })
    expect(byTestId("by-tag-unreadable")?.textContent).toContain("couldn't be read")

    // A listed tag's way in with another passkey: the link reads the tag like any other.
    await renderStart({ value: "alice", notice: { kind: "listed", tag: "alice" } })
    expect(byTestId("by-tag-listed")?.textContent).toContain("already on this browser")
    await click("by-tag-different-passkey")
    expect(onDifferentPasskey).toHaveBeenCalledTimes(1)
    await renderStart({ value: "alice", notice: { kind: "listed", tag: "alice" }, busy: true })
    expect((byTestId("by-tag-different-passkey") as HTMLButtonElement).disabled).toBe(true)

    await renderStart({ value: "alice", notice: { kind: "inconclusive", tag: "alice" } })
    expect(byTestId("by-tag-inconclusive")?.textContent).toContain(
      "more passkeys than this version can read",
    )
    expect(byTestId("by-tag-different-passkey")).toBeNull()

    // A read the network refused is the one notice with a retry: it asks the way leaving the field does.
    await renderStart({ value: "alice", notice: { kind: "lookupFailed", tag: "alice" } })
    expect(byTestId("by-tag-lookupFailed")?.textContent).toContain("Show passkeys")
    await click("by-tag-retry")
    expect(onTagBlur).toHaveBeenCalledTimes(1)

    await renderStart({ prepared: "failed" })
    expect(byTestId("sign-in-unprepared")?.textContent).toContain("Couldn't reach the network")
    await click("sign-in-prepare-again")
    expect(onPrepareAgain).toHaveBeenCalledTimes(1)
    expect(onShowPasskeys).not.toHaveBeenCalled()
  })

  it("with the chooser first, Show passkeys is the primary button and Login a secondary one", async () => {
    await renderStart({ chooserFirst: true, value: "alice", submitReady: true })
    expect(byTestId("sign-in-show-passkeys")?.tagName).toBe("BUTTON")
    expect(container.querySelector(".ww-invite-modal-foot")).toBeNull()
    await click("sign-in-show-passkeys")
    expect(onShowPasskeys).toHaveBeenCalledTimes(1)
    await click("sign-in-login")
    expect(onConfirm).toHaveBeenCalledWith("alice")
  })

  it("an invalid tag shows the rule it broke", async () => {
    await renderStart({ value: "a b" })
    expect(container.textContent).toContain("Letters, numbers and hyphens only")
  })

  it.each([false])(
    "Endpoints opens the editor without submitting the card (chooser first: %s)",
    async (chooserFirst) => {
      const onEndpoints = vi.fn()
      await renderStart({ onEndpoints, chooserFirst, value: "alice", submitReady: true })
      expect(byTestId("sign-in-endpoints")?.getAttribute("type")).toBe("button")
      expect(container.textContent).toContain("Using your own node?")
      await click("sign-in-endpoints")
      expect(onEndpoints).toHaveBeenCalledTimes(1)
      expect(onConfirm).not.toHaveBeenCalled()
    },
  )

  it("Endpoints waits out a running sign-in, and is absent without a way to edit", async () => {
    await renderStart({ onEndpoints: vi.fn(), busy: true })
    expect((byTestId("sign-in-endpoints") as HTMLButtonElement).disabled).toBe(true)
    await renderStart()
    expect(byTestId("sign-in-endpoints")).toBeNull()
  })
})

describe("the confirm role", () => {
  const renderConfirm = (initialHandle?: string) =>
    act(async () =>
      root.render(
        <ConfirmTagModal
          initialHandle={initialHandle}
          onConfirm={onConfirm}
          onBack={onBack}
          onClose={onClose}
        />,
      ),
    )

  it("keeps its title, its own test ids, and submits any well-formed tag", async () => {
    await renderConfirm("Alice")
    expect(byTestId("confirm-tag")).not.toBeNull()
    expect(byTestId("sign-in-start")).toBeNull()
    expect(container.textContent).toContain("Confirm by typing")
    expect(input().value).toBe("alice")
    await click("primary")
    expect(onConfirm).toHaveBeenCalledWith("alice")
    await submit()
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it("an invalid tag disables Login; Go back and the close call their handlers, and no open request is offered", async () => {
    await renderConfirm()
    await type("a b")
    expect((byTestId("primary") as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId("sign-in-show-passkeys")).toBeNull()
    expect(byTestId("sign-in-endpoints")).toBeNull()
    expect(container.textContent).toContain("Not your account?")
    await click("confirm-back")
    expect(onBack).toHaveBeenCalledTimes(1)
    await click("card-close")
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
