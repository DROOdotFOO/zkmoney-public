/**
 * Funds on their way count in the balance they land in, at what will land, so a balance only drops
 * for a send or a withdrawal: a deposit from its sweep, a migration or a Savings move from its burn.
 */
import { describe, expect, it } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import type { WithdrawalPhase, WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { SavingsMoveRecord } from "../../src/core/services/savings/types"
import type { Transaction } from "../../src/types/transactions"
import { arrivingFunds } from "../../src/engine/activityFeed"

const E18 = 10n ** 18n
const SIPA = `0x${"5a".repeat(20)}` as const
const none = { deposits: [], burns: [], moves: [], rows: [] }

const deposit = (patch: Partial<SIPADepositRecord>): SIPADepositRecord =>
  ({ sipaAddress: SIPA, phase: "broadcast", amount: "800", ...patch } as SIPADepositRecord)

/** 85 gross, 0.1 tip, 0.3 arrival fee: 84.6 reaches the new balance. */
const migration = (phase: WithdrawalPhase): WithdrawalRecord =>
  ({
    localId: "m1",
    intent: "migration",
    recipient: SIPA,
    amount: "85",
    rawAmount: (85n * E18).toString(),
    relayerTip: (E18 / 10n).toString(),
    arrivalFee: ((3n * E18) / 10n).toString(),
    tokenSymbol: "DAI",
    phase,
    startTime: 1_000,
  } as WithdrawalRecord)

const move = (patch: Partial<SavingsMoveRecord>): SavingsMoveRecord =>
  ({
    direction: "in",
    withdrawalLocalId: "w1",
    amount: (800n * E18).toString(),
    net: ((79_937n * E18) / 100n).toString(),
    startTime: 1_000,
    ...patch,
  } as SavingsMoveRecord)

/** A move's burn: 800 DAI, its release tip, and the escrow's tip. */
const moveBurn = (phase: WithdrawalPhase = "l2_mined"): WithdrawalRecord =>
  ({
    localId: "w1",
    amount: "800",
    rawAmount: (800n * E18).toString(),
    relayerTip: (E18 / 10n).toString(),
    skyMove: { direction: "in", relayerTip: (E18 / 2n).toString() },
    tokenSymbol: "DAI",
    phase,
    startTime: 1_000,
  } as WithdrawalRecord)
const mined = [moveBurn()]

const claim = (status: Transaction["status"], action: string = PaylinkActionEnum.CLAIM) =>
  ({ action, status, amountAtomic: 25n * E18, token: { decimals: 18 } } as unknown as Transaction)

describe("arrivingFunds", () => {
  it("counts a deposit from its sweep, at its net, until it is claimed", () => {
    const net = (7995n * E18) / 10n
    const at = (patch: Partial<SIPADepositRecord>) =>
      arrivingFunds({ ...none, deposits: [deposit(patch)] }).main
    expect(at({ phase: "broadcast" })).toBe(0n)
    expect(at({ phase: "sweeping" })).toBe(0n)
    expect(at({ phase: "pendingClaim", netAmount: net.toString() })).toBe(net)
    expect(at({ phase: "claimed", netAmount: net.toString() })).toBe(0n)
    expect(at({ phase: "recoverable" })).toBe(0n)
  })

  it("stops counting a deposit once Main is read after its claim landed, before it records claimed", () => {
    const net = (75n * E18) / 100n
    const landed = deposit({
      phase: "pendingClaim",
      inboxIndex: "26",
      netAmount: net.toString(),
      claimLanded: { inboxIndex: "26", at: 500 },
    })
    const at = (record: SIPADepositRecord, main?: number) =>
      arrivingFunds({ ...none, deposits: [record], balanceReadAt: { main } }).main
    expect(at(landed)).toBe(net)
    expect(at(landed, 499)).toBe(net)
    expect(at(landed, 500)).toBe(0n)
    // A later sweep on the same address is still on its way.
    expect(at({ ...landed, inboxIndex: "28" }, 500)).toBe(net)
  })

  it("counts a migration from its burn, then from its deposit's own net, never both", () => {
    const net = (846n * E18) / 10n
    const at = (burn: WithdrawalRecord, arrival?: Partial<SIPADepositRecord>) =>
      arrivingFunds({ ...none, burns: [burn], deposits: arrival ? [deposit(arrival)] : [] }).main
    expect(at(migration("l2_mined"))).toBe(net)
    expect(at(migration("l2_mined"), { phase: "broadcast", amount: "0" })).toBe(net)
    expect(at(migration("done"), { phase: "pendingClaim", netAmount: net.toString() })).toBe(net)
    expect(at(migration("done"), { phase: "claimed", netAmount: net.toString() })).toBe(0n)
    expect(at(migration("failed"))).toBe(0n)
  })

  it("counts a move into Savings at its quote, then at the shares it landed, priced", () => {
    const quoted = (79_937n * E18) / 100n
    expect(arrivingFunds({ ...none, burns: mined, moves: [move({})] })).toEqual({
      main: 0n,
      savings: quoted,
    })
    const landed = move({
      deposit: { inboxIndex: "1", amount: (760n * E18).toString(), claimed: false },
    })
    const price = (105n * E18) / 100n
    expect(
      arrivingFunds({ ...none, burns: mined, moves: [landed], sharePrice: price }).savings,
    ).toBe(798n * E18)
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed] }).savings).toBe(quoted)
  })

  it("counts a move back to Main at its quote, then at what it deposited", () => {
    const out = move({ direction: "out", net: (500n * E18).toString() })
    expect(arrivingFunds({ ...none, burns: mined, moves: [out] })).toEqual({
      main: 500n * E18,
      savings: 0n,
    })
    const landed = {
      ...out,
      deposit: { inboxIndex: "2", amount: (499n * E18).toString(), claimed: false },
    }
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed] }).main).toBe(499n * E18)
  })

  it("counts nothing while a burn is still proving, as its source still holds the funds", () => {
    const proving = [moveBurn("submitting")]
    expect(arrivingFunds({ ...none, burns: proving, moves: [move({})] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, moves: [move({})] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: [migration("submitting")] }).main).toBe(0n)
  })

  it("counts a move rebuilt without a quote only from its deposit, which may already be spent", () => {
    const out = move({ direction: "out", amount: (100n * E18).toString(), net: undefined })
    expect(arrivingFunds({ ...none, burns: mined, moves: [out] }).main).toBe(0n)
    const found = {
      ...out,
      deposit: { inboxIndex: "1", amount: (103n * E18).toString(), claimed: false },
    }
    expect(arrivingFunds({ ...none, burns: mined, moves: [found] }).main).toBe(103n * E18)
  })

  it("keeps a claim this device stored on its way until its balance is read after it", () => {
    const stored = move({
      deposit: { inboxIndex: "1", amount: (10n * E18).toString(), claimed: true, storedAt: 500 },
    })
    const at = (savings?: number) =>
      arrivingFunds({
        ...none,
        burns: mined,
        moves: [stored],
        sharePrice: E18,
        balanceReadAt: { savings },
      }).savings
    expect(at()).toBe(10n * E18)
    expect(at(499)).toBe(10n * E18)
    expect(at(500)).toBe(0n)
  })

  it("stops counting a move once it is claimed, recovered, or its burn failed", () => {
    const claimed = move({ deposit: { inboxIndex: "1", amount: "1", claimed: true } })
    const recovered = move({ recovered: { to: `0x${"ab".repeat(20)}`, txHashes: [] } })
    expect(arrivingFunds({ ...none, burns: mined, moves: [claimed] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: mined, moves: [recovered] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: [moveBurn("failed")], moves: [move({})] }).savings).toBe(
      0n,
    )
  })

  it("counts a link claim while its transaction is pending, and no send", () => {
    expect(arrivingFunds({ ...none, rows: [claim("pending")] }).main).toBe(25n * E18)
    expect(arrivingFunds({ ...none, rows: [claim("success")] }).main).toBe(0n)
    expect(arrivingFunds({ ...none, rows: [claim("pending", "send")] }).main).toBe(0n)
  })
})

