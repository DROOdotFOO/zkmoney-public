import { useEffect, useSyncExternalStore } from "react"
import {
  decodeEventLog,
  erc20Abi,
  formatUnits,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem"
import { DEFAULT_DECIMALS, WALLET_TOKEN_SYMBOL, registrationFloor } from "@obsidion/core/constants"
import {
  SIPADepositStore,
  inRowUnits,
  readSipaBalance,
  readSipaHolding,
  sweepsInto,
  type PendingRegistrationRecord,
  type SIPADepositRecord,
  type SipaFundingToken,
} from "@obsidion/front-core"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { admissionFloor, forgetDepositAdmission, refundedEntry } from "../identity/admission"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { walletStorage } from "../../platform/storage/walletStorage"
import { loadDepositTokens, sipaFundingTokens, tokenMetadata } from "../deposit/loadDepositFacts"
import { healRegistrationDeposits } from "./registrationDepositSeed"
import type { RegistrationTerms } from "./registrationTerms"
import { getPendingStore, registrationRecordForSipa } from "./webRegistration"

/**
 * A deposit whose committed fee cannot use the earned quote needs a refund first, then a restart.
 * `reached` is whether anything arrived at the address or was refunded from it: a live balance,
 * the funded stamp, the admission receipt or the confirmed refund. The receipt does not survive a
 * sign-out; the balance and the refund do. `sweepFee` is the deployed relayer cut a committed fee
 * must clear for its sweep to land at all; a fee below it needs the refund whatever it covers.
 */
export function registrationNeedsRefund(
  record: PendingRegistrationRecord,
  terms: RegistrationTerms | null,
  reached: boolean,
  sweepFee?: bigint,
): boolean {
  if (
    !reached ||
    record.sweptAt !== undefined ||
    record.sweepTxHash ||
    (record.phase !== "awaiting_deposit" && record.phase !== "funded")
  )
    return false
  const fee = record.fee ?? terms?.fee
  if (fee === undefined) return true
  if (sweepFee !== undefined && BigInt(fee) < sweepFee) return true
  if (
    terms?.fee === fee &&
    terms.minDeposit !== undefined &&
    (record.fundedAt !== undefined ||
      record.phase === "funded" ||
      BigInt(terms.depositAmount ?? "0") >=
        registrationFloor({ min: BigInt(terms.minDeposit), fee: BigInt(fee) }))
  )
    return false
  if (terms?.fee !== undefined && terms.fee !== fee) return true
  // The fee is committed into the address. An earned tag quoted the standard fee can only take the
  // earned price from a new address. A record with no schedule recorded names no price to disagree
  // with, so only a signed standard one calls for the refund.
  return terms?.earnedExpected === true && terms.fee !== undefined && terms.feeWaived !== true
}

/** What a Home surface knows about the address, beyond the record: the session's admission
 * receipt, a confirmed refund, and any other sign something reached it (a live balance, the funded
 * stamp). */
export interface RegistrationReachEvidence {
  depositAdmitted: boolean
  refunded: boolean
  reached?: boolean
}

/**
 * Whether a Home surface routes the record to recovery instead of pricing its deposit: an earned
 * registration whose committed quote cannot use the earned price, at an address something reached.
 * Only an earned registration has a cheaper price to restart at; a paid deposit is watched, never
 * refunded. The receipt itself marks the registration earned: it is only ever written for one.
 */
export function registrationRecoveryNeeded(
  record: PendingRegistrationRecord | null,
  terms: RegistrationTerms | null,
  evidence: RegistrationReachEvidence,
  sweepFee?: bigint,
): boolean {
  if (record === null) return false
  if (!evidence.depositAdmitted && terms?.earnedExpected !== true) return false
  const reached = evidence.depositAdmitted || evidence.refunded || evidence.reached === true
  return registrationNeedsRefund(record, terms, reached, sweepFee)
}

function assertCurrent(record: PendingRegistrationRecord, config: WebWalletConfig): void {
  const current = getPendingStore().get(record.account)
  if (config.l1ChainId !== record.l1ChainId)
    throw new Error("Switch to the registration network first.")
  if (
    !current ||
    current.sipaAddress !== record.sipaAddress ||
    current.nameHash !== record.nameHash ||
    current.l2Address !== record.l2Address ||
    current.fee !== record.fee ||
    current.depositToken !== record.depositToken ||
    current.beneficiary !== record.beneficiary ||
    current.sweptAt !== undefined ||
    current.sweepTxHash ||
    (current.phase !== "awaiting_deposit" && current.phase !== "funded")
  ) {
    throw new Error("This registration changed. Reopen its status before continuing.")
  }
}

function depositMatches(record: PendingRegistrationRecord, deposit: SIPADepositRecord): boolean {
  return (
    deposit.l1ChainId === record.l1ChainId &&
    deposit.recipientL2Address?.toLowerCase() === record.l2Address.toLowerCase()
  )
}

/** Every token the address accepts, the registration token first. */
function fundingTokens(
  record: PendingRegistrationRecord,
  config: WebWalletConfig = getConfig(),
): Promise<[SipaFundingToken, ...SipaFundingToken[]]> {
  return sipaFundingTokens(config, registrationToken(record), "registration")
}

/** Whether the registration accepts `token`: its sweep settles on the registration token's row. */
function acceptedToken(record: PendingRegistrationRecord, token: string | undefined): boolean {
  return token !== undefined && sweepsInto(record.l1ChainId, token, record.depositToken)
}

/** What the transaction moved out of the address, in registration-token units. */
async function refundedAmount(
  receipt: TransactionReceipt,
  record: PendingRegistrationRecord,
  config: WebWalletConfig = getConfig(),
): Promise<bigint> {
  let refunded = 0n
  if (receipt.status !== "success") return refunded
  const fee = registrationToken(record)
  // The listed decimals when the table reads, the token's own otherwise: a failed table read must not leave a
  // confirmed refund unsized.
  const listed = await loadDepositTokens(config, "registration").catch(() => undefined)
  const decimalsOf = async (token: Address) =>
    listed?.options.find((t) => sameToken(t, token))?.decimals ??
    (await tokenMetadata(config, token)).decimals
  for (const log of receipt.logs) {
    if (!acceptedToken(record, log.address)) continue
    let value: bigint
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      })
      if (event.args.from.toLowerCase() !== record.sipaAddress.toLowerCase()) continue
      value = event.args.value
    } catch {
      continue /* Not a Transfer. */
    }
    const sent = sameToken(fee, log.address)
      ? fee
      : { ...fee, address: log.address, decimals: await decimalsOf(log.address) }
    refunded += inRowUnits(value, sent, fee)
  }
  return refunded
}

