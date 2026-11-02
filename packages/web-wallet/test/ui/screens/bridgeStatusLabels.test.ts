/**
 * The status a bridge record shows on its feed row and in its detail modal. A deposit's row and
 * sheet read one word per phase, and every word the row names draws a badge; the withdrawal legs
 * that wait on the same thing read one state.
 */
import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import {
  WITHDRAWAL_PHASE_COPY,
  type SIPADepositPhase,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import { depositRowStatusLabel } from "../../../src/ui/screens/activityView"
import { depositStatus } from "../../../src/ui/screens/DepositDetailModal"
import { statusBadgeStyle } from "@obsidion/web-ds"

const WITHDRAWAL_PHASE_LABEL = Object.fromEntries(
  Object.entries(WITHDRAWAL_PHASE_COPY).map(([phase, copy]) => [phase, copy.pill]),
) as Record<keyof typeof WITHDRAWAL_PHASE_COPY, string | undefined>

const SWEEP_TX = `0x${"5e".repeat(32)}` as Hex

const deposit = (phase: SIPADepositPhase, sweepTxHash?: Hex): SIPADepositRecord =>
  ({
    sipaAddress: `0x${"11".repeat(20)}`,
    recipientL2Address: `0x${"0a".repeat(32)}`,
    messageSecret: "0x01",
    recipientHash: "0x02",
    recoveryAddress: `0x${"bb".repeat(20)}`,
    l1ChainId: 11155111,
    amount: "18",
    tokenSymbol: "DAI",
    phase,
    startTime: 1,
    sweepTxHash,
  } as SIPADepositRecord)

const DEPOSIT_PHASES: SIPADepositPhase[] = [
  "resolved",
  "funding",
  "funded",
  "broadcast",
  "sweeping",
  "pendingClaim",
  "claimed",
  "recovered",
  "recoverable",
  "failed",
]

describe("depositStatus", () => {
  it("keeps every in-flight phase on the pending badge", () => {
    for (const phase of [
      "resolved",
      "funding",
      "funded",
      "broadcast",
      "sweeping",
      "pendingClaim",
    ] as const) {
      expect(depositStatus(deposit(phase)).badge, phase).toBe("pending")
    }
    expect(depositStatus(deposit("sweeping", SWEEP_TX)).badge).toBe("pending")
  })

  it("reads Awaiting funds, Receiving, Crediting, then Completed", () => {
    expect(depositStatus(deposit("resolved")).label).toBe("Awaiting funds")
    expect(depositStatus({ ...deposit("broadcast"), amount: "0" }).label).toBe("Awaiting funds")
    for (const phase of ["funding", "funded", "broadcast", "sweeping"] as const) {
      expect(depositStatus(deposit(phase)).label, phase).toBe("Receiving")
    }
    expect(depositStatus(deposit("sweeping", SWEEP_TX)).label).toBe("Receiving")
    expect(depositStatus(deposit("pendingClaim")).label).toBe("Crediting")
    expect(depositStatus(deposit("claimed")).label).toBe("Completed")
  })
})

describe("depositRowStatusLabel", () => {
  it("leads with the recovery a deposit needs, over where it sits", () => {
    expect(depositRowStatusLabel(deposit("recoverable"))).toBe("Needs recovery")
  })

  it("names where a deposit still moving is, with a badge the row draws", () => {
    expect(depositRowStatusLabel(deposit("resolved"))).toBe("Awaiting funds")
    expect(depositRowStatusLabel(deposit("broadcast"))).toBe("Receiving")
    expect(depositRowStatusLabel(deposit("sweeping"))).toBe("Receiving")
    expect(depositRowStatusLabel(deposit("pendingClaim"))).toBe("Crediting")
    for (const phase of DEPOSIT_PHASES) {
      const label = depositRowStatusLabel(deposit(phase))
      if (label) expect(statusBadgeStyle(label), phase).toBeDefined()
    }
  })

  it("names each settled phase that never credited, and badges the one that did with nothing", () => {
    expect(depositRowStatusLabel(deposit("claimed"))).toBeUndefined()
    expect(depositRowStatusLabel(deposit("recovered"))).toBe("Recovered")
    expect(depositRowStatusLabel(deposit("failed"))).toBe("Deposit failed")
  })

  it("never contradicts the sheet: a badged phase reads the same word in both", () => {
    for (const phase of DEPOSIT_PHASES) {
      const row = depositRowStatusLabel(deposit(phase))
      if (!row) continue
      expect(depositStatus(deposit(phase)).label, phase).toBe(row)
    }
  })
})

describe("WITHDRAWAL_PHASE_LABEL", () => {
  it("shows one state from the burn to the payout, with a badge the row draws", () => {
    const releasing = ["l2_mined", "awaiting_proven", "finalizing_l1"] as const
    expect(releasing.map((phase) => WITHDRAWAL_PHASE_LABEL[phase])).toEqual([
      "Releasing",
      "Releasing",
      "Releasing",
    ])
    for (const phase of releasing) {
      expect(statusBadgeStyle(WITHDRAWAL_PHASE_LABEL[phase]!), phase).toBe("pending")
    }
  })

  it("separates the unmined burn, the failure, and the released withdrawal that shows nothing", () => {
    expect(WITHDRAWAL_PHASE_LABEL.done).toBeUndefined()
    expect(WITHDRAWAL_PHASE_LABEL.submitting).toBe("Pending")
    expect(WITHDRAWAL_PHASE_LABEL.failed).toBe("Failed")
  })
})
