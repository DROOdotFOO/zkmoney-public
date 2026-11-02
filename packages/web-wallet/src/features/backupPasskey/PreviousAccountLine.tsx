import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { isDust, type BackupRotationRecord } from "@obsidion/front-core"
import { createExternalState } from "../../lib/externalState"
import { usdAtomicFloor } from "../../ui/format"
import { PasskeysModal } from "../../ui/PasskeysModal"
import { useHideBalances } from "../../ui/prefs"
import {
  previousAccountActions,
  previousAccountCopy,
  type PreviousAccountView,
} from "./backupPasskeyCopy"
import { useBackupRotations, type BackupRotations } from "./backupRotationStore"
import {
  getPreviousAccountWatcher,
  type PreviousAccountState,
  type PreviousMoveOutcome,
} from "./previousAccountWatcher"

const HIDDEN = "$••••••"
const MAX_REFUSALS = 3

/** Spend refusals in a row this page session, and the cap the next move cuts its chunks to. */
const streak = createExternalState<{ refusals: number; cap?: bigint }>({ refusals: 0 })

function count(outcome: PreviousMoveOutcome): void {
  if (outcome.kind === "done") streak.set({ refusals: 0 })
  else if (outcome.kind === "refused" && outcome.reason === "spend") {
    streak.set({ refusals: streak.get().refusals + 1, cap: outcome.amount / 2n })
  }
}

/** A rotation that no longer moves its one-key account's balance. */
const finished = (record: BackupRotationRecord) =>
  record.phase === "done" ||
  record.phase === "conflict" ||
  record.phase === "recovered" ||
  (record.phase === "attention" &&
    (record.suspended === "done" || record.suspended === "recovered"))

function viewOf(
  state: PreviousAccountState,
  rotations: BackupRotations,
  { refusals, cap }: { refusals: number; cap?: bigint },
): PreviousAccountView | undefined {
  if (state.moving) return "moving"
  const { amount, dust, address } = state
  if (!state.open || !address || amount === undefined || dust === undefined) return undefined
  if (isDust(amount, dust)) return undefined
  if (!state.signs) return "backupSession"
  if (typeof rotations === "string") return "unchecked"
  const owns = (record: BackupRotationRecord) =>
    record.rotation?.builtOver.l2Address.toLowerCase() === address.toLowerCase()
  // Two movers would ask for two prompts: an unfinished rotation keeps moving this balance itself.
  if (rotations.some((record) => owns(record) && !finished(record))) return "resume"
  if (refusals >= MAX_REFUSALS || (cap !== undefined && cap < 1n)) return "stuck"
  const last = state.lastResult
  if (last?.kind === "refused" && last.reason === "spend") return "refused"
  if (last?.kind === "refused" || last?.kind === "failed") return "failed"
  return "move"
}

/**
 * Home's line for money that reached the account the wallet ran on before its backup passkey, with
 * the one action this session has over it. Leaving Home stops a move before its next prompt.
 */
export function PreviousAccountLine() {
  const watcher = getPreviousAccountWatcher()
  const state = useSyncExternalStore(watcher.subscribe, watcher.getSnapshot)
  const tries = useSyncExternalStore(streak.subscribe, streak.get)
  const rotations = useBackupRotations()
  const [hideBal] = useHideBalances()
  const [sheet, setSheet] = useState(false)
  const leave = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    leave.current = controller
    void watcher.refresh()
    return () => controller.abort()
  }, [watcher])

  const view = viewOf(state, rotations, tries)
  const amount = hideBal ? HIDDEN : usdAtomicFloor(state.amount ?? 0n)
  const copy = view && previousAccountCopy(view, amount)
  const move = () =>
    void watcher
      .move({ cap: tries.cap, signal: leave.current?.signal })
      .then(count, (err: unknown) => console.warn("[previousAccount] move did not start", err))
  return (
    <>
      {copy && (
        <div
          className="ww-banner"
          style={{ cursor: "default" }}
          data-testid="previous-account-line"
          aria-live="polite"
        >
          <span className="ww-banner__text">
            <span className="ww-banner__title">{copy.line}</span>
            {copy.detail && <span className="ww-banner__body">{copy.detail}</span>}
          </span>
          {copy.action && (
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              onClick={copy.action === "resume" ? () => setSheet(true) : move}
            >
              {previousAccountActions[copy.action]}
            </button>
          )}
        </div>
      )}
      {/* Stays open while the rotation it resumes moves the balance away. */}
      {sheet && <PasskeysModal onClose={() => setSheet(false)} />}
    </>
  )
}

/** Test seam: a new page session, with no refusals counted. */
export function resetPreviousAccountLineForTests(): void {
  streak.set({ refusals: 0 })
}
