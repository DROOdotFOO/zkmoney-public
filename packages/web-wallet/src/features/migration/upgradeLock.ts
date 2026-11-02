/**
 * The account's upgrade lock. From an upgrade's start until the account is fully upgraded here,
 * Home shows each account at what the upgrade will land, so arrivals never count twice.
 * Released, the account is current on this version. Both are keyed to the
 * deployment the profile pins.
 */
import { useSyncExternalStore } from "react"
import { UpgradeActivity, type MetadataMigrationRecord } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { createExternalState } from "../../lib/externalState"
import { walletStorage } from "../../platform/storage/walletStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

export type UpgradeLock =
  | { state: "pending" }
  | { state: "held"; main?: bigint; savings?: bigint }
  | { state: "released" }

const lockKey = (account: string) => `webwallet.upgradeLock/${account.toLowerCase()}`
const versionKey = (account: string) => `webwallet.version/${account.toLowerCase()}`
const createdKey = (account: string) => `webwallet.createdOn/${account.toLowerCase()}`
const pinned = () => getConfig().oxideProfile.portal.toLowerCase()
// v2: a read settled before registration commitments were scanned is read again.
const sourceReadKey = (account: string, source: string) =>
  `webwallet.retiredSourceRead.v2/${pinned()}/${source.toLowerCase()}/${account.toLowerCase()}`
const changes = createExternalState(0)
const changed = () => changes.set(changes.get() + 1)
// Accounts whose saved runs were read this page, so the lock can be trusted.
const checked = createExternalState<ReadonlySet<string>>(new Set())
// Storage shows a write before it is saved: a release reads as held until it is, and a failed one stays held.
const releasing = new Map<string, { lock: UpgradeLock; saved: Promise<void> }>()
// A take not saved yet, which a second take waits on rather than reading it as held.
const acquiring = new Map<string, Promise<void>>()

export function upgradeLock(account: string): UpgradeLock {
  const pending = releasing.get(account.toLowerCase())
  if (pending) return pending.lock
  const raw = walletStorage.getItem(lockKey(account))
  const lock = raw
    ? (JSON.parse(raw) as { portal: string; main?: string; savings?: string })
    : undefined
  if (lock?.portal === pinned())
    return {
      state: "held",
      main: lock.main === undefined ? undefined : BigInt(lock.main),
      ...(lock.savings === undefined ? {} : { savings: BigInt(lock.savings) }),
    }
  if (walletStorage.getItem(versionKey(account)) === pinned()) return { state: "released" }
  return { state: "pending" }
}

/** Takes the lock before an upgrade sends anything; a lock already held keeps its figure. */
export function acquireUpgradeLock(
  account: string,
  main?: bigint,
  savings?: bigint,
): Promise<void> {
  const id = account.toLowerCase()
  const pending = acquiring.get(id)
  if (pending) return pending
  if (upgradeLock(account).state === "held") return Promise.resolve()
  const saved = walletStorage
    .commitItem(
      lockKey(account),
      JSON.stringify({ portal: pinned(), main: main?.toString(), savings: savings?.toString() }),
    )
    .finally(() => {
      acquiring.delete(id)
      changed()
    })
  acquiring.set(id, saved)
  return saved
}

/**
 * The account is fully upgraded here: the lock opens and the account is current. Refused while a
 * run this account saved on this deployment is unfinished, even one whose source is out of reach.
 */
export function releaseUpgradeLock(account: string): Promise<void> {
  const id = account.toLowerCase()
  const pending = releasing.get(id)
  if (pending) return pending.saved
  const lock = upgradeLock(account)
  if (lock.state === "released") return Promise.resolve()
  const saved = (async () => {
    if (await unfinishedRun(account))
      throw new Error("An upgrade run on this version is unfinished")
    await walletStorage.commitTransaction([
      [lockKey(account), null],
      [versionKey(account), pinned()],
    ])
  })().finally(() => {
    releasing.delete(id)
    changed()
  })
  releasing.set(id, { lock, saved })
  return saved
}

