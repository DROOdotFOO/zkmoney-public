import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import type { SipaProcessingState } from "../../src/core/services/deposits/sipaProcessing"
import { STUCK_SWEEP_MS } from "../../src/core/services/deposits/sipaStuck"
import {
  canSelfSweep,
  depositDetailOffer,
  depositExitOffer,
  migrationAmounts,
  recoveryReasonFor,
  registrationTagForDeposit,
  type RegistrationRef,
} from "../../src/engine/feedRules"

const NOW = 1_800_000_000_000

const stuck = {
  sipaAddress: "0x000000000000000000000000000000000000d0d0",
  recipientL2Address: `0x${"aa".repeat(32)}`,
  messageSecret: `0x${"01".repeat(32)}`,
  recipientHash: `0x${"02".repeat(32)}`,
  recoveryAddress: "0x000000000000000000000000000000000000b0b0",
  l1ChainId: 11155111,
  amount: "18",
  tokenSymbol: "DAI",
  phase: "sweeping",
  startTime: NOW - 10 * 60_000,
} as SIPADepositRecord

const blocked: SipaProcessingState = {
  reason: {
    kind: "capacity",
    requiredAtomic: 17n * 10n ** 18n,
    availableAtomic: 5n * 10n ** 18n,
    refill: { status: "unknown" },
    decimals: 18,
    observedAt: 1,
  },
  blocker: { kind: "capacity", observedAt: 1 },
}

const cleared: SipaProcessingState = {
  reason: { kind: "processing", availableAtomic: 50n * 10n ** 18n, decimals: 18, observedAt: 2 },
}

const registration = (over: Partial<RegistrationRef> = {}): RegistrationRef => ({
  sipaAddress: stuck.sipaAddress,
  tag: "alice",
  phase: "funded",
  ...over,
})

describe("depositExitOffer", () => {
  it("offers Recover, opening recovery alone, while a capacity blocker is confirmed", () => {
    expect(depositExitOffer(stuck, { processing: blocked, now: NOW })).toEqual({
      reason: "stuck",
      canSweep: false,
      sweepable: true,
      waiting: true,
      action: "recover",
    })
  })

  it("offers the sweep again once a read clears the blocker", () => {
    expect(depositExitOffer(stuck, { processing: cleared, now: NOW })).toMatchObject({
      canSweep: true,
      action: "sweep",
    })
  })

  it("holds a registration-backed deposit to the registration's own gate", () => {
    const live = { processing: cleared, registration: registration(), now: NOW }
    expect(depositExitOffer(stuck, live)).toMatchObject({ canSweep: true, action: "sweep" })
    const swept = { ...live, registration: registration({ sweptAt: 1 }) }
    expect(depositExitOffer(stuck, swept)).toMatchObject({ canSweep: false, action: "recover" })
  })

  it("offers nothing before the stuck clock runs out", () => {
    expect(depositExitOffer(stuck, { processing: cleared, now: stuck.startTime })).toBeNull()
  })
})

describe("depositDetailOffer", () => {
  const fresh = { ...stuck, startTime: NOW }

  it("offers a sweep for funds still at the address", () => {
    expect(depositDetailOffer(fresh, { processing: cleared, now: NOW })).toMatchObject({
      canSweep: true,
      action: "sweep",
    })
  })

  it("offers nothing once the funds have left the address or never arrived", () => {
    const sweepTxHash = `0x${"03".repeat(32)}` as Hex
    const at = { processing: cleared, now: NOW }
    expect(depositDetailOffer({ ...fresh, sweepTxHash }, at)).toBeNull()
    expect(depositDetailOffer({ ...stuck, sweepTxHash }, at)).toBeNull()
    expect(
      depositDetailOffer({ ...fresh, phase: "pendingClaim", inboxIndex: "7", netAmount: "17" }, at),
    ).toBeNull()
    expect(depositDetailOffer({ ...stuck, phase: "broadcast", amount: "0" }, at)).toBeNull()
  })

  it("offers nothing on a backup passkey's deposit address, whose panel recovers it", () => {
    const origin = {
      protocol: "account",
      sipaFactory: "0x00000000000000000000000000000000000000fa",
      implementation: "0x00000000000000000000000000000000000000f1",
      intentHash: `0x${"04".repeat(32)}`,
      rollupVersion: "6",
      resweepable: false,
      recoveryAccount: "0x00000000000000000000000000000000000000a1",
      recoveryCommitment: `0x${"05".repeat(32)}`,
      accountFactory: "0x00000000000000000000000000000000000000af",
      forwardingTable: "0x00000000000000000000000000000000000000f7",
    } as const
    const at = { processing: cleared, now: NOW }
    for (const record of [stuck, fresh]) {
      const rotation = { ...record, recoveryAddress: "", origin, intent: "user-op" as const }
      expect(depositDetailOffer({ ...rotation, intent: undefined }, at)).not.toBeNull()
      expect(depositExitOffer(rotation, at)).toBeNull()
      expect(depositDetailOffer(rotation, at)).toBeNull()
    }
  })
})

