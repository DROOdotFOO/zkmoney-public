/**
 * The desktop bridge client's send check: a launcher without `recheck` is refused before anything is
 * created, each helper check runs the caller's recheck once within its budget, and every exit after
 * an approval reports that a send may still land.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DesktopBridgeUpdateRequiredError,
  DesktopRecheckTimeoutError,
  DesktopSendOpenError,
  DesktopSendUnresolvedError,
  submitViaDesktopBridge,
} from "../../src/platform/desktopBridge"

const PATH = "/desktop/l1-submit"
const ID = "ab".repeat(16)
const ANSWER = `${PATH}/${ID}/recheck`
const HASH = `0x${"12".repeat(32)}` as const
const params = {
  tx: { to: `0x${"cd".repeat(20)}` as const, data: "0x" as const, chainId: 1 },
  display: { title: "Fund your zk.money deposit", lines: [] as [string, string][] },
}

type Status = { state: string; check?: number; txHash?: string; message?: string }
/** A scripted status read: a status body, a network failure, or a read that never answers. */
type Poll = Status | "reject" | "hang"
let statuses: Poll[]
let posts: { url: string; body: Record<string, unknown> }[]
let failAnswers: boolean
let hangAnswers: boolean
const never = () => new Promise<Response>(() => {})
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "POST") {
    posts.push({ url, body: JSON.parse(String(init.body)) })
    if (url === ANSWER && failAnswers) throw new TypeError("fetch failed")
    if (url === ANSWER && hangAnswers) return never()
    return Response.json(url === PATH ? { id: ID } : { state: "ok" })
  }
  const next = statuses.length > 1 ? statuses.shift()! : statuses[0]
  if (next === "reject") throw new TypeError("Failed to fetch")
  if (next === "hang") return never()
  return Response.json(next)
})

function launcher(capabilities?: unknown) {
  ;(globalThis as { __ZKMONEY_DESKTOP_BRIDGE__?: unknown }).__ZKMONEY_DESKTOP_BRIDGE__ = {
    l1SubmitPath: PATH,
    ...(capabilities === undefined ? {} : { capabilities }),
  }
}

