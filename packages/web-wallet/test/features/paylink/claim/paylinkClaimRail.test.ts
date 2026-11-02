/**
 * Who pays for a sponsored L2 claim. A registered account rides its own rail; the link's voucher is
 * for an account with no rail yet, and the only payer of a claim that funds a registration. Only a
 * read that succeeded can say the voucher is spent: a read that failed stops the claim on a
 * retryable error rather than a refusal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

await (await import("../../../support/seedBootConfig")).seedBootConfig()
const VOUCHER = { fpcAddress: {}, fpcArtifact: {}, railId: 2 }
const REGISTERED = { fpcAddress: {}, fpcArtifact: {}, railId: 1 }
const { claimSponsorRail, claimSponsorContext } = vi.hoisted(() => ({
  claimSponsorRail: vi.fn(),
  claimSponsorContext: vi.fn(),
}))
vi.mock("../../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorRail,
  claimSponsorContext,
  noteSubscribed: vi.fn(),
}))
const { paylinkVoucherUses } = vi.hoisted(() => ({ paylinkVoucherUses: vi.fn() }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  paylinkVoucherUses,
}))

const { claimRail, VoucherReadError } = await import("../../../../src/features/paylink/sponsoredPaylink")

const deps = { wallet: {}, account: { getAddress: () => ({}) }, contractService: {} } as never
const params = {} as never
const noRegisteredRail = new Error("not subscribed on the registered rail")
const unreadable = new Error("PXE is busy")

describe("claimRail — an ordinary claim", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    claimSponsorRail.mockResolvedValue({ sponsor: VOUCHER, rail: {} })
    claimSponsorContext.mockResolvedValue(REGISTERED)
  })

  it("rides the claimer's registered rail without touching the voucher", async () => {
    expect(await claimRail(deps, params, false)).toEqual({
      sponsor: REGISTERED,
      voucherRail: undefined,
    })
    expect(paylinkVoucherUses).not.toHaveBeenCalled()
  })

  it("stops on the read's error when the voucher cannot be read, not on the refusal", async () => {
    claimSponsorContext.mockRejectedValueOnce(noRegisteredRail)
    paylinkVoucherUses.mockRejectedValueOnce(unreadable)
    const failure = await claimRail(deps, params, false).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(VoucherReadError)
    expect((failure as Error).message).toMatch(/couldn't check whether this link still pays/)
    expect((failure as Error).cause).toBe(unreadable)
  })

  it("treats a voucher rail that cannot be resolved as an unreadable voucher", async () => {
    claimSponsorContext.mockRejectedValueOnce(noRegisteredRail)
    claimSponsorRail.mockRejectedValueOnce(new Error("record read timed out"))
    await expect(claimRail(deps, params, false)).rejects.toBeInstanceOf(VoucherReadError)
    expect(paylinkVoucherUses).not.toHaveBeenCalled()
  })
})

describe("claimRail — a claim that funds the registration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    claimSponsorRail.mockResolvedValue({ sponsor: VOUCHER, rail: {} })
    claimSponsorContext.mockResolvedValue(REGISTERED)
  })

  it("rides the voucher and never the registered rail", async () => {
    paylinkVoucherUses.mockResolvedValueOnce(1)
    expect(await claimRail(deps, params, true)).toEqual({ sponsor: VOUCHER, voucherRail: VOUCHER })
    expect(claimSponsorContext).not.toHaveBeenCalled()
  })

  it("stops on the read's error when the voucher cannot be read, never calling it spent", async () => {
    paylinkVoucherUses.mockRejectedValueOnce(unreadable)
    const failure = await claimRail(deps, params, true).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(VoucherReadError)
    expect((failure as Error).message).not.toMatch(/spent/)
    claimSponsorRail.mockRejectedValueOnce(new Error("record read timed out"))
    await expect(claimRail(deps, params, true)).rejects.toBeInstanceOf(VoucherReadError)
  })
})
