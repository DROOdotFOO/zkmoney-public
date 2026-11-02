import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type ErrorModalPayload,
  outOfMemoryCopy,
  showErrorModal,
  showReportableError,
  subscribeErrorModal,
} from "../../src/errors/errorModal"

const WEDGED_TAB_MESSAGE =
  "Your browser is still holding an earlier passkey request. Close any open passkey dialog, " +
  "reload this page, and try again."

const oom = () => Object.assign(new Error("Out of memory"), { name: "RangeError" })

function shown(error: unknown): ErrorModalPayload {
  const seen: ErrorModalPayload[] = []
  const unsub = subscribeErrorModal((p) => seen.push(p))
  showReportableError(error, "paylink:create")
  unsub()
  expect(seen).toHaveLength(1)
  return seen[0]!
}

describe("showReportableError", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("shows a wedged passkey request as a known error with a reload, not a report", async () => {
    const reload = vi.fn()
    vi.stubGlobal("location", { reload })
    const payload = shown(new Error(WEDGED_TAB_MESSAGE))

    expect(payload).toMatchObject({ message: WEDGED_TAB_MESSAGE, context: "paylink:create" })
    expect(payload.title).toBe("Passkey request still open")
    expect(payload.showReport).toBeFalsy()
    expect(payload.retry?.label).toBe("Reload page")
    payload.retry!.run()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it.each([
    [
      "parallel tasks that all ran out of memory",
      new AggregateError([
        new AggregateError([oom(), oom(), oom()]),
        new AggregateError([oom(), oom(), oom(), oom()]),
      ]),
    ],
  ])("tells the person to wait and reload for %s, and keeps the report", async (_, error) => {
    const reload = vi.fn()
    vi.stubGlobal("location", { reload })
    const seen: ErrorModalPayload[] = []
    const unsub = subscribeErrorModal((p) => seen.push(p))
    showReportableError(error, "request-link:create", {
      message: "The request link wasn't created — try again.",
    })
    unsub()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      title: "Not enough memory",
      message:
        "The browser could not give zk.money the memory it needs. Wait a few seconds, then reload the page.",
      detail: error.stack,
      showReport: true,
      context: "request-link:create",
    })
    expect(seen[0]!.retry?.label).toBe("Reload page")
    seen[0]!.retry!.run()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })
})

describe("outOfMemoryCopy", () => {
  it.each([
    ["an aggregate with another failure", new AggregateError([oom(), new Error("boot failed")])],
    ["an empty aggregate", new AggregateError([], "Out of memory")],
  ])("does not match %s", (_, error) => {
    expect(outOfMemoryCopy(error)).toBeUndefined()
  })
})

describe("errorModal emitter", () => {
  it("buffers pre-mount errors (capped at 3) and flushes on subscribe", () => {
    for (let i = 0; i < 5; i++) showErrorModal({ title: `t${i}`, message: "m" })
    const seen: string[] = []
    const unsub = subscribeErrorModal((p) => seen.push(p.title))
    expect(seen).toEqual(["t0", "t1", "t2"])

    showErrorModal({ title: "live", message: "m" })
    expect(seen).toEqual(["t0", "t1", "t2", "live"])

    unsub()
    showErrorModal({ title: "after", message: "m" })
    expect(seen).toHaveLength(4)
  })
})

describe("showReportableError with a value that is not an Error", () => {
  function reported(raw: unknown): ErrorModalPayload {
    let payload: ErrorModalPayload | undefined
    const unsub = subscribeErrorModal((p) => (payload = p))
    showReportableError(raw, "unhandled")
    unsub()
    return payload!
  }

  it.each([
    [{ message: " ", shortMessage: "Request timed out" }, "Request timed out"],
    [{ code: "ACTION_REJECTED", message: "Rejected" }, "Rejected (code ACTION_REJECTED)"],
    [{ code: -32000 }, "Error code -32000"],
    [[4001, "0xsecret"], "Non-Error object with no named keys"],
  ])("reads %j as %s", (raw, message) => {
    expect(reported(raw).message).toBe(message)
  })

  it("still reports an object whose message getter throws", () => {
    const raw = Object.defineProperty({}, "message", {
      get: () => {
        throw new Error("getter")
      },
    })
    expect(reported(raw).message).toBe("Non-Error object that cannot be read")
  })

  it("names only the keys of an object with no message or code", () => {
    const address = `0x${"ab".repeat(20)}`
    const { message, detail } = reported({ data: "0xsecret", reason: 7, [address]: 1 })
    expect(message).toBe("Non-Error object with keys: data, reason")
    expect(`${message}\n${detail}`).not.toMatch(/0xsecret|0xabab|\[object Object\]/)
  })

  it("names at most ten keys", () => {
    const raw = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]))
    expect(reported(raw).message).toBe(
      "Non-Error object with keys: k0, k1, k2, k3, k4, k5, k6, k7, k8, k9",
    )
  })
})
