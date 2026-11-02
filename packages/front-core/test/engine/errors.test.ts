import { describe, expect, it, vi } from "vitest"
import { bestEffort, toFailure, WalletError } from "../../src/engine/errors"

describe("toFailure", () => {
  it("keeps a WalletError's code and detail", () => {
    expect(toFailure(new WalletError("tx.interrupted"))).toEqual({ code: "tx.interrupted" })
    expect(toFailure(new WalletError("tx.failed", "why"))).toEqual({
      code: "tx.failed",
      detail: "why",
    })
  })

  it("gives anything else the fallback code, with its message as detail", () => {
    expect(toFailure(new Error("boom"))).toEqual({ code: "unknown", detail: "boom" })
    expect(toFailure("text", "tx.failed")).toEqual({ code: "tx.failed", detail: "text" })
  })
})

describe("bestEffort", () => {
  it("returns the work's value", async () => {
    expect(await bestEffort("unknown", Promise.resolve(3))).toBe(3)
  })

  it("logs a failure under its code instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const err = new Error("boom")
    expect(await bestEffort("tx.failed", Promise.reject(err))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith("[tx.failed]", err)
    warn.mockRestore()
  })
})
