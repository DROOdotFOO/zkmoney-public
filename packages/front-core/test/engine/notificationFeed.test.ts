import { describe, expect, it } from "vitest"
import { zeroAddress } from "viem"
import type { UpgradeBatchItem } from "../../src/core/migration/upgradeActivity"
import type { OldVersionWithdrawal } from "../../src/core/migration/OldVersionWithdrawalStorage"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import { DEPOSIT_PHASE_COPY } from "../../src/core/services/deposits/depositCopy"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import type { OperationRecord } from "../../src/core/services/operations/OperationStore"
import type { PendingRegistrationRecord } from "../../src/core/services/registration/PendingRegistrationStore"
import { WITHDRAWAL_PHASE_COPY } from "../../src/core/services/bridge/withdrawalCopy"
import { LIVE_DEPOSIT_PHASES, LIVE_WITHDRAWAL_PHASES } from "../../src/engine/notificationBridge"
import { isNativeEth } from "../../src/oxide/sipaFunding"
import {
  deriveNotifications,
  notificationsStamped,
  reorgEvent,
  retiredNotifications,
  selectNotifications,
  type NotificationSources,
} from "../../src/engine/notificationFeed"
import {
  NOTIFICATION_WINDOW_MS,
  type NotificationEvent,
  type NotificationState,
} from "../../src/engine/notifications"
import type { Transaction } from "../../src/types/transactions"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const E18 = 10n ** 18n
const addr = (byte: string) => `0x${byte.repeat(20)}`
const token = {
  address: "0xt",
  name: "DAI",
  symbol: "DAI",
  decimals: 18,
  logo: "",
  amount: 5,
  price: 1,
}

const burn = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord =>
  ({
    localId: "w1",
    recipient: addr("e1"),
    amount: "7",
    tokenSymbol: "DAI",
    phase: "done",
    startTime: NOW - 2 * HOUR,
    endTime: NOW - HOUR,
    ...over,
  } as WithdrawalRecord)

const deposit = (over: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: addr("D1"),
    phase: "claimed",
    amount: "20",
    netAmount: (20n * E18).toString(),
    fee: "0",
    inboxIndex: "3",
    startTime: NOW - 2 * HOUR,
    endTime: NOW - HOUR,
    ...over,
  } as SIPADepositRecord)

const receive = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: "0xr1",
    action: "receive",
    token,
    amountAtomic: 5n * E18,
    timestamp: NOW - HOUR,
    status: "success",
    txHash: "0xR1",
    ...over,
  } as Transaction)

const paylink = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: "0xp1",
    action: "pay",
    emailPaymentAction: "pay",
    flavor: "direct",
    token,
    amountAtomic: 5n * E18,
    timestamp: NOW - 3 * 24 * HOUR,
    status: "success",
    txHash: "0xP1",
    ...over,
  } as Transaction)

const op = (over: Partial<OperationRecord> = {}): OperationRecord => ({
  operationId: "op1",
  flow: "send",
  summary: "$1 to @bo",
  scope: null,
  state: "failed",
  cause: "dropped",
  txHash: "0xS1",
  startedAt: NOW - 2 * HOUR,
  endedAt: NOW - HOUR,
  ...over,
})

const loaded = <T>(records: T[]) => ({ records, hydrated: true })

const sources = (over: Partial<NotificationSources> = {}): NotificationSources => ({
  rows: [],
  oldVersionWithdrawals: [],
  deposits: loaded([]),
  withdrawals: loaded([]),
  upgrades: { items: [], recipients: new Set(), loaded: true },
  processing: new Map(),
  registrations: [],
  operations: { ended: [], running: [] },
  loaded: true,
  ...over,
})

const ids = (s: NotificationSources, events = new Map<string, NotificationEvent>()) =>
  deriveNotifications(s, events, NOW).map((e) => e.id)

