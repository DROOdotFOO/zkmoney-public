/**
 * The data every demo scenario is built from. Records are the real record types, so a shape that
 * drifts in front-core breaks the build here rather than rendering a blank row at runtime.
 *
 * The SIPA deposits are crypto-consistent: each carries a real `message_secret` and the recovery
 * address actually derived from it and the demo master key, which is what `runSipaRecovery`
 * fail-closes on. That makes the Recover button in the `recovery` scenario a genuine end-to-end
 * run against the fake wallet, not a mocked one.
 */
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { Fr, Point } from "@aztec-labs/aztec.js/fields"
import { deriveRecoveryAddress, encodePaylinkInline } from "@obsidion/sdk"
import { deriveStealthKey, isSettledSipaPhase } from "@obsidion/front-core"
import type {
  Contact,
  PaylinkTransaction,
  StoredRequest,
  SIPADepositRecord,
  Transaction,
  WithdrawalRecord,
} from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { deploymentOfTuples, type PinnedOxideDeployment } from "@obsidion/core/oxide"
import { getAddress, parseUnits, type Address, type Hash, type Hex } from "viem"
import { STUCK_SWEEP_MS } from "../features/deposit/sipaRecovery"
import { DEMO_DEPOSIT_FEE, DEMO_L1_TOKEN, DEMO_PORTAL, DEMO_WITHDRAWAL_FEE } from "./fakeL1Rpc"
export { DEMO_L1_TOKEN }

/** Master secret every demo key derives from. Under the BN254 modulus, and public by design. */
export const DEMO_MSK_HEX = `0x${"2a".repeat(32)}`

/** ECDSA K256 signing key behind the demo auth provider — stands in for the passkey's r1 key. */
export const DEMO_SIGNING_KEY_HEX = "11".repeat(32)

export const DEMO_HANDLE = "demo"
export const DEMO_CREDENTIAL_ID = "demo-credential"
export const DEMO_PASSKEY_PUBKEY_HEX = "c1".repeat(64)
// Must stay below the BN254 field modulus — a real AztecAddress is a field element, and the
// handshake codec rejects anything that is not.
export const DEMO_L2_ADDRESS = `0x${"1f".repeat(32)}`
export const DEMO_COMPLETE_ADDRESS = `0x${"ab".repeat(288)}`

/** L2 oxide token — the address TokenStorage and BalanceStorage agree on. */
export const DEMO_L2_TOKEN = `0x${"5c".repeat(32)}`

/** The network every seeded record is stamped with: demo mode boots no wallet. */
export const DEMO_NETWORK_ID = `0x${"de".repeat(20)}`

/** The L1 account that paid the funded demo deposits — the deposit sheet's Funder. */
export const DEMO_L1_FUNDER = "0xf0de1000000000000000000000000000000fd0e1" as Address

/** 1,284.50 DAI, at the flat 18 decimals every network uses. */
export const DEMO_BALANCE_RAW = 1_284_500_000_000_000_000_000n

/** Stands in for the oxide manifest so nothing dials the env registry. */
export const DEMO_OXIDE_TUPLE: OxideEnvTuple = {
  version: "demo",
  gitSha: "0".repeat(40),
  timestamp: new Date(0).toISOString(),
  deployedAt: new Date(0).toISOString(),
  portal: DEMO_PORTAL,
  token: DEMO_L1_TOKEN,
  l2Token: DEMO_L2_TOKEN,
  enclaveUrl: "https://enclave.invalid",
  pcr0: "0".repeat(96),
  rollupVersion: "1",
  // The self-sweep binds its CREATE2 args and its deploy call to the factory.
  sipaFactory: "0x5117a0000000000000000000000000000000fac7",
  forwardingTable: "0xf0a2000000000000000000000000000000000fb1",
  sipaResolver: "0x8e50100000000000000000000000000000005e12",
  registry: "0x1e61000000000000000000000000000000015ada",
  depositSubsidy: "0x5ab500000000000000000000000000000000d1da",
  withdrawalSubsidy: "0x5ab500000000000000000000000000000000d1db",
  // Every burn settles into it; the withdrawal rails resolve only when it is present.
  plainWithdrawalExecutor: "0xe8ec000000000000000000000000000000000e8c",
}

