import { describe, expect, it } from "vitest"
import { activationSteps } from "../../../src/features/onboarding/activationSteps"

describe("activationSteps", () => {
  it("asks for the passkey before the deposit", () => {
    expect(activationSteps({ account: false, deposited: false })).toEqual([
      { id: "passkey", done: false },
      { id: "deposit", done: false, busy: false },
    ])
  })
})
