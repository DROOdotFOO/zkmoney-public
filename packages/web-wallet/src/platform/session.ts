/**
 * The account's stores, resources and tasks, built once per page and handed down by `useSession`. A
 * page serves one account: another account's sign-in reloads the page (`reloadIfSessionSwitched`),
 * so nothing here follows an account change. A page with no account, such as a link's visitor, runs on
 * the anonymous namespace until its first sign-in replaces it; its views and their watchers start
 * only once something reads them.
 */
import {
  WalletError,
  WalletSyncCoordinator,
  accountResource,
  balanceScope,
  bestEffort,
  createActivity,
  createBalances,
  createMilestones,
  createNotifications,
  createRequests,
  createTagForwardResolver,
  createWithdrawals,
  derived,
  memoryStore,
  oldVersionWithdrawalTask,
  reorg,
  savingsLookup,
  startRuntime,
  teeSignerResource,
  tokenResource,
  transferScan,
  useStore,
  watchNotifications,
  watchPayerApprovals,
  withdrawalTracker,
  type AccountResource,
  type AccountStorage,
  type Activity,
  type Balances,
  type BalanceSource,
  type BalanceStorage,
  type CatchUp,
  type ContactStorage,
  type Database,
  type Milestones,
  type Notifications,
  type OperationStore,
  type ReadonlyStore,
  type ReorgSipaStore,
  type Resource,
  type SipaProcessingObserver,
  type Task,
  type TeeSignerSource,
  type TokenStorage,
  type TrackerRails,
  type Withdrawals,
} from "@obsidion/front-core"
import {
  createWalletSyncSource,
  type AlphaAuthService,
  type ContractService,
  type Network,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import { useEffect } from "react"
import { broadcastState } from "../features/broadcasts/broadcastState"
import { resolveTagForCommit } from "../features/contacts/registryResolution"
import { walletIdentity } from "../features/identity/walletIdentity"
import { historicImports } from "../features/migration/historicActivityImport"
import {
  bell,
  bellRows,
  notificationSources,
  recordReorgOutcome,
} from "../features/notifications/notifications"
import { interruptedSweep, operationsSettle } from "../features/operations/operationsTasks"
import { openSavings, savingsRescanToken } from "../features/savings/savingsGateway"
import { savingsMovesReplay, savingsResource } from "../features/savings/savingsTasks"
import { settleOldVersionWithdrawal } from "../features/withdraw/oldVersionWithdrawals"
import { withdrawalRescan } from "../features/withdraw/withdrawGateway"
import { wallClock } from "../lib/clock"
import {
  activityReads,
  contactActivity,
  mergedRows,
  feedBase,
  feedSources,
  oldVersionWithdrawalRecords,
  registrationRecords,
} from "../ui/activity/feedSources"
import { pageSessionDeps } from "./sessionDeps"
import { getActiveStorageId } from "./storage/activeStorage"
import { depositRecords, legacyUnlisted } from "./storage/requests"
import { WEB_STORAGE_PREFIX } from "./storage/storageKeys"
import { createContactsByL2 } from "./xmtp/adapters"

/** `id` is null for the namespace a page with no account writes under. */
export type Namespace = { readonly id: string | null; readonly prefix: string }

export const namespaceOf = (id: string | null): Namespace => ({
  id,
  prefix: WEB_STORAGE_PREFIX + (id ? `${id}.` : ""),
})

/** The committed account's namespace, or the anonymous one when there is none. */
export const activeNamespace = (): Namespace => namespaceOf(getActiveStorageId())

/** What an account's session reads beside what every session does. */
export interface SignInDeps {
  storageId: string
  accounts: AccountStorage
  balances: BalanceStorage
  tokens: TokenStorage
  contacts: ContactStorage
  auth(wallet: ObsidionWallet): AlphaAuthService
  createToken(wallet: ObsidionWallet, account: ObsidionAccount): Promise<TokenService>
  /** The account a sign-in just built: the unlock returns it. */
  handoff?: ObsidionAccount
}

export interface SessionDeps {
  namespace: Namespace
  database: Database
  /** The page's: it outlives every session. */
  wallet: Resource<ObsidionWallet>
  /** The page's, over `wallet`. */
  contractService: Resource<ContractService>
  visible: ReadonlyStore<boolean>
  network: Network
  /** Keys the scan's cursor to a non-default node endpoint. */
  endpointScope: string | undefined
  catchUp: CatchUp
  teeSignerSource: TeeSignerSource
  operations: OperationStore
  /** When this tab became the active one: the interrupted-operations sweep ends what started before. */
  readonly activeSince: number
  withdrawalRails(): Promise<TrackerRails | null>
  sipaDeposits: ReorgSipaStore
  sipaObserver?: SipaProcessingObserver
  /** An account's session only. */
  signIn?: SignInDeps
}

/** What the feed, the bell and the contact lists read, and the watchers that write from them. */
function views(
  db: Database,
  activity: Activity,
  withdrawals: Withdrawals,
  notifications: Notifications,
  observer: SipaProcessingObserver | undefined,
  milestones: Milestones,
) {
  const reads = activityReads(activity)
  const requests = createRequests({
    db,
    payments: derived([reads.paying, depositRecords()] as const, (rows, sipa) => ({
      rows: rows.records,
      deposits: sipa.records,
      loaded: rows.loaded && sipa.hydrated,
      failed: rows.failed,
    })),
    legacyUnlisted,
  })
  const identity = walletIdentity()
  const base = feedBase(requests, withdrawals, observer)
  const rows = bellRows(activity, notifications, reads.open)
  const sources = notificationSources(base, rows, identity, milestones)
  // Home: the window, with every pending row, escrowed link and request payment.
  const homeRows = mergedRows([activity.view, reads.pending, reads.open, reads.paying])
  return {
    requests,
    identity,
    reads,
    base,
    homeRows,
    feed: feedSources(base, homeRows),
    contactActivity: contactActivity(activity, requests, withdrawals),
    registrations: registrationRecords(),
    bell: bell(sources, notifications),
    sources,
  }
}

const NO_BALANCES: BalanceSource = {
  load: async () => {},
  list: () => [],
  onListChanged: () => () => {},
}
const NOTHING_STORED = memoryStore({ value: undefined, loaded: true }).readonly
const NO_ROWS = memoryStore({ value: [], loaded: true }).readonly

/** Builds a session from its deps; `switchSession` makes one current. */
export function openSession(deps: SessionDeps) {
  const { namespace, wallet, contractService, signIn } = deps
  const ended = new AbortController()
  const db = deps.database.scoped(namespace.prefix, ended.signal)
  const activity = createActivity({ db })
  const withdrawals = createWithdrawals({ db })
  const notifications = createNotifications(db)
  const milestones = createMilestones({ catchUp: deps.catchUp })
  const teeSigner = teeSignerResource(deps.teeSignerSource)
  const account: AccountResource | null = signIn
    ? accountResource({
        wallet,
        contractService,
        accounts: signIn.accounts,
        auth: signIn.auth,
        handoff: signIn.handoff,
      })
    : null
  const token: Resource<TokenService> | null =
    signIn && account
      ? tokenResource({ wallet, account, contractService, teeSigner, create: signIn.createToken })
      : null
  let balances: Balances | undefined
  const stops: Array<() => void> = []
  let built: ReturnType<typeof views> | undefined
  const open = () => {
    if (built) return built
    built = views(db, activity, withdrawals, notifications, deps.sipaObserver, milestones)
    stops.push(watchNotifications(built.sources, wallClock, notifications))
    if (signIn) {
      // The payer of each paid request becomes a full contact.
      stops.push(
        watchPayerApprovals({
          requests: built.requests,
          rows: derived([built.reads.paying], (rows) => rows.records),
          approve: (address) => signIn.contacts.approveAutoAdded(address),
        }),
      )
    }
    return built
  }
  if (signIn) open()
  /** An account's chain sync, its Savings and the background work over them. */
  const accountWork = (
    signIn: SignInDeps,
    account: Resource<ObsidionAccount>,
    token: Resource<TokenService>,
  ) => {
    const scan = transferScan({
      wallet,
      account,
      token,
      contractService,
      tag: () => open().identity.get().value?.handle,
      endpointScope: () => deps.endpointScope,
      visible: deps.visible,
      coordinator: ({ wallet, account, token, contractService }, readBalances) =>
        new WalletSyncCoordinator({
          source: createWalletSyncSource({
            readBalances,
            prepareToken: async () => void (await token.getTokenContract()),
            wallet,
            tokenAddress: token.metadata.address,
            accountAddress: account.getAddress().toString(),
            contractService,
          }),
          db,
          transactionStore: activity,
          // A fresh manifest: the contact cache never vouches for a sender.
          tags: createTagForwardResolver(resolveTagForCommit),
          contacts: createContactsByL2(signIn.contacts),
          token: token.metadata,
          balance: {
            store: signIn.balances,
            scope: balanceScope(deps.network, account.getCompleteAddress().toString()),
            tokenAddress: token.metadata.address,
          },
          // A pending row settles wherever it sits, even past the newest rows.
          transactions: mergedRows([activity.view, open().reads.pending]),
          withdrawals: withdrawals.list,
          milestones,
        }),
    })
    const savings = savingsResource(
      [wallet, account, token, contractService],
      (wallet, account, tokenService, contractService) =>
        openSavings({
          wallet,
          account,
          tokenService,
          network: deps.network,
          contractService,
          refreshBalance: () => scan.refreshBalance(),
        }),
    )
    const tasks = [
      scan.task,
      withdrawalRescan({ wallet, token }),
      savingsLookup({ wallet, account, scan, lookup: savingsRescanToken }),
      savingsMovesReplay({ wallet, account, token, savings }, milestones),
      oldVersionWithdrawalTask({
        wallet,
        records: oldVersionWithdrawalRecords(),
        settle: (id, wallet) =>
          settleOldVersionWithdrawal(id, (hash) => broadcastState(wallet, hash)),
      }),
      ...historicImports(wallet, signIn),
    ]
    return { scan, savings, tasks }
  }
  const work = signIn && account && token ? accountWork(signIn, account, token) : null
  const tasks = {
    withdrawalTracker: withdrawalTracker({
      wallet,
      store: withdrawals,
      rails: deps.withdrawalRails,
    }),
    transferScan: work?.scan.task ?? null,
  }
  const { operations } = deps
  // They need the page's wallet: demo mode has none, so they never run.
  const runtime = startRuntime(
    [
      tasks.withdrawalTracker,
      reorg({
        wallet,
        activity,
        withdrawals,
        sipaDeposits: deps.sipaDeposits,
        tracker: tasks.withdrawalTracker,
        onOutcome: (outcome) =>
          void bestEffort("unknown", recordReorgOutcome(notifications, outcome)),
      }),
      operationsSettle({ wallet, operations }),
      interruptedSweep({
        wallet,
        db,
        activity,
        withdrawals,
        operations,
        activeSince: () => deps.activeSince,
      }),
      ...(work?.tasks ?? []),
    ],
    { db, milestones, visible: deps.visible },
  )
  return {
    namespace,
    get network() {
      return deps.network
    },
    /** The account's database: a scan cursor kept here saves with the rows. */
    db,
    activity,
    /** A visitor's withdrawals stay in the anonymous namespace when it signs in. */
    withdrawals,
    notifications,
    milestones,
    wallet,
    contractService,
    /** The withdrawal tracker and the reorg pass run in every session, a visitor's too; the scan in an account's. */
    tasks,
    wake: (task: Task) => runtime.wake(task),
    /** Null for a visitor. */
    account,
    /** Null for a visitor; built once a route that needs assets demands it. */
    token,
    teeSigner,
    /** Null for a visitor; its value is null without a sUSDS deployment. */
    savings: work?.savings ?? null,
    /** Main's balance: cached until the token is built, then live. */
    get balances() {
      return (balances ??= createBalances(
        signIn?.balances ?? NO_BALANCES,
        {
          network: deps.network,
          account: signIn?.accounts.current ?? NOTHING_STORED,
          tokens: signIn?.tokens.rows ?? NO_ROWS,
          activeToken: token
            ? derived([token], (s) =>
                s.status === "ready" ? s.value.tokenAddressOrNull?.toString() ?? null : null,
              )
            : memoryStore(null).readonly,
        },
        milestones.sync,
      ))
    },
    get requests() {
      return open().requests
    },
    get identity() {
      return open().identity
    },
    /** What every activity feed reads beside its rows. */
    get feedBase() {
      return open().base
    },
    /** Home's reads beside its window. */
    get reads() {
      return open().reads
    },
    /** Home's rows. */
    get homeRows() {
      return open().homeRows
    },
    /** Home's feed: the newest rows. */
    get feed() {
      return open().feed
    },
    get contactActivity() {
      return open().contactActivity
    },
    /** This wallet's registrations, live and replaced. */
    get registrations() {
      return open().registrations
    },
    get bell() {
      return open().bell
    },
    /** Stops the session's tasks, watchers and resources; its namespace stops hearing commits. */
    close: () => {
      runtime.stop()
      milestones.stop()
      for (const stop of stops) stop()
      work?.scan.dispose()
      work?.savings.close()
      token?.close()
      account?.close()
      teeSigner.close()
      ended.abort()
    },
  }
}

export type Session = ReturnType<typeof openSession>

const current = memoryStore<Session | null>(null)
/** The first account this page served: no other account's stores open before it reloads. */
let pageAccount: string | undefined

/** The open session: null before boot opens one and once sign-out closes it. */
export const openedSession: ReadonlyStore<Session | null> = current.readonly

/** Whether the committed account is not the one this page served, so the page must reload. */
export function servesAnotherAccount(): boolean {
  const id = getActiveStorageId()
  return id !== null && pageAccount !== undefined && id !== pageAccount
}

/**
 * Makes the namespace's session current: at boot, on sign-in and from the demo seed. The same
 * namespace keeps the open session, which takes `handoff` as its account; an open account's session
 * stays until it closes. Another account's never opens on this page: its sign-in reloads first, and
 * reaching here instead is a bug.
 */
export function switchSession(namespace: Namespace, handoff?: ObsidionAccount): Session {
  const open = current.get()
  if (namespace.id !== null && (pageAccount ??= namespace.id) !== namespace.id) {
    console.error("[session] another account signed in on this page; it serves the first one")
    return open ?? switchSession(namespaceOf(null))
  }
  if (open && (open.namespace.id === namespace.id || open.namespace.id !== null)) {
    if (handoff) open.account?.handOff(handoff)
    return open
  }
  open?.close()
  const session = openSession(pageSessionDeps(namespace, handoff))
  current.set(session)
  return session
}

/** Gives the account a sign-in built to the committed account's session. */
export function handOffAccount(account: ObsidionAccount): void {
  switchSession(activeNamespace(), account)
}

export function closeSession(): void {
  current.get()?.close()
  current.set(null)
}

/** Follows each saved change of the session pointers: a sign-in, or a rejected key's removal. */
export function followSavedSession(): void {
  const namespace = activeNamespace()
  if (namespace.id === null) closeSession()
  switchSession(namespace)
}

function opened(open: Session | null): Session {
  if (!open) throw new WalletError("unknown", "no session is open")
  return open
}

export const session = (): Session => opened(current.get())

export const useSession = (): Session => opened(useStore(current.readonly))

/** Starts the session's token and TEE signer once `ready`; they stay up for the session. */
export function useAssetDemand(ready: boolean): void {
  const { token, teeSigner } = useSession()
  useEffect(() => {
    if (!ready) return
    token?.demand()
    teeSigner.demand()
  }, [ready, token, teeSigner])
}