/** An upgrade's own deposits never count: the upgrade lock holds Home's figure until the balance holds them. */
describe("arrivingFunds beside an upgrade", () => {
  const NET = 99n * E18
  const swept = (patch: Partial<SIPADepositRecord>) =>
    deposit({ phase: "pendingClaim", netAmount: NET.toString(), ...patch })

  it("counts no deposit an upgrade's batch pays", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept({ sipaAddress: `0x${"b2".repeat(20)}` })],
      upgradeRecipients: new Set([`0x${"b2".repeat(20)}`]),
    })

    expect(funds.main).toBe(0n)
  })

  it("counts no deposit a backup passkey rotation pays itself", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept({ sipaAddress: `0x${"c3".repeat(20)}`, intent: "user-op" })],
    })

    expect(funds.main).toBe(0n)
  })

  it("counts an ordinary deposit and what old versions hold", () => {
    expect(
      arrivingFunds({ ...none, deposits: [swept({})], oldVersions: { main: E18, savings: 0n } })
        .main,
    ).toBe(NET + E18)
  })

  it("keeps old Savings in Savings beside old Main and an ordinary deposit", () => {
    expect(
      arrivingFunds({
        ...none,
        deposits: [swept({})],
        oldVersions: { main: 59n * E18, savings: 40n * E18 },
      }),
    ).toEqual({ main: NET + 59n * E18, savings: 40n * E18 })
  })
})

/** A rotated wallet's previous account shows its own arrivals on Home, apart from Main. */
describe("arrivingFunds beside a previous account", () => {
  const NET = 50n * E18
  const SESSION = `0x${"5e".repeat(32)}`
  const PREVIOUS = `0x${"0d".repeat(32)}`
  const swept = (recipientL2Address: string, fill: string) =>
    deposit({
      sipaAddress: `0x${fill.repeat(20)}`,
      phase: "pendingClaim",
      netAmount: NET.toString(),
      recipientL2Address,
    })

  it("adds nothing to Main for a swept deposit to the previous account", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept(`0x${"0D".repeat(32)}`, "d1")],
      previousAccount: PREVIOUS,
    })

    expect(funds.main).toBe(0n)
  })

  it("still counts the session account's own deposit beside it", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept(PREVIOUS, "d1"), swept(SESSION, "d2")],
      previousAccount: PREVIOUS,
    })

    expect(funds.main).toBe(NET)
  })

  it("counts a deposit with no recipient in Main, as before", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept("", "d3")],
      previousAccount: PREVIOUS,
    })

    expect(funds.main).toBe(NET)
  })

  it("counts every deposit in Main while no previous account is known", () => {
    expect(arrivingFunds({ ...none, deposits: [swept(PREVIOUS, "d1")] }).main).toBe(NET)
  })
})
