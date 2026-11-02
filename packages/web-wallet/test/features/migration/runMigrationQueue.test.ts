import { describe, expect, it } from "vitest"
import { upgradeApprovals } from "../../../src/features/migration/runMigrationQueue"

describe("an upgrade's approvals", () => {
  it("has no count for an upgrade that asks nothing", () => {
    expect(upgradeApprovals([{ summary: { fees: "0", approvals: 0 } }, {}])).toBeUndefined()
  })
})