/** The registration token, at the decimals the registration is priced in. */
function registrationToken(record: PendingRegistrationRecord): SipaFundingToken {
  return {
    address: record.depositToken as Address,
    symbol: WALLET_TOKEN_SYMBOL,
    decimals: DEFAULT_DECIMALS,
  }
}

const sameToken = (token: SipaFundingToken, address: string) =>
  token.address.toLowerCase() === address.toLowerCase()

interface RefundEvidence {
  token: string
  l1ChainId: number
  /** Oldest first. */
  txHashes: Hash[]
  /** What each sized refund moved, registration-token units. A refund without one is still owed
   *  its receipt read, and with it the registration record's settlement. */
  amounts?: Record<string, string>
}

const REFUNDS_KEY = "webwallet.registration.refunds"
const refundListeners = new Set<() => void>()

/**
 * Every refund confirmed off an address in a token it accepts, sized in registration-token units,
 * apart from the rail's record: the rail rewrites that record's token, phase and recovery hash for
 * whatever token reaches the address next, and the refunds must outlive that.
 */
function loadRefunds(): Record<string, RefundEvidence> {
  try {
    return JSON.parse(walletStorage.getItem(REFUNDS_KEY) ?? "{}") as Record<string, RefundEvidence>
  } catch {
    return {}
  }
}

function evidenceFor(record: PendingRegistrationRecord): RefundEvidence | undefined {
  const evidence = loadRefunds()[record.sipaAddress.toLowerCase()]
  return evidence !== undefined &&
    evidence.l1ChainId === record.l1ChainId &&
    evidence.token.toLowerCase() === record.depositToken.toLowerCase()
    ? evidence
    : undefined
}

function refundEvidence(record: PendingRegistrationRecord): Hash[] {
  return evidenceFor(record)?.txHashes ?? []
}

function unsizedRefunds(record: PendingRegistrationRecord): Hash[] {
  const known = evidenceFor(record)
  return known?.txHashes.filter((hash) => !(hash in (known.amounts ?? {}))) ?? []
}

function sizedRefunds(record: PendingRegistrationRecord): Record<string, bigint> {
  return Object.fromEntries(
    Object.entries(evidenceFor(record)?.amounts ?? {}).map(([hash, amount]) => [
      hash,
      BigInt(amount),
    ]),
  )
}

