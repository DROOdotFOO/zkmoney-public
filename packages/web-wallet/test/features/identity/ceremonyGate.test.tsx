/**
 * The ceremony gate's contract: a phone passes at once; a laptop probes, holds in
 * "awaiting-action" until `proceed`, resolves with the option the user picked and its route, and
 * refuses a below-floor creation (a sign-in never refuses — this computer always answers). Cancel,
 * dismiss and unmount reject the waiter with a cancel, never an error; only cancel aborts the
 * attempt.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  nativeCreate,
  nativeGet,
  onePasswordCreate,
  otherCreate,
} from "../../support/passkeyExtensionStubs"
import type {
  CeremonyGate,
  GateResult,
  GateState,
  UnheldPick,
} from "../../../src/features/identity/ceremonyGate"
import type { DevicePosture, LaptopCreation } from "@obsidion/passkey-web"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PHONE: LaptopCreation = { local: false, chromeTip: false }
const MAC: LaptopCreation = {
  local: true,
  os: "macos",
  row: "macChrome",
  managers: ["apple", "gpm"],
  withdrawn: [],
}
/** Picks as the ticket sheet hands them over, with the managers behind each. */
const PICKS = {
  macComputer: { choice: "computer", supported: ["iCloud Keychain", "Google Password Manager"] },
  phone: {
    choice: "phone",
    supported: ["iCloud Keychain", "Google Password Manager", "1Password"],
  },
  key: { choice: "key", supported: ["YubiKey 5, Trezor or Ledger security key"] },
  onePassword: { choice: "1password", supported: ["1Password"] },
} satisfies Record<string, UnheldPick>
/** Whether 1Password's script answers the page's passkey creation, or the browser's own method. */
const extension = (answers: boolean) => {
  Object.defineProperty(navigator, "credentials", {
    value: { get: nativeGet, create: answers ? onePasswordCreate() : nativeCreate },
    configurable: true,
  })
}
const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15"
const WINDOWS_EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"
const WINDOWS_EDGE: LaptopCreation = {
  local: true,
  os: "windows",
  row: "windowsEdgeBrave",
  managers: ["1password"],
  withdrawn: [],
  chromeTip: "gpm",
}

const h = vi.hoisted(() => ({
  probePhoneReach: vi.fn(async () => "unknown"),
  probeLaptopCreation: vi.fn(async (): Promise<unknown> => ({ local: false, chromeTip: false })),
  rootCredentialId: vi.fn(async () => undefined),
  suggestedRoute: vi.fn(async () => "this-device"),
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    probePhoneReach: h.probePhoneReach,
    probeLaptopCreation: h.probeLaptopCreation,
    rootCredentialId: h.rootCredentialId,
    suggestedRoute: h.suggestedRoute,
  }),
}))

const { useCeremonyGate, isGateCancelled } = await import("../../../src/features/identity/ceremonyGate")

type Handle = { gate: CeremonyGate; state: GateState; cancel: () => void; dismiss: () => void }
let handle: Handle
function Harness({ posture, holdsSignIn }: { posture: DevicePosture; holdsSignIn?: boolean }) {
  handle = useCeremonyGate(() => posture, { holdsSignIn })
  return <span>{handle.state.kind}</span>
}

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const mount = (posture: DevicePosture, holdsSignIn?: boolean) =>
  act(async () => root.render(<Harness posture={posture} holdsSignIn={holdsSignIn} />))

beforeEach(() => {
  h.probePhoneReach.mockReset().mockResolvedValue("unknown")
  h.probeLaptopCreation.mockReset().mockResolvedValue(PHONE)
  h.rootCredentialId.mockReset().mockResolvedValue(undefined)
  h.suggestedRoute.mockReset().mockResolvedValue("this-device")
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  delete (navigator as { credentials?: unknown }).credentials
})

