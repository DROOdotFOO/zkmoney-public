/**
 * The accounting CSV. Each table below names every stored kind the export knows, with the row it
 * must produce. A kind added to the source types fails the front-core build until the export maps
 * it, and then fails here until this file pins what it reports.
 */
import { describe, expect, it } from "vitest"
import { parseUnits, type Address } from "viem"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import type {
  SIPADepositRecord,
  SIPASweep,
} from "../../../src/core/services/deposits/SIPADepositStore"
import type { SavingsMoveRecord } from "../../../src/core/services/savings/types"
import type { ActivityItem } from "../../../src/core/services/bridge/BridgeActivityFeed"
import type { Transaction } from "../../../src/types/transactions"
import {
  ACTIVITY_CSV_COLUMNS,
  ACTIVITY_CSV_COVERAGE,
  activityCsv,
  activityCsvFileName,
  buildSavingsCsvRows,
  savingsCsv,
  buildActivityCsvRows,
  type ActivityCsvRow,
  type ActivityCsvSources,
} from "../../../src/core/services/activity/activityCsv"

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
const TOKEN = {
  address: "0x1",
  name: "Dai",
  symbol: "DAI",
  decimals: 18,
  logo: "",
  amount: 12.5,
  price: 1,
}
const DAI = { symbol: "DAI", decimals: 18 }
const EMPTY: ActivityCsvSources = { walletToken: DAI, transactions: [], items: [], requests: [] }

function tx(action: string, extra: Record<string, unknown> = {}): Transaction {
  return {
    action,
    emailPaymentAction: action,
    status: "success",
    timestamp: T0,
    txHash: `0x${action.length}`,
    token: TOKEN,
    ...extra,
  } as unknown as Transaction
}