/** The demo's deployment: one bridge, {@link DEMO_OXIDE_TUPLE}'s. */
export const DEMO_OXIDE_DEPLOYMENT: PinnedOxideDeployment = (() => {
  const deployment = deploymentOfTuples([DEMO_OXIDE_TUPLE])
  return { deployment, pinned: deployment.bridges[0]!, timestampMs: 0 }
})()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const CONTACT_ADDRESSES = ["a1", "b2", "c3", "d4"].map((byte) => `0x${byte.repeat(32)}`)

const hash = (seed: string): Hash => `0x${seed.repeat(32).slice(0, 64)}` as Hash

const address = (seed: string): Address => `0x${seed.repeat(20).slice(0, 40)}` as Address

/** Withdrawal recipients are stored EIP-55 checksummed — the withdraw screen checksums before it
 *  hands the address to the burn. */
const l1Recipient = (seed: string): Address => getAddress(address(seed))

/** Base units at the flat 18 decimals, for the fields writers persist raw. */
const atomic = (display: string): string => parseUnits(display, 18).toString()

/** A fixture row before the activity store's key and raw amount, which `keyed` derive. */
type DemoRow = Transaction extends infer T
  ? T extends Transaction
    ? Omit<T, "id" | "amountAtomic">
    : never
  : never

const keyed = (row: DemoRow): Transaction =>
  ({
    ...row,
    id: row.operationId ?? row.txHash,
    amountAtomic: "token" in row && row.token ? parseUnits(String(row.token.amount), 18) : 0n,
  }) as Transaction

const daiToken = (amount: number) => ({
  address: DEMO_L2_TOKEN,
  name: WALLET_TOKEN_SYMBOL,
  symbol: WALLET_TOKEN_SYMBOL,
  decimals: 18,
  logo: "",
  amount,
  price: 1,
})

/** The stealth keypair a demo session unlocks to — half of every recovery key below. */
export function demoStealthKey() {
  return deriveStealthKey(Fr.fromHexString(DEMO_MSK_HEX))
}

interface DepositSpec {
  seed: string
  phase: SIPADepositRecord["phase"]
  amount: string
  ageMs: number
  netAmount?: string
  fee?: string
  /** The sweep's inbox leaf index. Stamped with the net the moment the sweep log is read. */
  inboxIndex?: string
  /** Set only on the self-initiated deposits — a third-party sender's transfer is unknown. */
  fundingTxHash?: Hash
  sweepTxHash?: Hash
  claimTxHash?: string
  recoveryTxHash?: Hash
}

function depositFrom(spec: DepositSpec, now: number): SIPADepositRecord {
  const messageSecret = Fr.random()
  const recoveryAddress = deriveRecoveryAddress(
    demoStealthKey().publicKey,
    messageSecret,
  ).toString()
  const startTime = now - spec.ageMs
  const settled = isSettledSipaPhase(spec.phase)
  return {
    sipaAddress: address(spec.seed),
    recipientL2Address: DEMO_L2_ADDRESS,
    messageSecret: messageSecret.toString(),
    recipientHash: Fr.random().toString(),
    recoveryAddress,
    l1ChainId: 11155111,
    amount: spec.amount,
    tokenSymbol: WALLET_TOKEN_SYMBOL,
    phase: spec.phase,
    startTime,
    endTime: settled ? startTime + 4 * MINUTE : undefined,
    tokenAddress: DEMO_L1_TOKEN,
    netAmount: spec.netAmount,
    fee: spec.fee,
    inboxIndex: spec.inboxIndex,
    fundingTxHash: spec.fundingTxHash,
    // The funding-transfer scan reads the sender and the hash off the same log, so a fixture that
    // knows one knows both; the rest show the detail sheet's undetected state.
    fundingFromAddress: spec.fundingTxHash ? DEMO_L1_FUNDER : undefined,
    // The funder is the "Rainbow" L1 contact, so its chat shows these deposits.
    walletAddress: spec.fundingTxHash ? DEMO_L1_FUNDER : undefined,
    walletProvider: spec.fundingTxHash ? "rainbow" : undefined,
    walletName: spec.fundingTxHash ? "Rainbow" : undefined,
    sweepTxHash: spec.sweepTxHash,
    claimTxHash: spec.claimTxHash,
    recoveryTxHash: spec.recoveryTxHash,
  }
}

