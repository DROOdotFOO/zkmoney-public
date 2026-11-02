// @vitest-environment node
import { markPasskeyWritten } from "@obsidion/passkey-web"
import { describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({}))

const { errorLine } = await import("../../../src/features/backupPasskey/BackupPasskeyPanel")
const { LeftoverPasskeyError } = await import("../../../src/features/backupPasskey/backupPasskeyAdd")

const leftover = "stays on your device"
const count = (line: string) => line.split(leftover).length - 1

describe("errorLine", () => {
  it("adds the leftover line once when a passkey was written before the failure", () => {
    const declined = markPasskeyWritten(new DOMException("closed", "NotAllowedError"))
    expect(errorLine(declined)).toContain("closed or timed out")
    expect(count(errorLine(declined))).toBe(1)
    expect(count(errorLine(new LeftoverPasskeyError(declined)))).toBe(1)
    expect(count(errorLine(new LeftoverPasskeyError(new Error("seal broke"))))).toBe(1)
  })

  it("leaves the leftover line out when nothing was written", () => {
    expect(count(errorLine(new DOMException("closed", "NotAllowedError")))).toBe(0)
    expect(count(errorLine(new Error("rpc")))).toBe(0)
  })
})
