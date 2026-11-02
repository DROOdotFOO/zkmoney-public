/**
 * The page's one owner of a rotated wallet's previous one-key account: it finds the account from
 * the session's record, registers it, keeps its watch, runs its claims pass, reads its balance,
 * settles a stored move chunk and runs the move, and publishes one state for Home's line.
 */
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  deriveBootstrapKey,
  isDust,
  loadRecords,
  movePreviousBalance,
  observeWatch,
  openWatch,
  PreviousAccountWatchStore,
  previousRootKey,
  recordHoldsMoney,
  refundOnItsWay,
  resolveOxideIdentity,
  settleStoredChunk,
  txOutcome,
  WATCH_CHECK_MS,
  watchCheckDue,
  type MovedTokenRow,
  type PaylinkTransaction,
  type PreviousAccountWatch,
  type PreviousMoveDeps,
  type PreviousMoveResult,
  type After,
} from "@obsidion/front-core"
import {
  ContractService,
  normalizePubkeyHex,
  readSpendShape,
  type AlphaAuthProvider,
  type ObsidionAccount,
  type ObsidionWallet,
  type RecoveryMetadata,
} from "@obsidion/sdk"
import { getWebOxideToken } from "../../config/classArtifacts"
import { getConfig } from "../../config/env"
import { getFeeTokenBridgeTuple, getOxideTuple, requireTupleField } from "../../config/oxideTuple"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { openedSession } from "../../platform/session"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { usdAtomicFloor } from "../../ui/format"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { claimSponsorContext } from "../onboarding/claimSponsorship"
import { loadOxideGenerations } from "../onboarding/oxideGenerations"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { unlockedSessionKeys } from "../onboarding/registrationResume"
import { singleKeyAccount } from "../onboarding/sponsorAccounts"
import { l2TokenService } from "../token/l2TokenService"
import { currentTxAmountCap } from "../token/oxideToken"
import { sponsoredTokenService, walletOutcomeNode } from "./backupPasskeyRuntime"

/** How often an open watch runs the previous account's claims pass. */
export const PREVIOUS_PASS_MS = 5 * 60_000
const WATCH_AFTER: After = { firstBalance: true }

/** How a move ended, or the error that ended it. */
export type PreviousMoveOutcome = PreviousMoveResult | { kind: "failed"; error: unknown }

export interface PreviousAccountState {
  /** The previous account; absent while none is found. */
  address?: string
  /** Its balance of the moved token at the last read, atomic units. */
  amount?: bigint
  /** The smallest amount Home shows of that token; known once the account is registered. */
  dust?: bigint
  /** The session signs for it: the session's key is its root key. */
  signs: boolean
  open: boolean
  /** A chunk is stored or a move runs. */
  moving: boolean
  lastResult?: PreviousMoveOutcome
}

const NONE: PreviousAccountState = { signs: false, open: false, moving: false }

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const watches = () => PreviousAccountWatchStore.get(webStorage)

/** The smallest amount `usdAtomicFloor`, Home's balance figure, shows as more than nothing. */
export function dustFloor(decimals: number): bigint {
  const zero = usdAtomicFloor(0n, decimals)
  let unit = 1n
  while (usdAtomicFloor(unit, decimals) === zero) unit *= 10n
  return unit
}

let warnedSecondBridge = false

function warnOnSecondBridge(fee: OxideEnvTuple, pinned: OxideEnvTuple): void {
  if (warnedSecondBridge || sameHex(fee.portal, pinned.portal)) return
  warnedSecondBridge = true
  console.warn(
    `[previousAccount] the deposit bridge ${pinned.portal} is not the fee token's ${fee.portal}; ` +
      "only the fee token is watched",
  )
}

/** The previous account as a session found it. */
interface Previous {
  wallet: ObsidionWallet
  /** The session signer it was found under. */
  signer: AlphaAuthProvider
  record: RecoveryMetadata
  root: string
  address: AztecAddress
  signs: boolean
  l2Token: string
  row: MovedTokenRow
  registered?: Promise<Registered>
}

interface Registered {
  account: ObsidionAccount
  dust: bigint
}