/**
 * What a deposit costs in the demo: 0.25 DAI. Every funded fixture carries it, because the sync
 * stamps it with the gross the moment it reads L1 — and it comes off the fake chain's own read, so
 * the seeded records and the Deposit screen quote the same floor.
 */
const DEMO_FEE = DEMO_DEPOSIT_FEE.toString()

/**
 * Every branch of the two exits, in order: recovery alone under the fee floor, recovery alone over
 * the per-transaction cap, both exits (stuck), neither (a sweep still young), neither (both
 * terminal phases), and neither again once a self-sweep has been submitted and is waiting on the
 * claim scan.
 */
export function recoveryDeposits(now: number): SIPADepositRecord[] {
  return [
    {
      seed: "d1",
      phase: "recoverable" as const,
      amount: "0.2",
      ageMs: 3 * HOUR,
      fee: DEMO_FEE,
    },
    // Above the fee, so the copy reads the cap rather than the floor.
    {
      seed: "d8",
      phase: "recoverable" as const,
      amount: "8400",
      ageMs: 90 * MINUTE,
      fee: DEMO_FEE,
    },
    {
      seed: "d2",
      phase: "sweeping" as const,
      amount: "18",
      ageMs: STUCK_SWEEP_MS + 20 * MINUTE,
      fee: DEMO_FEE,
    },
    // Clearly inside the STUCK_SWEEP_MS window: seeded AT the threshold it reads stuck by the
    // time anything evaluates it (the check is >= against a later Date.now()).
    {
      seed: "d3",
      phase: "sweeping" as const,
      amount: "42",
      ageMs: 2 * MINUTE,
      fee: DEMO_FEE,
    },
    {
      seed: "d4",
      phase: "recovered" as const,
      amount: "0.3",
      ageMs: 2 * DAY,
      // Under the fee floor, which is what made it recoverable before it was recovered.
      fee: DEMO_FEE,
      recoveryTxHash: hash("4e"),
    },
    {
      seed: "d5",
      phase: "claimed" as const,
      // amount is the net: the sweep write overwrites the gross with formatUnits(net).
      amount: "249.75",
      ageMs: 5 * DAY,
      netAmount: atomic("249.75"),
      fee: DEMO_FEE,
      sweepTxHash: hash("7b"),
    },
    {
      seed: "d7",
      phase: "sweeping" as const,
      amount: "31",
      ageMs: STUCK_SWEEP_MS + 2 * HOUR,
      fee: DEMO_FEE,
      sweepTxHash: hash("8c"),
    },
  ].map((spec) => depositFrom(spec, now))
}

export function demoContacts(): Contact[] {
  return [
    { name: "Ada", address: CONTACT_ADDRESSES[0]!, tag: "ada", verified: true },
    { name: "Bo", address: CONTACT_ADDRESSES[1]!, tag: "bo", verified: true },
    { name: "Cleo", address: CONTACT_ADDRESSES[2]!, tag: "cleo", verified: true },
    { name: "Dmitri", address: CONTACT_ADDRESSES[3]!, tag: "dmitri" },
    // L1 wallets: a user-labeled one (the deposit funder, so its chat shows the deposits) and an
    // unlabeled one that renders as its truncated address.
    {
      name: "Rainbow",
      address: DEMO_L1_FUNDER,
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "rainbow", provenance: "deposit-attested", userLabeled: true },
    },
    {
      name: "External Wallet",
      address: "0x5a7e0000000000000000000000000000000e71a1",
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "metamask", provenance: "saved-recipient" },
    },
  ]
}

/** Not a saved contact — the counterparty label of last resort. Under the BN254 modulus, so it
 *  parses as an L2 address rather than falling back to the raw string. */
export const STRANGER_ADDRESS = `0x${"1e".repeat(32)}`

/** The sender tag a receive from a stranger carries: proven against the registry by the receiver,
 *  but bound to no contact on this device, so the row draws the bare tag. */
export const STRANGER_TAG = "kai"

/** Stands in for a stored claim URL. It carries no decodable fragment, so submitting a recovery
 *  from the demo fails at the decode rather than reaching a chain that isn't there. */
