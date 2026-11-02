import { describe, expect, it } from "vitest"
import { avatarColors } from "@obsidion/web-ds"

/** Golden pin: web-ds `avatarColors` — the same tag must keep the same gradient. */
describe("avatar gradient parity", () => {
  const GOLDEN: Record<string, readonly [string, string]> = {
    alice: ["#A000FF", "#FE708B"],
    bob: ["#56E79D", "#0099FF"],
    cyphergirl: ["#9907FF", "#2E6DFE"],
    satoshi: ["#FF7A00", "#FE708B"],
  }

  it("web-ds avatarColors matches the fixtures", () => {
    for (const [tag, expected] of Object.entries(GOLDEN)) {
      expect(avatarColors(tag)).toEqual(expected)
    }
  })

  it("is case-insensitive", () => {
    expect(avatarColors("Alice")).toEqual(avatarColors("alice"))
  })
})
