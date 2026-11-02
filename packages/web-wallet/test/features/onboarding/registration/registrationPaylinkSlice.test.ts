import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { webStorage } from "../../../../src/platform/storage/WebStorageAdapter"
import {
  commitRegistrationProverTip,
  rememberReissuedClaim,
  saveRegistrationTerms,
  type RegistrationTerms,
} from "../../../../src/features/onboarding/registrationTerms"
import {
  dai,
  earnedTerms,
  FAR_DEADLINE,
  pendingRecord,
  ticketBoundTerms,
} from "../../../support/registrationFixtures"

const PORTAL = `0x${"11".repeat(20)}`
const h = vi.hoisted(() => ({ tuple: vi.fn() }))
// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("../../../../src/config/env", async (original) => ({
  ...(await original<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))
vi.mock("../../../../src/config/oxideTuple", async (original) => ({
  ...(await original<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: h.tuple,
  l1PublicClient: () => ({}),
}))
const { registrationSlice, RegistrationFundingError } = await import(
  "../../../../src/features/paylink/sponsoredPaylink"
)
const account = `0x${"aa".repeat(20)}`
const l2Address = `0x${"bb".repeat(32)}` as const
const sipaAddress = `0x${"cc".repeat(20)}` as const
const deps = { account: { getAddress: () => ({ toString: () => l2Address }) } } as never
const noteAmount = dai(3)
const store = PendingRegistrationStore.get(webStorage)
/** Fee 0.5, no minimum, no prover tip: SIPA target 0.51, burn 0.61, return 0.01. */
const BURN = dai(0.61)

const terms = (over: Partial<RegistrationTerms> = {}) =>
  saveRegistrationTerms(
    ticketBoundTerms({
      account,
      tag: "alice",
      deadline: Number(FAR_DEADLINE),
      paylinkId: "id:link",
      ...over,
    }),
  )
/** The slice a ticket-funded claim of `note` burns. */
const fund = (note = noteAmount, nowMs?: number) => registrationSlice(deps, note, true, nowMs)

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (err) {
    if (err instanceof RegistrationFundingError) return err.reason
    throw err
  }
  return "claimed"
}

beforeEach(async () => {
  localStorage.clear()
  await store.load()
  vi.clearAllMocks()
  h.tuple.mockResolvedValue({ portal: PORTAL })
  await store.upsert(
    account,
    {},
    pendingRecord({ account, tag: "alice", l2Address, l1ChainId: 31337, sipaAddress }),
  )
  terms()
})

