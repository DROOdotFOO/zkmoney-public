// @vitest-environment node
import type { FundingAmount, SpendShape } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../../src/features/withdraw/useWithdrawals", () => ({ useWithdrawals: () => ({}) }))
vi.mock("../../../src/features/migration/oldVersionBalance", () => ({
  useOldVersionHoldings: () => ({}),
}))
vi.mock("../../../src/features/migration/upgradeLock", () => ({
  useUpgradeLock: () => ({ state: "pending" }),
}))
vi.mock("../../../src/features/identity/walletIdentity", () => ({ loadWalletIdentity: () => null }))
vi.mock("../../../src/features/onboarding/registrationResume", () => ({ unlockedSessionKeys: () => {} }))
vi.mock("../../../src/features/token/oxideToken", () => ({ currentTxAmountCap: () => {} }))
vi.mock("../../../src/config/classArtifacts", () => ({ getWebOxideToken: () => {} }))
vi.mock("../../../src/config/oxideTuple", () => ({}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))

const { chainFacts, withdrawalInFlight } = await import(
  "../../../src/features/backupPasskey/backupPasskeyFacts"
)

const DAI = 10n ** 18n
const funding = (amount: bigint): FundingAmount =>
  ({ amount, credited: amount / 2n, breakdown: {} } as FundingAmount)
const shape = (notes: bigint[], depositTotal = 0n): SpendShape => ({
  notes,
  depositTotal,
  balance: notes.reduce((a, b) => a + b, 0n) + depositTotal,
})

describe("chainFacts", () => {
  it("names a route that is not live, with nothing to fund", () => {
    const facts = chainFacts({ funding: undefined, shape: shape([3n * DAI]), cap: 5n * DAI })
    expect(facts).toMatchObject({ routeLive: false, fundingAmount: 0n, chunk: { kind: "fits" } })
  })

  it("has no plan over a cap of nothing", () => {
    const facts = chainFacts({ funding: funding(DAI), shape: shape([3n * DAI]), cap: 0n })
    expect(facts).toMatchObject({ plan: false, moves: 0 })
  })
})

describe("withdrawalInFlight", () => {
  it("counts a withdrawal in any phase but the settled ones", () => {
    expect(
      withdrawalInFlight([{ phase: "done" }, { phase: "failed" }, { phase: "recovered" }]),
    ).toBe(false)
    expect(withdrawalInFlight([{ phase: "done" }, { phase: "finalizing_l1" }])).toBe(true)
    expect(withdrawalInFlight([])).toBe(false)
  })
})
