/**
 * Whether a pasted L1 address looks fresh: no sent transactions, ETH or code on Ethereum, and
 * nothing in this wallet ties it back to the user. Token transfers are not read, and the verdict
 * says so. The verdict is advice on the paste sheet; it never blocks a withdrawal, which stays
 * with the screener.
 *
 * Both sources are read on every check. The L1 client answers nonce, balance and code; the
 * withdrawal store and the L1 contacts answer what this wallet has already done with the address.
 */
import { useEffect, useState } from "react"
import type { Address, PublicClient } from "viem"
import { ContactStorage, type Contact, type WithdrawalRecord } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { session } from "../../platform/session"

export type FreshAddressVerdict =
  | { kind: "idle" } // no parseable address
  | { kind: "checking" }
  | { kind: "fresh" } // zero nonce, zero balance, no code, no local history
  | { kind: "history" } // nonce or balance on L1
  | { kind: "contract" } // code present: the escrow pays ETH with a plain call, so a contract that rejects ETH strands the swap
  | { kind: "withdrew-before" } // a withdrawal record already names it, or a saved-recipient L1 contact
  | { kind: "linked-deposit" } // a deposit-attested L1 contact: this address funded the account
  | { kind: "unknown" } // a read did not answer

export interface FreshAddressCheckDeps {
  client: Pick<PublicClient, "getTransactionCount" | "getBalance" | "getCode">
  withdrawals: () => Promise<readonly WithdrawalRecord[]>
  contacts: () => Promise<Contact[]>
}

const DEBOUNCE_MS = 300

export const FRESH_ADDRESS_VERDICT_COPY: Record<
  Exclude<FreshAddressVerdict["kind"], "idle" | "checking">,
  { title: string; body: string; tone: "success" | "warning" | "error" }
> = {
  "fresh": {
    title: "Looks fresh",
    body: "No sent transactions, ETH or code found. Token transfers are not checked.",
    tone: "success",
  },
  "history": {
    title: "This address has onchain history",
    body: "Activity on Ethereum can be linked to this withdrawal.",
    tone: "warning",
  },
  "contract": {
    title: "This address is a contract",
    body:
      "The ETH for gas arrives as a plain transfer. A contract that rejects ETH would leave the " +
      "funds stuck at the swap escrow.",
    tone: "error",
  },
  "withdrew-before": {
    title: "You already withdrew to this address",
    body: "A second withdrawal links the two on the public chain.",
    tone: "warning",
  },
  "linked-deposit": {
    title: "Linked to your deposits",
    body:
      "This address funded your zk.money account. Withdrawing to it joins the deposit and the " +
      "withdrawal on the public chain.",
    tone: "error",
  },
  "unknown": {
    title: "Couldn't check this address",
    body: "The check did not finish. You can still continue.",
    tone: "warning",
  },
}

const settled = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
  result.status === "fulfilled" ? result.value : fallback

/** A tombstoned contact is revived by activity newer than its removal. */
const isLiveL1Contact = (contact: Contact): boolean => {
  const w = contact.l1Wallet
  return (
    !!w &&
    contact.addressKind === "ethereum-l1" &&
    (!w.deletedAt || (w.lastUsedAt ?? 0) > w.deletedAt)
  )
}

/** What this wallet already did with the address; the deposit link outranks a prior withdrawal. */
export function localVerdict(
  target: string,
  withdrawals: readonly WithdrawalRecord[],
  contacts: Contact[],
): { kind: "linked-deposit" | "withdrew-before" } | null {
  const provenance = contacts
    .filter((c) => c.address.toLowerCase() === target && isLiveL1Contact(c))
    .map((c) => c.l1Wallet!.provenance)
  if (provenance.includes("deposit-attested")) return { kind: "linked-deposit" }
  if (provenance.includes("saved-recipient")) return { kind: "withdrew-before" }
  // Registration and migration burns pay the wallet's own SIPA, not a destination the user chose.
  const withdrewTo = withdrawals.some(
    (r) => !r.intent && r.phase !== "failed" && r.recipient.toLowerCase() === target,
  )
  return withdrewTo ? { kind: "withdrew-before" } : null
}

/**
 * Precedence: contract, linked-deposit, withdrew-before, history, fresh. A read that failed cannot
 * rule anything out, so `fresh` needs all five reads, the wallet's own two included, and `unknown`
 * covers a failed read with nothing else to say. What the other reads found still counts.
 */
export async function checkFreshAddress(
  address: Address,
  deps: FreshAddressCheckDeps,
): Promise<FreshAddressVerdict> {
  const target = address.toLowerCase()
  const [nonce, balance, code, withdrawals, contacts] = await Promise.allSettled([
    deps.client.getTransactionCount({ address }),
    deps.client.getBalance({ address }),
    deps.client.getCode({ address }),
    deps.withdrawals(),
    deps.contacts(),
  ])
  if (code.status === "fulfilled" && !!code.value && code.value !== "0x")
    return { kind: "contract" }
  const local = localVerdict(target, settled(withdrawals, []), settled(contacts, []))
  if (local) return local
  const activity =
    (nonce.status === "fulfilled" && nonce.value > 0) ||
    (balance.status === "fulfilled" && balance.value > 0n)
  if (activity) return { kind: "history" }
  const answered = [nonce, balance, code, withdrawals, contacts].every(
    (r) => r.status === "fulfilled",
  )
  return { kind: answered ? "fresh" : "unknown" }
}

function liveDeps(): FreshAddressCheckDeps {
  return {
    client: l1PublicClient(getConfig()),
    withdrawals: () => session().withdrawals.all(),
    contacts: () => ContactStorage.get().getEntries(),
  }
}

/**
 * The verdict for the checksummed address in the paste field: `idle` while there is none,
 * `checking` from a new address through the debounce and the reads, and a result only for the
 * address still in the field. With `waitMs`, a check still running by then reads `unknown` until
 * its answer lands.
 */
export function useFreshAddressVerdict(
  address: Address | null,
  waitMs?: number,
): FreshAddressVerdict {
  const [verdict, setVerdict] = useState<FreshAddressVerdict>({ kind: "idle" })

  useEffect(() => {
    if (!address) {
      setVerdict({ kind: "idle" })
      return
    }
    let active = true
    setVerdict({ kind: "checking" })
    const timer = setTimeout(() => {
      checkFreshAddress(address, liveDeps())
        .catch((): FreshAddressVerdict => ({ kind: "unknown" }))
        .then((result) => {
          if (active) setVerdict(result)
        })
    }, DEBOUNCE_MS)
    const cap =
      waitMs &&
      setTimeout(() => setVerdict((v) => (v.kind === "checking" ? { kind: "unknown" } : v)), waitMs)
    return () => {
      active = false
      clearTimeout(timer)
      clearTimeout(cap)
    }
  }, [address, waitMs])

  return verdict
}
