// @vitest-environment node
/** Reading the desktop launcher's injected settings state, whatever shape it arrives in. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { readDesktopSettingsState } from "../../src/desktopSettings/state"

const inject = (value: unknown) => vi.stubGlobal("__ZKMONEY_DESKTOP_SETTINGS__", value)

afterEach(() => vi.unstubAllGlobals())

describe("readDesktopSettingsState", () => {
  it.each([undefined, null, "state", 7])("is null for a non-object global %j", (value) => {
    inject(value)
    expect(readDesktopSettingsState()).toBeNull()
  })

  it.each([{}, { token: "" }, { token: 7 }])("is null without a token: %j", (value) => {
    inject(value)
    expect(readDesktopSettingsState()).toBeNull()
  })

  it("fills the defaults when only the token arrives", () => {
    inject({ token: "t" })
    expect(readDesktopSettingsState()).toEqual({
      token: "t",
      values: {},
      sources: {},
      problems: [],
      builtAt: undefined,
      profile: { url: null, overridden: false, baked: null },
      profileProbe: null,
    })
  })

  it("keeps a well-formed state as sent", () => {
    const state = {
      token: "t",
      values: { configProfileUrl: "https://cdn.example/profiles/v5/current.json" },
      sources: { configProfileUrl: "env", bootFromBakedProfile: null },
      problems: [
        { key: null, source: "file", message: "bad json" },
        { key: "bootFromBakedProfile", source: "env", message: "not a flag" },
      ],
      builtAt: "2026-09-01T00:00:00.000Z",
      profile: {
        url: "https://cdn.example/profiles/v5/current.json",
        overridden: true,
        baked: { current: "0.5.1", publishedAt: "2026-08-01T00:00:00.000Z" },
      },
      profileProbe: { state: "ok", detail: null, overridden: true, bakedExpired: false },
    }
    inject(state)
    expect(readDesktopSettingsState()).toEqual({
      ...state,
      sources: { configProfileUrl: "env" },
      profileProbe: { state: "ok", detail: null, overridden: true, bakedExpired: false },
    })
  })

  it("drops fields of the wrong shape instead of trusting them", () => {
    inject({
      token: "t",
      values: { configProfileUrl: 7, bootFromBakedProfile: "yes" },
      sources: "env",
      problems: [{ key: "nodeUrl", message: "old key" }, { key: null }, "junk"],
      builtAt: 5,
      profile: { url: 7, overridden: "no", baked: { current: "0.5.1" } },
      profileProbe: { state: "broken" },
    })
    expect(readDesktopSettingsState()).toEqual({
      token: "t",
      values: {},
      sources: {},
      problems: [],
      builtAt: undefined,
      profile: { url: null, overridden: false, baked: null },
      profileProbe: null,
    })
  })
})
