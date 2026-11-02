/**
 * Which tab of the origin runs the wallet, and the handoff when another tab takes it over.
 *
 * The active-tab lock names the tab that runs the wallet. A tab that finds it held shows "Use this
 * tab", which steals it. The old tab learns of the steal when its lock request rejects: it stops,
 * closes its databases and reloads.
 *
 * A steal tells the new tab nothing about when the old one has stopped. The databases do: each
 * takes its OPFS pool lock when it opens and refuses to open in another tab while that is held, so
 * the new tab retries opening until the old tab has closed them. A database in memory, used where
 * OPFS is unavailable, takes no pool lock, but it belongs to its page alone, so there is nothing
 * the new tab could see the old one write.
 */
import { WebLocksUnavailableError } from "./webLock"

export const ACTIVE_TAB_LOCK = "webwallet.active-tab"

/** Between attempts to open a database another tab still holds. */
export const BUSY_RETRY_MS = 100
/** Until a tab still opening its databases tells the user to close the other one. */
export const STALLED_AFTER_MS = 5_000
/** Until a displaced tab stops waiting for its databases to close and reloads anyway. */
export const CLOSE_GRACE_MS = 2_000

export interface TabLocks {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => unknown,
  ): Promise<unknown>
}

export interface OpenedStorage {
  close(): Promise<void>
}

export interface ActiveTabDeps<T extends OpenedStorage> {
  locks: TabLocks | undefined
  /** Opens this tab's databases; rejects with a busy error while another tab holds one. */
  open(): Promise<T>
  isBusy(error: unknown): boolean
  /** Runs once the tab is active, before it reports ready. */
  prepare(opened: T): Promise<void>
  /** Marks this page as the one running the wallet (`activeTab.ts`). */
  activate(): void
  /** Marks this page as no longer running the wallet, for good. */
  revoke(): void
  reload(): void
}

export type ActiveTabState<T> =
  /** Asking for the active-tab lock: `opening` if this tab gets it, else `inactive`. */
  | { kind: "starting" }
  /** Another tab is active; `claiming` while "Use this tab" steals the lock, then `opening`. */
  | { kind: "inactive"; claiming: boolean }
  /**
   * This tab holds the active-tab lock and is opening its databases; `stalled` once another tab
   * has held one too long. `ready` once this tab has opened them and is marked active.
   */
  | { kind: "opening"; takeover: boolean; stalled: boolean }
  | { kind: "ready"; opened: T; activeSince: number }
  /** Another tab took over from `opening` or `ready`: this page closes its databases and reloads. */
  | { kind: "displaced" }
  /** Missing Web Locks or any unexpected error. The page stays inactive until it reloads. */
  | { kind: "failed"; error: unknown }

/** One claim of the active-tab lock, from the request to the page going away. */
interface Attempt<T> {
  live: boolean
  /** Another tab holds a database this attempt is opening. */
  blocked: boolean
  /** This attempt has waited long enough to say so. */
  overdue: boolean
  timers: Set<ReturnType<typeof setTimeout>>
  releaseActive?: () => void
  /** The latest opening, settling to the databases or to nothing. */
  opening?: Promise<T | undefined>
  /** Settles true once nothing this attempt opened is still open. */
  closing?: Promise<boolean>
}

export class ActiveTabLifecycle<T extends OpenedStorage> {
  private state: ActiveTabState<T> = { kind: "starting" }
  private readonly listeners = new Set<() => void>()
  private started = false

  constructor(private readonly deps: ActiveTabDeps<T>) {}

  getState = (): ActiveTabState<T> => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Takes the active-tab lock if no other tab holds it. Later calls do nothing. */
  start = (): void => {
    if (this.started) return
    this.started = true
    this.claim({ steal: false })
  }

  /** Takes the active-tab lock from whichever tab holds it. Only an `inactive` tab offers this. */
  takeOver = (): void => {
    const { state } = this
    if (state.kind !== "inactive" || state.claiming) {
      throw new Error(
        `Cannot take over while ${state.kind === "inactive" ? "claiming" : state.kind}`,
      )
    }
    this.set({ kind: "inactive", claiming: true })
    this.claim({ steal: true })
  }

