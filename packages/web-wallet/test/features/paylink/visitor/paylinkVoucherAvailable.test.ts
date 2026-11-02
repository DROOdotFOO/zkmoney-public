/**
 * Whether a link being created can carry a cash-out voucher.
 *
 * The gift is a second use of the creator's own allowance, so promising one the allowance cannot
 * cover would fail the whole create — the link would never exist. A creator who is not subscribed
 * yet counts as able (the create subscribes). A stored 0 stays conservative: the read cannot say
 * whether the create renews it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

await (await import("../../../support/seedBootConfig")).seedBootConfig()
const { claimSponsorRail } = vi.hoisted(() => ({
  claimSponsorRail: vi.fn(async (_deps: unknown, rail: string) => ({
    sponsor: { fpcAddress: {}, fpcArtifact: {}, railId: rail === "voucher" ? 2 : 1 },
    rail: {},
  })),
}))
vi.mock("../../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorRail,
  claimSponsorContext: vi.fn(),
  noteSubscribed: vi.fn(),
}))
const { readClaimFpcAllowance } = vi.hoisted(() => ({
  readClaimFpcAllowance: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readClaimFpcAllowance,
}))

const { voucherAvailable } = await import("../../../../src/features/paylink/sponsoredPaylink")

const deps = { wallet: {}, account: { getAddress: () => ({}) }, contractService: {} } as never

const allowance = (over: Record<string, unknown>) => ({
  subscribed: true,
  uses: 0,
  maxTx: 100,
  refillPeriod: 86_400,
  ...over,
})

describe("voucherAvailable", () => {
  beforeEach(() => vi.clearAllMocks())

  it("gifts when the allowance covers the create and the gift both", async () => {
    readClaimFpcAllowance.mockResolvedValueOnce(allowance({ uses: 2 }))
    expect(await voucherAvailable(deps)).toBe(true)
  })

  it("withholds the gift when only the create itself is covered", async () => {
    readClaimFpcAllowance.mockResolvedValueOnce(allowance({ uses: 1 }))
    expect(await voucherAvailable(deps)).toBe(false)
  })

  it("withholds the gift on a stored zero, since the read cannot say whether the create renews it", async () => {
    readClaimFpcAllowance.mockResolvedValueOnce(allowance({}))
    expect(await voucherAvailable(deps)).toBe(false)
  })

  it("withholds the gift when the allowance cannot be read", async () => {
    readClaimFpcAllowance.mockRejectedValueOnce(new Error("PXE is busy"))
    expect(await voucherAvailable(deps)).toBe(false)
  })
})