/** A refund sized by `amount` has settled the registration record off its receipt; one without still owes that. */
function rememberRefund(
  record: PendingRegistrationRecord,
  txHash: Hash,
  amount?: bigint,
  notify = true,
): void {
  const known = evidenceFor(record)
  const txHashes = known?.txHashes ?? []
  const isNew = !txHashes.includes(txHash)
  const sizes = amount !== undefined && !(txHash in (known?.amounts ?? {}))
  if (!isNew && !sizes) return
  const amounts = { ...known?.amounts, ...(sizes ? { [txHash]: amount.toString() } : {}) }
  const refunds = loadRefunds()
  refunds[record.sipaAddress.toLowerCase()] = {
    token: record.depositToken,
    l1ChainId: record.l1ChainId,
    txHashes: isNew ? [...txHashes, txHash] : txHashes,
    ...(Object.keys(amounts).length > 0 ? { amounts } : {}),
  }
  walletStorage.setItem(REFUNDS_KEY, JSON.stringify(refunds))
  if (notify) refundListeners.forEach((fn) => fn())
}

/**
 * The live record of a refunded address is funded no longer, and holds the entry a refund of the
 * earned total bought as `refundedEntry`, so the wallet stays open before any restart. A deposit
 * held in more than one token comes back one recovery per token: while the funded stamp stands the
 * sized refunds pool toward the entry the deposit as a whole earned, and a refund that buys none
 * leaves the stamp alone for the rest.
 */
async function settleRefundedRegistration(
  record: PendingRegistrationRecord,
  txHash: Hash,
  amount: bigint,
): Promise<void> {
  const live = getPendingStore().get(record.account)
  if (
    live?.sipaAddress.toLowerCase() !== record.sipaAddress.toLowerCase() ||
    live.sweptAt !== undefined ||
    live.sweepTxHash
  )
    return
  const funded = live.fundedAt !== undefined || live.phase === "funded"
  const pooled = funded
    ? Object.entries(sizedRefunds(record)).reduce(
        (sum, [hash, prior]) => (hash === txHash ? sum : sum + prior),
        amount,
      )
    : amount
  const entry = refundedEntry(live, { amount: pooled, txHash })
  if (!entry) return
  await getPendingStore()
    .upsert(record.account, {
      ...(funded
        ? { fundedAt: undefined, fundingTxHash: undefined, phase: "awaiting_deposit" }
        : {}),
      ...(entry ? { refundedEntry: entry } : {}),
    })
    .catch(() => {})
  // The receipt vouched for funds the refund just moved; entry now rides on the record.
  forgetDepositAdmission(live)
}

function assertDeposit(
  record: PendingRegistrationRecord,
  deposit: SIPADepositRecord | null,
): asserts deposit is SIPADepositRecord {
  if (!deposit || !depositMatches(record, deposit)) {
    throw new Error(
      "The original deposit details are not available yet. Unlock this wallet and try again.",
    )
  }
}

/** The rail's record, while it speaks for a token the registration accepts. */
function railRecord(record: PendingRegistrationRecord): SIPADepositRecord | null {
  const deposit = SIPADepositStore.get(webStorage).get(record.sipaAddress as Address)
  return deposit !== null &&
    depositMatches(record, deposit) &&
    acceptedToken(record, deposit.tokenAddress)
    ? deposit
    : null
}

/**
 * The record's deposit was recovered in a confirmed L1 transaction and nothing came back since:
 * funds the rail sees at the address again want another recovery, whatever was refunded before.
 * A refund is remembered the first time the rail's record shows it.
 */
export function registrationRefunded(record: PendingRegistrationRecord): boolean {
  const deposit = railRecord(record)
  if (deposit?.phase === "recoverable" || deposit?.phase === "sweeping") return false
  if (deposit?.phase === "recovered" && deposit.recoveryTxHash) {
    rememberRefund(record, deposit.recoveryTxHash, undefined, false)
    return true
  }
  return refundEvidence(record).length > 0
}

/**
 * A recovery confirmed off `sipa` from any surface, the activity list included. One that moved a
 * registration's token is remembered as its refund and settles the registration's record. Its
 * receipt sizes it: funds landing after the recovery was submitted went with it. A receipt that
 * cannot be read leaves the record as it is, entry included, and the refund unsized for a later
 * reconciliation to settle.
 */
export async function registrationRefundConfirmed(
  sipa: string,
  token: string,
  l1ChainId: number,
  txHash: Hash,
  readReceipt: (hash: Hash) => Promise<TransactionReceipt>,
): Promise<void> {
  const record = registrationRecordForSipa(sipa)
  if (!record || record.l1ChainId !== l1ChainId || !acceptedToken(record, token)) return
  rememberRefund(record, txHash)
  const receipt = await readReceipt(txHash).catch(() => undefined)
  if (!receipt) return
  const amount = await refundedAmount(receipt, record)
  if (amount > 0n) await settleRefundedRegistration(record, txHash, amount)
  rememberRefund(record, txHash, amount)
}

