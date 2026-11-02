/**
 * The wallet's read of where a registration stands: front-core's `registrationStage` over the
 * wallet's own stores. Surfaces that decide whether to ask for the deposit, show progress or step
 * aside read it here, and combine it with the facts a stage does not cover.
 */
import { useSyncExternalStore } from "react"
import type { Address } from "viem"
import {
  depositOwed,
  registrationStage,
  SIPADepositStore,
  type FundingBurn,
  type PendingRegistrationRecord,
  type RegistrationStage,
} from "@obsidion/front-core"
import { session } from "../../platform/session"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { walletStorage } from "../../platform/storage/walletStorage"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { registrationRouteFor } from "./registrationFunnel"
import { getPendingStore, registrationAddressPublished } from "./webRegistration"

/**
 * Undefined while the session's withdrawals load and the stage would read `reserved`: a funding burn
 * may be among them. A caller passing `burns` passes loaded ones.
 */
export function readRegistrationStage(
  record: PendingRegistrationRecord,
): RegistrationStage | undefined
export function readRegistrationStage(
  record: PendingRegistrationRecord,
  burns: readonly FundingBurn[],
): RegistrationStage
export function readRegistrationStage(
  record: PendingRegistrationRecord,
  burns?: readonly FundingBurn[],
): RegistrationStage | undefined {
  const list = burns ? { records: burns, hydrated: true } : session().withdrawals.list.get()
  const stage = registrationStage(record, {
    deposit: SIPADepositStore.get(webStorage).get(record.sipaAddress as Address),
    burns: list.records,
  })
  return stage === "reserved" && !list.hydrated ? undefined : stage
}

export interface OpenRegistration {
  record: PendingRegistrationRecord
  /** Undefined until it is known (`readRegistrationStage`). */
  stage: RegistrationStage | undefined
}

/** The registration behind the tag the active wallet still presents as pending. */
export function openRegistration(burns?: readonly FundingBurn[]): OpenRegistration | null {
  const identity = loadWalletIdentity()
  const record = getPendingStore().current()
  if (!identity?.pending || !record) return null
  if (record.l2Address.toLowerCase() !== identity.address.toLowerCase()) return null
  return { record, stage: burns ? readRegistrationStage(record, burns) : readRegistrationStage(record) }
}

/** Every store a stage reads. */
export function subscribeRegistrationStage(onChange: () => void): () => void {
  const offs = [
    getPendingStore().onListChanged(onChange),
    SIPADepositStore.get(webStorage).onListChanged(onChange),
    session().withdrawals.list.subscribe(onChange),
  ]
  return () => offs.forEach((off) => off())
}

/**
 * A primitive snapshot of `openRegistration`: the store hands out fresh objects, which would never
 * settle. The record fields are the ones a surface reads beside the stage.
 */
function openRegistrationKey(): string | null {
  const open = openRegistration()
  if (!open) return null
  const { record, stage } = open
  return [stage, record.account, record.phase, record.broadcast, record.fundedAt, record.sweptAt]
    .map((v) => v ?? "")
    .join(":")
}

/** Whether the active wallet owes its registration deposit: the gate that sends an action to the
 *  deposit screen instead. */
export function useRegistrationDepositOwed(): boolean {
  return useSyncExternalStore(subscribeRegistrationStage, () => {
    const open = openRegistration()
    return open?.stage !== undefined && depositOwed(open.stage)
  })
}

/** Whether the active wallet's tag is not yet claimed on L1; balance and activity wait for it. */
export function useNameClaimPending(): boolean {
  return useSyncExternalStore(subscribeRegistrationStage, () => {
    const open = openRegistration()
    return (
      open !== null &&
      open.stage !== "crediting" &&
      open.stage !== "registered" &&
      open.stage !== "failed"
    )
  })
}

/**
 * The L2 account whose registration still has funds to move, from the address it shows until its
 * deposit is credited. Read off the pending record alone, so a signup reloaded before it saved the
 * wallet identity still has one. The deposit sync runs on signup for that long.
 */
