/**
 * A link's refund starts only as the account that made it: the escrow pays its creator alone, so
 * another account's refund is refused before anything is proven or recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import type { PaylinkTransaction } from "@obsidion/front-core"

const ONE_KEY = `0x${"11".repeat(32)}`
const TWO_KEY = `0x${"22".repeat(32)}`
const SECRET = `0x${"44".repeat(32)}`
const NOW = 1_800_000_000

const refund = vi.hoisted(() => vi.fn(async () => `0x${"77".repeat(32)}`))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {
    refundSponsoredPaylink = refund
    on() {}
    off() {}
  },
  decodePaylinkInline: () => ({
    paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
    secret: { toString: () => SECRET },
  }),
}))
await (await import("../../support/seedBootConfig")).seedBootConfig()
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ fpcAddress: {}, policy: {} }),
  noteSubscribed: vi.fn(),
}))
vi.mock("../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))

const { recoverSponsoredLink } = await import("../../../src/features/paylink/sponsoredPaylink")
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/platform/session"
)

const link: PaylinkTransaction = {
  action: "Pay To Email",
  emailPaymentAction: "Pay To Email",
  flavor: "direct",
  status: "success",
  timestamp: (NOW - 600) * 1000,
  txHash: `0x${"ab".repeat(32)}`,
  paylink: "https://wallet.example/link#frag",
  payToEmailSecret: SECRET,
  fallbackSecret: `0x${"55".repeat(32)}`,
  obsidionAccountAddress: ONE_KEY,
  fromClaimable: 0,
  untilClaimable: NOW + 86_400,
  refundableUntil: NOW + 3_600,
} as PaylinkTransaction

const deps = (account: string) =>
  ({
    wallet: {
      networkId: "0xnet",
      node: {
        getBlockData: async () => ({ header: { globalVariables: { timestamp: BigInt(NOW) } } }),
      },
    },
    account: { getAddress: () => ({ toString: () => account }) },
    tokenService: {
      tokenAddressOrNull: undefined,
      fetchTokenInformation: async () => ({
        address: "0xdai",
        name: "DAI",
        symbol: "DAI",
        decimals: 18,
      }),
    },
  } as unknown as Parameters<typeof recoverSponsoredLink>[0])

beforeEach(async () => {
  refund.mockClear()
  await switchSession(activeNamespace()).activity.importHistoricRows([link])
})
afterEach(closeSession)

describe("recoverSponsoredLink", () => {
  it("refuses a refund by an account that did not make the link, before proving or recording", async () => {
    await expect(recoverSponsoredLink(deps(TWO_KEY), "frag")).rejects.toThrow(
      "Only the account that made this link can take it back",
    )
    expect(refund).not.toHaveBeenCalled()
    expect(await session().activity.all()).toHaveLength(1)
  })
})
