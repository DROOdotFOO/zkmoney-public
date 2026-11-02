/**
 * The demo's fake L1 answers the sweep fee the deployments charge, so a scenario reviewed offline
 * shows the figure a real wallet shows. Read from oxide's pin.
 */
import { describe, expect, it } from "vitest"
import { DEPOSIT_SWEEP_FEE } from "@oxide/l1-contracts/deploy/deploy_forwarding_table.js"
import { DEMO_DEPOSIT_FEE } from "../../src/dev/fakeL1Rpc"

describe("the demo's portal terms against oxide's pin", () => {
  it("answers the sweep tip oxide's forwarding table charges a deposit", () => {
    expect(DEMO_DEPOSIT_FEE).toBe(DEPOSIT_SWEEP_FEE)
  })
})