/** Every derived id seen at `at`, as the writer stamps them. */
const seenAll = (s: NotificationSources, events = new Map<string, NotificationEvent>(), at = NOW) =>
  new Map<string, NotificationState>(
    deriveNotifications(s, events, NOW).map((e) => [e.id, { id: e.id, firstSeenAt: at }]),
  )

const select = (s: NotificationSources, state = seenAll(s), events = new Map()) =>
  selectNotifications(s, state, events, NOW)

const eventMap = (...events: NotificationEvent[]) => new Map(events.map((e) => [e.id, e]))

describe("bridge entries", () => {
  it("reports a live withdrawal, then its ending, under their own ids", () => {
    expect(ids(sources({ withdrawals: loaded([burn({ phase: "l2_mined" })]) }))).toEqual([
      "bridge:withdrawal:w1:inflight",
    ])
    const [done] = select(sources({ withdrawals: loaded([burn()]) }))
    expect(done).toMatchObject({
      id: "bridge:withdrawal:w1:done",
      pending: false,
      severity: "success",
      timestampMs: NOW - HOUR,
      target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: "w1" },
    })
  })

  it("has no live row for a burn not yet mined, nor for a rebuilt one the tracker has not seen", () => {
    expect(ids(sources({ withdrawals: loaded([burn({ phase: "submitting" })]) }))).toEqual([])
    const rebuilt = burn({ phase: "awaiting_proven", rebuilt: true } as Partial<WithdrawalRecord>)
    expect(ids(sources({ withdrawals: loaded([rebuilt]) }))).toEqual([])
  })

  it("keys a deposit's ending per claim, and its live row by address", () => {
    expect(ids(sources({ deposits: loaded([deposit()]) }))).toEqual([
      `bridge:sipaDeposit:${addr("d1")}:3:done`,
    ])
    expect(ids(sources({ deposits: loaded([deposit({ phase: "sweeping" })]) }))).toEqual([
      `bridge:sipaDeposit:${addr("d1")}:inflight`,
    ])
  })

  it("keeps a swept deposit's live row until it is claimed", () => {
    const swept = { deposits: loaded([deposit({ phase: "pendingClaim", endTime: undefined })]) }
    expect(ids(sources(swept))).toEqual([`bridge:sipaDeposit:${addr("d1")}:inflight`])
  })

  it("leaves a backup passkey rotation's deposit and funding burn to the settings panel", () => {
    const s = sources({
      deposits: loaded([deposit({ intent: "user-op" } as Partial<SIPADepositRecord>)]),
      withdrawals: loaded([burn({ intent: "backup" } as Partial<WithdrawalRecord>)]),
    })
    expect(ids(s)).toEqual([])
  })

  it("reports a withdrawal of old-version funds pending while it sends, then its outcome", () => {
    const run = (phase: OldVersionWithdrawal["phase"]) =>
      ({
        id: "ov",
        startTime: NOW,
        to: addr("e9"),
        refunds: [],
        phase,
      } as unknown as OldVersionWithdrawal)
    const [sending] = select(sources({ oldVersionWithdrawals: [run("sending")] }))
    expect(sending).toMatchObject({
      id: "old-version-withdrawal:ov",
      pending: true,
      target: { type: "withdraw.oldVersion", id: "ov" },
    })
    const [done] = select(sources({ oldVersionWithdrawals: [run("done")] }))
    expect(done).toMatchObject({ pending: false, severity: "success" })
    const [failed] = select(sources({ oldVersionWithdrawals: [run("failed")] }))
    expect(failed).toMatchObject({ pending: false, severity: "error" })
  })

  it("keeps an earlier claim's unread ending when the address is paid and claimed again", () => {
    const first = {
      inboxIndex: "3",
      sweepTxHash: "0xs3",
      netAmount: (20n * E18).toString(),
      settledAt: NOW - 2 * HOUR,
    }
    const second = { ...first, inboxIndex: "4", sweepTxHash: "0xs4", settledAt: NOW - 5 }
    const done = (index: string) => `bridge:sipaDeposit:${addr("d1")}:${index}:done`
    const once = sources({ deposits: loaded([deposit({ sweeps: [first] } as never)]) })
    expect(ids(once)).toEqual([done("3")])
    const unread = seenAll(once)

    const paidAgain = sources({
      deposits: loaded([deposit({ phase: "sweeping", sweeps: [first] } as never)]),
    })
    expect(ids(paidAgain)).toEqual([`bridge:sipaDeposit:${addr("d1")}:inflight`, done("3")])

    const claimedAgain = sources({
      deposits: loaded([
        deposit({ inboxIndex: "4", endTime: NOW - 5, sweeps: [first, second] } as never),
      ]),
    })
    expect(ids(claimedAgain)).toEqual([done("3"), done("4")])
    const shown = select(claimedAgain, new Map([...unread, ...seenAll(claimedAgain)]))
    expect(shown.map((e) => [e.id, e.read])).toEqual([
      [done("4"), false],
      [done("3"), false],
    ])
    const earlier = shown.find((e) => e.id === done("3"))!
    expect(earlier.timestampMs).toBe(NOW - 2 * HOUR)
    expect(earlier.about).toMatchObject({
      kind: "bridgeEnded",
      item: { record: { inboxIndex: "3", sweepTxHash: "0xs3" } },
    })
  })

  it("reports an earlier claim in the token it credited, whatever funded the address since", () => {
    const first = { inboxIndex: "3", sweepTxHash: "0xs3", netAmount: (20n * E18).toString() }
    const recovered = deposit({
      phase: "recovered",
      tokenAddress: zeroAddress,
      tokenSymbol: "ETH",
      sweeps: [first],
    } as never)
    const earlier = select(sources({ deposits: loaded([recovered]) })).find((e) =>
      e.id.endsWith(":3:done"),
    )!
    expect(earlier.about).toMatchObject({ item: { record: { netAmount: first.netAmount } } })
    const record = (earlier.about as { item: { record: SIPADepositRecord } }).item.record
    expect(isNativeEth(record.tokenAddress)).toBe(false)
  })

  it("states a waiting deposit's reason on its live row once shown", () => {
    const processing = new Map([[addr("d1"), { reason: { kind: "capacity" } }]]) as never
    const [live] = select(
      sources({ deposits: loaded([deposit({ phase: "sweeping" })]), processing }),
    )
    expect(live.about).toMatchObject({ kind: "bridgeLive", reason: "capacity" })
  })

  it("leaves a registration's deposit and burn to the registration", () => {
    const s = sources({
      deposits: loaded([deposit({ intent: "registration" } as Partial<SIPADepositRecord>)]),
      withdrawals: loaded([burn({ intent: "registration" } as Partial<WithdrawalRecord>)]),
    })
    expect(ids(s)).toEqual([])
  })

  it("reports a migration once, at its arrival", () => {
    const exit = burn({ intent: "migration", recipient: addr("d1") } as Partial<WithdrawalRecord>)
    const s = sources({ withdrawals: loaded([exit]), deposits: loaded([deposit()]) })
    const [entry] = select(s)
    expect(ids(s)).toEqual([`bridge:sipaDeposit:${addr("d1")}:3:done`])
    expect(entry.about).toMatchObject({ kind: "bridgeEnded", migration: true })
  })

  it("reports a fresh-address group as one withdrawal", () => {
    const legs = [
      burn({ localId: "g", groupId: "0xG1", groupLeg: "gas", phase: "l2_mined" } as never),
      burn({ localId: "f", groupId: "0xG1", groupLeg: "funds", phase: "l2_mined" } as never),
    ]
    expect(ids(sources({ withdrawals: loaded(legs) }))).toEqual([
      "bridge:withdrawal-group:0xg1:inflight",
    ])
  })

  it("reports an upgrade run live, and complete once every batch arrived", () => {
    const batch = {
      id: "first",
      run: "r1",
      recipient: addr("d1"),
      amount: "20",
      exitFee: "0",
      state: "sent",
      approved: true,
      first: true,
      startTime: NOW - 2 * HOUR,
    }
    const s = (phase: SIPADepositRecord["phase"], more: UpgradeBatchItem[] = []) =>
      sources({
        upgrades: {
          items: [batch as unknown as UpgradeBatchItem, ...more],
          recipients: new Set([addr("d1")]),
          loaded: true,
        },
        deposits: loaded([deposit({ phase })]),
      })
    expect(ids(s("sweeping"))).toEqual(["migration-run:r1"])
    expect(ids(s("claimed"))).toEqual(["migration-run:r1:done:1"])
    // Complete only once no other run is approved and unsent.
    const planned = { ...batch, id: "second", run: "r2", state: "planned", first: false }
    expect(ids(s("claimed", [planned as unknown as UpgradeBatchItem]))).not.toContain(
      "migration-run:r1:done:1",
    )
  })

  it("reports an upgrade read off its direct deposits once, however many legs join", () => {
    const direct = deposit({ direct: { portal: addr("f1") } } as Partial<SIPADepositRecord>)
    const done = deriveNotifications(sources({ deposits: loaded([direct]) }), new Map(), NOW).find(
      (e) => e.id.endsWith(":done"),
    )
    expect(done).toMatchObject({ id: `migration-run:chain-upgrade/${addr("f1")}:done` })
    expect(done).not.toHaveProperty("seenWith")
  })
})

