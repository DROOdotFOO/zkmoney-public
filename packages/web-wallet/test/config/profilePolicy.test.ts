// @vitest-environment node
import { Network } from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import { assertProfilePolicy, parseNetwork } from "../../src/config/profilePolicy"

function boot(oxide: Record<string, unknown> | undefined) {
  return {
    profile: { profileId: "staging-v5" },
    versionId: "0.0.1",
    snapshot: { oxide },
  } as never
}

const pointer = {
  manifestUrl: "https://manifest.example/staging.v4.json",
  portal: "0x92308cE04e2416f20b03e941a14F9238C3603334",
  expectedGitSha: "a".repeat(40),
}

describe("parseNetwork", () => {
  it.each([
    ["sandbox", Network.SANDBOX],
    ["testnet", Network.TESTNET],
    ["mainnet", Network.MAINNET],
  ])("reads %s", (raw, network) => {
    expect(parseNetwork(raw)).toBe(network)
  })

  it("defaults to sandbox when unset", () => {
    expect(parseNetwork(undefined)).toBe(Network.SANDBOX)
  })

  it("refuses an unknown value rather than defaulting", () => {
    expect(() => parseNetwork("devnet")).toThrow(/Unknown VITE_NETWORK "devnet"/)
  })
})

describe("assertProfilePolicy", () => {
  it("returns a copy of an acceptable pointer", () => {
    const result = assertProfilePolicy(boot(pointer), Network.TESTNET)
    expect(result).toEqual(pointer)
    expect(result).not.toBe(pointer)
  })

  it("refuses a version with no pointer", () => {
    expect(() => assertProfilePolicy(boot(undefined), Network.TESTNET)).toThrow(/no oxide pointer/)
  })

  it("refuses a dev or sandbox manifest on a durable network, and allows it on sandbox", () => {
    for (const url of [
      "https://manifest.example/dev.json",
      "https://manifest.example/dev.v4.json?cache=1",
      "http://localhost:8083/oxide/sandbox.json",
    ]) {
      const dev = { ...pointer, manifestUrl: url }
      expect(() => assertProfilePolicy(boot(dev), Network.TESTNET), url).toThrow(
        /dev or local manifest/,
      )
      expect(assertProfilePolicy(boot(dev), Network.SANDBOX).manifestUrl).toBe(url)
    }
  })

  it("refuses a mainnet pointer with no expectedGitSha", () => {
    const unpinned = { manifestUrl: pointer.manifestUrl, portal: pointer.portal }
    expect(() => assertProfilePolicy(boot(unpinned), Network.MAINNET)).toThrow(/expectedGitSha/)
    expect(assertProfilePolicy(boot(unpinned), Network.TESTNET).portal).toBe(pointer.portal)
  })
})