/** What a start found: the session's signer, absent while locked, and the previous account. */
interface Found {
  signer?: AlphaAuthProvider
  previous?: Previous
}

/** One start of the watcher on a wallet. */
interface Life {
  wallet: ObsidionWallet
  found: Promise<Found>
}

/** An account's last pass: when it was reserved, whether it runs, and whether it fell short. */
type Pass = { at: number; running: boolean; failed?: true }

export class PreviousAccountWatcher {
  private state = NONE
  private readonly listeners = new Set<() => void>()
  private life?: Life
  private booted = false
  private readonly passes = new Map<string, Pass>()
  private settling?: Promise<void>
  /** The move run, held until all its work settled, across a stop and the next start. */
  private running?: Promise<PreviousMoveOutcome>
  /** The running move once a new session took over: waited out, never joined or shown. */
  private stale?: Promise<PreviousMoveOutcome>
  private abortRun?: AbortController

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): PreviousAccountState => this.state

  /** Watches for `wallet`'s session; a start on the wallet already watched does nothing. */
  start(wallet: ObsidionWallet): void {
    if (this.life?.wallet === wallet) return
    this.stop()
    this.begin(wallet)
  }

  /** Stops watching. A running move stops before its next prompt and stays held until it settles. */
  stop(): void {
    this.life = undefined
    this.abortRun?.abort()
    this.set(NONE)
  }

  /** The checks that are due; the mount calls it on an interval. A new session starts over. */
  async tick(): Promise<void> {
    const life = this.life
    if (!life) return
    const pending = life.found
    let found: Found
    try {
      found = await pending
    } catch (err) {
      console.warn("[previousAccount] could not find the previous account", err)
      if (life === this.life && life.found === pending) {
        this.clear(life)
        this.seek(life)
      }
      return
    }
    try {
      const keys = await getAuthService().sessionKeys()
      if (life !== this.life) return
      if (keys?.authProvider !== found.signer) return this.restart(life)
      if (found.previous) await this.check(life, found.previous)
    } catch (err) {
      console.warn("[previousAccount] check failed", err)
    }
  }

  /** Reads the previous account's balance again while its watch is open. */
  async refresh(): Promise<void> {
    const life = this.life
    if (!life || !this.booted) return
    try {
      const { previous } = await life.found
      if (!previous || life !== this.life) return
      const watch = await watches().get(previous.address.toString())
      if (!watch || watch.closed) return
      await this.observe(life, previous, await this.registered(previous), false)
    } catch (err) {
      console.warn("[previousAccount] balance read failed", err)
    }
  }

  /**
   * Moves the previous account's balance to the session's account. A move already running is
   * joined, so a second call, or one after a remount, never starts another; one an earlier session
   * started is waited out, then this one starts. `signal` stops it before its next prompt; `cap`
   * bounds each chunk.
   */
  move(opts: { cap?: bigint; signal?: AbortSignal } = {}): Promise<PreviousMoveOutcome> {
    if (opts.cap !== undefined && opts.cap < 1n) {
      return Promise.reject(new RangeError("a move's chunk cap must be at least 1"))
    }
    if (this.running) {
      if (this.running !== this.stale) return this.running
      const again = () => this.move(opts)
      return this.running.then(again, again)
    }
    const controller = new AbortController()
    if (opts.signal?.aborted) controller.abort()
    opts.signal?.addEventListener("abort", () => controller.abort(), { once: true })
    const run: Promise<PreviousMoveOutcome> = this.runMove(this.life, opts.cap, controller.signal)
      .catch((error: unknown) => ({ kind: "failed" as const, error }))
      .then(async (outcome) => {
        const stale = this.stale === run
        if (stale) this.stale = undefined
        if (this.running === run) {
          this.running = undefined
          this.abortRun = undefined
        }
        await this.afterMove(outcome, stale)
        return outcome
      })
    this.running = run
    this.abortRun = controller
    this.set({ ...this.state, moving: true })
    return run
  }

  private begin(wallet: ObsidionWallet): void {
    const life: Life = { wallet, found: Promise.resolve({}) }
    this.life = life
    this.seek(life)
    const milestones = openedSession.get()?.milestones
    void (milestones ? milestones.after(WATCH_AFTER) : Promise.resolve(true)).then((over) => {
      if (!over) return
      this.booted = true
      return this.tick()
    })
    void this.tick()
  }

  /** Starts `life`'s search for the previous account; a tick that reads a failure searches again. */
  private seek(life: Life): void {
    life.found = this.find(life)
    // Marks the rejection handled only: `life.found` still rejects for the tick that reads it.
    life.found.catch(() => undefined)
  }

  /** A new session on the same wallet: the line keeps its account until the new search answers. */
  private restart(life: Life): void {
    if (life !== this.life) return
    this.stale = this.running
    this.abortRun?.abort()
    this.begin(life.wallet)
  }

  /** Clears the line while `life` is the watcher's: its search failed or found no account. */
  private clear(life: Life): void {
    if (life === this.life && this.state !== NONE) this.set(NONE)
  }

  /** The previous account of the session's record, with its watch opened on first sight. */
  private async find(life: Life): Promise<Found> {
    const keys = await unlockedSessionKeys(life.wallet)
    if (!keys) {
      this.clear(life)
      return {}
    }
    const signer = keys.authProvider
    const session = keys.account.getAddress()
    const record = await getAuthService().accountRecord(session.toString())
    const root = record && previousRootKey(record)
    if (!record || !root) {
      this.clear(life)
      return { signer }
    }
    const address = await life.wallet.deriveAccountAddress(keys.secretKey, [root])
    if (address.equals(session)) {
      this.clear(life)
      return { signer }
    }
    const config = getConfig()
    const [fee, pinned] = await Promise.all([getFeeTokenBridgeTuple(config), getOxideTuple(config)])
    warnOnSecondBridge(fee, pinned)
    const previous: Previous = {
      wallet: life.wallet,
      signer,
      record,
      root,
      address,
      signs: normalizePubkeyHex(keys.pubkeyHex) === root,
      l2Token: requireTupleField(fee, "l2Token"),
      row: { portal: fee.portal, token: bridgeUnderlying(fee) },
    }
    const key = address.toString()
    const watch = await watches().update(key, (current) =>
      current ? null : openWatch(key, Date.now()),
    )
    if (life === this.life) {
      const { amount, dust } = this.state.address === key ? this.state : NONE
      this.set({ ...NONE, amount, dust, address: key, signs: previous.signs })
      if (watch) this.publishWatch(watch)
    }
    return { signer, previous }
  }

  private async check(life: Life, previous: Previous): Promise<void> {
    const watch = await watches().get(previous.address.toString())
    if (life !== this.life || !watch) return
    this.publishWatch(watch)
    await Promise.all([
      watch.closed ? undefined : this.settle(life, previous),
      this.passIfDue(life, previous, watch),
    ])
  }

  /** Settles a stored chunk by its receipt, in the move's slot; never plans, sends or signs. */
  private async settle(life: Life, previous: Previous): Promise<void> {
    if (this.running || this.settling) return
    const settling = settleStoredChunk({
      store: watches(),
      address: previous.address.toString(),
      outcome: outcomeOf(previous.wallet),
    })
      .then((stored) => {
        if (life === this.life) this.set({ ...this.state, moving: !!this.running || stored })
      })
      .finally(() => {
        if (this.settling === settling) this.settling = undefined
      })
    this.settling = settling
    await settling
  }

  /**
   * One claims pass and balance read once boot released deposits: every `PREVIOUS_PASS_MS` while
   * the watch is open, and once a day while closed, or again after `PREVIOUS_PASS_MS` when the
   * last one threw or fell short. The slot is reserved before the pass queues.
   */
  private async passIfDue(
    life: Life,
    previous: Previous,
    watch: PreviousAccountWatch,
  ): Promise<void> {
    if (!this.booted) return
    const key = previous.address.toString().toLowerCase()
    const now = Date.now()
    const last = this.passes.get(key)
    if (last?.running) return
    const since = last ? now - last.at : Infinity
    const due = watch.closed
      ? watchCheckDue(watch, now) && since >= (last?.failed ? PREVIOUS_PASS_MS : WATCH_CHECK_MS)
      : since >= PREVIOUS_PASS_MS
    if (!due) return
    const pass: Pass = { at: now, running: true }
    this.passes.set(key, pass)
    try {
      const registered = await this.registered(previous)
      const { completed } = await getSipaDepositGateway().syncRecipient(
        previous.wallet,
        previous.address,
        (l2Token) => l2TokenService(previous.wallet, registered.account, l2Token),
      )
      // A pass a new session cut short recorded nothing, so the next check comes early.
      if (life !== this.life || !(await this.observe(life, previous, registered, completed))) {
        pass.failed = true
      }
    } catch (err) {
      pass.failed = true
      throw err
    } finally {
      pass.running = false
    }
  }

  /** The previous account registered under the session's key, and its token's dust floor. */
  private registered(previous: Previous): Promise<Registered> {
    previous.registered ??= this.register(previous).catch((err: unknown) => {
      previous.registered = undefined
      throw err
    })
    return previous.registered
  }

  private async register(previous: Previous): Promise<Registered> {
    const account = await singleKeyAccount(
      { wallet: previous.wallet, session: getAuthService() },
      previous.record,
      previous.root,
      previous.signs ? "sign" : "held",
    )
    const service = await l2TokenService(previous.wallet, account, previous.l2Token)
    const dust = dustFloor((await service.fetchTokenInformation()).decimals)
    if (this.state.address === previous.address.toString()) this.set({ ...this.state, dust })
    return { account, dust }
  }

  /**
   * Reads the balance, which syncs the account's notes, and applies what the check found to the
   * watch. A record or a refund of the previous account still holding money holds it too. Answers
   * whether the check was complete.
   */
  private async observe(
    life: Life,
    previous: Previous,
    { account, dust }: Registered,
    passCompleted: boolean,
  ): Promise<boolean> {
    const address = previous.address.toString()
    let balance: bigint | undefined
    try {
      balance = await (
        await l2TokenService(previous.wallet, account, previous.l2Token)
      ).getBalance()
    } catch (err) {
      console.warn("[previousAccount] balance read failed", err)
    }
    const recordHolds = getSipaDepositGateway()
      .records()
      .some(
        (record) =>
          !!record.recipientL2Address &&
          sameHex(record.recipientL2Address, address) &&
          recordHoldsMoney(record, previous.row, dust),
      )
    // With no session open, or a failed read, its paylink rows are unread: the check is incomplete.
    const activity = openedSession.get()?.activity
    const links = activity
      ? await loadRecords(activity.query("link", {})).catch((err: unknown) => {
          console.warn("[previousAccount] paylink rows unread", err)
          return undefined
        })
      : undefined
    const refunding = !!links?.some((row) => refundOnItsWay(row as PaylinkTransaction, address))
    const observation = {
      completed: passCompleted && balance !== undefined && !!links,
      held: (balance !== undefined && !isDust(balance, dust)) || recordHolds || refunding,
      inFlight: !!this.running,
    }
    const now = Date.now()
    const watch = await watches().update(address, (current) => {
      const next = observeWatch(current ?? openWatch(address, now), observation, now)
      return next === current ? null : next
    })
    if (life === this.life) {
      if (balance !== undefined) this.set({ ...this.state, amount: balance })
      if (watch) this.publishWatch(watch)
    }
    return observation.completed
  }

  private async runMove(
    life: Life | undefined,
    cap: bigint | undefined,
    signal: AbortSignal,
  ): Promise<PreviousMoveResult> {
    await this.settling?.catch(() => {})
    if (!life) throw new Error("the wallet is locked")
    const { previous } = await life.found
    if (!previous) throw new Error("no previous account to move from")
    if (!previous.signs) throw new Error("the first passkey must be signed in to move the balance")
    const registered = await this.registered(previous)
    return movePreviousBalance(await moveDeps(previous, registered, cap, signal), signal)
  }

  /** Publishes how a move ended, unless a new session took over while it ran. */
  private async afterMove(outcome: PreviousMoveOutcome, stale: boolean): Promise<void> {
    let stored = false
    try {
      const previous = this.life && (await this.life.found).previous
      stored = !!(previous && (await watches().get(previous.address.toString())))?.move
    } catch (err) {
      console.warn("[previousAccount] watch unread after the move", err)
    }
    const moving = !!this.running || stored
    this.set(stale ? { ...this.state, moving } : { ...this.state, lastResult: outcome, moving })
    void this.refresh()
  }

  private publishWatch(watch: PreviousAccountWatch): void {
    const open = !watch.closed
    const moving = !!this.running || !!watch.move
    if (open !== this.state.open || moving !== this.state.moving) {
      this.set({ ...this.state, open, moving })
    }
  }

  private set(state: PreviousAccountState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

/**
 * The forward's dependencies: the rotation's send sequence with the previous account acting, to
 * the live session account, which must derive from its record's set, differ from the source, and
 * be the account the L1 user record names.
 */
async function moveDeps(
  previous: Previous,
  { account, dust }: Registered,
  cap: bigint | undefined,
  signal: AbortSignal,
): Promise<PreviousMoveDeps> {
  const { wallet } = previous
  const session = await unlockedSessionKeys(wallet)
  if (!session) throw new Error("the wallet is locked")
  if (session.authProvider !== previous.signer) throw new SessionChangedError()
  const destination = session.account.getAddress()
  const source = previous.address.toString()
  const contractService = ContractService.getInstance()
  let named: Promise<boolean> | undefined
  return {
    store: watches(),
    address: source,
    source,
    destination: destination.toString(),
    shape: async () =>
      readSpendShape(
        wallet,
        await getWebOxideToken(wallet, contractService, previous.l2Token),
        account.getAddress(),
      ),
    cap: cap ?? (await currentTxAmountCap()),
    dust,
    send: async (amount, onTxHash, signal) => {
      const [tokenService, sponsor] = await Promise.all([
        sponsoredTokenService(wallet, account, previous.l2Token),
        claimSponsorContext({ wallet, account, contractService }, RAIL_REGISTERED),
      ])
      if (signal.aborted) throw new Error("the move was stopped")
      await tokenService.sendTokenSponsored(destination, amount.toString(), sponsor, {
        userAccount: account,
        useRawAmount: true,
        onTxHash,
        signal,
      })
      maybeRefuelFpc({
        wallet,
        contractService,
        fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact },
      })
    },
    outcome: outcomeOf(wallet),
    destinationOk: async () => {
      const record = await getAuthService().accountRecord(destination.toString())
      if (!record?.passkeySet) return false
      const derived = await wallet.deriveAccountAddress(session.secretKey, record.passkeySet)
      if (!derived.equals(destination) || destination.equals(previous.address)) return false
      named ??= namedOnL1(wallet, session.secretKey, destination.toString())
      return named
    },
    sleep: (ms) => sleep(ms, signal),
    now: Date.now,
  }
}