/** Runs the poll loop to completion on fake timers. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(2_000)
  const result = await outcome
  if ("error" in result) throw result.error
  return result.value
}

const answers = () => posts.filter((p) => p.url === ANSWER).map((p) => p.body)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockClear()
  statuses = []
  posts = []
  failAnswers = false
  hangAnswers = false
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (globalThis as { __ZKMONEY_DESKTOP_BRIDGE__?: unknown }).__ZKMONEY_DESKTOP_BRIDGE__
})

describe("submitViaDesktopBridge without a recheck", () => {
  it("refuses a checked send on a launcher without recheck before creating anything", async () => {
    launcher()
    const recheck = vi.fn(async () => {})
    await expect(submitViaDesktopBridge({ ...params, recheck })).rejects.toBeInstanceOf(
      DesktopBridgeUpdateRequiredError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(recheck).not.toHaveBeenCalled()
  })

  it("refuses a checked send while zk.money Desktop holds another send open, before any check", async () => {
    launcher(["recheck"])
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ error: "A send is already open in a wallet" }, { status: 409 }),
    )
    const recheck = vi.fn(async () => {})
    const beforeApprove = vi.fn()
    await expect(
      submitViaDesktopBridge({ ...params, recheck, beforeApprove }),
    ).rejects.toBeInstanceOf(DesktopSendOpenError)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(recheck).not.toHaveBeenCalled()
    expect(beforeApprove).not.toHaveBeenCalled()
  })

  it("sends an unchecked request unchanged on a launcher with recheck", async () => {
    launcher(["recheck"])
    statuses = [{ state: "pending" }, { state: "submitted", txHash: HASH }]
    await expect(settle(submitViaDesktopBridge(params))).resolves.toBe(HASH)
    expect(posts).toEqual([{ url: PATH, body: { tx: params.tx, display: params.display } }])
  })

  it("keeps plain errors unwrapped", async () => {
    launcher(["recheck"])
    statuses = [{ state: "superseded" }]
    const error = await settle(submitViaDesktopBridge(params)).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(DesktopSendUnresolvedError)
    expect((error as Error).message).toBe("This transaction request was replaced by a newer one")
  })
})

describe("submitViaDesktopBridge with a recheck", () => {
  beforeEach(() => launcher(["recheck"]))

  it("answers each helper check once and returns the hash the helper reports", async () => {
    const recheck = vi.fn(async () => {})
    statuses = [
      { state: "pending", check: 0 },
      { state: "checking", check: 1 },
      { state: "checking", check: 1 },
      { state: "authorized", check: 1 },
      // The wallet prompt was declined and the helper asked again.
      { state: "checking", check: 2 },
      { state: "submitted", check: 2, txHash: HASH },
    ]
    await expect(settle(submitViaDesktopBridge({ ...params, recheck }))).resolves.toBe(HASH)
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(posts[0]).toEqual({
      url: PATH,
      body: { tx: params.tx, display: params.display, recheck: true },
    })
    expect(answers()).toEqual([
      { check: 1, ok: true },
      { check: 2, ok: true },
    ])
  })

  it("never answers a check number it has already passed", async () => {
    const recheck = vi.fn(async () => {})
    statuses = [
      { state: "checking", check: 2 },
      { state: "checking", check: 1 },
      { state: "submitted", check: 2, txHash: HASH },
    ]
    await expect(settle(submitViaDesktopBridge({ ...params, recheck }))).resolves.toBe(HASH)
    expect(answers()).toEqual([{ check: 2, ok: true }])
  })

  it("refuses before any approval with the recheck's own error: nothing was sent", async () => {
    const refusal = new Error("x".repeat(600))
    const recheck = vi.fn(async () => {
      throw refusal
    })
    statuses = [{ state: "checking", check: 1 }]
    await expect(settle(submitViaDesktopBridge({ ...params, recheck }))).rejects.toBe(refusal)
    expect(recheck).toHaveBeenCalledOnce()
    expect(answers()).toEqual([{ check: 1, ok: false, message: "x".repeat(500) }])
    // Create, one status read, one answer: nothing after the refusal.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("still rethrows the refusal when posting it fails", async () => {
    failAnswers = true
    const refusal = new Error("Network capacity changed.")
    statuses = [{ state: "checking", check: 1 }]
    await expect(
      settle(submitViaDesktopBridge({ ...params, recheck: () => Promise.reject(refusal) })),
    ).rejects.toBe(refusal)
  })

  it("rejects at once as unresolved when a refusal follows an approval", async () => {
    const refusal = new Error("Network capacity changed.")
    const recheck = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal)
    statuses = [
      { state: "checking", check: 1 },
      { state: "checking", check: 2 },
    ]
    const start = Date.now()
    let endedAfter = 0
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck }).finally(() => {
        endedAfter = Date.now() - start
      }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopSendUnresolvedError)
    expect((error as Error).cause).toBe(refusal)
    expect(answers()).toEqual([
      { check: 1, ok: true },
      { check: 2, ok: false, message: refusal.message },
    ])
    // The second poll answered check 2; nothing waited for the deadline.
    expect(endedAfter).toBe(4_000)
  })

  it("reports an approved send as unresolved when the helper reports an error", async () => {
    // A failed approval post still counts: the launcher may have recorded it.
    failAnswers = true
    statuses = [
      { state: "checking", check: 1 },
      { state: "error", check: 1, message: "boom" },
    ]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck: async () => {}, timeoutMs: 20_000 }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopSendUnresolvedError)
  })

  it("reports an approved send as unresolved when a later status read fails", async () => {
    statuses = [{ state: "checking", check: 1 }, "reject"]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck: async () => {} }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopSendUnresolvedError)
  })

  it("refuses a recheck that throws synchronously, posting the refusal", async () => {
    const refusal = new Error("Capacity could not be checked.")
    statuses = [{ state: "checking", check: 1 }]
    const recheck = () => {
      throw refusal
    }
    await expect(settle(submitViaDesktopBridge({ ...params, recheck }))).rejects.toBe(refusal)
    expect(answers()).toEqual([{ check: 1, ok: false, message: refusal.message }])
  })

  it("stops waiting on a status read that hangs past the deadline", async () => {
    statuses = [{ state: "checking", check: 1 }, "hang"]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck: async () => {}, timeoutMs: 20_000 }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopSendUnresolvedError)
  })

  it("counts an approval whose post hangs, and stops waiting at the deadline", async () => {
    hangAnswers = true
    statuses = [{ state: "checking", check: 1 }]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck: async () => {}, timeoutMs: 20_000 }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopSendUnresolvedError)
  })

  it("refuses a check whose recheck would leave no time to watch for the send", async () => {
    let finish = () => {}
    const recheck = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    // Seen at 2 s with 5 s left: the recheck gets 1 s, then the send is refused.
    statuses = [{ state: "checking", check: 1 }]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck, timeoutMs: 7_000 }),
    ).catch((e: unknown) => e)
    finish()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(error).toBeInstanceOf(DesktopRecheckTimeoutError)
    expect(answers()).toEqual([{ check: 1, ok: false, message: (error as Error).message }])
  })

  it("leaves a check first seen too close to the deadline to watch its send unanswered", async () => {
    const recheck = vi.fn(async () => {})
    statuses = [
      ...Array.from({ length: 8 }, () => ({ state: "pending", check: 0 })),
      { state: "checking", check: 1 },
    ]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck, timeoutMs: 18_500 }),
    ).catch((e: unknown) => e)
    expect(recheck).not.toHaveBeenCalled()
    expect(answers()).toEqual([])
    expect(error).not.toBeInstanceOf(DesktopSendUnresolvedError)
    expect((error as Error).message).toMatch(/^Timed out waiting/)
  })

  it("posts the approval only once it is recorded", async () => {
    let record = () => {}
    const beforeApprove = vi.fn(() => new Promise<void>((resolve) => (record = resolve)))
    statuses = [
      { state: "checking", check: 1 },
      { state: "submitted", check: 1, txHash: HASH },
    ]
    const sent = submitViaDesktopBridge({ ...params, recheck: async () => {}, beforeApprove })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(beforeApprove).toHaveBeenCalledWith(ID)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(answers()).toEqual([])
    record()
    await expect(settle(sent)).resolves.toBe(HASH)
    expect(answers()).toEqual([{ check: 1, ok: true }])
  })

  it("refuses a send whose record does not settle within the budget, and never approves it later", async () => {
    let record = () => {}
    const beforeApprove = vi.fn(() => new Promise<void>((resolve) => (record = resolve)))
    statuses = [{ state: "checking", check: 1 }]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck: async () => {}, beforeApprove }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopRecheckTimeoutError)
    record()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(answers()).toEqual([{ check: 1, ok: false, message: (error as Error).message }])
  })

  it("never records an approval for a recheck that settles after its budget", async () => {
    const beforeApprove = vi.fn()
    let finish = () => {}
    const recheck = () => new Promise<void>((resolve) => (finish = resolve))
    statuses = [{ state: "checking", check: 1 }]
    const error = await settle(submitViaDesktopBridge({ ...params, recheck, beforeApprove })).catch(
      (e: unknown) => e,
    )
    finish()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(error).toBeInstanceOf(DesktopRecheckTimeoutError)
    expect(beforeApprove).not.toHaveBeenCalled()
  })

  it("never records an approval when the clock leaves too little time after the recheck", async () => {
    const beforeApprove = vi.fn()
    const recheck = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 15_000)
    })
    statuses = [{ state: "checking", check: 1 }]
    const error = await settle(
      submitViaDesktopBridge({ ...params, recheck, beforeApprove, timeoutMs: 20_000 }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopRecheckTimeoutError)
    expect(beforeApprove).not.toHaveBeenCalled()
  })

  it("refuses the send when the approval cannot be recorded", async () => {
    const cannotKeep = new Error("This browser couldn't save the deposit's progress.")
    statuses = [{ state: "checking", check: 1 }]
    const error = await settle(
      submitViaDesktopBridge({
        ...params,
        recheck: async () => {},
        beforeApprove: async () => {
          throw cannotKeep
        },
      }),
    ).catch((e: unknown) => e)
    expect(error).toBe(cannotKeep)
    expect(answers()).toEqual([{ check: 1, ok: false, message: cannotKeep.message }])
  })
})
