import { beforeAll, describe, expect, it } from "vitest"
import { getConfig } from "../../../../src/config/env"
import { upgradeRunAccount } from "../../../../src/features/migration/upgradeRunAccount"
import { seedBootConfig } from "../../../support/seedBootConfig"

beforeAll(seedBootConfig)

describe("upgradeRunAccount", () => {
  it("names an upgrade another device inferred from its deposits the same way", () => {
    const main = getConfig().oxideProfile.portal.toLowerCase()
    expect(upgradeRunAccount(`chain-upgrade/${main}`)).toBe("main")
    expect(upgradeRunAccount("chain-upgrade/0xsavings")).toBe("savings")
  })
})
