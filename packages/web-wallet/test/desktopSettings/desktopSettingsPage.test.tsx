/**
 * The desktop launcher's settings page, built from the wallet's code: the shared endpoint editor
 * over this browser's record, the configuration setting posted to the launcher, one save.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import type { DesktopSettingsState } from "../../src/desktopSettings/state"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
    isLoading,
  }: {
    title: string
    onClick: () => void
    isDisabled?: boolean
    isLoading?: boolean
  }) => (
    <button disabled={isDisabled || isLoading} onClick={onClick}>
      {title}
    </button>
  ),
}))

const { DesktopSettingsScreen } = await import("../../src/desktopSettings/DesktopSettingsScreen")

const RECORD = "webwallet.endpoints"
const SHAPED = "https://cdn.example/profiles/v5/current.json"
const BAKED = { current: "0.5.1", publishedAt: "2026-08-01T00:00:00.000Z" }

type Reply = { status: number; body?: object } | "no-answer"
let replies: Record<string, Reply[]>
let calls: { path: string; body: Record<string, unknown> }[]
let root: Root
let container: HTMLDivElement

function state(overrides: Partial<DesktopSettingsState> = {}): DesktopSettingsState {
  return {
    token: "tok",
    values: {},
    sources: {},
    problems: [],
    builtAt: "2026-09-01T00:00:00.000Z",
    profile: { url: SHAPED, overridden: false, baked: BAKED },
    profileProbe: { state: "ok", overridden: false },
    ...overrides,
  }
}

async function mount(s: DesktopSettingsState | null = state(), network = Network.TESTNET) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<DesktopSettingsScreen state={s} network={network} />))
}

const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!
const profileUrl = () => input("config-profile-url")
const shippedSwitch = () =>
  container.querySelector<HTMLInputElement>('.ww-dsettings__switch input[type="checkbox"]')!
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)
const saveButton = () => button("Save & relaunch wallet")!
const status = () => container.querySelector('[data-testid="dsettings-status"]')?.textContent
const text = () => container.textContent ?? ""
const stored = () => JSON.parse(localStorage.getItem(RECORD) ?? "null")

function fill(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function toggle(el: HTMLInputElement) {
  act(() => el.click())
}
const save = () => act(async () => saveButton().click())

beforeEach(() => {
  localStorage.clear()
  calls = []
  replies = {}
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) })
      const reply = replies[path]?.shift() ?? {
        status: 200,
        body: { ok: true, status: "accepted" },
      }
      if (reply === "no-answer") throw new TypeError("Failed to fetch")
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status })
    }),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the page", () => {
  it("shows the endpoint fields empty with the fixed placeholders, and the build table", async () => {
    await mount()
    expect(input("endpoint-node").value).toBe("")
    expect(input("endpoint-node").placeholder).toBe(
      "Leave blank to use the address built into the app",
    )
    expect(text()).toContain("Bundle built")
    expect(text()).toContain("version 0.5.1, published Aug 1, 2026")
    expect(text()).toContain(SHAPED)
    expect(profileUrl().placeholder).toBe(`${SHAPED} (default)`)
  })

  it("carries the fund-loss warning on the URL field", async () => {
    await mount()
    expect(
      container.querySelector('[data-testid="dsettings-fund-warning"]')?.textContent,
    ).toContain("Only use a URL you are sure of.")
  })

  it("says to open it from the menu, and offers no save, without the launcher's state", async () => {
    await mount(null)
    expect(container.querySelector('[data-testid="dsettings-missing"]')?.textContent).toContain(
      "Open this page from the zk.money Desktop menu",
    )
    expect(button("Save & relaunch wallet")).toBeUndefined()
  })

  it("names an environment-set value", async () => {
    await mount(
      state({ values: { configProfileUrl: SHAPED }, sources: { configProfileUrl: "env" } }),
    )
    expect(text()).toContain("OBSIDION_CONFIG_PROFILE_URL")
    expect(text()).toContain("environment variable is set and overrides")
  })

  it("names an environment-set shipped-configuration switch", async () => {
    await mount(
      state({ values: { bootFromBakedProfile: true }, sources: { bootFromBakedProfile: "env" } }),
    )
    expect(text()).toContain("OBSIDION_BOOT_FROM_BAKED_PROFILE")
    expect(text()).toContain("environment variable is set and overrides")
  })

  it("keeps the banners on the saved switch while the box is ticked but not saved", async () => {
    await mount(state({ profileProbe: { state: "rejected", detail: "gone" } }))
    expect(text()).toContain("turn on Shipped configuration below and relaunch")
    toggle(shippedSwitch())
    expect(text()).toContain("turn on Shipped configuration below and relaunch")
    expect(text()).not.toContain("the wallet is running on the shipped copy")
  })

  it.each([
    [
      { key: null, source: "file", message: "bad json" },
      "The saved settings could not be read (bad json). Saving this page replaces them.",
    ],
    [
      { key: "configProfileUrl" as const, source: "env", message: "not a URL" },
      "The OBSIDION_CONFIG_PROFILE_URL environment variable holds an invalid value and was ignored: not a URL.",
    ],
    [
      { key: "configProfileUrl" as const, source: "file", message: "not a URL" },
      "A saved setting is invalid and was ignored: not a URL. Saving this page replaces it.",
    ],
  ])("banners a problem %j", async (problem, banner) => {
    await mount(state({ problems: [problem] }))
    expect(text()).toContain(banner)
  })

  it.each([
    [
      { state: "rejected" as const, detail: "gone" },
      { bootFromBakedProfile: true },
      "It is being ignored while Shipped configuration is on",
    ],
    [
      { state: "rejected" as const, detail: "gone", overridden: true },
      {},
      "The configuration URL you set did not provide a usable configuration when the app started (gone), so the wallet cannot start. Correct or clear the URL below and relaunch.",
    ],
    [
      { state: "rejected" as const, detail: "gone" },
      {},
      "First check for a newer release of zk.money Desktop",
    ],
    [
      { state: "unreachable" as const, detail: "timeout", bakedExpired: true },
      {},
      "the shipped copy has expired, so the wallet cannot start on its own",
    ],
    [
      { state: "ok" as const },
      { bootFromBakedProfile: true },
      "zk.money's configuration service answered normally when the app started",
    ],
  ])("banners the profile check %j", async (probe, values, banner) => {
    await mount(state({ profileProbe: probe, values }))
    expect(text()).toContain(banner)
  })

  it("banners an unreachable service when the build shipped no copy", async () => {
    await mount(
      state({
        profileProbe: { state: "unreachable", detail: "timeout" },
        profile: { url: SHAPED, overridden: false, baked: null },
      }),
    )
    expect(text()).toContain("this build carries no shipped configuration to fall back on")
    expect(shippedSwitch().disabled).toBe(true)
  })
})

describe("saving", () => {
  it("posts the configuration, writes the record, then asks for the relaunch, in that order", async () => {
    await mount()
    fill(input("endpoint-node"), "https://n.example")
    fill(profileUrl(), SHAPED)
    await save()
    expect(calls.map((c) => c.path)).toEqual([
      "/desktop-settings/save",
      "/desktop-settings/relaunch",
    ])
    expect(calls[0].body).toEqual({
      token: "tok",
      configProfileUrl: SHAPED,
      bootFromBakedProfile: false,
    })
    expect(calls[1].body).toEqual({ token: "tok" })
    expect(stored()).toEqual({ node: "https://n.example" })
    expect(status()).toContain("Relaunching…")
    expect(saveButton().disabled).toBe(true)
  })

  it("the configuration alone: no record write", async () => {
    await mount()
    const write = vi.spyOn(Storage.prototype, "setItem")
    toggle(shippedSwitch())
    await save()
    expect(calls.map((c) => c.path)).toEqual([
      "/desktop-settings/save",
      "/desktop-settings/relaunch",
    ])
    expect(calls[0].body.bootFromBakedProfile).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it("nothing changed: a plain relaunch", async () => {
    await mount()
    await save()
    expect(calls.map((c) => c.path)).toEqual(["/desktop-settings/relaunch"])
  })

  it("an invalid endpoint stops everything", async () => {
    await mount()
    fill(input("endpoint-enclave"), "https://e.example/rpc")
    expect(saveButton().disabled).toBe(true)
    await save()
    expect(calls).toEqual([])
    expect(stored()).toBeNull()
  })

  it("a URL of the wrong shape on a testnet build stops everything", async () => {
    await mount()
    fill(profileUrl(), "https://elsewhere.example/profile.json")
    expect(text()).toContain("Enter a profile address of the form")
    expect(saveButton().disabled).toBe(true)
    await save()
    expect(calls).toEqual([])
  })

  it("a flat URL is fine on a sandbox build", async () => {
    await mount(state(), Network.SANDBOX)
    fill(profileUrl(), "http://localhost:8083/profiles/sandbox.json")
    expect(saveButton().disabled).toBe(false)
  })

  it("with the switch on a wrong-shape URL is allowed, but not a non-http one", async () => {
    await mount()
    toggle(shippedSwitch())
    fill(profileUrl(), "https://elsewhere.example/profile.json")
    expect(saveButton().disabled).toBe(false)
    expect(text()).toContain("Ignored while Shipped configuration is on")
    fill(profileUrl(), "ftp://elsewhere.example/profile.json")
    expect(saveButton().disabled).toBe(true)
  })

  it("a configuration the launcher refuses: its error, nothing else saved; fixing it saves", async () => {
    replies["/desktop-settings/save"] = [
      { status: 400, body: { error: "configProfileUrl must be http(s)" } },
    ]
    await mount()
    fill(input("endpoint-node"), "https://n.example")
    fill(profileUrl(), SHAPED)
    await save()
    expect(status()).toBe("configProfileUrl must be http(s)")
    expect(stored()).toBeNull()
    expect(calls.map((c) => c.path)).toEqual(["/desktop-settings/save"])
    await save()
    expect(calls.map((c) => c.path)).toEqual([
      "/desktop-settings/save",
      "/desktop-settings/save",
      "/desktop-settings/relaunch",
    ])
    expect(stored()).toEqual({ node: "https://n.example" })
  })

  it("no answer to the configuration: says it may not be saved and to reopen", async () => {
    replies["/desktop-settings/save"] = ["no-answer"]
    await mount()
    fill(profileUrl(), SHAPED)
    await save()
    expect(status()).toBe(
      "The configuration may not have been saved and the endpoints were not. Reopen this page to check.",
    )
  })

  it("the endpoints changed in another window: configuration saved, endpoints not, no relaunch", async () => {
    await mount()
    fill(input("endpoint-node"), "https://n.example")
    fill(profileUrl(), SHAPED)
    localStorage.setItem(RECORD, JSON.stringify({ l1Rpc: "https://other.example" }))
    await save()
    expect(status()).toBe(
      "The configuration was saved, but the endpoints were not: another window changed them. Reopen this page to review them.",
    )
    expect(calls.map((c) => c.path)).toEqual(["/desktop-settings/save"])
  })

  it("an endpoint write it cannot confirm: says so and asks to reopen, and the reopened page saves", async () => {
    await mount()
    fill(input("endpoint-node"), "https://n.example")
    const realGet = Storage.prototype.getItem
    const realSet = Storage.prototype.setItem
    let written = false
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k, v) {
      realSet.call(this, k, v)
      written = true
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k) {
      if (written) throw new Error("read failed")
      return realGet.call(this, k)
    })
    await save()
    expect(status()).toBe(
      "The endpoints could not be confirmed saved. Reopen this page to check them.",
    )
    expect(calls).toEqual([])

    vi.restoreAllMocks()
    await act(async () => root.unmount())
    container.remove()
    await mount()
    expect(input("endpoint-node").value).toBe("https://n.example")
    fill(input("endpoint-l1Rpc"), "https://l1.example")
    await save()
    expect(stored()).toEqual({ node: "https://n.example", l1Rpc: "https://l1.example" })
    expect(status()).toContain("Relaunching…")
  })

  it.each([
    ["an error", { status: 500, body: { error: "close failed" } } as Reply],
    ["no answer", "no-answer" as Reply],
  ])(
    "a relaunch that fails with %s: everything saved, and the retry sends only the relaunch",
    async (_, reply) => {
      replies["/desktop-settings/relaunch"] = [reply]
      await mount()
      fill(input("endpoint-node"), "https://n.example")
      fill(profileUrl(), SHAPED)
      await save()
      expect(status()).toBe(
        "Your settings are saved, but the relaunch may not have started. Press the button again, or restart zk.money Desktop.",
      )
      expect(stored()).toEqual({ node: "https://n.example" })
      await save()
      expect(calls.map((c) => c.path)).toEqual([
        "/desktop-settings/save",
        "/desktop-settings/relaunch",
        "/desktop-settings/relaunch",
      ])
      expect(status()).toContain("Relaunching…")
    },
  )

  it("a relaunch already under way", async () => {
    replies["/desktop-settings/relaunch"] = [
      { status: 200, body: { ok: true, status: "already-relaunching" } },
    ]
    await mount()
    await save()
    expect(status()).toContain("The wallet is already relaunching")
  })

  it("repairs a settings file the launcher could not use, even with nothing changed", async () => {
    replies["/desktop-settings/relaunch"] = ["no-answer"]
    await mount(state({ problems: [{ key: null, source: "file", message: "bad json" }] }))
    await save()
    expect(calls.map((c) => c.path)).toEqual([
      "/desktop-settings/save",
      "/desktop-settings/relaunch",
    ])
    // Repaired once; the retry only relaunches.
    await save()
    expect(calls.map((c) => c.path).slice(2)).toEqual(["/desktop-settings/relaunch"])
  })

  it("an invalid saved URL is repaired the same way; an environment problem is not", async () => {
    await mount(
      state({ problems: [{ key: "configProfileUrl", source: "file", message: "not a URL" }] }),
    )
    await save()
    expect(calls[0].path).toBe("/desktop-settings/save")
    await act(async () => root.unmount())
    container.remove()
    calls = []
    await mount(
      state({ problems: [{ key: "configProfileUrl", source: "env", message: "not a URL" }] }),
    )
    await save()
    expect(calls.map((c) => c.path)).toEqual(["/desktop-settings/relaunch"])
  })

  it("Reset in a window that missed another window's save refuses instead of relaunching", async () => {
    await mount()
    localStorage.setItem(RECORD, JSON.stringify({ node: "https://other.example" }))
    await act(async () => button("Reset all to defaults")!.click())
    await save()
    expect(status()).toBe(
      "The configuration was saved, but the endpoints were not: another window changed them. Reopen this page to review them.",
    )
    expect(calls.map((c) => c.path)).toEqual(["/desktop-settings/save"])
    expect(stored()).toEqual({ node: "https://other.example" })
  })

  it("Reset saves the default configuration even where the fields already showed it", async () => {
    await mount()
    await act(async () => button("Reset all to defaults")!.click())
    await save()
    expect(calls.map((c) => c.path)).toEqual([
      "/desktop-settings/save",
      "/desktop-settings/relaunch",
    ])
    expect(calls[0].body).toEqual({
      token: "tok",
      configProfileUrl: "",
      bootFromBakedProfile: false,
    })
  })

  it("turning the switch off checks the saved URL it brings back into use", async () => {
    const mirror = "https://mirror.example/p.json"
    await mount(state({ values: { configProfileUrl: mirror, bootFromBakedProfile: true } }))
    expect(saveButton().disabled).toBe(false)
    toggle(shippedSwitch())
    expect(text()).toContain("Enter a profile address of the form")
    expect(saveButton().disabled).toBe(true)
    await save()
    expect(calls).toEqual([])
  })

  it("a URL without the slashes after its scheme stops everything, switch or not", async () => {
    await mount()
    fill(profileUrl(), "https:cdn.example/profiles/v5/current.json")
    expect(text()).toContain("Enter a full http(s) URL.")
    expect(saveButton().disabled).toBe(true)
    toggle(shippedSwitch())
    expect(saveButton().disabled).toBe(true)
  })

  it("an environment URL of the wrong shape does not block saving the endpoints", async () => {
    const env = "https://mirror.example/p.json"
    await mount(state({ values: { configProfileUrl: env }, sources: { configProfileUrl: "env" } }))
    fill(input("endpoint-node"), "https://n.example")
    expect(saveButton().disabled).toBe(false)
    await save()
    expect(calls.map((c) => c.path)).toEqual(["/desktop-settings/relaunch"])
    expect(stored()).toEqual({ node: "https://n.example" })
    // A URL the user types is still checked.
    fill(profileUrl(), "https://mirror.example/other.json")
    expect(text()).toContain("Enter a profile address of the form")
  })

  it("asks before leaving while a save is under way", async () => {
    let answer!: () => void
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        }),
    )
    await mount()
    fill(profileUrl(), SHAPED)
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(leave()).toBe(false)
    await act(async () => saveButton().click())
    expect(leave()).toBe(true)
    await act(async () => answer())
    expect(leave()).toBe(false)
  })

  it("Reset clears the fields only", async () => {
    localStorage.setItem(RECORD, JSON.stringify({ node: "https://n.example" }))
    await mount(state({ values: { configProfileUrl: SHAPED, bootFromBakedProfile: true } }))
    await act(async () => button("Reset all to defaults")!.click())
    expect(input("endpoint-node").value).toBe("")
    expect(profileUrl().value).toBe("")
    expect(shippedSwitch().checked).toBe(false)
    expect(calls).toEqual([])
    expect(stored()).toEqual({ node: "https://n.example" })
  })
})

describe("the route", () => {
  const h = vi.hoisted(() => ({ walletBootLoaded: false }))
  vi.mock("../../src/walletBoot", () => {
    h.walletBootLoaded = true
    return { default: () => <div>wallet boot</div> }
  })
  vi.mock("../../src/desktopSettings", () => ({ default: () => <div>desktop settings screen</div> }))

  async function boot(path: string, flag: string) {
    vi.resetModules()
    h.walletBootLoaded = false
    vi.stubEnv("VITE_DESKTOP_BUILD", flag)
    history.replaceState(null, "", path)
    const rootEl = document.createElement("div")
    rootEl.id = "root"
    document.body.appendChild(rootEl)
    await act(async () => {
      await import("../../src/main")
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const content = rootEl.textContent
    rootEl.remove()
    return content
  }

  beforeEach(() => {
    container = document.createElement("div")
    root = createRoot(container)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    history.replaceState(null, "", "/")
  })

  it("renders the settings screen at its path in a desktop build, without the wallet", async () => {
    expect(await boot("/desktop-settings", "true")).toBe("desktop settings screen")
    expect(h.walletBootLoaded).toBe(false)
  })

  it("renders the wallet at that path in any other build", async () => {
    expect(await boot("/desktop-settings", "")).toBe("wallet boot")
  })
})
