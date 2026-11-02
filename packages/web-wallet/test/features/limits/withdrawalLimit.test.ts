/** The per-withdrawal limit the sheets and the gateways share: the burn, fees included, at $1 a token. */
import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import {
  assertWithinWithdrawalLimit,
  sendLimitError,
  sharesBurnLimitProblem,
  sharesBurnMax,
  withdrawalLimitProblem,
  withdrawalLimitRefusal,
  withdrawalMaxAtomic,
} from "../../../src/features/limits/withdrawalLimit"
import { LIMIT, LIMIT_USD } from "../../support/publicLimit"

const LIMIT_ATOMIC = parseUnits(String(LIMIT), 18)
/** The source portal's `TX_AMOUNT_CAP()`, as the oxide deployments set it. */
const CAP = parseUnits("5166", 18)

describe("withdrawalLimitProblem", () => {
  it(`admits a burn of exactly ${LIMIT_USD} and refuses one atomic unit more`, () => {
    expect(withdrawalLimitProblem(LIMIT_ATOMIC, CAP)).toBeUndefined()
    expect(withdrawalLimitProblem(LIMIT_ATOMIC + 1n, CAP)).toBe("public")
  })

  it("counts in the token's own units", () => {
    expect(withdrawalLimitProblem(parseUnits(String(LIMIT), 6), CAP, 6)).toBeUndefined()
    expect(withdrawalLimitProblem(parseUnits(String(LIMIT), 6) + 1n, CAP, 6)).toBe("public")
  })

  it("refuses a burn over a portal cap below the published limit as the network's", () => {
    expect(withdrawalLimitProblem(LIMIT_ATOMIC - 1n, LIMIT_ATOMIC - 1n)).toBeUndefined()
    expect(withdrawalLimitProblem(LIMIT_ATOMIC, LIMIT_ATOMIC - 1n)).toBe("protocol")
  })
})

describe("assertWithinWithdrawalLimit", () => {
  it("throws the refusal for the subject over the limit, and nothing within it", () => {
    expect(() => assertWithinWithdrawalLimit(LIMIT_ATOMIC, CAP)).not.toThrow()
    expect(() => assertWithinWithdrawalLimit(LIMIT_ATOMIC + 1n, CAP)).toThrow(
      withdrawalLimitRefusal("public", "withdrawal"),
    )
    expect(() => assertWithinWithdrawalLimit(LIMIT_ATOMIC + 1n, CAP, "link")).toThrow(
      withdrawalLimitRefusal("public", "link"),
    )
  })

  it("never names the protocol ceiling as a figure", () => {
    for (const subject of ["withdrawal", "link"] as const) {
      expect(withdrawalLimitRefusal("protocol", subject)).not.toMatch(/\d/)
    }
  })
})

describe("sendLimitError", () => {
  it(`admits ${LIMIT_USD} and refuses one atomic unit more`, () => {
    expect(sendLimitError(LIMIT_ATOMIC)).toBeUndefined()
    expect(sendLimitError(LIMIT_ATOMIC + 1n)).toBeDefined()
    expect(sendLimitError(parseUnits(String(LIMIT), 6) + 1n, 6)).toBeDefined()
  })
})

describe("sharesBurnLimitProblem", () => {
  it("holds a Savings move out to the network's maximum per burn, not to Main's dollar limit", () => {
    expect(sharesBurnLimitProblem(LIMIT_ATOMIC + 1n, CAP)).toBeUndefined()
    expect(sharesBurnLimitProblem(CAP, CAP)).toBeUndefined()
    expect(sharesBurnLimitProblem(CAP + 1n, CAP)).toBe("protocol")
    expect(sharesBurnMax(CAP + 5n, CAP)).toBe(CAP)
    expect(sharesBurnMax(7n, CAP)).toBe(7n)
  })

  it("holds nothing back while the cap is unread", () => {
    expect(sharesBurnLimitProblem(CAP + 1n, undefined)).toBeUndefined()
    expect(sharesBurnMax(CAP + 5n, undefined)).toBe(CAP + 5n)
  })
})

describe("withdrawalMaxAtomic", () => {
  it("takes the whole balance within the limit, and the limit to the cent above it", () => {
    expect(withdrawalMaxAtomic(LIMIT_ATOMIC - 7n, CAP)).toBe(LIMIT_ATOMIC - 7n)
    expect(withdrawalMaxAtomic(LIMIT_ATOMIC * 3n, CAP)).toBe(LIMIT_ATOMIC)
  })
})