describe("useCeremonyGate", () => {
  it("a phone passes without probing or changing state", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("idle")
    // Its own passkey is the only route a phone can take, so no route is picked.
    expect(result.route).toBeUndefined()
  })

  it("a laptop sign-in holds the Sign in sheet without probing, and resolves on proceed", async () => {
    await mount("laptop")
    let settled = false
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate().then((r) => {
        settled = true
        return r
      })
    })
    await flush()
    // A sign-in picks no device — the browser's own chooser does — so it never probes.
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(h.probeLaptopCreation).not.toHaveBeenCalled()
    expect(container.textContent).toBe("awaiting-action")
    expect(settled).toBe(false)

    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the sheet")
    expect(state.prompt).toBe("sign-in")
    await act(async () => state.proceed())
    const result = await promise
    expect(settled).toBe(true)
    expect(result.route).toBeUndefined()
    expect(container.textContent).toBe("idle")
  })

  it("a sign-in ignores a creation sheet's pick and still holds its own sheet", async () => {
    await mount("laptop")
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate({ purpose: "sign-in", unheld: PICKS.key })
    })
    await flush()
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the sheet")
    expect(state.prompt).toBe("sign-in")
    await act(async () => state.proceed())
    expect((await promise).route).toBeUndefined()
  })

  it("a screen that owns the tap: a laptop sign-in resolves at once, with no sheet and no probe", async () => {
    await mount("laptop", false)
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("idle")
    expect(result.route).toBeUndefined()
    expect(result.signal.aborted).toBe(false)
    // The hook's cancel still ends the attempt it handed out.
    await act(async () => handle.cancel())
    expect(result.signal.aborted).toBe(true)
  })

  it("a screen that owns the tap still holds a creation's steps and a sign-in's second prompt", async () => {
    await mount("laptop", false)
    let settled = false
    await act(async () => {
      void handle
        .gate({ purpose: "create" })
        .then(() => (settled = true))
        .catch(() => {})
    })
    await flush()
    expect(h.probePhoneReach).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe("awaiting-action")
    if (handle.state.kind !== "awaiting-action") throw new Error("expected the steps")
    expect(handle.state.prompt).toBe("phone-steps")
    expect(settled).toBe(false)
    await act(async () => handle.cancel())

    const again = new AbortController().signal
    await act(async () => {
      void handle.gate({ again }).catch(() => {})
    })
    await flush()
    if (handle.state.kind !== "awaiting-action") throw new Error("expected approve-again")
    expect(handle.state.prompt).toBe("approve-again")
  })

  it.each([
    ["computer", "this-device"],
    ["1password", "this-device"],
    ["phone", "phone"],
    ["phone-or-key", "phone"],
    ["key", "security-key"],
  ] as const)("a %s pick resolves on the %s route", async (choice, route) => {
    await mount("laptop")
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate({ purpose: "create" })
    })
    await flush()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the steps")
    await act(async () => state.proceed(choice))
    expect(await promise).toMatchObject({ choice, route })
  })

  it("a creation holds the steps with both probes in hand, and resolves on this computer", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    h.probeLaptopCreation.mockResolvedValue(MAC)
    await mount("laptop")
    let promise!: Promise<GateResult>
    await act(async () => {
      promise = handle.gate({ purpose: "create" })
    })
    await flush()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the steps")
    expect(state.reach).toBe("ok")
    expect(state.creation).toEqual(MAC)
    expect(state.openOn).toBeUndefined()
    await act(async () => state.proceed("computer"))
    const result = await promise
    expect(result).toMatchObject({
      choice: "computer",
      route: "this-device",
      reach: "ok",
      creation: MAC,
    })
  })

  it("keeps the sheet's This Mac pick while the fresh options offer it with the same managers", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    h.probeLaptopCreation.mockResolvedValue(MAC)
    await mount("laptop")
    const result = await act(() => handle.gate({ purpose: "create", unheld: PICKS.macComputer }))
    expect(result).toMatchObject({ choice: "computer", route: "this-device", creation: MAC })
    expect(container.textContent).toBe("idle")
  })

  it("keeps the sheet's 1Password pick while an extension still answers", async () => {
    extension(true)
    h.probeLaptopCreation.mockResolvedValue({ ...MAC, managers: ["apple", "gpm", "1password"] })
    await mount("laptop")
    const result = await act(() => handle.gate({ purpose: "create", unheld: PICKS.onePassword }))
    expect(result).toMatchObject({ choice: "1password", route: "this-device" })
    expect(container.textContent).toBe("idle")
  })

  it("holds the sheet on This Mac for a 1Password pick when the script answering is not 1Password's", async () => {
    Object.defineProperty(navigator, "credentials", {
      value: { get: nativeGet, create: otherCreate() },
      configurable: true,
    })
    h.probeLaptopCreation.mockResolvedValue({ ...MAC, managers: ["apple", "gpm", "1password"] })
    await mount("laptop")
    const { state } = await heldFor(PICKS.onePassword)
    expect(state.openOn).toBe("computer")
  })

  /** The sheet the gate holds for `unheld`, or the result if it held none. */
  async function heldFor(unheld: UnheldPick) {
    let settled: GateResult | undefined
    await act(async () => {
      void handle.gate({ purpose: "create", unheld }).then(
        (r) => (settled = r),
        () => {},
      )
    })
    await flush()
    expect(settled).toBeUndefined()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the sheet, never a silent pick")
    expect(state.prompt).toBe("phone-steps")
    return { state, settled: () => settled }
  }

  it("a This Mac pick the probe no longer allows holds the sheet on the phone", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    await mount("laptop")
    const { state, settled } = await heldFor(PICKS.macComputer)
    expect(state.openOn).toBe("phone")
    expect(state.creation).toEqual(PHONE)
    await act(async () => state.proceed("phone"))
    await flush()
    expect(settled()).toMatchObject({ choice: "phone", route: "phone" })
  })

  it.each([
    ["with an extension, where This Mac is gone", true, "1password"],
    ["without one, where This Mac now means 1Password through its window", false, "phone-or-key"],
  ] as const)(
    "a This Mac pick on Safari whose Apple Passwords was dropped holds the sheet, %s",
    async (_, answers, openOn) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_SAFARI_UA)
      extension(answers)
      h.probeLaptopCreation.mockResolvedValue({
        local: true,
        os: "macos",
        row: "macSafari",
        managers: ["1password"],
        withdrawn: [],
      })
      await mount("laptop")
      const { state } = await heldFor({ choice: "computer", supported: ["iCloud Keychain"] })
      expect(state.openOn).toBe(openOn)
      await act(async () => handle.cancel())
    },
  )

  it("holds on the option a screen asks for", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    h.probeLaptopCreation.mockResolvedValue(MAC)
    await mount("laptop")
    await act(async () => {
      void handle
        .gate({
          purpose: "create",
          unheld: PICKS.macComputer,
          openOn: "key",
          reopened: "blocked",
        })
        .catch(() => {})
    })
    await flush()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the sheet")
    // A way back to the sheet wins over the pick that was made before it.
    expect(state.openOn).toBe("key")
    expect(state.reopened).toBe("blocked")
    await act(async () => handle.cancel())
  })

  it("a creation probe that throws or answers nothing counts as phone creation", async () => {
    h.probeLaptopCreation.mockRejectedValue(new Error("no hints"))
    await mount("laptop")
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch(() => {})
    })
    await flush()
    let state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the steps")
    expect(state.creation).toEqual(PHONE)
    await act(async () => handle.cancel())

    h.probeLaptopCreation.mockResolvedValue(undefined as never)
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch(() => {})
    })
    await flush()
    state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the steps")
    expect(state.creation).toEqual(PHONE)
    await act(async () => handle.cancel())
  })

  it("a creation whose screen was the sheet probes and resolves at once on its phone pick", async () => {
    await mount("laptop")
    const result = await act(() => handle.gate({ purpose: "create", unheld: PICKS.phone }))
    expect(h.probePhoneReach).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ choice: "phone", route: "phone" })
    expect(container.textContent).toBe("idle")
  })

  it("a phone pick with no phone in reach holds the sheet on the key, so the key takes its own tap", async () => {
    h.probePhoneReach.mockResolvedValue("no-hybrid")
    await mount("laptop")
    const { state, settled } = await heldFor(PICKS.phone)
    expect(state.openOn).toBe("key")
    await act(async () => state.proceed("key"))
    await flush()
    expect(settled()).toMatchObject({ choice: "key", route: "security-key" })
  })

  describe("on Windows, where the phone and the key are one option", () => {
    const phoneOrKey: UnheldPick = {
      choice: "phone-or-key",
      supported: [...PICKS.phone.supported, ...PICKS.key.supported],
    }
    beforeEach(() => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_EDGE_UA)
      h.probePhoneReach.mockResolvedValue("ok")
      h.probeLaptopCreation.mockResolvedValue(WINDOWS_EDGE)
    })

    it("a pick of that option behind the same managers passes", async () => {
      await mount("laptop")
      const result = await act(() => handle.gate({ purpose: "create", unheld: phoneOrKey }))
      expect(result).toMatchObject({ choice: "phone-or-key", route: "phone" })
      expect(container.textContent).toBe("idle")
    })

    it("a phone or key pick from a sheet that drew them apart holds the sheet on the one option", async () => {
      await mount("laptop")
      for (const unheld of [PICKS.phone, PICKS.key]) {
        const { state } = await heldFor(unheld)
        expect(state.openOn).toBe("phone-or-key")
        await act(async () => handle.cancel())
      }
    })

    it("that pick with no phone in reach holds the sheet on the key", async () => {
      h.probePhoneReach.mockResolvedValue("no-hybrid")
      await mount("laptop")
      const { state, settled } = await heldFor(phoneOrKey)
      expect(state.openOn).toBe("key")
      await act(async () => state.proceed("key"))
      await flush()
      expect(settled()).toMatchObject({ choice: "key", route: "security-key" })
    })
  })

  it("keeps the sheet's security-key pick where a phone is reachable", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    await mount("laptop")
    const result = await act(() => handle.gate({ purpose: "create", unheld: PICKS.key }))
    expect(result).toMatchObject({ choice: "key", route: "security-key" })
    expect(container.textContent).toBe("idle")
  })

  it("refuses a browser below the floor whatever the sheet picked", async () => {
    h.probePhoneReach.mockResolvedValue("below-floor")
    await mount("laptop")
    for (const unheld of [PICKS.phone, PICKS.key]) {
      let error: unknown
      let result: unknown
      await act(async () =>
        handle.gate({ purpose: "create", unheld }).then(
          (r) => (result = r),
          (e) => (error = e),
        ),
      )
      expect(error).toMatchObject({ name: "PhoneUnreachableError" })
      expect(result).toBeUndefined()
    }
  })

  it("a creation whose probe never settles is still ended by cancel", async () => {
    h.probePhoneReach.mockImplementation(() => new Promise(() => {}))
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch((e) => (error = e))
    })
    expect(container.textContent).toBe("probing")
    await act(async () => handle.cancel())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  it("cancel rejects the waiter with a cancel and resets", async () => {
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate().catch((e) => (error = e))
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.cancel())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  it("a second gate call cancels the first waiter", async () => {
    await mount("laptop")
    let first: unknown
    await act(async () => {
      void handle.gate().catch((e) => (first = e))
    })
    await flush()
    await act(async () => {
      void handle.gate().catch(() => {})
    })
    await flush()
    expect(isGateCancelled(first)).toBe(true)
    expect(container.textContent).toBe("awaiting-action")
  })

  it("unmount rejects the waiter with a cancel", async () => {
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate().catch((e) => (error = e))
    })
    await flush()
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(isGateCancelled(error)).toBe(true)
  })

  it("cancel during a creation probe rejects with a cancel and the late probe changes nothing", async () => {
    let resolveProbe!: (reach: string) => void
    h.probePhoneReach.mockImplementation(() => new Promise((r) => (resolveProbe = r)))
    await mount("laptop")
    let error: unknown
    await act(async () => {
      void handle.gate({ purpose: "create" }).catch((e) => (error = e))
    })
    expect(container.textContent).toBe("probing")
    await act(async () => handle.cancel())
    await act(async () => resolveProbe("unknown"))
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  it("a second plain call aborts the first attempt's signal", async () => {
    await mount("phone")
    let first!: GateResult
    let second!: GateResult
    await act(async () => {
      first = await handle.gate()
      second = await handle.gate()
    })
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
  })

  it("a phone asked again holds for one tap, without probing", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    let settled = false
    await act(async () => {
      void handle
        .gate({ again: result.signal })
        .then(() => (settled = true))
        .catch(() => {})
    })
    await flush()
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("awaiting-action")
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the tap")
    expect(state.prompt).toBe("approve-again")
    expect(settled).toBe(false)
    await act(async () => state.proceed())
    await flush()
    expect(settled).toBe(true)
    expect(container.textContent).toBe("idle")
  })

  /** A laptop's first sign-in, taken through the Sign in sheet; resolves with the attempt's signal. */
  async function firstLaptopGate(): Promise<AbortSignal> {
    let first!: Promise<GateResult>
    await act(async () => {
      first = handle.gate()
    })
    await flush()
    const opened = handle.state
    if (opened.kind !== "awaiting-action") throw new Error("expected the sheet")
    await act(async () => opened.proceed())
    return (await first).signal
  }

  it("cancel and unmount reject a phone's tap with a cancel", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    let error: unknown
    await act(async () => {
      void handle.gate({ again: result.signal }).catch((e) => (error = e))
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.cancel())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(container.textContent).toBe("idle")

    await act(async () => {
      result = await handle.gate()
    })
    let unmounted: unknown
    await act(async () => {
      void handle.gate({ again: result.signal }).catch((e) => (unmounted = e))
    })
    await flush()
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(isGateCancelled(unmounted)).toBe(true)
  })

  it("dismiss rejects the waiter and leaves the attempt's signal alone", async () => {
    await mount("laptop")
    const signal = await firstLaptopGate()
    let error: unknown
    await act(async () => {
      void handle.gate({ again: signal }).catch((e) => (error = e))
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")
    await act(async () => handle.dismiss())
    await flush()
    expect(isGateCancelled(error)).toBe(true)
    expect(signal.aborted).toBe(false)
    expect(container.textContent).toBe("idle")
  })

  it("a tap answered as the screen goes: the ask is refused, no prompt follows", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    let error: unknown
    let settled = false
    await act(async () => {
      void handle
        .gate({ again: result.signal })
        .then(() => (settled = true))
        .catch((e) => (error = e))
    })
    await flush()
    const state = handle.state
    if (state.kind !== "awaiting-action") throw new Error("expected the tap")
    await act(async () => {
      state.proceed()
      root.unmount()
    })
    root = createRoot(container)
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    expect(isGateCancelled(error)).toBe(true)
  })

  it("unmount leaves the attempt's signal alone, and asking the gone screen again is refused", async () => {
    await mount("phone")
    let result!: GateResult
    await act(async () => {
      result = await handle.gate()
    })
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(result.signal.aborted).toBe(false)
    let error: unknown
    await handle.gate({ again: result.signal }).catch((e) => (error = e))
    expect(isGateCancelled(error)).toBe(true)
  })

  it("a cancelled attempt asked again is refused at once and leaves a newer attempt waiting", async () => {
    await mount("laptop")
    const stale = await firstLaptopGate()
    await act(async () => handle.cancel())
    expect(stale.aborted).toBe(true)

    let newer = false
    await act(async () => {
      void handle
        .gate()
        .then(() => (newer = true))
        .catch(() => {})
    })
    await flush()
    expect(container.textContent).toBe("awaiting-action")

    let error: unknown
    await act(async () => handle.gate({ again: stale }).catch((e) => (error = e)))
    expect(isGateCancelled(error)).toBe(true)
    // A sign-in never probes, so neither the first call nor the newer one asked the browser.
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(container.textContent).toBe("awaiting-action")
    const live = handle.state
    if (live.kind !== "awaiting-action") throw new Error("expected the newer waiter")
    await act(async () => live.proceed())
    await flush()
    expect(newer).toBe(true)
  })

  it("a picked route from an earlier call never releases a later waiter", async () => {
    await mount("laptop")
    let first: unknown
    await act(async () => {
      void handle.gate().catch((e) => (first = e))
    })
    await flush()
    const stale = handle.state
    if (stale.kind !== "awaiting-action") throw new Error("expected the picker")
    let second = false
    await act(async () => {
      void handle
        .gate()
        .then(() => (second = true))
        .catch(() => {})
    })
    await flush()
    expect(isGateCancelled(first)).toBe(true)
    await act(async () => stale.proceed("phone"))
    await flush()
    expect(second).toBe(false)
    expect(container.textContent).toBe("awaiting-action")
    const live = handle.state
    if (live.kind !== "awaiting-action") throw new Error("expected the second waiter")
    await act(async () => live.proceed("phone"))
    await flush()
    expect(second).toBe(true)
  })
})
