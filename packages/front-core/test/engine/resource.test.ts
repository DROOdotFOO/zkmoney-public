// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { fixed, resource, valueOf, type Resource } from "../../src/engine/resource"
import { fakeClock, flush, later } from "./taskTable"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const status = (r: Resource<unknown>) => r.get().status

describe("resource", () => {
  fakeClock()

  it("builds once its inputs are ready, however late they arrive", async () => {
    const a = later<number>("a")
    const sum = resource("sum", { from: [a.resource], backoff: "manual" }, async ([n]) => n + 1)
    await flush()
    expect(status(sum)).toBe("pending")
    a.ready(1)
    await flush()
    expect(valueOf(sum)).toBe(2)
  })

  it("rebuilds when an input's value changes, aborting the build in flight and releasing the value", async () => {
    const a = later<number>("a")
    const builds: { n: number; signal: AbortSignal; done: ReturnType<typeof deferred<number>> }[] =
      []
    const r = resource("r", { from: [a.resource], backoff: "manual" }, ([n], { signal }) => {
      const done = deferred<number>()
      builds.push({ n, signal, done })
      return done.promise
    })
    a.ready(1)
    await flush()
    builds[0].done.resolve(10)
    await flush()
    expect(valueOf(r)).toBe(10)

    a.ready(2)
    expect(builds[0].signal.aborted).toBe(true)
    expect(status(r)).toBe("pending")
    a.ready(3)
    expect(builds[1].signal.aborted).toBe(true)
    builds[1].done.resolve(20) // late: dropped
    builds[2].done.resolve(30)
    await flush()
    expect(valueOf(r)).toBe(30)
  })

  it("retries a failed build with a doubling backoff, capped", async () => {
    let fails = 3
    const build = vi.fn(async () => {
      if (fails-- > 0) throw new Error("down")
      return "up"
    })
    const r = resource("r", { from: [], backoff: { baseMs: 1_000, maxMs: 1_500 } }, build)
    await flush()
    expect(r.get()).toMatchObject({ status: "failed", retryAt: Date.now() + 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(build).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(build).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(build).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(valueOf(r)).toBe("up")
  })

  it("waits for `retry` after a failure when manual", async () => {
    let fail = true
    const r = resource("r", { from: [], backoff: "manual" }, async () => {
      if (fail) throw new Error("cancelled")
      return 1
    })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(status(r)).toBe("failed")
    fail = false
    r.retry()
    await flush()
    expect(valueOf(r)).toBe(1)
  })

  it("builds a lazy resource and its lazy inputs only once demanded", async () => {
    const inner = vi.fn(async () => 1)
    const a = resource("a", { from: [], lazy: true, backoff: "manual" }, inner)
    const b = resource("b", { from: [a], lazy: true, backoff: "manual" }, async ([n]) => n + 1)
    await flush()
    expect(inner).not.toHaveBeenCalled()
    b.demand()
    await flush()
    expect(valueOf(b)).toBe(2)
  })

  it("stays pending on an undefined build until `changes` fires", async () => {
    let fire = () => {}
    const built: { value?: number } = {}
    const r = resource(
      "r",
      { from: [], backoff: "manual", changes: (onChange) => ((fire = onChange), () => {}) },
      async () => built.value,
    )
    await flush()
    expect(status(r)).toBe("pending")
    built.value = 7
    fire()
    await flush()
    expect(valueOf(r)).toBe(7)
  })

  it("hears a lazy resource's `changes` only once demanded, until it closes", () => {
    const off = vi.fn()
    const changes = vi.fn(() => off)
    const r = resource("r", { from: [], lazy: true, backoff: "manual", changes }, async () => 1)
    expect(changes).not.toHaveBeenCalled()
    r.demand()
    expect(changes).toHaveBeenCalledTimes(1)
    r.close()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it("follows another resource for the value's life", async () => {
    const signer = later<string>("signer")
    const seen: (string | undefined)[] = []
    const a = later<number>("a")
    const r = resource("r", { from: [a.resource], backoff: "manual" }, async ([n], { follow }) => {
      follow(signer.resource, (s) => seen.push(s))
      return n
    })
    a.ready(1)
    await flush()
    signer.ready("s1")
    await flush()
    a.ready(2)
    await flush()
    expect(seen).toEqual([undefined, "s1", undefined, "s1"])
    r.close()
    expect(seen.at(-1)).toBeUndefined()
  })

  it("closes: aborts the build, releases the value and builds nothing more", async () => {
    const a = later<number>("a")
    const build = vi.fn(async ([n]: readonly [number]) => n)
    const r = resource("r", { from: [a.resource], backoff: "manual" }, build)
    a.ready(1)
    await flush()
    r.close()
    expect(status(r)).toBe("pending")
    a.ready(2)
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it("is ready from the start when fixed", () => {
    expect(valueOf(fixed("wallet", 5))).toBe(5)
  })
})
