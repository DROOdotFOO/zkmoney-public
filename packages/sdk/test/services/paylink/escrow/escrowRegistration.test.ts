import { describe, expect, it, vi } from "vitest"
import { sharedNoteRead } from "../../../../src/services/paylink/escrow/escrowRegistration.js"

describe("sharedNoteRead", () => {
  it("runs one simulation for overlapping reads of an escrow, and a fresh one after", async () => {
    const wallet = {}
    let settle: (v: unknown) => void = () => {}
    const read = vi.fn(() => new Promise<never>((r) => (settle = r as never)))
    const first = sharedNoteRead(wallet, "0xescrow", read)
    const second = sharedNoteRead(wallet, "0xescrow", read)
    settle({ amount: 1n })
    await expect(Promise.all([first, second])).resolves.toEqual([{ amount: 1n }, { amount: 1n }])
    expect(read).toHaveBeenCalledOnce()
    void sharedNoteRead(wallet, "0xescrow", read)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
