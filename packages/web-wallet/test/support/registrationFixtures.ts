/** One registration as the stores, the claim server and the tab's stash hold it. */
import { isAddress, type Address, type Hex } from "viem"
import type { NameClaimResponse, SignedTermsResponse } from "@obsidion/core/types"
import {
  PendingRegistrationStore,
  SIPADepositStore,
  type PendingRegistrationRecord,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import type { RegistrationTerms } from "../../src/features/onboarding/registrationTerms"
import { RANDOM } from "./registrationPrices"
import type { TicketSignupStash } from "../../src/features/paylink/claimStash"
import { webStorage } from "../../src/platform/storage/WebStorageAdapter"

export const DAI = 10n ** 18n
/** DAI to the cent, in base units. */
export const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
/** 2100-01-01, unix seconds: a deadline no test outlives. */
export const FAR_DEADLINE = "4102444800"

export const ACCOUNT = "0x00000000000000000000000000000000000000f1"
export const L2_ADDRESS: Hex = `0x${"22".repeat(32)}`
const NAME_HASH: Hex = `0x${"11".repeat(32)}`
export const SIPA = "0x00000000000000000000000000000000000000c3"
const TOKEN: Hex = "0x00000000000000000000000000000000000000d4"
/** The fragment a ticket-funded registration is bound to. */
const PAYLINK_FRAGMENT = "paylink-frag"

export const pendingRecord = (
  over: Partial<PendingRegistrationRecord> = {},
): PendingRegistrationRecord => ({
  account: ACCOUNT,
  tag: "taga",
  nameHash: NAME_HASH,
  l2Address: L2_ADDRESS,
  l1ChainId: 11155111,
  sipaAddress: SIPA,
  depositToken: TOKEN,
  broadcast: true,
  phase: "awaiting_deposit",
  retries: 0,
  startTime: Date.now(),
  ...over,
})

/** The earned schedule: the tag price waived, the relayer's 0.5 fee over a 4.5 minimum. */
export const earnedTerms = (over: Partial<SignedTermsResponse> = {}): SignedTermsResponse => ({
  fee: String(RANDOM.fee),
  minDeposit: String(RANDOM.min),
  nonce: "1",
  deadline: FAR_DEADLINE,
  signature: "0x00",
  reduced: true,
  ticket: false,
  ...over,
})

/** A NameClaim whose hold ends with it. */
export function nameClaim(over: Partial<NameClaimResponse> = {}): NameClaimResponse {
  const deadline = over.deadline ?? FAR_DEADLINE
  return { signature: "0x", nonce: "1", deadline, hold: { deadline }, ...over }
}

/** Stored terms for one registration, live for two more hours. */
export const registrationTerms = (over: Partial<RegistrationTerms> = {}): RegistrationTerms => ({
  account: ACCOUNT,
  tag: "taga",
  deadline: Math.floor(Date.now() / 1000) + 7200,
  ...over,
})

/** Stored terms a paylink's golden ticket bought, bound to `PAYLINK_FRAGMENT`. */
export const ticketBoundTerms = (over: Partial<RegistrationTerms> = {}): RegistrationTerms =>
  registrationTerms({
    fee: String(dai(0.5)),
    minDeposit: "0",
    feeWaived: true,
    paylinkFunded: true,
    paylinkId: `id:${PAYLINK_FRAGMENT}`,
    ...over,
  })

/** The marker a ticket signup stashes on its tab. */
export const ticketSignupStash = (over: Partial<TicketSignupStash> = {}): TicketSignupStash => ({
  fragment: PAYLINK_FRAGMENT,
  threshold: String(2n * DAI),
  schedule: { fee: String(dai(0.5)), minDeposit: "0" },
  ...over,
})

/** Seeds the rail record the registration's deposit address keeps. */
export async function seedRegistrationRail(
  record: PendingRegistrationRecord,
  patch: Parameters<SIPADepositStore["upsert"]>[1],
  over: Partial<Omit<SIPADepositRecord, "sipaAddress" | "phase">> = {},
): Promise<void> {
  const sipa = record.sipaAddress
  if (!isAddress(sipa)) throw new Error(`not an address: ${sipa}`)
  const token: Address = record.depositToken
  const rail = SIPADepositStore.get(webStorage)
  await rail.load()
  await rail.upsert(sipa, patch, {
    networkId: "0xnet",
    recipientL2Address: record.l2Address,
    tokenAddress: token,
    tokenSymbol: "DAI",
    l1ChainId: record.l1ChainId,
    messageSecret: record.nameHash,
    recoveryAddress: record.account,
    recipientHash: record.nameHash,
    amount: "15",
    startTime: 1,
    intent: "registration",
    ...over,
  })
}

/** Drops the store singletons, so the next `get` reads storage afresh as a reloaded page would. */
export function resetRegistrationStores(): void {
  Reflect.set(PendingRegistrationStore, "instance", null)
  Reflect.set(SIPADepositStore, "instance", null)
}