describe("registration entries", () => {
  const record = (over: Partial<PendingRegistrationRecord> = {}) =>
    ({
      account: "0xACC",
      nameHash: "0xNH",
      l2Address: "0xL2",
      sipaAddress: addr("d1"),
      tag: "ada",
      phase: "awaiting_deposit",
      startTime: NOW - 2 * HOUR,
      ...over,
    } as PendingRegistrationRecord)

  it("reports the active wallet's registration live, then registered", () => {
    const s = (over: Partial<PendingRegistrationRecord>, account = "0xl2") =>
      sources({ registrations: [record(over)], account })
    expect(ids(s({}))).toEqual([])
    expect(select(s({ fundedAt: NOW - HOUR }))[0]).toMatchObject({
      id: "registration:0xacc:0xnh:live",
      pending: true,
      about: { kind: "registrationLive", stage: "received", tag: "ada" },
      target: { type: "registration.pending", tag: "ada" },
    })
    expect(select(s({ phase: "confirmed", endTime: NOW - HOUR }))[0]).toMatchObject({
      id: "registration:0xacc:0xnh",
      target: { type: "bridge.txDetail", bridgeKind: "deposit", sourceId: addr("d1") },
    })
    expect(ids(s({ phase: "confirmed" }, "0xother"))).toEqual([])
  })
})

