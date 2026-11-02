import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { AccountServiceError, NameClaimStore, type NameClaimRecord } from "@obsidion/front-core"
import { webStorage } from "../../../../src/platform/storage/WebStorageAdapter"
import { CLAIM_WAIT_NOTICE, requireNameClaim } from "../../../../src/features/onboarding/nameClaim"
import {
  loadRegistrationTerms,
  saveRegistrationTerms,
} from "../../../../src/features/onboarding/registrationTerms"
import { earnedTerms, nameClaim } from "../../../support/registrationFixtures"

const mocks = vi.hoisted(() => ({ signDomain: vi.fn() }))

vi.mock("../../../../src/features/onboarding/oxideOnboarding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  accountServiceFor: () => ({ signDomain: mocks.signDomain }),
}))
vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: () => ({}),
}))

const RECORD = {
  account: "0x00000000000000000000000000000000000000aa",
  tag: "alice",
  nameHash: `0x${"77".repeat(32)}` as Hex,
  l2Address: `0x${"cd".repeat(32)}` as Hex,
}

const KEYS = { secretKey: {} as never }

function cachedClaim(overrides: Partial<NameClaimRecord> = {}): NameClaimRecord {
  return {
    address: RECORD.l2Address,
    handle: "alice",
    nameHash: RECORD.nameHash,
    signature: "0xcafe",
    nonce: "1",
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  NameClaimStore.resetForTests()
  NameClaimStore.get(webStorage)
  mocks.signDomain.mockReset()
})

describe("requireNameClaim", () => {
  it("keeps the reservation the screen shows in step with a re-issued claim", async () => {
    saveRegistrationTerms({
      account: RECORD.account,
      tag: "alice",
      deadline: 1,
      fee: "1",
      minDeposit: "4",
      feeWaived: true,
      depositAmount: "5",
    })
    const deadline = String(Math.floor(Date.now() / 1000) + 3600)
    mocks.signDomain.mockResolvedValue(
      nameClaim({ deadline, terms: earnedTerms({ fee: "1", minDeposit: "4" }) }),
    )
    await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)
    expect(loadRegistrationTerms(RECORD.account, "alice")).toMatchObject({
      deadline: Number(deadline),
      fee: "1",
      feeWaived: true,
      depositAmount: "5",
    })
  })

  it("leaves the stored terms alone when the re-issued quote prices another fee", async () => {
    saveRegistrationTerms({ account: RECORD.account, tag: "alice", deadline: 1, feeWaived: false })
    mocks.signDomain.mockResolvedValue(nameClaim({ terms: earnedTerms({ fee: "2" }) }))
    await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)
    expect(loadRegistrationTerms(RECORD.account, "alice")?.deadline).toBe(1)
  })

  it("re-requests past an expired or mismatched cached claim", async () => {
    mocks.signDomain.mockResolvedValue(nameClaim({ signature: "0xbeef" }))
    await NameClaimStore.get().put(cachedClaim({ deadline: "1" }))
    expect((await requireNameClaim(RECORD, KEYS)).signature).toBe("0xbeef")
    await NameClaimStore.get().put(cachedClaim({ nameHash: `0x${"88".repeat(32)}` }))
    expect((await requireNameClaim(RECORD, KEYS)).signature).toBe("0xbeef")
  })
})