/** Whether the L1 user record of the MSK's bootstrap owner names `l2Address` on this rollup. */
async function namedOnL1(
  wallet: ObsidionWallet,
  secretKey: Fr,
  l2Address: string,
): Promise<boolean> {
  const generations = await loadOxideGenerations(wallet, ContractService.getInstance(), getConfig())
  const outcome = await resolveOxideIdentity(
    { ...generations, admissibleRollupVersions: new Set([generations.rollupVersion]) },
    deriveBootstrapKey(secretKey).address,
    l2Address,
  )
  return outcome.kind === "verified"
}

/** `txOutcome` over the wallet's node. */
function outcomeOf(wallet: ObsidionWallet) {
  const node = walletOutcomeNode(wallet)
  return (txHash: string, expiresAtMs: number) => txOutcome(node, txHash, expiresAtMs)
}

/** Waits `ms`, or until `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

let watcher: PreviousAccountWatcher | undefined

/** The page's watcher. */
export function getPreviousAccountWatcher(): PreviousAccountWatcher {
  watcher ??= new PreviousAccountWatcher()
  return watcher
}

/** Test seam: the next `getPreviousAccountWatcher` builds a fresh watcher. */
export function resetPreviousAccountWatcherForTests(): void {
  watcher?.stop()
  watcher = undefined
  warnedSecondBridge = false
}