/** A run of the account's on this deployment that has not reached `done`, read from its saved runs. */
async function unfinishedRun(account: string): Promise<boolean> {
  const prefix = `metadata-migration/${pinned()}/`
  for (const run of await UpgradeActivity.get(webStorage).runs()) {
    const key = run.toLowerCase()
    if (!key.startsWith(prefix) || !key.endsWith(`/${account.toLowerCase()}`)) continue
    const raw = await webStorage.getItem(run)
    const record = raw ? (JSON.parse(raw) as MetadataMigrationRecord) : undefined
    if (record && record.phase !== "done") return true
  }
  return false
}

/** The account was made here, on this version: it has nothing to upgrade. A held lock stays. */
export function markCreatedHere(account: string): void {
  if (upgradeLock(account).state !== "pending") return
  walletStorage.setItem(versionKey(account), pinned())
  changed()
}

/** A new identity made here, on this version: unlike a passkey rotation's account, it holds nothing on another rollup. */
export function markNewAccountHere(account: string): void {
  if (upgradeLock(account).state !== "pending") return
  walletStorage.setItem(createdKey(account), pinned())
  markCreatedHere(account)
}

const SETTLED = "settled"

/**
 * Whether the account has nothing left to read on `source`, a deployment on another rollup: it is a
 * new account made here, or it is current here and `source` settled.
 */
export function retiredSourceSettled(account: string, source: string): boolean {
  if (walletStorage.getItem(createdKey(account)) === pinned()) return true
  return (
    upgradeLock(account).state === "released" &&
    walletStorage.getItem(sourceReadKey(account, source)) === SETTLED
  )
}

/** An L1 block, by number and hash. */
export interface L1Tip {
  number: bigint
  hash: string
}

/** The L1 tip that closed the account's latest empty read of `source`, while it has not settled. */
export function retiredSourceCandidate(account: string, source: string): L1Tip | undefined {
  const raw = walletStorage.getItem(sourceReadKey(account, source))
  if (raw === null || raw === SETTLED) return undefined
  const { number, hash } = JSON.parse(raw) as { number: string; hash: string }
  return { number: BigInt(number), hash }
}

/**
 * A complete read of `source`, frozen on another rollup. `empty`: nothing left there and its history
 * in, read up to L1 block `tip`. Once the account is current here, an empty read settles the source
 * when `priorFinal`: the block that closed the previous empty read is final and still on chain, so
 * every refund that read saw is final. Otherwise it waits on `tip`; a read that finds funds starts over.
 */
export function recordRetiredSourceRead(
  account: string,
  source: string,
  read: { empty: false } | { empty: true; tip: L1Tip; priorFinal: boolean },
): void {
  const key = sourceReadKey(account, source)
  if (!read.empty) return walletStorage.removeItem(key)
  if (upgradeLock(account).state !== "released") return
  const held = walletStorage.getItem(key)
  if (held === SETTLED) return
  if (held !== null && read.priorFinal) return walletStorage.setItem(key, SETTLED)
  walletStorage.setItem(
    key,
    JSON.stringify({ number: read.tip.number.toString(), hash: read.tip.hash }),
  )
}

/**
 * Takes the lock, with no figure, for a run on this deployment that an older build started and
 * left unfinished, then marks the lock as read for this page. A failed read leaves it unread.
 */
export async function checkUpgradeLock(account: string): Promise<void> {
  if (await unfinishedRun(account)) await acquireUpgradeLock(account)
  checked.set(new Set([...checked.get(), account.toLowerCase()]))
}

/** The account's lock, and whether this page has read its saved runs yet. The demo is never locked. */
export function useUpgradeLock(account: string | undefined): UpgradeLock & { checked: boolean } {
  useSyncExternalStore(changes.subscribe, changes.get)
  const read = useSyncExternalStore(checked.subscribe, checked.get)
  if (!account || isDemoMode()) return { state: "pending", checked: true }
  return { ...upgradeLock(account), checked: read.has(account.toLowerCase()) }
}