/** A terms-less claim: the controller's own fee is the only thing that can price one. */
describe("requireNameClaim against a terms-less cache", () => {
  const OFFLINE = new Error("connection refused")
  const withTerms = (fee: string) => ({ terms: earnedTerms({ fee }) })
  const priced = (fee: string) => nameClaim({ signature: "0xbeef", ...withTerms(fee) })

  it("sweeps the committed fee off the controller's own fee, with no request", async () => {
    await NameClaimStore.get().put(cachedClaim())

    const claim = await requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee: 1n })

    expect(claim.signature).toBe("0xcafe")
    expect(mocks.signDomain).not.toHaveBeenCalled()
  })

  it("re-signs when the controller prices another fee, and caches what lands", async () => {
    await NameClaimStore.get().put(cachedClaim())
    mocks.signDomain.mockResolvedValue(priced("1"))

    const claim = await requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee: 9n })

    expect(claim.signature).toBe("0xbeef")
    expect(claim.terms?.fee).toBe("1")
    expect((await NameClaimStore.get().get(RECORD.l2Address))?.signature).toBe("0xbeef")
  })

  it("re-signs while the controller's fee is unread", async () => {
    await NameClaimStore.get().put(cachedClaim())
    mocks.signDomain.mockResolvedValue(priced("1"))

    expect((await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)).signature).toBe("0xbeef")
    expect(mocks.signDomain).toHaveBeenCalledTimes(1)
  })

  it("serves a cache priced at the record's fee without a request", async () => {
    await NameClaimStore.get().put(cachedClaim(withTerms("1")))
    expect((await requireNameClaim({ ...RECORD, fee: "1" }, KEYS)).signature).toBe("0xcafe")
    expect(mocks.signDomain).not.toHaveBeenCalled()
  })

  it.each([
    ["a terms-less cache the controller prices otherwise", {}, 9n],
    ["a cache priced at another fee", withTerms("10"), undefined],
    ["an expired cache the controller's fee would price", { deadline: "1" }, 1n],
  ])("throws when the re-sign fails rather than serve %s", async (_, cached, controllerFee) => {
    await NameClaimStore.get().put(cachedClaim(cached))
    mocks.signDomain.mockRejectedValue(OFFLINE)

    await expect(
      requireNameClaim({ ...RECORD, fee: "1" }, KEYS, { controllerFee }),
    ).rejects.toMatchObject({ cause: OFFLINE })
  })
})

/** The three 409s the service classes wait-and-retry, against everything else it can refuse with. */
describe("requireNameClaim refusal handling", () => {
  const refusal = (status: number, reason: string) =>
    new AccountServiceError(status, "refused", { error: "refused", reason })

  const CLAIM = nameClaim({ signature: "0xbeef" })

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("waits out a claim_conflict, telling the caller it is waiting, and caches what lands", async () => {
    mocks.signDomain
      .mockRejectedValueOnce(refusal(409, "claim_conflict"))
      .mockResolvedValueOnce(CLAIM)
    const onNotice = vi.fn()

    const pending = requireNameClaim(RECORD, KEYS, { onNotice })
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await pending).signature).toBe("0xbeef")
    expect(mocks.signDomain).toHaveBeenCalledTimes(2)
    expect(onNotice.mock.calls).toEqual([[CLAIM_WAIT_NOTICE]])
    expect((await NameClaimStore.get().get(RECORD.l2Address))?.signature).toBe("0xbeef")
  })

  it("fails fast on a terminal refusal, with no wait and no second request", async () => {
    mocks.signDomain.mockRejectedValue(refusal(409, "name_reserved"))
    const onNotice = vi.fn()

    await expect(requireNameClaim(RECORD, KEYS, { onNotice })).rejects.toThrow(
      "Couldn't refresh the reservation for this name: refused",
    )
    expect(mocks.signDomain).toHaveBeenCalledTimes(1)
    expect(onNotice).not.toHaveBeenCalled()
  })

  it("blames the hold, not the name, once the wait runs out", async () => {
    mocks.signDomain.mockRejectedValue(refusal(409, "claim_conflict"))

    const pending = requireNameClaim(RECORD, KEYS).then(
      () => {
        throw new Error("expected the refusal to outlast the wait")
      },
      (e: Error) => e,
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const err = await pending

    expect(err.message).toMatch(/reserved to another address on this device/)
    expect(err.message).toMatch(/clears by itself/)
    expect(err.message).not.toMatch(/taken|reserved by another user/)
  })
})