const reconciling = new Map<string, Promise<void>>()

/**
 * Settle a refund whose receipt wait did not finish: the hash is stamped at submission, the
 * `recovered` phase only on confirmation, and only while the address holds nothing, since funds
 * can reach it again after the refund. A receipt is read once per hash; a reverted one is
 * unstamped so the address can be recovered again. The balance read spans every token the
 * registration accepts, so the rail's record settles while it names one of them. Under any other
 * token's name the record keeps its phase: its hash is read only for what it moved in an accepted
 * token. Refunds remembered unsized are sized here too, and settle the registration's record.
 */
export function reconcileRegistrationRefund(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
): Promise<void> {
  const store = SIPADepositStore.get(webStorage)
  const deposit = store.get(record.sipaAddress as Address)
  if (!deposit || !depositMatches(record, deposit) || config.l1ChainId !== record.l1ChainId)
    return Promise.resolve()
  const hash = deposit.recoveryTxHash
  const unsized = unsizedRefunds(record)
  const settled = deposit.phase === "recovered"
  const named = acceptedToken(record, deposit.tokenAddress)
  const remembered = hash !== undefined && refundEvidence(record).includes(hash)
  // A settled record in an accepted token vouches for its hash without a receipt.
  const unread = hash !== undefined && !remembered && !(settled && named)
  const unsettled = hash !== undefined && !settled && named && recovering(deposit)
  if (!unread && !unsettled && unsized.length === 0) return Promise.resolve()
  const key = `${deposit.sipaAddress.toLowerCase()}:${hash ?? ""}`
  let inflight = reconciling.get(key)
  if (!inflight) {
    const client = l1PublicClient(config)
    inflight = (async () => {
      for (const owed of unsized) {
        const receipt = await client.getTransactionReceipt({ hash: owed }).catch(() => undefined)
        if (!receipt) continue
        const amount = await refundedAmount(receipt, record)
        if (amount > 0n) await settleRefundedRegistration(record, owed, amount)
        rememberRefund(record, owed, amount)
      }
      if (unread && hash !== undefined) {
        const receipt = await client.getTransactionReceipt({ hash })
        if (receipt.status !== "success") {
          if (!settled)
            await store.upsert(deposit.sipaAddress, {
              phase: deposit.phase,
              recoveryTxHash: undefined,
            })
          return
        }
        const amount = await refundedAmount(receipt, record)
        if (amount > 0n) {
          await settleRefundedRegistration(record, hash, amount)
          rememberRefund(record, hash, amount)
        }
      }
      if (!unsettled || hash === undefined) return
      const balance = await readSipaBalance(
        client,
        record.sipaAddress as Address,
        await fundingTokens(record, config),
      )
      const latest = store.get(deposit.sipaAddress)
      if (balance === 0n && latest && recovering(latest) && latest.recoveryTxHash === hash)
        await store.upsert(deposit.sipaAddress, { phase: "recovered", recoveryTxHash: hash })
    })()
      .catch(() => undefined)
      .finally(() => reconciling.delete(key))
    reconciling.set(key, inflight)
  }
  return inflight
}

/** A stamped recovery is this deposit's until a sweep of the address lands or is claimed. */
function recovering(deposit: SIPADepositRecord): boolean {
  return !deposit.sweepTxHash && deposit.phase !== "pendingClaim" && deposit.phase !== "claimed"
}

/**
 * A refunded address the registration re-enters starts a new deposit cycle on the rail. The
 * recovery stays as refund evidence; a settled record would never be scanned for the new deposit.
 */
export async function reopenRefundedDeposit(record: PendingRegistrationRecord): Promise<void> {
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  const deposit = store.get(record.sipaAddress as Address)
  if (deposit?.phase !== "recovered") return
  await store.upsert(deposit.sipaAddress, {
    phase: "broadcast",
    amount: "0",
    recoveryTxHash: undefined,
    endTime: undefined,
  })
}

export function useRegistrationRefunded(record: PendingRegistrationRecord | null): boolean {
  const store = SIPADepositStore.get(webStorage)
  useEffect(() => {
    if (record === null) return
    void store
      .load()
      .then(() => reconcileRegistrationRefund(record, getConfig()))
      .catch((err) => console.warn("registration refund reconcile failed", err))
  }, [store, record])
  return useSyncExternalStore(
    (notify) => {
      const off = store.onListChanged(notify)
      refundListeners.add(notify)
      return () => {
        off()
        refundListeners.delete(notify)
      }
    },
    () => record !== null && registrationRefunded(record),
  )
}