describe("row entries", () => {
  it("reports a receive, and a claimed paylink at the time it was seen claimed", () => {
    const s = sources({
      rows: [receive(), paylink({ isClaimed: true, claimedAt: NOW - 1000 } as never)],
    })
    expect(ids(s)).toEqual(["transfer:receive:0xr1", "paylink:claimed:0xp1"])
    expect(select(s).find((e) => e.id === "paylink:claimed:0xp1")?.timestampMs).toBe(NOW - 1000)
  })

  it("leaves out the creator's own claim, and counts a claim without a claimer as the chain's", () => {
    const claimed = (claimedBy?: "self" | "chain") =>
      ids(sources({ rows: [paylink({ isClaimed: true, claimedBy } as never)] }))
    expect(claimed("self")).toEqual([])
    expect(claimed("chain")).toEqual(["paylink:claimed:0xp1"])
    expect(claimed()).toEqual(["paylink:claimed:0xp1"])
  })

  it("keeps a claim a reorg reverted beside its reversal", () => {
    const reversed = eventMap({
      id: "paylink:claim-reversed:0xp1",
      at: NOW,
      kind: "claimReversed",
      data: { txHash: "0xP1" },
    })
    expect(ids(sources({ rows: [paylink()] }), reversed)).toEqual([
      "paylink:claimed:0xp1",
      "paylink:claim-reversed:0xp1",
    ])
  })
})

