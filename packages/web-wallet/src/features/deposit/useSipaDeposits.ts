import { useEffect, useMemo, useRef } from "react"
import { SIPADepositStore, useCachedRecords, useResource } from "@obsidion/front-core"
import type {
  After,
  Milestones,
  ResolverPaymentWatcher,
  SIPADepositRecord,
  SipaDepositSyncResult,
} from "@obsidion/front-core"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { whenVisibilityChanges } from "../../platform/visibilityScheduler"
import { fireEvent } from "../../lib/analytics"
import { notePassLanded, observeDeposits } from "./depositPasses"
import { getSipaDepositGateway } from "./sipaGateway"
import { useSession } from "../../platform/session"

/** The SIPA pass; its first clean run is `depositsReplayed`. */
const SYNC_AFTER: After = { firstBalance: true }
/** L1 polls and address derivation, no PXE work. */
const RESOLVER_AFTER: After = { firstBalance: true }

/** Poll cadence while a deposit is in flight. */
const SYNC_INTERVAL_MS = 12_000
/** Cadence once every known SIPA is settled or long-idle (`SipaDepositSyncResult.active === 0`). */
const IDLE_SYNC_INTERVAL_MS = 60_000

/**
 * Records that just reached the terminal `claimed` phase (balance-visible), against `seen` —
 * which it mutates, so each claim reports exactly once. Seed `seen` with the already-claimed
 * records at mount or history re-fires. Addresses stay in-memory dedup keys; only durations
 * are ever emitted.
 */
export function newlyClaimedRecords(
  records: SIPADepositRecord[],
  seen: Set<string>,
): SIPADepositRecord[] {
  const fresh: SIPADepositRecord[] = []
  for (const r of records) {
    if (r.phase !== "claimed" || seen.has(r.sipaAddress)) continue
    seen.add(r.sipaAddress)
    fresh.push(r)
  }
  return fresh
}

/**
 * Reports the claims that settle from `since` onward, deduped by address. Records hydrate
 * cache-first and asynchronously, starting from an empty list, so arrival order can't separate
 * history from a live claim — `endTime` can: a record that settled before this session started is
 * history whenever it shows up. A claimed record with no `endTime` is treated as history, since a
 * duplicate funnel entry costs more than a missing one.
 *
 * In-memory dedupe: a reload re-derives everything from `since`, so it can't double-count.
 */
export function createClaimSweepReporter(
  since: number = Date.now(),
): (records: SIPADepositRecord[]) => SIPADepositRecord[] {
  const seen = new Set<string>()
  return (records) =>
    newlyClaimedRecords(records, seen).filter((r) => r.endTime !== undefined && r.endTime >= since)
}

/**
 * Reports a sync's unclaimed notes only on the way into failure. The pass retries on every tick, so
 * a note that stays stuck would otherwise report itself for as long as it sits there. A clean run
 * arms the next report.
 */
export function createSyncFailureReporter(): (failed: number) => boolean {
  let failing = false
  return (failed) => {
    const report = failed > 0 && !failing
    failing = failed > 0
    return report
  }
}

/**
 * Whether a pass settles the boot balance: it ran unlocked and claimed every note it found. A failed
 * or locked pass leaves that to a later pass or the backstop.
 */
export function settlesBootBalance(result: SipaDepositSyncResult | null): boolean {
  return !!result && result.failed === 0
}

/**
 * Runs `watcher` on the delays its ticks return while the page is shown, and stops while it is
 * hidden: what it finds is read on screen, and the sync pass keeps any recorded deposit moving.
 * Showing the page ticks at once. Returns the stop.
 */
export function startResolverPaymentLoop(
  watcher: Pick<ResolverPaymentWatcher, "tick">,
  visibility: typeof whenVisibilityChanges = whenVisibilityChanges,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let shown = false
  let running = false
  let stopped = false
  const run = async () => {
    if (running || stopped || !shown) return
    running = true
    clearTimeout(timer)
    const delay = await watcher.tick()
    running = false
    if (!stopped && shown) timer = setTimeout(run, delay)
  }
  const unlisten = visibility({
    onShow: () => {
      shown = true
      void run()
    },
    onHide: () => {
      shown = false
      clearTimeout(timer)
    },
  })
  return () => {
    stopped = true
    clearTimeout(timer)
    unlisten()
  }
}

/**
 * Drives the browser SIPA deposit loop: discovery (once) + a claim sync pass
 * on an interval. Records render cache-first — the persisted store hydrates
 * immediately and the sync pass overwrites it as fresh chain state lands.
 * Balance is NOT read here — a claim credits the session's balances, the pass
 * refreshes the chain view through `refreshBalance`, and the balances store
 * renders the result.
 * Sync is a no-op while the wallet is locked (the claim path needs the
 * unlocked key), so a refreshed session starts crediting deposits as soon as
 * it unlocks. The first pass runs after the first balance, and its first clean
 * run is `depositsReplayed`. Resolver payments are polled beside it,
 * and one that lands runs a pass at once.
 */
