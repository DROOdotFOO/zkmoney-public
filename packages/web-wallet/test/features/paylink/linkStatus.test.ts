import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const viewLink = vi.fn()
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({
  viewLink: (...a: unknown[]) => viewLink(...a),
  decodeLink: (fragment: string) => ({ fragment, status: "unclaimed", flavor: "direct" }),
}))
// Fake fragments never decode; the cache only needs a stable name for one.
vi.mock("../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
await (await import("../../support/seedBootConfig")).seedBootConfig()

import { seededLink, watchLink } from "../../../src/features/paylink/linkStatus"

const deps = {} as never
const unknownTiming = { status: "unclaimed" as const }
const known = { status: "unclaimed" as const, claimableFrom: 1_800_000_100 }

describe("watchLink", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("settles on errors but ignores an in-flight read after cancellation", async () => {
    const error = new Error("node unavailable")
    viewLink.mockRejectedValueOnce(error)
    const onError = vi.fn()
    const settled = vi.fn()
    watchLink(deps, "frag", vi.fn(), onError, settled)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(error)
    expect(settled.mock.calls).toEqual([[false]])

    let resolve!: (value: typeof known) => void
    viewLink.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const onLink = vi.fn()
    const stop = watchLink(deps, "frag", onLink, onError, settled)
    stop()
    resolve(known)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onLink).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledTimes(1)
  })
})

describe("the tab's read of a link", () => {
  const read = {
    status: "unclaimed" as const,
    amount: "25",
    claimableFrom: 1_800_000_100,
    claimableUntil: 1_800_086_500,
    memo: "Pizza dinner",
    senderTag: "river",
    txHash: "0xfund",
    email: "never@cached.example",
    tokenAddress: "0xtoken",
  }
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("shows a reload what the last read found, and keeps reading past a miss for the rest of the note", async () => {
    expect(seededLink("frag").amount).toBeUndefined()
    viewLink.mockResolvedValueOnce(read)
    watchLink(deps, "frag", vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    // A reload: the link opens with the amount, window, memo, sender and funding tx, and nothing else.
    expect(seededLink("frag")).toEqual({
      fragment: "frag",
      status: "unclaimed",
      flavor: "direct",
      amount: "25",
      claimableFrom: 1_800_000_100,
      claimableUntil: 1_800_086_500,
      memo: "Pizza dinner",
      senderTag: "river",
      txHash: "0xfund",
    })
    expect(JSON.stringify(sessionStorage)).not.toContain("never@cached.example")

    // Its read misses the note: the window stands, and the link is read again for what was not
    // kept (the token, the email and its commitment).
    viewLink.mockResolvedValueOnce(unknownTiming).mockResolvedValueOnce(read)
    const onLink = vi.fn()
    const settled = vi.fn()
    watchLink(deps, "frag", onLink, vi.fn(), settled)
    await vi.advanceTimersByTimeAsync(0)
    expect(onLink).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: "25", claimableFrom: 1_800_000_100 }),
    )
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onLink).toHaveBeenLastCalledWith(read)
    expect(settled.mock.calls).toEqual([[true]])
    expect(viewLink).toHaveBeenCalledTimes(3)
  })
})
