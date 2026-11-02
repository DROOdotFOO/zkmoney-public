import { beforeEach, describe, expect, it, vi } from "vitest"
import { SIPADepositStore, type PendingRegistrationRecord } from "@obsidion/front-core"

const identity = { address: `0x${"cd".repeat(32)}`, handle: "taga", claimedAt: 1 }
vi.mock("../../../../src/features/identity/walletIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/identity/walletIdentity")>()),
  loadWalletIdentity: () => identity,
}))
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1ChainId: 11155111, l1Chain: { name: "Sepolia" } }),
}))

const { getPendingStore } = await import("../../../../src/features/onboarding/webRegistration")
const { registrationForFeed, registrationTagForDeposit, registrationTagForSipa } = await import(
  "../../../../src/features/onboarding/useRegistrationDepositEntry"
)
const { webStorage } = await import("../../../../src/platform/storage/WebStorageAdapter")
const { sweptPhase } = await import("../../../../src/features/onboarding/registrationSweep")

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const SIPA = "0x00000000000000000000000000000000000000c3"

const record = (over: Partial<PendingRegistrationRecord> = {}): PendingRegistrationRecord =>
  ({
    account: ACCOUNT,
    tag: "taga",
    nameHash: `0x${"77".repeat(32)}`,
    l2Address: identity.address,
    l1ChainId: 11155111,
    sipaAddress: SIPA,
    depositToken: "0x00000000000000000000000000000000000000d4",
    broadcast: true,
    phase: "funded",
    retries: 0,
    startTime: Date.now(),
    fundedAt: Date.now(),
    ...over,
  } as PendingRegistrationRecord)

const rail = () => SIPADepositStore.get(webStorage)

const seedDeposit = async (phase: string, amount = "15") => {
  await rail().load()
  await rail().upsert(
    SIPA as never,
    { phase, amount } as never,
    {
      networkId: "0xnet",
      amount,
      startTime: Date.now(),
    } as never,
  )
}

beforeEach(async () => {
  localStorage.clear()
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
  ;(
    (await import("@obsidion/front-core")).PendingRegistrationStore as unknown as {
      instance: unknown
    }
  ).instance = null
  await getPendingStore().load()
  await getPendingStore().upsert(ACCOUNT, {}, record())
})

/**
 * One deposit must produce one row. The registration speaks for it until the rail holds the funds;
 * from there the rail's own row and detail show, as for any deposit. The address watch and the
 * detection tick write the funds and the sweep onto the rail, and a manual sweep stamps its own
 * receipt, because the rail's scan learns of the deposit only from the Sweep log.
 */
describe("registration deposit hands over to the rail exactly once", () => {
  it("the registration speaks while the rail holds nothing at broadcast", async () => {
    await seedDeposit("broadcast", "0")
    expect(registrationForFeed()?.tag).toBe("taga")
  })

  it("falls silent once the rail holds the funds, before any sweep", async () => {
    await seedDeposit("broadcast")
    expect(registrationForFeed()).toBeNull()
  })

  it("falls silent once the rail is sweeping, so the feed shows one row", async () => {
    await seedDeposit("sweeping")
    expect(registrationForFeed()).toBeNull()
  })

  it("stays silent through every phase past the sweep", async () => {
    for (const phase of ["pendingClaim", "claimed", "recoverable", "recovered", "failed"]) {
      await seedDeposit(phase)
      expect(registrationForFeed(), `phase ${phase}`).toBeNull()
    }
  })

  it("speaks again once a recovered deposit leaves it waiting for payment", async () => {
    await getPendingStore().upsert(
      ACCOUNT,
      { phase: "awaiting_deposit", fundedAt: undefined } as never,
      record(),
    )
    await seedDeposit("recovered", "0.02")
    expect(registrationForFeed()?.tag).toBe("taga")
  })

  it("stays silent while the deposit still needs recovery", async () => {
    await getPendingStore().upsert(
      ACCOUNT,
      { phase: "awaiting_deposit", fundedAt: undefined } as never,
      record(),
    )
    await seedDeposit("recoverable", "0.02")
    expect(registrationForFeed()).toBeNull()
  })

  it("speaks when the rail has no record of the deposit at all", async () => {
    expect(registrationForFeed()?.tag).toBe("taga")
  })
})

/** The receipt the manual sweep waited for is what moves the rail; nothing else may be waiting. */
describe("a landed manual sweep advances the rail itself", () => {
  it("moves every pre-sweep phase to sweeping", () => {
    for (const phase of ["resolved", "funding", "funded", "broadcast"] as const) {
      expect(sweptPhase(phase), `from ${phase}`).toBe("sweeping")
    }
  })

  it("never walks a further-along or terminal phase backwards", () => {
    for (const phase of [
      "sweeping",
      "pendingClaim",
      "claimed",
      "recoverable",
      "recovered",
      "failed",
    ] as const) {
      expect(sweptPhase(phase), `from ${phase}`).toBe(phase)
    }
  })
})

/** Only the returned deposit's own row drops the registration identity. */
describe("a refunded deposit reads as a plain deposit", () => {
  const awaiting = () =>
    getPendingStore().upsert(
      ACCOUNT,
      { phase: "awaiting_deposit", fundedAt: undefined } as never,
      record(),
    )

  it("drops the tag once recovered and the registration waits for payment", async () => {
    await awaiting()
    await seedDeposit("recovered", "0.02")
    expect(registrationTagForDeposit(SIPA)).toBeUndefined()
  })

  it("keeps the registration identity for every other reader", async () => {
    await awaiting()
    await seedDeposit("recovered", "0.02")
    expect(registrationTagForSipa(SIPA)).toBe("taga")
  })

  it("keeps the tag while the deposit still needs recovery or the record is funded", async () => {
    await seedDeposit("recovered", "0.02")
    expect(registrationTagForDeposit(SIPA), "funded").toBe("taga")
    await awaiting()
    await seedDeposit("recoverable", "0.02")
    expect(registrationTagForDeposit(SIPA), "recoverable").toBe("taga")
  })
})
