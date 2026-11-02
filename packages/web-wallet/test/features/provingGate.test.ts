/**
 * The proving gate is what keeps a background SIPA broadcast or upgrade step from making a user's
 * send/withdraw, or another background proof, throw `LocalProvingInFlight`: background proofs run
 * one at a time and must not start while a user flow runs, and a user flow must wait out a proof
 * already in flight rather than collide with it.
 */
import { describe, expect, it } from "vitest"
import { runUserFlow, trackBackgroundProve, userFlowActive } from "../../src/features/provingGate"

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("provingGate", () => {
  it("raises the flag synchronously and lowers it when the flow settles", async () => {
    expect(userFlowActive()).toBe(false)
    const gate = deferred()
    const flow = runUserFlow(() => gate.promise)
    // Synchronous: a background prover checking in the same tick must already see the flag.
    expect(userFlowActive()).toBe(true)
    gate.resolve()
    await flow
    expect(userFlowActive()).toBe(false)
  })

  it("lowers the flag when the flow throws", async () => {
    await expect(runUserFlow(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(userFlowActive()).toBe(false)
  })

  it("holds the flag until the last concurrent flow ends", async () => {
    const a = deferred()
    const b = deferred()
    const flowA = runUserFlow(() => a.promise)
    const flowB = runUserFlow(() => b.promise)
    a.resolve()
    await flowA
    expect(userFlowActive()).toBe(true)
    b.resolve()
    await flowB
    expect(userFlowActive()).toBe(false)
  })

  it("makes a user flow wait out an in-flight background proof", async () => {
    const proof = deferred()
    void trackBackgroundProve(() => proof.promise)
    let started = false
    const flow = runUserFlow(async () => {
      started = true
    })
    await Promise.resolve()
    expect(started).toBe(false)
    proof.resolve()
    await flow
    expect(started).toBe(true)
  })

  it("runs background proofs one at a time, in the order they were reserved", async () => {
    const first = deferred()
    const second = deferred()
    const started: string[] = []
    const a = trackBackgroundProve(async () => {
      started.push("a")
      await first.promise
    })
    const b = trackBackgroundProve(async () => {
      started.push("b")
      await second.promise
    })
    const c = trackBackgroundProve(async () => void started.push("c"))
    await Promise.resolve()
    expect(started).toEqual(["a"])
    first.reject(new Error("proof died"))
    await expect(a).rejects.toThrow("proof died")
    await Promise.resolve()
    expect(started).toEqual(["a", "b"])
    second.resolve()
    await Promise.all([b, c])
    expect(started).toEqual(["a", "b", "c"])
  })

  it("starts a waiting background proof only once a user flow raised before its turn has ended", async () => {
    const proof = deferred()
    const flow = deferred()
    const started: string[] = []
    void trackBackgroundProve(() => proof.promise)
    const queued = trackBackgroundProve(async () => void started.push("background"))
    const user = runUserFlow(async () => {
      started.push("user")
      await flow.promise
    })
    proof.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(["user"])
    flow.resolve()
    await Promise.all([user, queued])
    expect(started).toEqual(["user", "background"])
  })

  it("a failed background proof neither fails nor blocks the user flow", async () => {
    const proof = deferred()
    const tracked = trackBackgroundProve(() => proof.promise)
    proof.reject(new Error("proof died"))
    // The failure still belongs to the background caller...
    await expect(tracked).rejects.toThrow("proof died")
    // ...and the user flow sails through.
    await expect(runUserFlow(async () => "ok")).resolves.toBe("ok")
  })
})