const DEMO_PAYLINK = "https://zk.money/link#demo"

/**
 * The creator "Sent via paylink" rows, one per state the detail modal's recovery gate separates: a
 * link still in its grace window (offers Cancel link), an email and a direct link past their
 * windows (offer Reclaim funds), and a claimed and a refunded row that offer neither. The settled two carry no
 * `paylink`: `markCreateRowClaimed` / `markCreateRowRefunded` scrub it as they set the flag. Their
 * status pill reads `paylinkStatusFor`, which never looks at the URL.
 */
function creatorLinkRows(now: number): Omit<PaylinkTransaction, "id" | "amountAtomic">[] {
  const sec = (ms: number) => Math.floor(ms / 1000)
  const base = {
    action: "Pay To Email" as const,
    emailPaymentAction: "Pay To Email" as const,
    status: "success" as const,
    paylink: DEMO_PAYLINK,
    obsidionAccountAddress: DEMO_L2_ADDRESS,
    tokenAddress: DEMO_L2_TOKEN,
  }
  return [
    {
      ...base,
      flavor: "direct",
      token: daiToken(30),
      timestamp: now - 6 * DAY,
      txHash: hash("66"),
      payToEmailSecret: `0x${"71".repeat(32)}`,
      fallbackSecret: `0x${"81".repeat(32)}`,
      fromClaimable: sec(now + 5 * 60 * 1000),
      untilClaimable: sec(now + 7 * DAY),
      refundableUntil: sec(now + 7 * DAY),
    },
    {
      ...base,
      flavor: "email",
      to: "friend@example.com",
      token: daiToken(12),
      timestamp: now - 40 * DAY,
      txHash: hash("67"),
      payToEmailSecret: `0x${"72".repeat(32)}`,
      fallbackSecret: `0x${"82".repeat(32)}`,
      fromClaimable: 0,
      untilClaimable: sec(now - 10 * DAY),
      refundableUntil: sec(now - 10 * DAY),
    },
    {
      ...base,
      flavor: "direct",
      token: daiToken(20),
      timestamp: now - 30 * DAY,
      txHash: hash("6b"),
      payToEmailSecret: `0x${"75".repeat(32)}`,
      fallbackSecret: `0x${"85".repeat(32)}`,
      fromClaimable: 0,
      untilClaimable: sec(now - 2 * DAY),
      refundableUntil: sec(now - 2 * DAY),
    },
    {
      ...base,
      flavor: "direct",
      token: daiToken(75),
      timestamp: now - 13 * DAY,
      txHash: hash("68"),
      payToEmailSecret: `0x${"73".repeat(32)}`,
      fallbackSecret: `0x${"83".repeat(32)}`,
      fromClaimable: 0,
      untilClaimable: sec(now + 17 * DAY),
      refundableUntil: sec(now + 17 * DAY),
      isClaimed: true,
      paylink: undefined,
    },
    {
      ...base,
      flavor: "email",
      to: "nobody@example.com",
      token: daiToken(9),
      timestamp: now - 45 * DAY,
      txHash: hash("69"),
      payToEmailSecret: `0x${"74".repeat(32)}`,
      fallbackSecret: `0x${"84".repeat(32)}`,
      fromClaimable: 0,
      untilClaimable: sec(now - 15 * DAY),
      refundableUntil: sec(now - 15 * DAY),
      isRefunded: true,
      refundTxHash: hash("6a"),
      refundKind: "reclaim",
      paylink: undefined,
    },
  ]
}

/**
 * A mixed L2 history covering every row the activity feed builds from a transaction the web wallet
 * can actually write: sends and receives against saved contacts (which is what the contact chat
 * assembles from) and against strangers, the three paylink legs, and the pending/failed statuses.
 *
 * A receive's `from` is the sender's TAG — the receiver resolves a display name and persists that,
 * never an address — while `senderL2Address` carries the proven sender. A send's `to` is the
 * resolved L2 address, which is what the send path passes to storage.
 */
/** A row this page is still proving: dated after it loaded, so the boot sweep leaves it. */
function provingSince(at: number): number {
  return Math.max(at, performance.timeOrigin + 1)
}

