// @vitest-environment node
/**
 * Where the key comes from before any ceremony: the held key when it is the passkey asked for, the
 * chooser always a ceremony.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ recoverFromCache: vi.fn() }))

vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    rpId: "localhost",
    recoverFromCache: h.recoverFromCache,
  }),
}))

const { resolveKeySource } = await import("../../../src/features/onboarding/oxideOnboarding")

const held = { credentialId: "cred-held" }

beforeEach(() => {
  vi.clearAllMocks()
  h.recoverFromCache.mockResolvedValue(undefined)
})

describe("resolveKeySource", () => {
  it("the held key answers a visit that names no passkey, or names the held one", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect(await resolveKeySource()).toEqual({ kind: "cache", result: held })
    expect(await resolveKeySource({ credentialId: "cred-held" })).toEqual({
      kind: "cache",
      result: held,
    })
  })

  it("the held key never answers for another passkey", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect((await resolveKeySource({ credentialId: "other" })).kind).toBe("ceremony-required")
  })

  it("a phone-steered request is always a ceremony, even with a held key", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect(await resolveKeySource({ discover: true, phone: true })).toEqual({
      kind: "ceremony-required",
      request: { discover: true, phone: true },
    })
    expect(h.recoverFromCache).not.toHaveBeenCalled()
  })
})
