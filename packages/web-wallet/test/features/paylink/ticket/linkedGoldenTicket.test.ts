import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CLAIM_STASH_KEY,
  peekTicketSignup,
  stashTicketSignup,
} from "../../../../src/features/paylink/claimStash"
import type { WebWalletConfig } from "../../../../src/config/env"

const h = vi.hoisted(() => ({
  redeem: vi.fn(),
}))

// The executor's withdrawal fee: 0.1 DAI.
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  activeWithdrawalFee: async () => 10n ** 17n,
  activeWithdrawalExecutor: async () => ({ fee: 10n ** 17n }),
  withdrawalExecutor: async () => ({ fee: 10n ** 17n }),
  withdrawalExecutorAt: async () => ({ fee: 10n ** 17n }),
}))
vi.mock("../../../../src/features/onboarding/goldenTicket", () => ({
  redeemGoldenTicketForLink: h.redeem,
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ portal: "0x00000000000000000000000000000000000000f0" }),
  l1PublicClient: () => ({}),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
}))

const { redeemLinkedGoldenTicket } = await import("../../../../src/features/onboarding/oxideOnboarding")

const keys = {
  account: { getAddress: () => ({ toString: () => "0x1" }) },
  secretKey: { toString: () => "0x11" },
  authProvider: {},
  pubkeyHex: "0x22",
} as never

const config = { accountServiceUrl: "http://127.0.0.1:5060" } as WebWalletConfig
const wallet = { wallet: true } as never
const DAI = 10n ** 18n
const ticket = () =>
  stashTicketSignup({
    fragment: "paylink-frag",
    threshold: (2n * DAI).toString(),
    schedule: { fee: (DAI / 2n).toString(), minDeposit: "0" },
  })

describe("redeemLinkedGoldenTicket", () => {
  beforeEach(() => {
    h.redeem.mockReset()
    sessionStorage.clear()
  })

  it("never reads a marker the hosting wizard did not hand in", async () => {
    ticket()
    await expect(redeemLinkedGoldenTicket(keys, config, wallet, null)).resolves.toBe("none")
    expect(h.redeem).not.toHaveBeenCalled()
  })

  it("throws when the ticket cannot be redeemed, naming the reason", async () => {
    ticket()
    const redeem = () => redeemLinkedGoldenTicket(keys, config, wallet, peekTicketSignup())
    h.redeem.mockResolvedValueOnce({ status: "below_threshold", amount: DAI })
    await expect(redeem()).rejects.toThrow(/below the amount that waives/)
    h.redeem.mockResolvedValueOnce({ status: "cannot_cover", amount: DAI })
    await expect(redeem()).rejects.toThrow(/cannot cover the account deposit/)
  })

  it("prices the burn from the advertised schedule before the ticket is spent, and keeps the amount", async () => {
    ticket()
    h.redeem.mockImplementationOnce(
      async (args: {
        covers: (amount: bigint, advertised?: { fee: bigint; min: bigint }) => Promise<boolean>
      }) => {
        const advertised = { fee: DAI / 2n, min: 0n }
        // 0.5 fee + 0.01 remainder + 0.1 executor fee + 0.1 relayer = 0.71 DAI. No prover tip: gas
        // never fails a link here.
        expect(await args.covers((71n * DAI) / 100n, advertised)).toBe(false)
        expect(await args.covers((71n * DAI) / 100n + 1n, advertised)).toBe(true)
        // An unadvertised schedule prices nothing, so nothing is spent on it.
        expect(await args.covers(20n * DAI, undefined)).toBe(false)
        return { status: "created", amount: 20n * DAI }
      },
    )
    await expect(redeemLinkedGoldenTicket(keys, config, wallet, peekTicketSignup())).resolves.toBe(
      "redeemed",
    )
    expect(peekTicketSignup()?.amount).toBe((20n * DAI).toString())
    expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
  })
})