export function demoTransactions(now: number): Transaction[] {
  const [ada, bo, cleo] = CONTACT_ADDRESSES as [string, string, string]
  const rows: DemoRow[] = [
    // The two pending sends are the chat's delivery marks: no hash yet means the proof is still
    // running (spinner), a hash means it is in the mempool (one tick).
    {
      action: "send",
      token: daiToken(18),
      to: ada,
      timestamp: provingSince(now - 2 * MINUTE),
      status: "pending",
      // Pre-submit rows persist with an empty hash until the wallet mints the real one.
      txHash: "",
      operationId: "demo-send-proving",
    },
    // A pre-submit row a closed tab left behind: `recoverInterrupted` fails it on the next load.
    {
      action: "send",
      token: daiToken(27),
      to: cleo,
      timestamp: now - 2 * HOUR,
      status: "pending",
      txHash: "",
      operationId: "demo-send-interrupted",
    },
    {
      action: "send",
      token: daiToken(42),
      to: ada,
      timestamp: now - 25 * MINUTE,
      status: "pending",
      txHash: hash("11"),
    },
    {
      action: "receive",
      token: daiToken(120),
      from: "bo",
      senderL2Address: bo,
      to: DEMO_HANDLE,
      memo: "dinner split",
      timestamp: now - 5 * HOUR,
      status: "success",
      txHash: hash("22"),
    },
    {
      action: "send",
      token: daiToken(15.5),
      to: cleo,
      timestamp: now - 2 * DAY,
      status: "success",
      txHash: hash("33"),
    },
    {
      action: "send",
      token: daiToken(8),
      to: ada,
      timestamp: now - 3 * DAY,
      // The send path keeps the thrown message as detail; this is aztec.js's receipt wait giving up
      // on a transaction the sequencer dropped after it was broadcast.
      status: "failed",
      failure: { code: "tx.failed", detail: `Transaction ${hash("44")} was dropped. Reason: unknown` },
      txHash: hash("44"),
    },
    {
      action: "receive",
      token: daiToken(64),
      from: "ada",
      senderL2Address: ada,
      to: DEMO_HANDLE,
      timestamp: now - 4 * DAY,
      status: "success",
      txHash: hash("55"),
      requestId: "req_demo_done",
    },
    ...creatorLinkRows(now),
    {
      action: "Claim With Email",
      emailPaymentAction: "Claim With Email",
      flavor: "direct",
      token: daiToken(45),
      timestamp: now - 7 * DAY,
      status: "success",
      txHash: hash("77"),
    },
    {
      action: "Claim Back",
      emailPaymentAction: "Claim Back",
      flavor: "direct",
      token: daiToken(22),
      timestamp: now - 8 * DAY,
      status: "success",
      txHash: hash("88"),
    },
    {
      action: "receive",
      token: daiToken(7.25),
      from: STRANGER_TAG,
      senderL2Address: STRANGER_ADDRESS,
      to: DEMO_HANDLE,
      timestamp: now - 11 * DAY,
      status: "success",
      txHash: hash("b9"),
    },
    {
      action: "send",
      token: daiToken(19),
      to: STRANGER_ADDRESS,
      timestamp: now - 12 * DAY,
      status: "success",
      txHash: hash("c9"),
    },
  ]
  return rows.map(keyed)
}

/**
 * One record per phase. Every record carries `rawAmount` and `relayerTip`, written at the seed
 * because both are fixed when the burn is built; post-mine records add
 * `l2TxHash` and `blockNumber`, which `markMined` writes with them. `withdrawalId` joins them from
 * `awaiting_proven` on: the tracker derives it at the top of a tick and cannot advance a record
 * past `l2_mined` without one.
 */
