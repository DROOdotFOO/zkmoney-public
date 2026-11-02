import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, expect, it, vi } from "vitest"
import { clearProfileDraft, profileDraft } from "../../src/dev/configDraft"
import { sandboxProfile } from "../fixtures/sandboxProfile"

const PROFILE_URL = "https://preview.example/sandbox.json"
const BAD_URL = "https://preview.example/other.json"
const IMPORT_URL = "https://preview.example/import.json"

vi.stubEnv("VITE_CONFIG_PROFILE_URL", PROFILE_URL)
vi.stubEnv("VITE_CONFIG_EXPECTED_PROFILE_ID", "sandbox")
vi.stubEnv("VITE_NETWORK", "sandbox")

vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick: () => void
    isDisabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={isDisabled}>
      {title}
    </button>
  ),
}))
vi.mock("../../src/ui/Modal", () => ({
  PageModal: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
  PageModalPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../src/features/operations/operations", () => ({
  useLeavingLosesTransaction: () => false,
}))
vi.mock("../../src/platform/storage/walletStorage", () => ({ reloadPage: vi.fn(async () => {}) }))

const { ConfigProfileModal } = await import("../../src/dev/ConfigProfileModal")
const { reloadPage } = await import("../../src/platform/storage/walletStorage")

let root: Root
let container: HTMLDivElement

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label)!

function enterUrl(value: string) {
  const input = container.querySelector<HTMLInputElement>("#ww-config-profile-url")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function click(label: string) {
  await act(async () => button(label).click())
}

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  clearProfileDraft()
  vi.unstubAllGlobals()
  vi.mocked(reloadPage).mockClear()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

afterAll(() => vi.unstubAllEnvs())

it("imports only a valid profile, then saves it as a tab draft even when the live URL fails", async () => {
  clearProfileDraft()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const wrongProfile = sandboxProfile()
  wrongProfile.profileId = "other"
  const imported = sandboxProfile()
  imported.versions["0.0.1"].nodeUrl = "http://imported-node.test"
  const fetchProfile = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === PROFILE_URL) return { ok: false, status: 503 }
    return { ok: true, status: 200, json: async () => (url === BAD_URL ? wrongProfile : imported) }
  })
  vi.stubGlobal("fetch", fetchProfile)

  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<ConfigProfileModal onClose={() => {}} />))

  await click("Edit JSON")
  const editor = container.querySelector<HTMLTextAreaElement>("#ww-config-profile-json")!
  enterUrl(BAD_URL)
  await click("Load JSON")
  expect(editor.value).toBe("")
  expect(container.querySelector("#ww-config-profile-issues")?.textContent).toContain(
    "1 error loading the JSON",
  )

  enterUrl(IMPORT_URL)
  await click("Load JSON")
  expect(editor.value).toContain("http://imported-node.test")
  expect(container.querySelector("#ww-config-profile-issues")).toBeNull()
  expect(profileDraft(PROFILE_URL)).toBeUndefined()

  await click("Save & reload")
  expect(profileDraft(PROFILE_URL)).toBe(editor.value)
  expect(reloadPage).toHaveBeenCalledTimes(1)
})
