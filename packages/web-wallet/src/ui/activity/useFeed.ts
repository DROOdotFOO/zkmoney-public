import { useMemo, useSyncExternalStore } from "react"
import {
  selectFeed,
  useContactsDirectory,
  useSavingsPosition,
  useStore,
  type Feed,
  type FeedSources,
  type ReadonlyStore,
  type RecordSet,
  type Registrations,
  type Transaction,
  useResource,
} from "@obsidion/front-core"
import { getPreviousAccountWatcher } from "../../features/backupPasskey/previousAccountWatcher"
import { useOldVersionHoldings } from "../../features/migration/oldVersionBalance"
import { usePolledChainSeconds } from "../../features/paylink/chainTime"
import { useSession, type Session } from "../../platform/session"
import { feedSources, mergedRows } from "./feedSources"

/** The feed's records: the rows listed, Home's by default, joined by a deep-linked row's hash. */
export function feedRows(
  session: Session,
  rows?: ReadonlyStore<RecordSet<Transaction>>,
  txHash?: string,
): ReadonlyStore<FeedSources> {
  if (!txHash) return rows ? feedSources(session.feedBase, rows) : session.feed
  const opened = session.activity.query("hash", txHash.toLowerCase())
  return feedSources(session.feedBase, mergedRows([rows ?? session.homeRows, opened]))
}

/** The feed, from the stores and what the view knows beside them. */
export function useFeed({
  registration,
  chainNode,
  account,
  rows,
  txHash,
}: {
  /** The activity rows it lists; Home's newest rows by default. */
  rows?: ReadonlyStore<RecordSet<Transaction>>
  /** A row a deep link opens, read by its hash wherever it sits. */
  txHash?: string
  /** The pending registration's own row, while it has one. */
  registration?: { sipaAddress: string; ts: number }
  /** The node to read chain time from, which gates a creator paylink's recovery offer. */
  chainNode?: Parameters<typeof usePolledChainSeconds>[0]
  /** The session's account, which alone can take back the links it made. */
  account?: string
} = {}): {
  feed: Feed
  registrations: Registrations["records"]
  handle?: string
} {
  const { contacts, hydrated, failed } = useContactsDirectory()
  const session = useSession()
  const records = useStore(session.registrations)
  const handle = useStore(session.identity, (identity) => identity.value?.handle)
  const chainNow = usePolledChainSeconds(chainNode)
  const mainReadAt = useStore(useSession().balances.view, (v) => v.readAt)
  const position = useSavingsPosition().position
  const { main: oldMain, savings: oldSavings } = useOldVersionHoldings()
  const watcher = getPreviousAccountWatcher()
  const previousAccount = useSyncExternalStore(
    watcher.subscribe,
    () => watcher.getSnapshot().address,
  )
  const activeNetworkId = useResource(useSession().wallet)?.networkId
  const regSipa = registration?.sipaAddress
  const regTs = registration?.ts
  const select = useMemo(() => {
    const ctx = {
      contacts: { rows: contacts, hydrated, failed },
      registrations: { records, handle },
      registration: regSipa !== undefined ? { sipaAddress: regSipa, ts: regTs! } : undefined,
      chainNowSec: chainNow,
      activeNetworkId,
      account,
      balanceReadAt: { main: mainReadAt, savings: position?.sharesReadAt },
      sharePrice: position?.sharePrice,
      oldVersions: { main: oldMain, savings: oldSavings },
      previousAccount,
    }
    return (sources: Parameters<typeof selectFeed>[0]) => selectFeed(sources, ctx)
  }, [
    contacts,
    hydrated,
    failed,
    records,
    handle,
    regSipa,
    regTs,
    chainNow,
    mainReadAt,
    position,
    oldMain,
    oldSavings,
    activeNetworkId,
    account,
    previousAccount,
  ])
  const sources = useMemo(() => feedRows(session, rows, txHash), [session, rows, txHash])
  return { feed: useStore(sources, select), registrations: records, handle }
}