export function demoWithdrawals(now: number): WithdrawalRecord[] {
  const base = {
    tokenSymbol: WALLET_TOKEN_SYMBOL,
    tokenDecimals: 18,
    recipientProvenance: "saved-recipient" as const,
    // The executor takes its fee and pays the tip out of the burn, so the fee row renders on every record.
    relayerTip: WITHDRAW_RELAYER_TIP.toString(),
    withdrawalFee: DEMO_WITHDRAWAL_FEE.toString(),
  }
  return [
    {
      ...base,
      localId: "wdraw_demo_1",
      recipient: getAddress(DEMO_L1_FUNDER),
      amount: "75",
      rawAmount: atomic("75"),
      phase: "submitting",
      startTime: provingSince(now - 40_000),
    },
    // Left behind by a closed tab: `recoverInterrupted` fails it on the next load.
    {
      ...base,
      localId: "wdraw_demo_9",
      recipient: l1Recipient("dd"),
      amount: "33",
      rawAmount: atomic("33"),
      phase: "submitting",
      startTime: now - 2 * HOUR,
    },
    {
      ...base,
      localId: "wdraw_demo_2",
      recipient: l1Recipient("bb"),
      amount: "120",
      rawAmount: atomic("120"),
      phase: "l2_mined",
      startTime: now - 6 * MINUTE,
      phaseEnteredAt: now - 5 * MINUTE,
      l2TxHash: hash("a1"),
      blockNumber: 4211,
    },
    {
      ...base,
      localId: "wdraw_demo_3",
      recipient: l1Recipient("cc"),
      amount: "500",
      rawAmount: atomic("500"),
      phase: "awaiting_proven",
      // Older than the delay threshold, so the row offers "Check again" — which is inert in the
      // demo: the re-check runs off the wallet's node, and the demo has no wallet.
      startTime: now - 3 * HOUR,
      phaseEnteredAt: now - 3 * HOUR,
      l2TxHash: hash("b2"),
      blockNumber: 4100,
      withdrawalId: hash("b3") as Hex,
    },
    {
      ...base,
      localId: "wdraw_demo_4",
      recipient: l1Recipient("dd"),
      amount: "36",
      rawAmount: atomic("36"),
      phase: "finalizing_l1",
      startTime: now - 30 * MINUTE,
      phaseEnteredAt: now - 12 * MINUTE,
      l2TxHash: hash("c3"),
      blockNumber: 4180,
      withdrawalId: hash("c4") as Hex,
    },
    {
      ...base,
      localId: "wdraw_demo_7",
      recipient: l1Recipient("77"),
      amount: "210",
      rawAmount: atomic("210"),
      phase: "finalizing_l1",
      // Proven on L2 and past the delay threshold with no release: the one record that offers the
      // manual finalize, which runs its full arc against the fake L1 (`demoFinalization.ts`).
      startTime: now - 5 * HOUR,
      phaseEnteredAt: now - 4 * HOUR,
      l2TxHash: hash("c7"),
      blockNumber: 4035,
      withdrawalId: hash("c8") as Hex,
    },
    {
      ...base,
      localId: "wdraw_demo_8",
      recipient: l1Recipient("88"),
      amount: "48",
      rawAmount: atomic("48"),
      phase: "finalizing_l1",
      // A manual finalize already submitted: the record waits on that transaction, so the detail
      // modal shows its Finalization row and no finalize affordance.
      startTime: now - 6 * HOUR,
      phaseEnteredAt: now - 5 * HOUR,
      l2TxHash: hash("c9"),
      blockNumber: 4020,
      withdrawalId: hash("ca") as Hex,
      finalizeTxHash: hash("cb") as Hex,
    },
    {
      ...base,
      localId: "wdraw_demo_5",
      recipient: l1Recipient("ee"),
      amount: "900",
      rawAmount: atomic("900"),
      phase: "done",
      startTime: now - 3 * DAY,
      endTime: now - 3 * DAY + 40 * MINUTE,
      l2TxHash: hash("d5"),
      blockNumber: 3120,
      withdrawalId: hash("d7") as Hex,
      l1TxHash: hash("d6") as Hex,
    },
    {
      ...base,
      localId: "wdraw_demo_6",
      recipient: l1Recipient("ff"),
      amount: "12",
      rawAmount: atomic("12"),
      phase: "failed",
      startTime: now - 8 * DAY,
      endTime: now - 8 * DAY + MINUTE,
      // Pre-mine throw: the passkey never answered.
      failure: { code: "withdrawal.failed", detail: "Passkey assertion returned no credential" },
    },
  ]
}

/**
 * Every request row the wallet draws: contact requests in both directions, requests from people
 * outside the contact book, and a shareable link request. The token trio and `networkId` come with
 * every row: the announce (and the receiver's ingest on the incoming one) carries them alongside the
 * display amount.
 */
