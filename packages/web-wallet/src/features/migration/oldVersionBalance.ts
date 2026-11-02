/**
 * The DAI value the account holds on retired versions, kept in `BalanceStorage` beside the live balance
 * and never in its scope. Home counts it until an upgrade starts; what is left once the account is
 * upgraded is abandoned, unless a later check offers to move it. Everything is keyed by the deployment
 * the profile pins, so a repoint never mixes another deployment's old versions in.
 */
import { useMemo, useSyncExternalStore } from "react"
import {
  balanceScope,
  BalanceStorage,
  useCachedRecords,
  type BalanceRecord,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { createExternalState } from "../../lib/externalState"
import { walletStorage } from "../../platform/storage/walletStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useUpgradeLock } from "./upgradeLock"

const pinned = () => getConfig().oxideProfile.portal.toLowerCase()
const prefix = () => `${pinned()}/old/`

/** Where the retired deployment `source` keeps what it holds for `account`. */
export const oldVersionScope = (source: string, account: string) =>
  balanceScope(`${prefix()}${source.toLowerCase()}`, account.toLowerCase())

/** What `records` hold on old versions for `account`. */
export function oldVersionRecords(
  records: readonly BalanceRecord[],
  account: string,
): BalanceRecord[] {
  return records.filter(
    (r) => r.scope.startsWith(prefix()) && r.scope.endsWith(`:${account.toLowerCase()}`),
  )
}

const readKey = (account: string) =>
  `webwallet.oldHoldingsRead/${pinned()}/${account.toLowerCase()}`
const changes = createExternalState(0)
const released = createExternalState(false)
const savingsSources = createExternalState<ReadonlySet<string> | undefined>(undefined)
const savingsSourcesKey = () => `webwallet.oldSavingsSources/${pinned()}`

/** The scan identifies which old portals move into Savings. */
export function setOldVersionDestinations(
  current: string,
  destinations: ReadonlyMap<string, { tuple: { portal: string } }>,
): void {
  const sources = new Set(
    [...destinations].flatMap(([source, { tuple }]) =>
      tuple.portal.toLowerCase() === current.toLowerCase() ? [] : [source.toLowerCase()],
    ),
  )
  walletStorage.setItem(savingsSourcesKey(), JSON.stringify([...sources]))
  savingsSources.set(sources)
}

/** Whether a check has read every old version once for `account`. */
export function oldHoldingsRead(account: string): boolean {
  return walletStorage.getItem(readKey(account)) === "1"
}

/** A check read every old version for `account`: from now on Home shows what is recorded. */
export function markOldHoldingsRead(account: string): void {
  if (oldHoldingsRead(account)) return
  walletStorage.setItem(readKey(account), "1")
  changes.set(changes.get() + 1)
}

const fundsKey = (account: string) =>
  `webwallet.upgradeMovesFunds/${pinned()}/${account.toLowerCase()}`

/**
 * Whether the last check that answered for `account` in this browser offered an upgrade that moves
 * funds; undefined when none answered.
 */
export function upgradeMovedFunds(account: string): boolean | undefined {
  const mark = walletStorage.getItem(fundsKey(account))
  return mark === null ? undefined : mark === "1"
}

export function markUpgradeMovesFunds(account: string, moves: boolean): void {
  if (upgradeMovedFunds(account) === moves) return
  walletStorage.setItem(fundsKey(account), moves ? "1" : "0")
  // Home counts an upgraded account's old versions again while a check offers to move their funds.
  changes.set(changes.get() + 1)
}

/** Nothing can be read in this page, such as with the wallet locked: Home shows what it has. */
export function releaseOldHoldingsWait(release: boolean): void {
  released.set(release)
}

/**
 * What the signed-in account holds on old versions, and whether Home waits for it: no check has
 * read every old version yet. Home hides the total once the upgrade lock is taken, and shows it again
 * after the upgrade only while the last check offers to move funds: an upgrade that did not see them,
 * or funds that reached an old version since. Recorded amounts keep each account's holdings
 * available for the upgrade snapshot.
 */
export function useOldVersionHoldings(): {
  total: bigint
  main: bigint
  savings: bigint
  recordedMain: bigint
  recordedSavings: bigint
  pending: boolean
} {
  const { records } = useCachedRecords(useMemo(() => BalanceStorage.get(webStorage), []))
  const changed = useSyncExternalStore(changes.subscribe, changes.get)
  const free = useSyncExternalStore(released.subscribe, released.get)
  const scanned = useSyncExternalStore(savingsSources.subscribe, savingsSources.get)
  const saved = walletStorage.getItem(savingsSourcesKey())
  const sources = useMemo(
    () => scanned ?? (saved === null ? undefined : new Set<string>(JSON.parse(saved))),
    [scanned, saved],
  )
  const account = loadWalletIdentity()?.address
  const lock = useUpgradeLock(account).state
  return useMemo(() => {
    const held = account ? oldVersionRecords(records, account) : []
    let recordedMain = 0n
    let recordedSavings = 0n
    for (const r of held) {
      const source = r.scope.slice(prefix().length, r.scope.lastIndexOf(":"))
      if (sources?.has(source)) recordedSavings += BigInt(r.balance)
      else recordedMain += BigInt(r.balance)
    }
    const recordedTotal = recordedMain + recordedSavings
    // A held lock's figure already counts them.
    const counted =
      lock === "pending" ||
      (lock === "released" && !!account && upgradeMovedFunds(account) === true)
    return {
      total: counted ? recordedTotal : 0n,
      main: counted ? recordedMain : 0n,
      savings: counted ? recordedSavings : 0n,
      recordedMain,
      recordedSavings,
      pending:
        lock === "pending" &&
        !!account &&
        !isDemoMode() &&
        !free &&
        (!oldHoldingsRead(account) || sources === undefined),
    }
    // `changed` re-reads the marks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, account, free, changed, lock, sources])
}
