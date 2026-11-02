// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  lastPasskeyEnvironment,
  recordPasskeyEnvironment,
} from "../../src/browser/passkeyEnvironment.js"

const KEY = "x.passkeyEnv"

describe("passkey environment", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("keeps the creation's label and transports across the assertion records that follow", async () => {
    await recordPasskeyEnvironment(
      { created: { attachment: "platform", transports: ["hybrid"] }, posture: "laptop" },
      KEY,
    )
    await recordPasskeyEnvironment({ aaguid: "abc", posture: "laptop" }, KEY)
    expect(lastPasskeyEnvironment(KEY)).toMatchObject({
      aaguid: "abc",
      attachment: "platform",
      transports: ["hybrid"],
    })
    // A later creation replaces them.
    await recordPasskeyEnvironment({ created: {}, posture: "laptop" }, KEY)
    expect(lastPasskeyEnvironment(KEY)?.attachment).toBe("unknown")
    expect(lastPasskeyEnvironment(KEY)?.transports).toBeUndefined()
  })

  it("an assertion naming another provider does not wear the creation's fields", async () => {
    await recordPasskeyEnvironment(
      {
        aaguid: "apple",
        created: { attachment: "platform", transports: ["hybrid"] },
        posture: "laptop",
      },
      KEY,
    )
    await recordPasskeyEnvironment({ aaguid: "key", posture: "laptop" }, KEY)
    expect(lastPasskeyEnvironment(KEY)).toMatchObject({ aaguid: "key" })
    expect(lastPasskeyEnvironment(KEY)?.attachment).toBeUndefined()
    expect(lastPasskeyEnvironment(KEY)?.transports).toBeUndefined()
  })

  it("records the latest environment under the given key and reads it back", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    })
    await recordPasskeyEnvironment(
      { aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd", posture: "phone" },
      KEY,
    )
    await recordPasskeyEnvironment({ posture: "phone" }, KEY)
    expect(lastPasskeyEnvironment(KEY)).toEqual({
      aaguid: "unknown",
      osFamily: "ios",
      osVersionReported: "18.3",
      browserFamily: "safari",
      browserVersionReported: "18.3",
      posture: "phone",
    })
    expect(lastPasskeyEnvironment("other.key")).toBeNull()
  })

  it("is a no-op without storage", async () => {
    vi.stubGlobal("localStorage", undefined)
    await expect(recordPasskeyEnvironment({ posture: "laptop" }, KEY)).resolves.toBeUndefined()
    expect(lastPasskeyEnvironment(KEY)).toBeNull()
  })
})