export function demoRequests(now: number, networkId: string): StoredRequest[] {
  const token = { tokenAddress: DEMO_L2_TOKEN, tokenDecimals: 18, networkId }
  return [
    {
      ...token,
      // The share URL re-encodes id / addresses as BN254 fields, so this row alone needs
      // sub-modulus hex values (DEMO_L2_TOKEN's 0x5c… pattern exceeds the field).
      id: hash("0d"),
      tokenAddress: hash("1b"),
      contactTag: "",
      amount: 10,
      amountAtomic: atomic("10"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "outgoing",
      status: "pending",
      // Newest row in the feed so the Home pending tab's three-row cut keeps it visible.
      createdAt: now - MINUTE,
      kind: "link",
      note: "Pizza dinner",
      expiresAt: now + 7 * DAY,
      requesterTag: "demo",
      requesterAddress: hash("2c"),
    },
    {
      ...token,
      // Paid but not yet credited: its SIPA (seed "ea" below) is funded, so the row reads
      // "Payment detected" and the deposit itself collapses into this row.
      id: hash("0e"),
      tokenAddress: hash("1b"),
      contactTag: "",
      amount: 25,
      amountAtomic: atomic("25"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "outgoing",
      status: "pending",
      createdAt: now - 4 * MINUTE,
      kind: "link",
      note: "Concert ticket",
      expiresAt: now + 6 * DAY,
      requesterTag: "demo",
      requesterAddress: hash("2c"),
      sipaAddress: address("ea"),
    },
    {
      ...token,
      id: "req_demo_in",
      contactTag: "bo",
      amount: 24,
      amountAtomic: atomic("24"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "incoming",
      status: "pending",
      createdAt: now - 90 * MINUTE,
      kind: "contact",
      note: "coffee run",
    },
    {
      ...token,
      id: "req_demo_out",
      contactTag: "cleo",
      amount: 180,
      amountAtomic: atomic("180"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "outgoing",
      status: "pending",
      createdAt: now - 20 * HOUR,
      kind: "contact",
    },
    // Ada's chat shows every request bubble: requested (out), is-requesting (in), declined.
    {
      ...token,
      id: "req_demo_ada_out",
      contactTag: "ada",
      amount: 23,
      amountAtomic: atomic("23"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "outgoing",
      status: "pending",
      createdAt: now - 40 * MINUTE,
      kind: "contact",
      note: "Pizza dinner",
    },
    {
      ...token,
      id: "req_demo_ada_in",
      contactTag: "ada",
      amount: 12,
      amountAtomic: atomic("12"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "incoming",
      status: "pending",
      createdAt: now - 3 * HOUR,
      kind: "contact",
      note: "tickets",
    },
    {
      ...token,
      id: "req_demo_ada_declined",
      contactTag: "ada",
      amount: 10,
      amountAtomic: atomic("10"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "outgoing",
      status: "declined",
      createdAt: now - 3 * DAY - HOUR,
      kind: "contact",
    },
    // Requesters outside the contact book: the separate inbox's rows, never in Activity.
    {
      ...token,
      id: "req_demo_stranger_mina",
      contactTag: "mina",
      amount: 42,
      amountAtomic: atomic("42"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "incoming",
      status: "pending",
      createdAt: now - 2 * HOUR,
      kind: "contact",
      note: "Dinner split",
    },
    {
      ...token,
      id: "req_demo_stranger_paul",
      contactTag: "paul_c",
      amount: 1250,
      amountAtomic: atomic("1250"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "incoming",
      status: "pending",
      createdAt: now - 26 * HOUR,
      kind: "contact",
      note: "Invoice #204",
    },
    {
      ...token,
      id: "req_demo_stranger_jj",
      contactTag: "jj_8",
      amount: 5,
      amountAtomic: atomic("5"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "incoming",
      status: "pending",
      createdAt: now - 3 * DAY,
      kind: "contact",
    },
    {
      ...token,
      id: "req_demo_done",
      contactTag: "ada",
      amount: 60,
      amountAtomic: atomic("60"),
      asset: WALLET_TOKEN_SYMBOL,
      direction: "outgoing",
      status: "pending",
      createdAt: now - 9 * DAY,
      kind: "contact",
    },
  ]
}

/**
 * Every deposit row the feed can draw: credited, in flight, both exits on offer, a completed
 * recovery, and an unfunded address that must stay out of the feed. `failed` (a reverted funding tx)
 * is absent because the web wallet never writes it.
 */
export function activityDeposits(now: number): SIPADepositRecord[] {
  return [
    {
      seed: "e1",
      phase: "claimed" as const,
      // amount is the net: the sweep write overwrites the gross with formatUnits(net).
      amount: "399.75",
      ageMs: 8 * HOUR,
      netAmount: atomic("399.75"),
      fee: DEMO_FEE,
      fundingTxHash: hash("e6"),
      sweepTxHash: hash("e7"),
      claimTxHash: hash("e8"),
    },
    {
      seed: "e2",
      phase: "sweeping" as const,
      amount: "95",
      ageMs: 3 * MINUTE,
      fee: DEMO_FEE,
    },
    // Funds for the "Concert ticket" request link: hidden as a deposit row, shown on that row.
    {
      seed: "ea",
      phase: "sweeping" as const,
      amount: "25",
      ageMs: 2 * MINUTE,
      fee: DEMO_FEE,
    },
    // Sweep log read, L1->L2 message not yet settled. The claim scan writes the net into both
    // `amount` and `netAmount` here, so the gross 75 the row shows is the net plus the stamped fee.
    {
      seed: "e3",
      phase: "pendingClaim" as const,
      amount: "74.75",
      ageMs: 2 * MINUTE,
      netAmount: atomic("74.75"),
      fee: DEMO_FEE,
      inboxIndex: "12",
      sweepTxHash: hash("eb"),
    },
    {
      seed: "e4",
      phase: "recoverable" as const,
      amount: "0.2",
      ageMs: 5 * HOUR,
      fee: DEMO_FEE,
    },
    // Above the fee: unsweepable for the per-transaction cap instead of the floor.
    {
      seed: "e9",
      phase: "recoverable" as const,
      amount: "8400",
      ageMs: 90 * MINUTE,
      fee: DEMO_FEE,
    },
    {
      seed: "e5",
      phase: "sweeping" as const,
      amount: "18",
      ageMs: STUCK_SWEEP_MS + 20 * MINUTE,
      fee: DEMO_FEE,
      fundingTxHash: hash("ea"),
    },
    {
      seed: "e6",
      phase: "recovered" as const,
      amount: "0.3",
      ageMs: 2 * DAY,
      fee: DEMO_FEE,
      recoveryTxHash: hash("e9"),
    },
    // Address published, never paid — the feed hides it.
    { seed: "e8", phase: "broadcast" as const, amount: "0", ageMs: 30 * MINUTE },
  ].map((spec) => depositFrom(spec, now))
}

/**
 * Deterministic claimable paylink fragments — someone else's links, so /link#<fragment> hands off
 * to the Home claim modal. The escrow tag point is the Grumpkin generator; nothing here can be
 * spent.
 */
export function demoClaimFragments(): { direct: string; email: string } {
  const escrowTagSecret = Point.fromString(
    "0x00000000000000000000000000000000000000000000000000000000000000010000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272c",
  )
  return {
    direct: encodePaylinkInline({
      secret: new Fr(0x11n),
      paylinkType: "paylinkDirect",
      classId: new Fr(0x22n),
      chainId: 31337,
      fallbackKeyHash: new Fr(0x23n),
      rollupVersion: 1,
      escrowTagSecret,
    }),
    email: encodePaylinkInline({
      secret: new Fr(0x33n),
      paylinkType: "paylinkEmail",
      classId: new Fr(0x44n),
      chainId: 31337,
      fallbackKeyHash: new Fr(0x45n),
      rollupVersion: 1,
      escrowTagSecret,
    }),
  }
}

/** What chain would say about a demo link: a link carries no amount or funding tx of its own. */
export function demoEscrowAmount(_fragment: string): bigint {
  return parseUnits("100", 18)
}
export function demoFundingTxHash(_fragment: string): string {
  return "0x0093c3aabbccddeeff00112233445566778899aabbccddeeff00112233444623"
}
