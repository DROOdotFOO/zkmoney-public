import { beforeEach, describe, expect, it } from "vitest"
import {
  pastUserReducer,
  recallPastUser,
  rememberPastUser,
  type PastUserEvent,
  type PastUserState,
} from "../../../../src/features/onboarding/pastUserCheck"

const OLD = `0x3f${"00".repeat(17)}a91c` as const
const run = (...events: PastUserEvent[]) =>
  events.reduce(pastUserReducer, { step: "connect" } as PastUserState)

describe("past-user check", () => {
  it("holds a failed step and moves no further", () => {
    const state = run(
      { type: "connected", account: OLD },
      { type: "failed", error: "no signature" },
      { type: "signed" },
    )
    expect(state).toEqual({ step: "sign", account: OLD, error: "no signature" })
  })

  it("ignores a step out of order, and starts over for a new wallet", () => {
    expect(run({ type: "confirmed" }).step).toBe("connect")
    expect(run({ type: "connected", account: OLD }, { type: "confirmed" }).step).toBe("sign")
    const failed = run({ type: "connected", account: OLD }, { type: "failed", error: "no" })
    expect(pastUserReducer(failed, { type: "connected", account: OLD })).toEqual({
      step: "sign",
      account: OLD,
    })
  })
})

describe("past-user check across reloads", () => {
  const OWNER = "0xowner"
  beforeEach(() => sessionStorage.clear())

  it("recalls a passed check only", () => {
    rememberPastUser(OWNER, { step: "check", account: OLD })
    expect(recallPastUser(OWNER)).toEqual({ step: "connect" })
    rememberPastUser(OWNER, { step: "confirmed", account: OLD })
    expect(recallPastUser(OWNER)).toEqual({ step: "confirmed", account: OLD })
  })
})
