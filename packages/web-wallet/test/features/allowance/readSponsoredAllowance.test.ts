/**
 * Which ClaimFPC instance the allowance is read from: the one `claimSponsorContext` picks for the
 * account's sponsored batches, which may be a retired generation. While registration is pending no
 * instance is picked yet, so the current instance answers (it reports no subscription).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RegistrationPendingError } from "../../../src/features/onboarding/registrationRail"

const { claimSponsorContext, claimSponsorRail, readClaimFpcAllowance } = vi.hoisted(() => ({
  claimSponsorContext: vi.fn(),
  claimSponsorRail: vi.fn(),
  readClaimFpcAllowance: vi.fn(async () => ({
    subscribed: false,
    uses: 0,
    maxTx: 100,
    refillPeriod: 86_400,
  })),
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext,
  claimSponsorRail,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readClaimFpcAllowance,
}))

const { readSponsoredAllowance } = await import("../../../src/features/allowance/readAllowance")

const user = { toString: () => "0xuser" }
const deps = { wallet: {}, account: { getAddress: () => user }, contractService: {} } as never
const sponsor = (address: string, railId: number) => ({
  fpcAddress: { toString: () => address },
  fpcArtifact: { name: address },
  railId,
})

describe("readSponsoredAllowance", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reads the instance and rail the account's batches use", async () => {
    claimSponsorContext.mockResolvedValueOnce(sponsor("0xretired", 1))
    const read = await readSponsoredAllowance(deps)
    expect(claimSponsorContext).toHaveBeenCalledWith(deps, "registered")
    expect(readClaimFpcAllowance).toHaveBeenCalledWith(
      {},
      expect.anything(),
      { name: "0xretired" },
      user,
      1,
    )
    expect(read).toMatchObject({ fpcAddress: "0xretired", railId: 1, payer: "0xuser" })
  })

  it("reads the payer's note when the context names one", async () => {
    const payer = { toString: () => "0xpayer" }
    claimSponsorContext.mockResolvedValueOnce({ ...sponsor("0xcurrent", 1), payer })
    const read = await readSponsoredAllowance(deps)
    expect(readClaimFpcAllowance).toHaveBeenCalledWith(
      {},
      expect.anything(),
      { name: "0xcurrent" },
      payer,
      1,
    )
    expect(read.payer).toBe("0xpayer")
  })

  it("falls back to the current instance while registration is pending", async () => {
    claimSponsorContext.mockRejectedValueOnce(new RegistrationPendingError({ pending: "message" }))
    claimSponsorRail.mockResolvedValueOnce({ sponsor: sponsor("0xcurrent", 1), rail: {} })
    const read = await readSponsoredAllowance(deps)
    expect(claimSponsorRail).toHaveBeenCalledWith(deps, "registered")
    expect(read.fpcAddress).toBe("0xcurrent")
  })

  it("surfaces any other failure as a failed read", async () => {
    claimSponsorContext.mockRejectedValueOnce(new Error("L1 unreachable"))
    await expect(readSponsoredAllowance(deps)).rejects.toThrow("L1 unreachable")
    expect(claimSponsorRail).not.toHaveBeenCalled()
  })
})