function withdrawal(extra: Partial<WithdrawalRecord> = {}): ActivityItem {
  return {
    kind: "bridge.withdrawal",
    record: {
      localId: "wdraw_1",
      recipient: "0x00000000000000000000000000000000000000aa",
      recipientProvenance: "saved-recipient",
      amount: "10",
      rawAmount: parseUnits("10", 18).toString(),
      relayerTip: parseUnits("0.5", 18).toString(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      phase: "done",
      startTime: T0,
      endTime: T0 + 1000,
      l2TxHash: "0xl2",
      l1TxHash: "0xl1",
      receivedAmount: parseUnits("9.5", 18).toString(),
      ...extra,
    } as WithdrawalRecord,
  }
}

/** A claimed sweep that took `gross` DAI off the address and credited `net`; no gross when never read. */
function sweep(
  inboxIndex: string,
  gross: string | undefined,
  net: string,
  extra: Partial<SIPASweep> = {},
): SIPASweep {
  return {
    inboxIndex,
    sweepTxHash: `0xsweep${inboxIndex}` as SIPASweep["sweepTxHash"],
    netAmount: parseUnits(net, 18).toString(),
    ...(gross === undefined
      ? {}
      : {
          grossAmount: parseUnits(gross, 18).toString(),
          fundingTokenSymbol: "DAI",
          fundingTokenDecimals: 18,
        }),
    ...extra,
  }
}

function deposit(extra: Partial<SIPADepositRecord> = {}): ActivityItem {
  return {
    kind: "bridge.sipaDeposit",
    record: {
      sipaAddress: "0x00000000000000000000000000000000000000Bb",
      amount: "20",
      netAmount: parseUnits("19", 18).toString(),
      fee: parseUnits("1", 18).toString(),
      tokenSymbol: "DAI",
      phase: "claimed",
      startTime: T0,
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweeps: [sweep("7", "20", "19")],
      fundingFromAddress: "0x00000000000000000000000000000000000000cc",
      fundingTokenSymbol: "DAI",
      fundingTxHash: "0xfund",
      claimTxHash: "0xclaim",
      ...extra,
    } as SIPADepositRecord,
  }
}

function only(sources: Partial<ActivityCsvSources>): ActivityCsvRow | undefined {
  const rows = buildActivityCsvRows({ ...EMPTY, ...sources })
  expect(rows.length).toBeLessThanOrEqual(1)
  return rows[0]
}

type Expected = Pick<ActivityCsvRow, "type"> & { side: "sent" | "received" }

/** null: the action is left out of the export. */
const TRANSACTION_ACTIONS: Record<string, Expected | null> = {
  "send": { type: "Payment sent", side: "sent" },
  "receive": { type: "Payment received", side: "received" },
  "faucet": null,
  "Pay To Email": { type: "Payment link created", side: "sent" },
  "Claim With Email": { type: "Payment link claimed", side: "received" },
  "Claim Back": { type: "Payment link refunded", side: "received" },
  "Refunded": null,
  "Claimed": null,
  "contract_call": null,
  "create_account": null,
  "import_account": null,
}

const TRANSACTION_STATUSES: Record<string, boolean> = {
  success: true,
  pending: false,
  failed: false,
}

const WITHDRAWAL_PHASES: Record<string, boolean> = {
  done: true,
  recovered: true,
  submitting: false,
  l2_mined: false,
  awaiting_proven: false,
  finalizing_l1: false,
  swapping: false,
  recoverable: false,
  failed: false,
}

const WITHDRAWAL_KINDS: Record<string, [Partial<WithdrawalRecord>, ActivityCsvRow["type"]]> = {
  "balance": [{}, "Withdrawal"],
  "paylink": [{ source: "paylink" }, "Payment link paid to Ethereum"],
  "registration": [{ intent: "registration", source: "paylink" }, "Name registration"],
  "migration": [{ intent: "migration" }, "Upgrade out"],
  "backup": [{ intent: "backup" }, "Backup passkey added"],
  "savings-in": [
    { skyMove: { direction: "in" } as WithdrawalRecord["skyMove"] },
    "Savings deposit",
  ],
  "savings-out": [
    { skyMove: { direction: "out" } as WithdrawalRecord["skyMove"] },
    "Savings withdrawal",
  ],
}

const DEPOSIT_PHASES: Record<string, boolean> = {
  claimed: true,
  resolved: false,
  funding: false,
  funded: false,
  broadcast: false,
  sweeping: false,
  pendingClaim: false,
  failed: false,
  recoverable: false,
  recovered: false,
}

const SIPA = "0x00000000000000000000000000000000000000bb"
const DEPOSIT_KINDS: Record<
  string,
  [Partial<ActivityCsvSources>, Partial<SIPADepositRecord>, ActivityCsvRow["type"]]
> = {
  "deposit": [{}, {}, "Deposit"],
  "registration": [{}, { intent: "registration" }, "Name registration"],
  "user-op": [{}, { intent: "user-op" }, "Backup passkey added"],
  "request": [{ requests: [{ sipaAddress: SIPA } as never] }, {}, "Payment request paid"],
  "migration": [
    {
      items: [
        withdrawal({ intent: "migration", recipient: SIPA as `0x${string}`, phase: "l2_mined" }),
      ],
    },
    {},
    "Upgrade in",
  ],
}

const UPGRADE_STATES: Record<string, boolean> = {
  planned: false,
  sent: false,
  refunded: true,
  received: true,
}

const upgradeBatch = (state: string): ActivityItem => ({
  kind: "upgrade.batch",
  batch: {
    run: "run",
    id: "remaining-0",
    recipient: SIPA,
    amount: (10n * 10n ** 18n).toString(),
    state: state as "sent",
    tx: "0xcarrier",
    startTime: 1,
  },
})

/** Feed item kinds the export reads. */
const ITEM_KINDS: Record<string, "exported"> = {
  "bridge.withdrawal": "exported",
  "upgrade.batch": "exported",
  "bridge.sipaDeposit": "exported",
}

const keys = (table: object) => Object.keys(table).sort()

describe("every stored kind is pinned here", () => {
  it.each([
    ["transactionActions", TRANSACTION_ACTIONS],
    ["transactionStatuses", TRANSACTION_STATUSES],
    ["withdrawalPhases", WITHDRAWAL_PHASES],
    ["withdrawalKinds", WITHDRAWAL_KINDS],
    ["depositPhases", DEPOSIT_PHASES],
    ["depositKinds", DEPOSIT_KINDS],
    ["itemKinds", ITEM_KINDS],
    ["upgradeStates", UPGRADE_STATES],
  ] as const)("%s", (name, table) => {
    expect(keys(table)).toEqual([...ACTIVITY_CSV_COVERAGE[name]].sort())
  })
})

describe("transactions", () => {
  it.each(Object.entries(TRANSACTION_ACTIONS))("%s", (action, expected) => {
    const row = only({ transactions: [tx(action)] })
    if (!expected) return expect(row).toBeUndefined()
    expect(row?.type).toBe(expected.type)
    expect(row?.[expected.side]).toEqual({ amount: "12.5", currency: "DAI" })
    expect(row?.[expected.side === "sent" ? "received" : "sent"]).toBeUndefined()
  })

  it.each(Object.entries(TRANSACTION_STATUSES))(
    "a %s transaction exported: %s",
    (status, exported) => {
      expect(!!only({ transactions: [tx("send", { status })] })).toBe(exported)
    },
  )

  it("prefers the verified atomic amount and names the counterparty", () => {
    const row = only({
      transactions: [
        tx("receive", {
          amountAtomic: parseUnits("3.25", 18).toString(),
          from: "alice",
          memo: "rent",
        }),
      ],
    })
    expect(row).toMatchObject({
      received: { amount: "3.25", currency: "DAI" },
      counterparty: { name: "alice", network: "Aztec" },
      note: "rent",
    })
  })
})

describe("withdrawals", () => {
  it.each(Object.entries(WITHDRAWAL_PHASES))("phase %s exported: %s", (phase, exported) => {
    expect(!!only({ items: [withdrawal({ phase: phase as WithdrawalRecord["phase"] })] })).toBe(
      exported,
    )
  })

  it.each(Object.entries(WITHDRAWAL_KINDS))("%s", (_, [extra, type]) => {
    expect(only({ items: [withdrawal(extra)] })?.type).toBe(type)
  })

  it("sends what arrived, with the rest of the gross burned as the fee", () => {
    expect(only({ items: [withdrawal()] })).toMatchObject({
      sent: { amount: "9.5", currency: "DAI" },
      fee: { amount: "0.5", currency: "DAI" },
      aztecTxHash: "0xl2",
      ethereumTxHash: "0xl1",
    })
  })
})

describe("upgrade batches", () => {
  it.each(Object.entries(UPGRADE_STATES))("state %s exported: %s", (state, exported) => {
    expect(!!only({ items: [upgradeBatch(state)] })).toBe(exported)
  })

  it("leaves the old version as a migration with no fee, and arrives as one", () => {
    const rows = buildActivityCsvRows({
      ...EMPTY,
      items: [upgradeBatch("received"), deposit({ sipaAddress: SIPA })],
    })
    expect(rows.map((r) => r.type).sort()).toEqual(["Upgrade in", "Upgrade out"])
    const out = rows.find((r) => r.type === "Upgrade out")
    expect(out).toMatchObject({ sent: { amount: "10", currency: "DAI" }, aztecTxHash: "0xcarrier" })
    expect(out?.fee).toBeUndefined()
  })
})

describe("deposits", () => {
  it.each(Object.entries(DEPOSIT_PHASES))(
    "a record with no ledger at phase %s exported: %s",
    (phase, exported) => {
      const record = { phase: phase as SIPADepositRecord["phase"], sweeps: undefined }
      expect(!!only({ items: [deposit(record)] })).toBe(exported)
    },
  )

  it.each(Object.keys(DEPOSIT_PHASES))(
    "a claimed sweep stays exported while its address is %s again",
    (phase) => {
      const row = only({ items: [deposit({ phase: phase as SIPADepositRecord["phase"] })] })
      expect(row).toMatchObject({ received: { amount: "20", currency: "DAI" } })
    },
  )

  it.each(Object.entries(DEPOSIT_KINDS))("%s", (_, [sources, extra, type]) => {
    const rows = buildActivityCsvRows({
      ...EMPTY,
      ...sources,
      items: [...(sources.items ?? []), deposit(extra)],
    })
    expect(rows.map((r) => r.type)).toEqual([type])
  })

  it("receives what the sweep took off the address, with the fee taken out of it", () => {
    const row = only({ items: [deposit()] })
    expect(row?.sent).toBeUndefined()
    expect(row).toMatchObject({
      timestampMs: T0,
      received: { amount: "20", currency: "DAI" },
      fee: { amount: "1", currency: "DAI" },
      aztecTxHash: "0xclaim",
      ethereumTxHash: "0xfund",
    })
  })

  it("a re-used address has one row per sweep, each dated at its sweep", () => {
    const rows = buildActivityCsvRows({
      ...EMPTY,
      items: [
        deposit({
          inboxIndex: "9",
          claimedInboxIndexes: ["7", "9"],
          sweeps: [
            sweep("7", "20", "19", { settledAt: T0 + 1000 }),
            sweep("9", "5", "4.5", { settledAt: T0 + 5000 }),
          ],
        }),
      ],
    })
    expect(rows).toMatchObject([
      {
        timestampMs: T0 + 1000,
        received: { amount: "20", currency: "DAI" },
        fee: { amount: "1", currency: "DAI" },
        ethereumTxHash: "0xfund",
      },
      {
        timestampMs: T0 + 5000,
        received: { amount: "5", currency: "DAI" },
        fee: { amount: "0.5", currency: "DAI" },
        aztecTxHash: "0xclaim",
        ethereumTxHash: "0xsweep9",
      },
    ])
    expect(rows[0]?.aztecTxHash).toBeUndefined()
  })
})

describe("deposits across rows", () => {
  const SUSDS = "0x5875eee11cf8398102fdad704c9e96607675467a" as Address
  const USDC = { tokenSymbol: "USDC", tokenDecimals: 6 }
  const twoTokens = deposit({
    inboxIndex: "8",
    claimedInboxIndexes: ["7", "8"],
    tokenAddress: SUSDS,
    tokenSymbol: "sUSDS",
    sweeps: [
      sweep("7", undefined, "19", { tokenSymbol: "DAI", tokenDecimals: 18 }),
      {
        inboxIndex: "8",
        sweepTxHash: "0xsweep8" as SIPASweep["sweepTxHash"],
        netAmount: "4500000",
        grossAmount: "5000000",
        fundingTokenSymbol: "USDC",
        fundingTokenDecimals: 6,
        ...USDC,
      },
    ],
  })

  it("reports each sweep in the token and decimals of the row it credited", () => {
    const rows = buildActivityCsvRows({ ...EMPTY, items: [twoTokens] })
    expect(rows.map((r) => [r.received, r.fee])).toEqual([
      [{ amount: "19", currency: "DAI" }, undefined],
      [
        { amount: "5", currency: "USDC" },
        { amount: "0.5", currency: "USDC" },
      ],
    ])
  })

  it("reports a token split out of its address's record once, among the record's sweeps", () => {
    const split: ActivityItem = {
      kind: "bridge.sipaDeposit",
      record: (twoTokens as { record: SIPADepositRecord }).record,
      credit: "0x6b175474e89094c44da98b954eedeac495271d0f",
    }
    expect(buildActivityCsvRows({ ...EMPTY, items: [twoTokens, split] })).toHaveLength(2)
  })
})

describe("registrations", () => {
  it("a registration deposit receives what was funded; what it did not credit is the fee", () => {
    const row = only({
      items: [
        deposit({
          intent: "registration",
          sweeps: [sweep("7", "7", "2")],
        }),
      ],
    })
    expect(row).toMatchObject({
      type: "Name registration",
      received: { amount: "7", currency: "DAI" },
      fee: { amount: "5", currency: "DAI" },
    })
  })

  it("a registration paid from the balance reports the gross burned and what arrived", () => {
    expect(only({ items: [withdrawal({ intent: "registration" })] })).toMatchObject({
      type: "Name registration",
      sent: { amount: "9.5", currency: "DAI" },
      fee: { amount: "0.5", currency: "DAI" },
    })
  })
})

describe("fees come from chain amounts only", () => {
  it("a deposit sent in another token receives only the net, with no fee", () => {
    const row = only({
      items: [
        deposit({
          sweeps: [
            sweep("7", undefined, "19", {
              grossAmount: "20000000",
              fundingTokenSymbol: "USDC",
              fundingTokenDecimals: 6,
            }),
          ],
        }),
      ],
    })
    expect(row?.received).toEqual({ amount: "19", currency: "DAI" })
    expect(row?.sent).toBeUndefined()
    expect(row?.fee).toBeUndefined()
  })

  it("a sweep whose gross was never read receives the net, with no fee", () => {
    const row = only({ items: [deposit({ sweeps: [sweep("7", undefined, "19")] })] })
    expect(row?.received).toEqual({ amount: "19", currency: "DAI" })
    expect(row?.fee).toBeUndefined()
  })

  it("a deposit claimed before the ledger existed receives its latest net, with no fee", () => {
    const row = only({ items: [deposit({ sweeps: undefined })] })
    expect(row).toMatchObject({
      timestampMs: T0,
      received: { amount: "19", currency: "DAI" },
      aztecTxHash: "0xclaim",
      ethereumTxHash: "0xfund",
    })
    expect(row?.fee).toBeUndefined()
  })

  it("a withdrawal with no read payout sends the gross, with no fee", () => {
    const row = only({ items: [withdrawal({ receivedAmount: undefined })] })
    expect(row?.sent).toEqual({ amount: "10", currency: "DAI" })
    expect(row?.fee).toBeUndefined()
  })

  it("a swap withdrawal arrives in another token, so it has no fee", () => {
    expect(only({ items: [withdrawal({ swapOutput: "USDC" as never })] })?.fee).toBeUndefined()
  })
})

describe("counterparty", () => {
  it("a send to a name keeps the name and the Aztec address apart", () => {
    const row = only({ transactions: [tx("send", { toTag: "bob", to: "0xabc" })] })
    expect(row?.counterparty).toEqual({ name: "bob", address: "0xabc", network: "Aztec" })
  })

  it("a receive from an unnamed sender has only its address", () => {
    const row = only({ transactions: [tx("receive", { from: "0xdef" })] })
    expect(row?.counterparty).toEqual({ name: undefined, address: "0xdef", network: "Aztec" })
  })

  it("a withdrawal names the Ethereum address with the user's label for it", () => {
    const row = only({ items: [withdrawal({ recipientAlias: "Ledger" })] })
    expect(row?.counterparty).toEqual({
      name: "Ledger",
      address: "0x00000000000000000000000000000000000000aa",
      network: "Ethereum",
    })
  })

  it("is described by the type, the name, the address and the note", () => {
    const csv = activityCsv({
      ...EMPTY,
      transactions: [tx("send", { toTag: "bob", to: "0xabc", memo: "rent" })],
    })
    expect(csv).toContain(",Payment sent · bob · 0xabc · rent,")
  })
})

describe("savings", () => {
  const BURN = "burn-1"
  const burn = {
    localId: BURN,
    recipient: "0x00000000000000000000000000000000000000ee",
    recipientProvenance: "saved-recipient",
    amount: "10",
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    phase: "done",
    startTime: T0,
    l2TxHash: "0xburn",
    minedAt: T0 + 500,
  } as WithdrawalRecord
  const burns = new Map([[BURN, burn]])

  /** A move in of 10 DAI whose vault took 9.9 for 9.5 shares, claimed on the Savings side. */
  function move(extra: Partial<SavingsMoveRecord> = {}): SavingsMoveRecord {
    return {
      direction: "in",
      withdrawalLocalId: BURN,
      escrow: "0x00000000000000000000000000000000000000ee",
      nonce: "0x01",
      recipientCommitment: "0x02",
      amount: parseUnits("10", 18).toString(),
      startTime: T0,
      deposit: {
        inboxIndex: "3",
        amount: parseUnits("9.5", 18).toString(),
        claimed: true,
        txHash: "0xrun",
        at: T0 + 1000,
      },
      vault: {
        txHash: "0xrun",
        assets: parseUnits("9.9", 18).toString(),
        shares: parseUnits("9.5", 18).toString(),
      },
      ...extra,
    }
  }

  it("a move in receives what the vault took, dated when its deposit landed", () => {
    expect(buildSavingsCsvRows({ walletToken: DAI, moves: [move()], burns })).toEqual([
      {
        timestampMs: T0 + 1000,
        type: "Savings deposit",
        received: { amount: "9.9", currency: "DAI" },
        aztecTxHash: "0xburn",
        ethereumTxHash: "0xrun",
      },
    ])
  })

  it("a move in with no vault figures receives the quoted net, else the burn's gross", () => {
    const quoted = move({ vault: undefined, net: parseUnits("9.8", 18).toString() })
    expect(
      buildSavingsCsvRows({ walletToken: DAI, moves: [quoted], burns })[0]?.received?.amount,
    ).toBe("9.8")
    const unread = move({ vault: undefined })
    expect(
      buildSavingsCsvRows({ walletToken: DAI, moves: [unread], burns })[0]?.received?.amount,
    ).toBe("10")
  })

  it("a move out sends what landed on Main, with the rest of what the vault paid as the fee, dated at its burn", () => {
    const out = move({ direction: "out", amount: parseUnits("9.5", 18).toString() })
    expect(buildSavingsCsvRows({ walletToken: DAI, moves: [out], burns })).toEqual([
      {
        timestampMs: T0 + 500,
        type: "Savings withdrawal",
        sent: { amount: "9.5", currency: "DAI" },
        fee: { amount: "0.4", currency: "DAI" },
        aztecTxHash: "0xburn",
        ethereumTxHash: "0xrun",
      },
    ])
    const unread = move({ direction: "out", vault: undefined })
    const row = buildSavingsCsvRows({ walletToken: DAI, moves: [unread], burns })[0]
    expect(row?.sent).toEqual({ amount: "9.5", currency: "DAI" })
    expect(row?.fee).toBeUndefined()
  })

  it("a move whose deposit is not yet claimed has no row", () => {
    const pending = move({ deposit: { inboxIndex: "3", amount: "1", claimed: false } })
    expect(
      buildSavingsCsvRows({
        walletToken: DAI,
        moves: [pending, move({ deposit: undefined })],
        burns,
      }),
    ).toEqual([])
  })

  it("has its own file", () => {
    const lines = savingsCsv({ walletToken: DAI, moves: [move()], burns })
      .trimEnd()
      .split("\r\n")
    expect(lines[1]).toBe("2026-01-02 03:04:06 UTC,,,9.9,DAI,,,,,,Savings deposit,0xrun")
    expect(activityCsvFileName(new Date(T0), "savings")).toBe(
      "zkmoney-savings-activity-2026-01-02.csv",
    )
  })
})

describe("a 6-decimal token", () => {
  const USDC = { symbol: "USDC", decimals: 6 }

  it("exports a withdrawal in the burned token's own decimals and symbol", () => {
    const row = only({
      items: [
        withdrawal({
          tokenSymbol: "USDC",
          tokenDecimals: 6,
          amount: "10",
          rawAmount: parseUnits("10", 6).toString(),
          relayerTip: parseUnits("0.5", 6).toString(),
          receivedAmount: parseUnits("9.5", 6).toString(),
        }),
      ],
    })
    expect(row).toMatchObject({
      sent: { amount: "9.5", currency: "USDC" },
      fee: { amount: "0.5", currency: "USDC" },
    })
  })

  it("exports transfers and deposits in the wallet token's decimals and symbol", () => {
    const rows = buildActivityCsvRows({
      ...EMPTY,
      walletToken: USDC,
      transactions: [
        tx("send", { token: { ...TOKEN, symbol: "", decimals: 6 }, amountAtomic: "2500000" }),
      ],
      items: [
        deposit({
          tokenSymbol: "",
          netAmount: parseUnits("19", 6).toString(),
          sweeps: [
            sweep("7", undefined, "19", {
              netAmount: parseUnits("19", 6).toString(),
              grossAmount: parseUnits("20", 18).toString(),
              fundingTokenSymbol: "USDC",
              fundingTokenDecimals: 18,
            }),
          ],
        }),
      ],
    })
    expect(rows.find((r) => r.type === "Payment sent")?.sent).toEqual({
      amount: "2.5",
      currency: "USDC",
    })
    expect(rows.find((r) => r.type === "Deposit")).toMatchObject({
      received: { amount: "20", currency: "USDC" },
      fee: { amount: "1", currency: "USDC" },
    })
  })

  it("exports Savings moves in the wallet token's decimals and symbol", () => {
    const move: SavingsMoveRecord = {
      direction: "out",
      withdrawalLocalId: "burn-6",
      escrow: "0x00000000000000000000000000000000000000ee",
      nonce: "0x01",
      recipientCommitment: "0x02",
      amount: parseUnits("9.5", 6).toString(),
      startTime: T0,
      deposit: { inboxIndex: "3", amount: parseUnits("9.5", 6).toString(), claimed: true },
    }
    expect(
      buildSavingsCsvRows({ walletToken: USDC, moves: [move], burns: new Map() }),
    ).toMatchObject([{ sent: { amount: "9.5", currency: "USDC" } }])
  })
})

describe("the file", () => {
  it("uses Koinly's universal headers, UTC dates, oldest first", () => {
    const csv = activityCsv({
      ...EMPTY,
      transactions: [tx("send", { timestamp: T0 + 60_000 }), tx("receive")],
    })
    const lines = csv.trimEnd().split("\r\n")
    expect(lines[0]).toBe(
      "Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency," +
        "Net Worth Amount,Net Worth Currency,Label,Description,TxHash",
    )
    expect(lines[1]).toMatch(/^2026-01-02 03:04:05 UTC,,,12.5,DAI,/)
    expect(lines[2]).toMatch(/^2026-01-02 03:05:05 UTC,12.5,DAI,,,/)
  })

  it("never fills both sides of a row, so Koinly reads no trade", () => {
    const rows = buildActivityCsvRows({
      ...EMPTY,
      transactions: Object.keys(TRANSACTION_ACTIONS).map((action) => tx(action)),
      items: [
        ...Object.values(WITHDRAWAL_KINDS).map(([extra]) => withdrawal(extra)),
        ...Object.values(DEPOSIT_KINDS).map(([, extra]) => deposit(extra)),
      ],
    })
    expect(rows.filter((r) => r.sent && r.received)).toEqual([])
  })

  it("prefers the Ethereum hash, which an imported Ethereum wallet shares", () => {
    expect(activityCsv({ ...EMPTY, items: [withdrawal()] }).trimEnd()).toMatch(/,0xl1$/)
  })

  it("quotes commas and quotes", () => {
    const csv = activityCsv({ ...EMPTY, transactions: [tx("send", { memo: 'a, "x"' })] })
    expect(csv).toContain(`"Payment sent · a, ""x"""`)
  })

  it("is named by date", () => {
    expect(activityCsvFileName(new Date(T0))).toBe("zkmoney-activity-2026-01-02.csv")
  })
})