export function useRegistrationInCustody(): string | null {
  return useSyncExternalStore(subscribeRegistrationStage, () => {
    const record = getPendingStore().current()
    if (!record) return null
    const stage = readRegistrationStage(record)
    return stage !== "registered" && stage !== "failed" ? record.l2Address : null
  })
}

/** Whether the active wallet's pending tag is already claimed on L1, so it can no longer be lost. */
export function useNameClaimedOnL1(): boolean {
  return useSyncExternalStore(subscribeRegistrationStage, () => {
    const open = openRegistration()
    return open !== null && (open.stage === "crediting" || open.stage === "registered")
  })
}

/** `readRegistrationStage` for one record, kept current. Null without a record. */
export function useRegistrationStage(
  record: PendingRegistrationRecord,
): RegistrationStage | undefined
export function useRegistrationStage(
  record: PendingRegistrationRecord | null,
): RegistrationStage | undefined | null
export function useRegistrationStage(
  record: PendingRegistrationRecord | null,
): RegistrationStage | undefined | null {
  return useSyncExternalStore(subscribeRegistrationStage, () =>
    record ? readRegistrationStage(record) : null,
  )
}

/** `openRegistration`, kept current. */
export function useOpenRegistration(): OpenRegistration | null {
  const key = useSyncExternalStore(subscribeRegistrationStage, openRegistrationKey)
  return key === null ? null : openRegistration()
}

// ── Tag confirmation ────────────────────────────────────────────────────────────

const CONFIRMED_KEY = "webwallet.registration.confirmed"
const confirmListeners = new Set<() => void>()

function confirmedAddresses(): string[] {
  try {
    return JSON.parse(walletStorage.getItem(CONFIRMED_KEY) ?? "[]") as string[]
  } catch {
    return []
  }
}

/**
 * Whether the user settled on this registration's tag. The ClaimFPC's broadcast rail sponsors one
 * broadcast per L1 account, ever, so an address is broadcast only once its tag is final, and from
 * then on the tag cannot change.
 */
export function registrationTagConfirmed(
  record: PendingRegistrationRecord,
  burns?: readonly FundingBurn[],
): boolean {
  if (registrationAddressPublished(record)) return true
  const stage = burns ? readRegistrationStage(record, burns) : readRegistrationStage(record)
  if (stage !== undefined && !depositOwed(stage)) return true
  if (confirmedAddresses().includes(record.sipaAddress.toLowerCase())) return true
  const route = registrationRouteFor(record.tag)
  // Random and paid tags wait on the user: keep or swap, and register or verify as a past user.
  return route !== undefined && route !== "random" && route !== "paid"
}

/** The user keeps the drawn tag: its address may now be broadcast. */
export function confirmRegistrationTag(record: PendingRegistrationRecord): void {
  try {
    const next = [...new Set([...confirmedAddresses(), record.sipaAddress.toLowerCase()])]
    walletStorage.setItem(CONFIRMED_KEY, JSON.stringify(next))
  } catch {
    // Unsaved: the deposit screen asks again.
  }
  confirmListeners.forEach((listener) => listener())
}

function subscribeConfirmed(onChange: () => void): () => void {
  confirmListeners.add(onChange)
  const off = subscribeRegistrationStage(onChange)
  return () => {
    confirmListeners.delete(onChange)
    off()
  }
}

/** `registrationTagConfirmed`, kept current. True without a record: nothing is left to choose. */
export function useRegistrationTagConfirmed(record: PendingRegistrationRecord | null): boolean {
  return useSyncExternalStore(subscribeConfirmed, () =>
    record ? registrationTagConfirmed(record) : true,
  )
}

/** Whether the active wallet may still change its tag: the deposit is owed and the tag not final. */
export function useRegistrationTagChangeable(): boolean {
  return useSyncExternalStore(subscribeConfirmed, () => {
    const open = openRegistration()
    return (
      open?.stage !== undefined && depositOwed(open.stage) && !registrationTagConfirmed(open.record)
    )
  })
}