export interface RegistrationRefund {
  /** What the refund moved off the address, read from its transaction. */
  amount: bigint
  txHash: Hash
}

/** An address the earned quote cannot use may be replaced outright only while nothing reached it. */
export async function assertRegistrationUnfunded(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
): Promise<void> {
  assertCurrent(record, config)
  const reached = "A deposit reached this address. Recover it before requesting a new address."
  if (record.phase !== "awaiting_deposit" || record.fundedAt !== undefined) throw new Error(reached)
  const balance = await readSipaBalance(
    l1PublicClient(config),
    record.sipaAddress as Address,
    await fundingTokens(record, config),
  )
  if (balance !== 0n) throw new Error(reached)
  assertCurrent(record, config)
}

/** Reconstruct the original recovery inputs; never derive them from a replacement quote. */
export async function prepareRegistrationRefund(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
  networkId: string,
): Promise<SIPADepositRecord> {
  assertCurrent(record, config)
  await healRegistrationDeposits(config, networkId)
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  const deposit = store.get(record.sipaAddress as Address)
  assertDeposit(record, deposit)
  const { token, status } = await readSipaHolding(
    l1PublicClient(config),
    record.sipaAddress as Address,
    await fundingTokens(record, config),
  )
  if (status.balance === 0n)
    throw new Error("No funds remain at this address. Check its recovery or registration status.")
  assertCurrent(record, config)
  // The rail's record names whatever token reached the address last; the refund moves the token
  // that holds the funds.
  return {
    ...deposit,
    amount: formatUnits(status.balance, token.decimals),
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
  }
}

/**
 * Only a confirmed token refund and an empty old address allow a new registration address. The
 * refund reported is the largest confirmed off the address: the entry it bought is not revoked by
 * a later, smaller refund of funds that came back.
 */
export async function assertRegistrationRefunded(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
): Promise<RegistrationRefund> {
  assertCurrent(record, config)
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  await reconcileRegistrationRefund(record, config)
  const hashes = registrationRefunded(record) ? refundEvidence(record) : []
  if (hashes.length === 0) {
    assertDeposit(record, store.get(record.sipaAddress as Address))
    throw new Error("Recover the original deposit before requesting a new address.")
  }
  const client = l1PublicClient(config)
  // A receipt the chain no longer serves (a refund reorganized away) counts for nothing; the
  // others still do.
  const [receipts, balance] = await Promise.all([
    Promise.allSettled(hashes.map((hash) => client.getTransactionReceipt({ hash }))),
    readSipaBalance(client, record.sipaAddress as Address, await fundingTokens(record, config)),
  ])
  const sizes = await Promise.all(
    receipts.map((receipt) =>
      receipt.status === "fulfilled" ? refundedAmount(receipt.value, record) : undefined,
    ),
  )
  let largest: RegistrationRefund | undefined
  let unread = false
  sizes.forEach((amount, i) => {
    if (amount === undefined) {
      unread = true
      return
    }
    if (amount > 0n && (largest === undefined || amount >= largest.amount))
      largest = { amount, txHash: hashes[i] }
  })
  // Refunds pooled on the record while it was funded outrank any one receipt, on the evidence read
  // here alone: every refund the pool counted must still read as a successful transfer, and the
  // pool credits no more than those receipts return now.
  const pooled = getPendingStore().get(record.account)?.refundedEntry
  const sizeOf = (hash: string) => sizes[hashes.indexOf(hash as Hash)] ?? 0n
  const counted = Object.keys(sizedRefunds(record))
  if (pooled && sizeOf(pooled.recoveryTxHash) > 0n && counted.every((hash) => sizeOf(hash) > 0n)) {
    const returned = counted.reduce((sum, hash) => sum + sizeOf(hash), 0n)
    const amount = returned < BigInt(pooled.amount) ? returned : BigInt(pooled.amount)
    if (amount > (largest?.amount ?? 0n))
      largest = { amount, txHash: pooled.recoveryTxHash as Hash }
  }
  if (balance !== 0n || (largest === undefined && !unread))
    throw new Error(
      "The original refund is not complete. Check it before requesting a new address.",
    )
  // An unread receipt may be the refund that bought entry; a restart on the rest alone would
  // drop it, so only evidence that qualifies by itself goes ahead without it.
  if (largest === undefined || (unread && largest.amount < admissionFloor(record)))
    throw new Error("A refund receipt could not be read. Try again.")
  assertCurrent(record, config)
  return largest
}