describe("recoveryReasonFor", () => {
  const at = (patch: Partial<SIPADepositRecord>) => ({
    ...stuck,
    startTime: NOW - STUCK_SWEEP_MS,
    ...patch,
  })

  it("always offers the exit to a deposit that can never be swept, however fresh", () => {
    expect(recoveryReasonFor(at({ phase: "recoverable", startTime: NOW }), NOW)).toBe("unsweepable")
  })

  it.each(["sweeping", "broadcast"] as const)(
    "offers a %s deposit the exit only once it is stuck",
    (phase) => {
      expect(recoveryReasonFor(at({ phase }), NOW)).toBe("stuck")
      expect(recoveryReasonFor(at({ phase, startTime: NOW - STUCK_SWEEP_MS + 1 }), NOW)).toBeNull()
    },
  )

  it("offers nothing without the note's message secret", () => {
    // Half the recovery key derives from it.
    expect(recoveryReasonFor(at({ messageSecret: "" }), NOW)).toBeNull()
    expect(recoveryReasonFor(at({ messageSecret: "", phase: "recoverable" }), NOW)).toBeNull()
  })

  it("offers nothing on every other phase", () => {
    for (const phase of [
      "resolved",
      "funding",
      "funded",
      "pendingClaim",
      "claimed",
      "failed",
      "recovered",
    ] as const) {
      expect(recoveryReasonFor(at({ phase, startTime: 0 }), NOW)).toBeNull()
    }
  })
})

describe("canSelfSweep", () => {
  it("offers the sweep to a stuck deposit", () => {
    expect(canSelfSweep(stuck, NOW)).toBe(true)
  })

  it("withholds it from a deposit under the fee floor, where Recover is the only exit", () => {
    expect(canSelfSweep({ ...stuck, phase: "recoverable", startTime: 0 }, NOW)).toBe(false)
  })

  it("withholds it without the derived inputs the CREATE2 address is bound to", () => {
    expect(canSelfSweep({ ...stuck, recipientHash: "" }, NOW)).toBe(false)
    expect(canSelfSweep({ ...stuck, recoveryAddress: "" }, NOW)).toBe(false)
  })
})

describe("registrationTagForDeposit", () => {
  it("names the registration, and drops it once the deposit went back unpaid", () => {
    const regs = { records: [registration({ phase: "awaiting_deposit" })], handle: "me" }
    expect(registrationTagForDeposit(regs, stuck)).toBe("alice")
    expect(registrationTagForDeposit(regs, { ...stuck, phase: "recovered" })).toBeUndefined()
    const other = { ...stuck, sipaAddress: "0x1", intent: "registration" as const }
    expect(registrationTagForDeposit(regs, other)).toBe("me")
  })
})

describe("migrationAmounts", () => {
  it("takes the tip, the executor fee and the arrival fee off the amount", () => {
    // 85 less the 0.1 tip, the 0.05 executor fee and the 0.25 arrival fee.
    expect(
      migrationAmounts({
        amount: "85",
        rawAmount: (85n * 10n ** 18n).toString(),
        tokenDecimals: 18,
        relayerTip: WITHDRAW_RELAYER_TIP.toString(),
        withdrawalFee: (5n * 10n ** 16n).toString(),
        arrivalFee: (25n * 10n ** 16n).toString(),
      })?.netDisplay,
    ).toBe("84.6")
  })

  it("prices nothing while a fee is missing", () => {
    expect(migrationAmounts({ amount: "85", relayerTip: "1", tokenDecimals: 18 })).toBeUndefined()
  })
})
