import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BackupRotationRecord } from "../../../src/core/storages/BackupRotationStore"
import { OWNER, signedRecord } from "../../__test-helpers__/backupRotation"

vi.mock("../../../src/core/rotation/backupRotationFlow", async (actual) => ({
  ...(await actual<typeof import("../../../src/core/rotation/backupRotationFlow")>()),
  resumeRotation: vi.fn(),
  retryMove: vi.fn(),
}))

import {
  resumeRotation,
  retryMove,
  RotationFlowError,
  type FlowResult,
  type RotationFlowDeps,
} from "../../../src/core/rotation/backupRotationFlow"
import { RotationDriver, type RotationDriveSource } from "../../../src/core/rotation/rotationDriver"

const resume = vi.mocked(resumeRotation)
const retry = vi.mocked(retryMove)
const POLL = 1000
const DEPS = { tag: "deps" } as unknown as RotationFlowDeps

/** A store whose records the test sets, delivered the way `onChanged` delivers them. */
function fakeStore(initial: BackupRotationRecord[]) {
  let records = initial
  const listeners = new Set<(records: BackupRotationRecord[]) => void>()
  return {
    list: vi.fn(async () => records),
    onChanged: (listener: (records: BackupRotationRecord[]) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set(next: BackupRotationRecord[]) {
      records = next
      for (const listener of listeners) listener(next)
    },
  }
}

/** A resume the test settles by hand. */
function held() {
  let settle!: (result: FlowResult) => void
  let fail!: (error: unknown) => void
  const promise = new Promise<FlowResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  return { promise, settle, fail }
}

const funded = (over: Partial<BackupRotationRecord> = {}) => signedRecord("funded", over)

let driver: RotationDriver

function start(records: BackupRotationRecord[], over: Partial<RotationDriveSource> = {}) {
  const store = fakeStore(records)
  const source: RotationDriveSource = {
    store,
    deps: vi.fn(async () => DEPS),
    owns: () => true,
    report: vi.fn(),
    pollMs: POLL,
    ...over,
  }
  driver.start(source)
  return { store, source }
}

beforeEach(() => {
  vi.useFakeTimers()
  driver = new RotationDriver()
  resume.mockReset()
  retry.mockReset()
})

afterEach(() => {
  driver.stop()
  vi.useRealTimers()
})

describe("RotationDriver", () => {
  it("resumes the session's records once read, never one it does not own or one still created", async () => {
    resume.mockImplementation(async (_d, record) => ({ record, wait: "funding" }))
    const other = funded({ owner: "0x00000000000000000000000000000000000000aa" })
    start([funded(), other, signedRecord("created", { owner: "0xbb" })], {
      owns: (record) => record.owner === OWNER,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume.mock.calls[0]?.[1].owner).toBe(OWNER)
    expect(resume.mock.calls[0]?.[2]).toBeUndefined()
    expect([...driver.getSnapshot().keys()]).toEqual([OWNER.toLowerCase()])
    expect(driver.drive(OWNER)?.resume).toEqual({ wait: "funding" })
  })

  it("runs one resume at a time, and resumes the record again once a run ends that it outlived", async () => {
    const first = held()
    resume.mockReturnValueOnce(first.promise)
    resume.mockImplementation(async (_d, record) => ({ record, wait: "funding" }))
    const { store } = start([funded()])
    await vi.advanceTimersByTimeAsync(0)
    const swept = funded({ phase: "swept" })
    store.set([swept])
    store.set([swept])
    await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(driver.drive(OWNER)?.resume).toBeUndefined()
    first.settle({ record: funded(), wait: "sweep" })
    await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledTimes(2)
    expect(resume.mock.calls[1]?.[1]).toBe(swept)
    // The outlived run's answer was for the record before.
    expect(driver.drive(OWNER)?.resume).toEqual({ wait: "funding" })
  })

  it("asks again after a while on a chain wait, a failure or a park, and never on the user's waits", async () => {
    const cases: [Partial<BackupRotationRecord>, FlowResult["wait"] | Error, boolean][] = [
      [{}, "sweep", true],
      [{}, "chunk", true],
      [{}, new Error("rpc down"), true],
      [{ phase: "attention", attention: "stranded", suspended: "funded" }, undefined, true],
      [{ phase: "published" }, "funding", false],
      [{ phase: "rerooted" }, "approval", false],
      [{ phase: "rerooted" }, "declined", false],
      [{ phase: "attention", attention: "move", suspended: "rerooted" }, undefined, false],
    ]
    for (const [over, answer, polls] of cases) {
      driver.stop()
      resume.mockReset()
      resume.mockImplementation(async (_d, record) => {
        if (answer instanceof Error) throw answer
        return { record, wait: answer }
      })
      start([funded(over)])
      await vi.advanceTimersByTimeAsync(0)
      expect(resume).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(POLL)
      expect(resume).toHaveBeenCalledTimes(polls ? 2 : 1)
    }
  })

  it("prompts only on approve, which waits behind the running resume", async () => {
    const background = held()
    resume.mockReturnValueOnce(background.promise)
    resume.mockImplementation(async (_d, record) => ({ record, wait: "chunk" }))
    start([funded({ phase: "rerooted" })])
    await vi.advanceTimersByTimeAsync(0)
    const approved = driver.approve(OWNER)
    await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledTimes(1)
    background.settle({ record: funded({ phase: "rerooted" }), wait: "approval" })
    await vi.advanceTimersByTimeAsync(0)
    expect(driver.drive(OWNER)?.approving).toBe(false)
    expect(await approved).toMatchObject({ wait: "chunk" })
    expect(resume).toHaveBeenCalledTimes(2)
    expect(resume.mock.calls[0]?.[2]).toBeUndefined()
    expect(resume.mock.calls[1]?.[2]).toEqual({ prompt: true })
    expect(driver.drive(OWNER)?.resume).toEqual({ wait: "chunk" })
  })

  it("shows a step the user started as running while it runs", async () => {
    const step = held()
    resume.mockImplementation(async (_d, record) => ({ record, wait: "approval" }))
    start([funded({ phase: "rerooted" })])
    await vi.advanceTimersByTimeAsync(0)
    resume.mockReturnValueOnce(step.promise)
    const approved = driver.approve(OWNER)
    await vi.advanceTimersByTimeAsync(0)
    expect(driver.drive(OWNER)).toMatchObject({ approving: true, resume: { wait: "approval" } })
    step.settle({ record: funded({ phase: "rerooted" }), wait: "chunk" })
    await approved
    expect(driver.drive(OWNER)?.approving).toBe(false)
  })

  it("a declined approval rejects to its caller and is read again without a prompt, once", async () => {
    resume.mockImplementation(async (_d, record) => ({ record, wait: "approval" }))
    start([funded({ phase: "rerooted" })])
    await vi.advanceTimersByTimeAsync(0)
    const declined = Object.assign(new Error("closed"), { name: "NotAllowedError" })
    resume.mockRejectedValueOnce(declined)
    await expect(driver.approve(OWNER)).rejects.toBe(declined)
    await vi.advanceTimersByTimeAsync(0)
    expect(resume).toHaveBeenCalledTimes(3)
    expect(resume.mock.calls[2]?.[2]).toBeUndefined()
    expect(driver.drive(OWNER)?.resume).toEqual({ wait: "approval" })
    await vi.advanceTimersByTimeAsync(POLL * 10)
    expect(resume).toHaveBeenCalledTimes(3)
  })

  it("retries a paused move only on the user's call", async () => {
    resume.mockImplementation(async (_d, record) => ({ record }))
    retry.mockImplementation(async (_d, record) => ({ record, wait: "chunk" }))
    start([funded({ phase: "attention", attention: "move", suspended: "rerooted" })])
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(retry).not.toHaveBeenCalled()
    await driver.retry(OWNER)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry.mock.calls[0]?.[0]).toBe(DEPS)
  })

  it("hands the tapping screen's signal to the step it runs", async () => {
    resume.mockImplementation(async (_d, record) => ({ record, wait: "approval" }))
    retry.mockImplementation(async (_d, record) => ({ record, wait: "chunk" }))
    start([funded({ phase: "rerooted" })])
    await vi.advanceTimersByTimeAsync(0)
    const { signal } = new AbortController()
    await driver.approve(OWNER, signal)
    expect(resume.mock.calls[1]?.[2]).toEqual({ prompt: true, signal })
    await driver.retry(OWNER, signal)
    expect(retry.mock.calls[0]?.[2]).toEqual({ signal })
  })

  it("reads the records again on the poll after a failed first read, until stopped", async () => {
    resume.mockImplementation(async (_d, record) => ({ record, wait: "funding" }))
    const { store, source } = start([funded()])
    store.list.mockRejectedValueOnce(new Error("storage busy"))
    driver.start(source)
    await vi.advanceTimersByTimeAsync(0)
    expect(source.report).toHaveBeenCalledWith("rotation read failed", expect.any(Error))
    expect(resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(driver.drive(OWNER)?.resume).toEqual({ wait: "funding" })

    store.list.mockRejectedValue(new Error("storage busy"))
    driver.start(source)
    await vi.advanceTimersByTimeAsync(0)
    const reads = store.list.mock.calls.length
    driver.stop()
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(store.list.mock.calls.length).toBe(reads)
  })

  it("refuses a user step for a record it does not drive", async () => {
    start([])
    await expect(driver.approve(OWNER)).rejects.toThrow("nothing to drive")
    expect(resume).not.toHaveBeenCalled()
  })

  it("shows no failure for a record that moved under the resume, and asks again on the poll", async () => {
    resume.mockRejectedValueOnce(new RotationFlowError("phase", "the record moved on"))
    resume.mockImplementation(async (_d, record) => ({ record, wait: "funding" }))
    const { source } = start([funded()])
    await vi.advanceTimersByTimeAsync(0)
    expect(driver.drive(OWNER)?.resume).toBeUndefined()
    expect(source.report).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL)
    expect(driver.drive(OWNER)?.resume).toEqual({ wait: "funding" })
  })

  it("reports a dependency build that failed and builds them again on the next run", async () => {
    resume.mockImplementation(async (_d, record) => ({ record, wait: "funding" }))
    const deps = vi.fn<RotationDriveSource["deps"]>()
    deps.mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(DEPS)
    const { source } = start([funded()], { deps })
    await vi.advanceTimersByTimeAsync(0)
    expect(driver.drive(OWNER)?.resume?.error).toBeInstanceOf(Error)
    expect(source.report).toHaveBeenCalledWith("resume failed", expect.any(Error))
    driver.check(OWNER)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps).toHaveBeenCalledTimes(2)
    expect(deps.mock.calls[0]?.[0]).toBe(OWNER)
    expect(driver.drive(OWNER)?.resume).toEqual({ wait: "funding" })
  })

  it("drops a record the store no longer holds", async () => {
    resume.mockImplementation(async (_d, record) => ({ record, wait: "sweep" }))
    const { store } = start([funded()])
    await vi.advanceTimersByTimeAsync(0)
    store.set([])
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(driver.drive(OWNER)).toBeUndefined()
  })

  it("runs nothing whose dependencies arrive after the session ended", async () => {
    let built!: (deps: RotationFlowDeps) => void
    const deps = vi.fn(() => new Promise<RotationFlowDeps>((resolve) => (built = resolve)))
    start([funded({ phase: "rerooted" })], { deps })
    await vi.advanceTimersByTimeAsync(0)
    const approved = driver.approve(OWNER)
    driver.stop()
    built(DEPS)
    await expect(approved).rejects.toThrow("the session ended")
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(resume).not.toHaveBeenCalled()
  })

  it("runs no tapped step whose own dependency build outlived the session", async () => {
    resume.mockImplementation(async (_d, record) => ({ record, wait: "approval" }))
    let built!: (deps: RotationFlowDeps) => void
    const deps = vi.fn<RotationDriveSource["deps"]>()
    deps.mockRejectedValueOnce(new Error("rpc down"))
    deps.mockImplementationOnce(() => new Promise((resolve) => (built = resolve)))
    start([funded({ phase: "rerooted" })], { deps })
    await vi.advanceTimersByTimeAsync(0)
    const approved = driver.approve(OWNER)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps).toHaveBeenCalledTimes(2)
    driver.stop()
    built(DEPS)
    await expect(approved).rejects.toThrow("the session ended")
    expect(resume).not.toHaveBeenCalled()
  })

  it("runs no tapped step over a record the store dropped while it waited", async () => {
    const background = held()
    resume.mockReturnValueOnce(background.promise)
    const { store } = start([funded({ phase: "rerooted" })])
    await vi.advanceTimersByTimeAsync(0)
    const approved = driver.approve(OWNER)
    store.set([])
    background.settle({ record: funded({ phase: "rerooted" }), wait: "approval" })
    await expect(approved).rejects.toThrow("nothing to drive")
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it("stops with the session: nothing more runs and a late answer is not shown", async () => {
    const run = held()
    resume.mockReturnValueOnce(run.promise)
    const { store } = start([funded()])
    await vi.advanceTimersByTimeAsync(0)
    driver.stop()
    run.settle({ record: funded(), wait: "sweep" })
    store.set([funded({ phase: "swept" })])
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(driver.getSnapshot().size).toBe(0)
  })
})
