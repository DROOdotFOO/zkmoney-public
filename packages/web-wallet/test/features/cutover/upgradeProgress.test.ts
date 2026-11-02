import { describe, expect, it } from "vitest"
import type { MetadataMigrationPhase } from "@obsidion/front-core"
import { queueProgress, upgradeSteps } from "../../../src/features/cutover/upgradeProgress"

const run = (phase: MetadataMigrationPhase) => ({ phase })

describe("the ring over a queued upgrade", () => {
  it("never moves back as the queue approves, proves and sends one run after the other", () => {
    const steps: [MetadataMigrationPhase[], number][] = [
      [["preparing", "preparing"], 0],
      [["preparing", "preparing"], 1],
      [["broadcasting", "preparing"], 2],
      [["broadcasting", "preparing"], 3],
      [["broadcasting", "broadcasting"], 3],
      [["subscribing", "broadcasting"], 3],
      [["recovering", "broadcasting"], 3],
      [["arriving", "broadcasting"], 3],
      [["arriving", "waiting"], 3],
      [["arriving", "recovering"], 3],
      [["arriving", "arriving"], 3],
    ]
    const percents = steps.map(
      ([phases, approved]) => queueProgress(phases.map(run), { approved, total: 3 }).percent,
    )
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    expect(percents).toEqual([1, 11, 21, 31, 33, 47, 52, 59, 68, 78, 85])
  })

  it("shows the upgrade's approvals while a run has yet to approve", () => {
    expect(queueProgress([run("arriving"), null], { approved: 1, total: 3 }).percent).toBe(11)
  })
})

describe("the Upgrading page's steps", () => {
  it("follow a queued upgrade in the order it runs: the account's update, then the old version's funds", () => {
    const phases: MetadataMigrationPhase[][] = [
      ["preparing", "preparing"],
      ["broadcasting", "broadcasting"],
      ["subscribing", "broadcasting"],
      ["recovering", "broadcasting"],
      ["arriving", "waiting"],
      ["arriving", "recovering"],
      ["arriving", "arriving"],
      ["done", "done"],
    ]
    expect(phases.map((runs) => upgradeSteps(runs, false))).toEqual([
      ["active", "todo", "todo"],
      ["active", "todo", "todo"],
      ["active", "todo", "todo"],
      ["done", "active", "todo"],
      ["done", "active", "todo"],
      ["done", "active", "todo"],
      ["done", "done", "active"],
      ["done", "done", "done"],
    ])
  })

  it("keep the account's update open while a run waits for it", () => {
    expect(upgradeSteps(["waiting"], false)).toEqual(["active", "todo", "todo"])
  })

  it("start at the withdrawal for an account already updated", () => {
    expect(upgradeSteps(["preparing"], true)).toEqual(["done", "active", "todo"])
  })
})
