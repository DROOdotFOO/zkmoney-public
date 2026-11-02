/** Which account a backup passkey add still has to switch: the one its signed change was built over. */
import { describe, expect, it } from "vitest"
import type { BackupRotationRecord } from "@obsidion/front-core"
import { rerootPending } from "../../../src/features/backupPasskey/backupRotationStore"

const ONE_KEY = `0x${"11".repeat(32)}`
const OTHER = `0x${"33".repeat(32)}`

const record = (over: Partial<BackupRotationRecord>): BackupRotationRecord =>
  ({ owner: "0xowner", phase: "published", fundings: [], ...over } as BackupRotationRecord)
const signed = (phase: BackupRotationRecord["phase"], l2Address = ONE_KEY) =>
  record({ phase, rotation: { builtOver: { l2Address } } as BackupRotationRecord["rotation"] })

describe("rerootPending", () => {
  it("holds for the account a signed change still has to switch, whatever its case", () => {
    expect(rerootPending([signed("published")], ONE_KEY)).toBe(true)
    expect(rerootPending([signed("published")], ONE_KEY.toUpperCase())).toBe(true)
    expect(rerootPending([signed("published", OTHER)], ONE_KEY)).toBe(false)
  })

  it("holds for any account while the change is not signed yet", () => {
    expect(rerootPending([record({ phase: "created" })], ONE_KEY)).toBe(true)
  })

  it("holds nothing before the records are read, or while they cannot be", () => {
    expect(rerootPending("loading", ONE_KEY)).toBe(false)
    expect(rerootPending("unreadable", ONE_KEY)).toBe(false)
    expect(rerootPending([record({ phase: "created" })], undefined)).toBe(false)
  })
})