export function useSipaDeposits(milestones: Pick<Milestones, "after" | "progress" | "mark">): void {
  const obsidionWallet = useResource(useSession().wallet)
  const tokenService = useResource(useSession().token)
  const gateway = getSipaDepositGateway()

  const store = useMemo(() => SIPADepositStore.get(webStorage), [])
  const { records } = useCachedRecords(store)

  // Per-mount, so a StrictMode re-run reuses the same reporter and re-reports nothing.
  const reportSweeps = useRef<ReturnType<typeof createClaimSweepReporter> | null>(null)
  reportSweeps.current ??= createClaimSweepReporter()

  useEffect(() => {
    for (const r of reportSweeps.current!(records)) {
      fireEvent("deposit_swept", {
        duration_ms: r.endTime !== undefined ? r.endTime - r.startTime : undefined,
        ...(r.intent === "registration" && { registration: true }),
      })
    }
  }, [records])

  // Per-mount, so a StrictMode re-run reuses the same reporter.
  const reportFailures = useRef<ReturnType<typeof createSyncFailureReporter> | null>(null)
  reportFailures.current ??= createSyncFailureReporter()

  // Runs a pass now unless one is running; a no-op until the loop below is up.
  const wakeSync = useRef<() => void>(() => {})

  useEffect(() => {
    if (!obsidionWallet || !tokenService) return
    let cancelled = false
    let running = false
    // Past the boot wait: a pass waiting there has not listed its records yet.
    let syncing = false
    // A wake that arrived mid-pass: the pass may have listed its records before the new one.
    let wokenMidPass = false
    let timer: ReturnType<typeof setTimeout>
    gateway.warm().catch((err) => console.warn("[sipa] warming the deposit sync failed:", err))

    const runOnce = async () => {
      running = true
      // Fast unless a pass reports nothing in flight. A locked or failed pass reports
      // nothing at all, so it stays fast.
      let nextDelay = SYNC_INTERVAL_MS
      let clean = false
      try {
        if (!(await milestones.after(SYNC_AFTER)) || cancelled) return
        syncing = true
        const result = await gateway.sync(obsidionWallet, tokenService, {
          onProgress: (done, total) => milestones.progress("deposits", done, total),
        })
        // Locked sessions return null; a healthy tick logs its counts so
        // silence always means "not running", never "ran and found nothing".
        if (result) console.debug("[sipaDeposits] sync:", result)
        if (result) notePassLanded()
        // Per-note failures are swallowed by the pass so one bad note can't stop the others, which
        // leaves a deposit stuck with nothing said. Report the run, not each note.
        if (result) {
          if (result.failed > 0)
            console.warn("[sipaDeposits] sync left", result.failed, "note(s) unclaimed")
          if (reportFailures.current!(result.failed))
            fireEvent("action_failed", { action: "deposit:sync", code: "note_sync_failed" })
        }
        if (result && result.active === 0) nextDelay = IDLE_SYNC_INTERVAL_MS
        clean = settlesBootBalance(result)
      } catch (e) {
        console.warn("[sipaDeposits] sync failed (will retry):", e)
        nextDelay = SYNC_INTERVAL_MS
      } finally {
        running = false
        syncing = false
        if (!cancelled) {
          if (clean) milestones.mark("depositsReplayed")
          if (wokenMidPass) nextDelay = 0
          wokenMidPass = false
          timer = setTimeout(runOnce, nextDelay)
        }
      }
    }
    runOnce()
    wakeSync.current = () => {
      if (cancelled) return
      if (running) {
        if (syncing) wokenMidPass = true
        return
      }
      clearTimeout(timer)
      void runOnce()
    }

    return () => {
      cancelled = true
      clearTimeout(timer)
      wakeSync.current = () => {}
    }
  }, [gateway, obsidionWallet, tokenService, milestones])

  // Watching screens observe the wallet's own account; L1 reads alone, so never behind the PXE.
  const account = loadWalletIdentity()?.address
  useEffect(
    () => (obsidionWallet && account ? observeDeposits(obsidionWallet, account) : undefined),
    [obsidionWallet, account],
  )

  useEffect(() => {
    if (!obsidionWallet) return
    let cancelled = false
    let stop: (() => void) | undefined
    void milestones.after(RESOLVER_AFTER).then((over) => {
      if (over && !cancelled)
        stop = startResolverPaymentLoop(
          gateway.resolverPayments(obsidionWallet.networkId, () => wakeSync.current()),
        )
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [gateway, obsidionWallet, milestones])
}

/**
 * Signup's deposit loop while `recipient`'s registration holds custody: observe-only passes that
 * keep the registration address's record current with L1 reads alone. No PXE work, so the sponsored
 * account setup it runs beside is never starved; the full loop claims once the wallet routes mount.
 * It needs no token, which signup never starts for the same reason.
 */
export function useSignupDeposits(recipient: string | null): void {
  const obsidionWallet = useResource(useSession().wallet)
  useEffect(
    () =>
      obsidionWallet && recipient
        ? observeDeposits(obsidionWallet, recipient, SYNC_INTERVAL_MS)
        : undefined,
    [obsidionWallet, recipient],
  )
}