describe("paylink registration funding", () => {
  it("never burns for an ordinary claim, even with an unfunded pending reservation", async () => {
    expect(await registrationSlice(deps, noteAmount, false)).toBeUndefined()
    expect(h.tuple).not.toHaveBeenCalled()
    // A second ordinary claim before L1 finalization must also retain its entire note.
    expect(await registrationSlice(deps, noteAmount, false)).toBeUndefined()
  })

  it("burns the ticket quote to the reserved SIPA when asked to fund it", async () => {
    const slice = await fund()
    expect(slice?.l1Recipient.toString().toLowerCase()).toBe(sipaAddress)
    expect(slice?.amount).toBe(BURN)
    expect(slice?.relayerTip).toBe(WITHDRAW_RELAYER_TIP)
    expect(slice?.proverTip).toBe(0n)
    expect(slice?.target).toBe(dai(0.51))
    expect(slice?.withdrawal).toEqual({ tuple: { portal: PORTAL }, l1: expect.anything() })
  })

  it("refuses lapsed terms before pricing anything", async () => {
    const lapsed = Math.floor(Date.now() / 1000) - 60
    terms({ deadline: lapsed })
    expect(await refusal(fund())).toBe("expired")
    expect(h.tuple).not.toHaveBeenCalled()
    // The clock the caller passes decides, not the wall clock alone.
    expect((await fund(noteAmount, lapsed * 1000 - 1))?.amount).toBe(BURN)
    // A deadline of zero is a stamp with no reservation behind it, not a lapse.
    terms({ deadline: 0 })
    expect((await fund())?.amount).toBe(BURN)
  })

  it("prices an unpublished address and names it for the batch to publish", async () => {
    expect((await fund())?.unpublished).toBeUndefined()
    await store.upsert(account, { broadcast: false })
    const slice = await fund()
    expect(slice?.amount).toBe(BURN)
    expect(slice?.unpublished).toMatchObject({ account, sipaAddress, broadcast: false })
  })

  it("funds a signed minimum above the remainder once, never on top of it", async () => {
    terms({ minDeposit: String(dai(1)) })
    expect((await fund())?.amount).toBe(dai(1.6))
  })

  it("keeps the committed tip through a renewal", async () => {
    commitRegistrationProverTip(account, "alice", dai(0.4), "faster")
    rememberReissuedClaim(
      { account, tag: "alice", fee: String(dai(0.5)) },
      {
        hold: { deadline: "4102444900" },
        terms: earnedTerms({ minDeposit: "0", ticket: true }),
      },
    )
    expect((await fund())?.proverTip).toBe(dai(0.4))
  })

  it.each([["the committed tip", dai(0.4)]])(
    "refuses a note that only equals the burn with %s, and takes one a wei over it",
    async (_, tip) => {
      commitRegistrationProverTip(account, "alice", tip, "faster")
      expect(await refusal(fund(BURN + tip))).toBe("uncovered")
      expect((await fund(BURN + tip + 1n))?.amount).toBe(BURN + tip)
    },
  )

  it("refuses to price the burn while the note amount is unknown", async () => {
    expect(await refusal(registrationSlice(deps, undefined, true))).toBe("unpriced")
  })

  it("refuses a registration with no signed schedule instead of guessing one", async () => {
    terms({ fee: undefined, minDeposit: undefined })
    expect(await refusal(fund())).toBe("no_schedule")
    terms({ fee: "0", minDeposit: "0" })
    expect(await refusal(fund())).toBe("no_schedule")
  })

  it("refuses when no registration waits for the deposit", async () => {
    await store.remove(account)
    expect(await refusal(fund())).toBe("no_registration")
  })

  it("refuses terms no paylink funds, whatever the waiver flag says, before reading anything", async () => {
    terms({ fee: String(dai(10)), minDeposit: String(dai(5)), paylinkFunded: false })
    expect(await refusal(fund())).toBe("not_ticket")
    terms({ paylinkFunded: false })
    expect(await refusal(fund())).toBe("not_ticket")
    localStorage.clear()
    expect(await refusal(fund())).toBe("not_ticket")
    expect(h.tuple).not.toHaveBeenCalled()
  })

  it("refuses a binding the last renewal blocked", async () => {
    terms({ paylinkBlocked: true })
    expect(await refusal(fund())).toBe("blocked")
    expect(h.tuple).not.toHaveBeenCalled()
  })
})

describe("a link that pays an ordinary deposit", () => {
  /** A drawn tag's signed deposit, bound to the link with no ticket behind it. */
  const depositTerms = () =>
    saveRegistrationTerms({
      account,
      tag: "alice",
      deadline: Number(FAR_DEADLINE),
      fee: String(dai(0.5)),
      minDeposit: String(dai(1)),
      feeWaived: true,
      paylinkFunded: true,
      paylinkDeposit: true,
      paylinkId: "id:link",
    })
  const renew = () =>
    rememberReissuedClaim(
      { account, tag: "alice", fee: String(dai(0.5)) },
      {
        hold: { deadline: "4102444900" },
        terms: earnedTerms({ fee: String(dai(0.5)), minDeposit: String(dai(1)) }),
      },
    )

  it("stays the link's through a renewal that quotes no ticket", async () => {
    depositTerms()
    expect(renew()).toEqual({ ticketRefused: false })
    expect((await fund())?.amount).toBe(dai(1.6))
  })
})
