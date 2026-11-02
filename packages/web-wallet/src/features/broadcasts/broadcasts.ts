/**
 * The wallet's side of front-core's broadcast ledger: the one ledger over wallet storage, what
 * owes it a broadcast, and the scheduler that runs it while the wallet is up. Every SIPA this
 * wallet derives is owed here until its broadcast lands.
 */
import {
  BroadcastDeferred,
  BroadcastLedger,
  BroadcastScheduler,
  type BroadcastSchedulerDeps,
  type PendingRegistrationRecord,
  type RegistrationBroadcastPayload,
} from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { getOperationStore } from "../operations/operations"
import {
  backgroundProveReserved,
  onBackgroundProvesEnded,
  onUserFlowsIdle,
  trackBackgroundProve,
  userFlowActive,
} from "../provingGate"
import { broadcastState } from "./broadcastState"

/** How long a broadcast waits for an unlock or a claim server before asking again. */
export const WAIT_MS = 30_000

/** Why the ledger waits on a broadcast, as the executors report it to a status row. */
export const WAITING_FOR_UNLOCK = "Waiting for unlock"
export const WAITING_FOR_REGISTRATION = "Waiting for the tag to register"
export const WAITING_FOR_BALANCE_MOVE = "Waiting for the balance move"

let ledger: BroadcastLedger | undefined

export function getBroadcastLedger(): BroadcastLedger {
  return (ledger ??= new BroadcastLedger(webStorage))
}

/** Test-only: a fresh ledger over whatever storage the test set up. */
export function resetBroadcastsForTests(): void {
  ledger = undefined
  freshPayloads.clear()
}

/** When the sweep stops accepting the payload: its claim's deadline, or its signed terms' if sooner. */
export function payloadDeadlineMs(payload: RegistrationBroadcastPayload): number {
  const claim = payload.domainAuth.deadline
  const terms = payload.signedTerms.deadline
  return Number(terms > 0n && terms < claim ? terms : claim) * 1000
}

/** Payloads a session just signed, so the first attempt needs no re-sign. Gone on reload. */
export const freshPayloads = new Map<string, RegistrationBroadcastPayload>()

/** The session's payload, kept for when a sheet shows the address and owes its broadcast. */
export function rememberRegistrationPayload(
  sipaAddress: string,
  payload: RegistrationBroadcastPayload,
): void {
  freshPayloads.set(sipaAddress.toLowerCase(), payload)
}

/**
 * Owe a registration's broadcast. `payload` is the session's own, so the first attempt reuses it;
 * `now` drops a backoff, for the user's own retry.
 */
export async function oweRegistrationBroadcast(
  record: Pick<PendingRegistrationRecord, "account" | "sipaAddress">,
  opts: { payload?: RegistrationBroadcastPayload; now?: boolean } = {},
): Promise<void> {
  const address = record.sipaAddress.toLowerCase()
  if (opts.payload) freshPayloads.set(address, opts.payload)
  const ledger = getBroadcastLedger()
  await ledger.enqueue({
    address,
    kind: "registration",
    scope: getActiveStorageId(),
    source: { type: "registration", account: record.account },
  })
  if (opts.now) await ledger.retryNow(address)
}

/**
 * Owe a backup passkey rotation's deposit-address broadcast; the record under `owner` rebuilds it.
 * `republishSince`, for an address paid again: only a landing at or past that block settles the job.
 */
export async function oweRotationBroadcast(
  owner: string,
  sipaAddress: string,
  republishSince?: number,
): Promise<void> {
  await getBroadcastLedger().enqueue({
    address: sipaAddress.toLowerCase(),
    kind: "deposit",
    scope: getActiveStorageId(),
    source: { type: "rotation", owner },
    ...(republishSince === undefined ? {} : { republishSince }),
  })
}

/**
 * Resolves once the address's broadcast landed, through however many failed attempts; rejects once
 * the job is gone without landing.
 */
export async function broadcastLanded(address: string): Promise<void> {
  while (!(await broadcastSettled(address))) {
    if (!getBroadcastLedger().get(address)) throw new Error("the address's broadcast was dropped")
  }
}

/**
 * Resolves true once the address's broadcast landed, false once an attempt at it fails or the job
 * ends without one.
 */
export function broadcastSettled(address: string): Promise<boolean> {
  const ledger = getBroadcastLedger()
  return new Promise((resolve) => {
    let failures: number | undefined
    const check = () => {
      const job = ledger.get(address)
      failures ??= job?.failures ?? 0
      const outcome =
        job?.state === "landed" ? true : !job || job.failures > failures ? false : undefined
      if (outcome === undefined) return
      off()
      resolve(outcome)
    }
    const off = ledger.onListChanged(check)
    void ledger.load().then(check)
  })
}

/**
 * Resolves once no attempt at the address's broadcast is proving or sent: it landed, failed, waits
 * for its turn, or is gone.
 */
export function broadcastAttemptEnded(address: string): Promise<void> {
  const ledger = getBroadcastLedger()
  return new Promise((resolve) => {
    const check = () => {
      const state = ledger.get(address)?.state
      if (state === "proving" || state === "sent") return
      off()
      resolve()
    }
    const off = ledger.onListChanged(check)
    void ledger.load().then(check)
  })
}

/** Runs the ledger while this wallet is up; returns its stop. */
export function startBroadcasts(
  wallet: ObsidionWallet,
  executors: BroadcastSchedulerDeps["executors"],
): () => void {
  const scheduler = new BroadcastScheduler({
    ledger: getBroadcastLedger(),
    operations: getOperationStore(),
    executors,
    txState: (txHash) => broadcastState(wallet, txHash),
    // Checked in the same synchronous block that registers the proof, so a user flow raised
    // during the attempt's reads makes it wait instead of colliding with it. An attempt never waits
    // its turn behind another background proof: it reads as proving, and a user flow may wait on it.
    runExclusive: async (_job, attempt) => {
      if (userFlowActive()) throw new BroadcastDeferred(Date.now(), "Waiting for your transaction")
      if (backgroundProveReserved())
        throw new BroadcastDeferred(Date.now(), "Waiting for another transaction")
      let txHash!: Awaited<ReturnType<typeof attempt>>
      await trackBackgroundProve(async () => {
        txHash = await attempt()
      })
      return txHash
    },
    scope: getActiveStorageId,
    busy: () => userFlowActive() || backgroundProveReserved(),
    describe: (job) =>
      job.kind === "pool"
        ? undefined
        : {
            flow: "deposit",
            summary: job.source.type === "rotation" ? "Backup passkey" : "Deposit address",
            background: true,
          },
  })
  let stopped = false
  let stop: (() => void) | undefined
  const offIdle = onUserFlowsIdle(() => scheduler.kick())
  const offEnded = onBackgroundProvesEnded(() => scheduler.kick())
  void scheduler.recover().then(() => {
    if (!stopped) stop = scheduler.start()
  })
  return () => {
    stopped = true
    offIdle()
    offEnded()
    stop?.()
  }
}
