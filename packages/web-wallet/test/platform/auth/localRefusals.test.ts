import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DeviceBoundPasskeyError,
  LaptopPasskeyRefusedError,
  NoPrfError,
  PhoneRequiredError,
  UnsupportedProviderError,
} from "@obsidion/passkey-web"
import {
  LOCAL_REFUSAL_LIMIT,
  clearLocalRefusals,
  countsAsLocalRefusal,
  localRefusalCount,
  localRefusalsOverLimit,
  noteLocalRefusal,
} from "../../../src/platform/auth/localRefusals"
import { DEVICE_KEYS } from "../../../src/platform/storage/rollupStorage"

const unsupported = () =>
  new UnsupportedProviderError("manager", { providerName: "Bitwarden", localManagers: ["gpm"] })

afterEach(() => {
  vi.unstubAllGlobals()
  clearLocalRefusals()
})

describe("which refusals count", () => {
  it("counts what another manager's answer causes", () => {
    expect(countsAsLocalRefusal(unsupported())).toBe(true)
    expect(countsAsLocalRefusal(new LaptopPasskeyRefusedError("unnamed", ["1password"]))).toBe(true)
    expect(countsAsLocalRefusal(new LaptopPasskeyRefusedError("not-local", ["gpm"]))).toBe(true)
    // Apple Passwords withdrawn from the row is a manager the row does not admit.
    expect(
      countsAsLocalRefusal(
        new LaptopPasskeyRefusedError("apple", ["1password"], { appleWithdrawn: true }),
      ),
    ).toBe(true)
  })

  it("counts neither 1Password's own failure nor what has its own card", () => {
    expect(countsAsLocalRefusal(new NoPrfError({ manager: "1password" }))).toBe(false)
    expect(countsAsLocalRefusal(new LaptopPasskeyRefusedError("apple", ["gpm"]))).toBe(false)
    expect(countsAsLocalRefusal(new UnsupportedProviderError("security-key"))).toBe(false)
    expect(countsAsLocalRefusal(new DeviceBoundPasskeyError())).toBe(false)
    expect(countsAsLocalRefusal(new PhoneRequiredError())).toBe(false)
    expect(countsAsLocalRefusal(new DOMException("closed", "NotAllowedError"))).toBe(false)
  })
})

describe("the count", () => {
  it("is over the limit only above it, and only while an extension answers", () => {
    for (let i = 0; i < LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
    expect(localRefusalCount()).toBe(2)
    expect(localRefusalsOverLimit(true)).toBe(false)
    noteLocalRefusal()
    expect(localRefusalsOverLimit(true)).toBe(true)
    expect(localRefusalsOverLimit(false)).toBe(false)
    clearLocalRefusals()
    expect(localRefusalCount()).toBe(0)
    expect(localRefusalsOverLimit(true)).toBe(false)
  })

  it("is kept about this browser, so no rollup roll or wallet reset removes it", () => {
    noteLocalRefusal()
    expect(localStorage.getItem("webwallet.local-refusals")).toBe("1")
    expect(DEVICE_KEYS.has("webwallet.local-refusals")).toBe(true)
  })

  it("reads anything but a positive whole number as none", () => {
    for (const stored of ["", "x", "-1", "1.5", "NaN"]) {
      localStorage.setItem("webwallet.local-refusals", stored)
      expect(localRefusalCount()).toBe(0)
    }
  })

  it("counts nothing, and raises nothing, where storage throws", () => {
    const refuse = () => {
      throw new DOMException("denied", "SecurityError")
    }
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse })
    expect(() => noteLocalRefusal()).not.toThrow()
    expect(() => clearLocalRefusals()).not.toThrow()
    expect(localRefusalCount()).toBe(0)
    expect(localRefusalsOverLimit(true)).toBe(false)
  })
})