  private set(state: ActiveTabState<T>): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }

  private claim({ steal }: { steal: boolean }): void {
    const locks = this.deps.locks
    if (typeof locks?.request !== "function") {
      this.set({ kind: "failed", error: new WebLocksUnavailableError() })
      return
    }
    const attempt: Attempt<T> = { live: true, blocked: false, overdue: false, timers: new Set() }
    let held = false
    locks
      .request(ACTIVE_TAB_LOCK, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) return
        held = true
        return new Promise<void>((release) => {
          attempt.releaseActive = release
          this.set({ kind: "opening", takeover: steal, stalled: false })
          this.after(attempt, STALLED_AFTER_MS, () => {
            attempt.overdue = true
            this.updateStalled(attempt)
          })
          void this.boot(attempt)
        })
      })
      .then(
        () => {
          if (!held) this.set({ kind: "inactive", claiming: false })
        },
        // This tab held the lock and another tab stole it. The steal rejects this request but leaves
        // the work its callback started (the databases) running.
        (error: unknown) =>
          held && (error as Error | undefined)?.name === "AbortError"
            ? this.displace(attempt)
            : this.fail(attempt, error),
      )
  }

  /**
   * Another tab can take over during any await here. The attempt is then no longer live and
   * `displace` closes what it opened, so this stops without touching it.
   */
  private async boot(attempt: Attempt<T>): Promise<void> {
    try {
      const opened = await this.openWhenFree(attempt)
      if (!opened || !attempt.live) return
      this.deps.activate()
      await this.deps.prepare(opened)
      if (!attempt.live) return
      this.clearTimers(attempt)
      this.set({ kind: "ready", opened, activeSince: Date.now() })
    } catch (error) {
      this.fail(attempt, error)
    }
  }

  /**
   * The databases offer no way to check whether another tab still holds them, nor to wait until
   * they are free, so this tries to open them and, while one is busy, waits and tries again. Any
   * other error ends the attempt.
   */
  private async openWhenFree(attempt: Attempt<T>): Promise<T | undefined> {
    while (attempt.live) {
      const opening = this.deps.open()
      attempt.opening = opening.catch(() => undefined)
      try {
        const opened = await opening
        attempt.blocked = false
        this.updateStalled(attempt)
        return opened
      } catch (error) {
        if (!this.deps.isBusy(error)) throw error
      }
      attempt.blocked = true
      this.updateStalled(attempt)
      await new Promise<void>((resolve) => this.after(attempt, BUSY_RETRY_MS, resolve))
    }
    return undefined
  }

  /** Guidance to close the other tab, only while another tab is what keeps this one waiting. */
  private updateStalled(attempt: Attempt<T>): void {
    const stalled = attempt.overdue && attempt.blocked
    if (attempt.live && this.state.kind === "opening" && this.state.stalled !== stalled) {
      this.set({ ...this.state, stalled })
    }
  }

  /**
   * The active-tab lock goes only once the databases have closed. One that failed to close may
   * still hold its files, so the lock then stays until the page goes.
   */
  private fail(attempt: Attempt<T>, error: unknown): void {
    if (!attempt.live) return
    this.end(attempt)
    this.set({ kind: "failed", error })
    void this.close(attempt).then((closed) => {
      if (closed) attempt.releaseActive?.()
    })
  }

  private displace(attempt: Attempt<T>): void {
    this.end(attempt)
    this.set({ kind: "displaced" })
    const grace = new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE_MS))
    void Promise.race([this.close(attempt), grace]).then(() => this.deps.reload())
  }

  /** Nothing this page runs may act as the active tab or open the databases again. */
  private end(attempt: Attempt<T>): void {
    attempt.live = false
    this.deps.revoke()
    this.clearTimers(attempt)
  }

  /**
   * One close per attempt: a second upstream `close()` resolves before the first has finished.
   * False when a database failed to close and may still hold its files.
   */
  private close(attempt: Attempt<T>): Promise<boolean> {
    attempt.closing ??= (attempt.opening ?? Promise.resolve(undefined))
      .then((opened) => opened?.close())
      .then(
        () => true,
        () => false,
      )
    return attempt.closing
  }

  private after(attempt: Attempt<T>, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      attempt.timers.delete(timer)
      fn()
    }, ms)
    attempt.timers.add(timer)
  }

  private clearTimers(attempt: Attempt<T>): void {
    for (const timer of attempt.timers) clearTimeout(timer)
    attempt.timers.clear()
  }
}