describe("the join", () => {
  it("lists only entries the writer has seen, hides dismissed ones, and reads unread off the state", () => {
    const s = sources({ rows: [receive(), receive({ id: "0xr2", txHash: "0xR2" })] })
    const state = new Map<string, NotificationState>([
      ["transfer:receive:0xr1", { id: "transfer:receive:0xr1", firstSeenAt: NOW, readAt: NOW }],
    ])
    expect(select(s, state).map((e) => [e.id, e.read])).toEqual([["transfer:receive:0xr1", true]])
    state.set("transfer:receive:0xr2", {
      id: "transfer:receive:0xr2",
      firstSeenAt: NOW,
      dismissedAt: NOW,
    })
    expect(select(s, state).map((e) => e.id)).toEqual(["transfer:receive:0xr1"])
  })

  it("keeps a pending row listed whatever its dismissal", () => {
    const s = sources({ withdrawals: loaded([burn({ phase: "l2_mined" })]) })
    const id = "bridge:withdrawal:w1:inflight"
    const state = new Map([[id, { id, firstSeenAt: NOW, dismissedAt: NOW }]])
    expect(select(s, state).map((e) => e.id)).toEqual([id])
  })

  it("lists newest first, an event at its time and an operation at its ending", () => {
    const events = eventMap({
      id: "contact:added:0xc",
      at: NOW - 10,
      kind: "contactAdded",
      data: { address: "0xc", contactId: "0xc" },
    })
    const s = sources({
      rows: [receive({ timestamp: NOW - HOUR })],
      operations: { ended: [op({ endedAt: NOW - 5 })], running: [] },
    })
    expect(select(s, seenAll(s, events), events).map((e) => e.id)).toEqual([
      "operation:op1",
      "contact:added:0xc",
      "transfer:receive:0xr1",
    ])
  })

  it("lets a running leg stand for its group's live row", () => {
    const leg = burn({
      localId: "f",
      groupId: "0xG1",
      groupLeg: "funds",
      phase: "l2_mined",
      operationId: "op-leg",
    } as never)
    const s = sources({ withdrawals: loaded([leg]) })
    expect(select(s).map((e) => e.id)).toEqual(["bridge:withdrawal-group:0xg1:inflight"])
    const running = { ...s, operations: { ended: [], running: [op({ operationId: "op-leg" })] } }
    expect(select(running, seenAll(s))).toEqual([])
  })
})

