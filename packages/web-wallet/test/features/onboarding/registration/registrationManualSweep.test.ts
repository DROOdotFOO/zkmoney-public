import { beforeEach, describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import {
  PendingRegistrationStore,
  canManualRegistrationSweep,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { assertScreened, registrationRecordForSipa } from "../../../../src/features/onboarding/registrationSweep"
import {
  archiveReplacedRegistration,
  getPendingStore,
} from "../../../../src/features/onboarding/webRegistration"

describe("canManualRegistrationSweep", () => {
  const base = { phase: "awaiting_deposit", sweptAt: undefined, sweepTxHash: undefined } as const

  it("offers on a pending record, funded or not", () => {
    expect(canManualRegistrationSweep({ ...base })).toBe(true)
    expect(canManualRegistrationSweep({ ...base, phase: "funded" })).toBe(true)
  })

  it("never offers once a sweep is submitted, observed, or the record is settled", () => {
    expect(canManualRegistrationSweep({ ...base, sweepTxHash: "0x1" })).toBe(false)
    expect(canManualRegistrationSweep({ ...base, sweptAt: 1 })).toBe(false)
    expect(canManualRegistrationSweep({ ...base, phase: "confirmed" })).toBe(false)
    expect(canManualRegistrationSweep({ ...base, phase: "failed_taken" })).toBe(false)
  })
})

describe("assertScreened", () => {
  const ADDR = "0x00000000000000000000000000000000000000aa" as Address

  it("passes silently with no screener or a compliant verdict", async () => {
    await assertScreened(undefined, ADDR)
    await assertScreened(async () => ({ compliant: true }), ADDR)
  })

  it("throws Predicate's message on a blocked verdict", async () => {
    await expect(
      assertScreened(
        async () => ({ compliant: false, reason: { code: "blocked", message: "Address blocked" } }),
        ADDR,
      ),
    ).rejects.toThrow("Address blocked")
    await expect(assertScreened(async () => ({ compliant: false }), ADDR)).rejects.toThrow(
      "This address can't be used here",
    )
  })
})

describe("registrationRecordForSipa", () => {
  const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
  const SIPA = "0x00000000000000000000000000000000000000c3" as Address

  function record(): Omit<PendingRegistrationRecord, "account"> {
    return {
      tag: "alice",
      nameHash: `0x${"77".repeat(32)}` as Hex,
      l2Address: `0x${"cd".repeat(32)}` as Hex,
      l1ChainId: 11155111,
      sipaAddress: SIPA,
      fee: "1",
      beneficiary: "0x00000000000000000000000000000000000000b5",
      depositToken: "0x00000000000000000000000000000000000000d4" as Address,
      broadcast: true,
      phase: "awaiting_deposit",
      retries: 0,
      startTime: Date.now(),
    }
  }

  beforeEach(() => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
  })

  it("finds the pending registration behind a rail-tracked SIPA, case-insensitively", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record())
    expect(registrationRecordForSipa(SIPA)?.tag).toBe("alice")
    expect(registrationRecordForSipa(SIPA.toUpperCase() as Address)?.tag).toBe("alice")
  })

  it("finds a registration the earned quote replaced, closed to any sweep; a live record wins", async () => {
    archiveReplacedRegistration({ ...record(), account: ACCOUNT })
    const archived = registrationRecordForSipa(SIPA)!
    expect(archived).toMatchObject({ tag: "alice", fee: "1", phase: "failed_terminal" })
    expect(canManualRegistrationSweep(archived)).toBe(false)
    await getPendingStore().upsert(ACCOUNT, {}, { ...record(), tag: "alice-live" })
    expect(registrationRecordForSipa(SIPA)?.tag).toBe("alice-live")
  })
})