describe("reorg notices", () => {
  const none = () => false
  const failed = reorgEvent({ type: "failed", txHash: "0xS1", reorgEpoch: 1 }, NOW, none)!

  it("keys an outcome per episode and stays quiet where the record reports it", () => {
    expect(failed.id).toBe("reorg:failed:0xs1:1")
    expect(
      reorgEvent({ type: "failed", txHash: "0xS1", source: "withdrawal" }, NOW, none),
    ).toBeNull()
    expect(
      reorgEvent({ type: "re-confirmed", txHash: "0xS1", hadAlerted: false }, NOW, none),
    ).toBeNull()
  })

  it("answers a failure the bell holds, though the monitor that reported it was another page's", () => {
    const reconfirmed = { type: "re-confirmed", txHash: "0xS1", hadAlerted: false, reorgEpoch: 1 }
    const held = new Set([failed.id])
    expect(reorgEvent(reconfirmed as never, NOW, (id) => held.has(id))?.id).toBe(
      "reorg:reconfirmed:0xs1:1",
    )
    const otherEpoch = { ...reconfirmed, reorgEpoch: 2 }
    expect(reorgEvent(otherEpoch as never, NOW, (id) => held.has(id))).toBeNull()
  })

  it("rings a dropped send once: the operation's entry stands", () => {
    const events = eventMap(failed)
    const alone = sources()
    expect(select(alone, seenAll(alone, events), events).map((e) => e.id)).toEqual([failed.id])
    const covered = sources({ operations: { ended: [op()], running: [] } })
    expect(select(covered, seenAll(covered, events), events).map((e) => e.id)).toEqual([
      "operation:op1",
    ])
    const settled = sources({ operations: { ended: [op({ state: "settled" })], running: [] } })
    expect(select(settled, seenAll(settled, events), events).map((e) => e.id)).toContain(failed.id)
  })

  it("keeps a covered reorg notice hidden after its operation is read or cleared", () => {
    const events = eventMap(failed)
    for (const over of [{ readAt: NOW }, { readAt: NOW, dismissedAt: NOW }]) {
      const s = sources({ operations: { ended: [op(over)], running: [] } })
      expect(select(s, seenAll(s, events), events).map((e) => e.id)).not.toContain(failed.id)
    }
  })

  it("drops a failure notice once its withdrawal burn is live again", () => {
    const events = eventMap(failed)
    const s = sources({
      withdrawals: loaded([burn({ phase: "l2_mined", l2TxHash: "0xs1" } as never)]),
    })
    expect(select(s, seenAll(s, events), events).map((e) => e.id)).not.toContain(failed.id)
  })
})

describe("the writer's inputs", () => {
  it("gives each ending its settle time, and a dropped burn none", () => {
    const [ended] = deriveNotifications(sources({ withdrawals: loaded([burn()]) }), new Map(), NOW)
    expect(ended.settledAt).toBe(NOW - HOUR)
    const dropped = burn({ phase: "failed", droppedBurn: true } as Partial<WithdrawalRecord>)
    const [entry] = deriveNotifications(sources({ withdrawals: loaded([dropped]) }), new Map(), NOW)
    expect(entry.settledAt).toBeUndefined()
  })

  it("forgets a failure once its withdrawal is no longer failed", () => {
    expect(retiredNotifications(sources({ withdrawals: loaded([burn()]) }))).toEqual([
      "bridge:withdrawal:w1:failed",
    ])
    expect(
      retiredNotifications(sources({ withdrawals: loaded([burn({ phase: "failed" })]) })),
    ).toEqual([])
    const unread = { records: [burn()], hydrated: false }
    expect(retiredNotifications(sources({ withdrawals: unread }))).toEqual([])
  })
})

describe("the bell's list", () => {
  const done = sources({ withdrawals: loaded([burn()]) })
  const stamped = (s: NotificationSources, state: Map<string, NotificationState>) =>
    notificationsStamped(s, state, new Map(), NOW)

  it("is complete once every source has loaded and the writer has saved each entry it stamps", () => {
    expect(stamped({ ...done, loaded: false }, seenAll(done))).toBe(false)
    expect(stamped(done, new Map())).toBe(false)
    expect(stamped(done, seenAll(done))).toBe(true)
  })

  it("never waits on an entry that settled before the window", () => {
    const old = sources({
      withdrawals: loaded([burn({ endTime: NOW - 2 * NOTIFICATION_WINDOW_MS })]),
    })
    expect(stamped(old, new Map())).toBe(true)
  })
})

describe("the live phases", () => {
  it("are the phases whose copy has a live line", () => {
    for (const [phase, copy] of Object.entries(WITHDRAWAL_PHASE_COPY))
      expect(LIVE_WITHDRAWAL_PHASES.has(phase as never)).toBe(copy.live !== undefined)
    for (const [phase, copy] of Object.entries(DEPOSIT_PHASE_COPY))
      expect(LIVE_DEPOSIT_PHASES.has(phase as never)).toBe(copy.live !== undefined)
  })
})
