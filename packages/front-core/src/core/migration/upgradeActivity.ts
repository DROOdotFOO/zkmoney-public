import type { MigrationDirectDeposit, MigrationFundingBatch } from "@obsidion/core/types"
import type { IStorageAdapter } from "../storages/adapter"
import { depositAmounts } from "../services/deposits/depositAmounts"
import {
  directDepositKey,
  isSettledSipaPhase,
  type SIPADepositRecord,
} from "../services/deposits/SIPADepositStore"
import { logger } from "../../utils/logger"

/** One refund batch of an upgrade, as activity shows it. */
export interface UpgradeBatchItem {
  /** The run's record key. */
  run: string
  id: string
  /** Where the batch's arrival is logged: its direct-deposit record key. */
  recipient: string
  /**
   * Set when the migration executor deposits the refund straight into the destination portal:
   * there is no SIPA, and the user pays no tip.
   */
  direct?: MigrationDirectDeposit
  /** The source block its plan was read at: no deposit of it is older. */
  fromBlock?: string
  /** What the source refunds. */
  amount: string
  /** Planned, sent to L2, refunded on L1, or received on the destination. */
  state: "planned" | "sent" | "refunded" | "received"
  /** The user approved its refund. */
  approved: boolean
  tx?: string
  startTime: number
  /** Read off chain by a device that holds none of the run's records (`chainUpgradeBatches`). */
  inferred?: boolean
}

/** A batch has arrived once its deposit is credited; a recovery to Ethereum or a failure is not. */
export function upgradeBatchArrived(arrival?: Pick<SIPADepositRecord, "phase">): boolean {
  return arrival?.phase === "claimed"
}

/**
 * A batch's figure: what it lands, from its deposit once swept, else its amount. The migration
 * executor takes no fee from it.
 */
export function upgradeBatchFigure(
  batch: Pick<UpgradeBatchItem, "amount">,
  arrival?: SIPADepositRecord,
): bigint {
  if (upgradeBatchArrived(arrival) || arrival?.netAmount != null)
    return depositAmounts(arrival!).netAtomic
  return BigInt(batch.amount)
}

/** What a run's batches bring to the balance: one whose deposit settled uncredited brings nothing. */
export function upgradeRunTotal(
  legs: readonly {
    batch: Pick<UpgradeBatchItem, "amount">
    arrival?: SIPADepositRecord
  }[],
): bigint {
  return legs.reduce(
    (sum, { batch, arrival }) =>
      arrival && isSettledSipaPhase(arrival.phase) && !upgradeBatchArrived(arrival)
        ? sum
        : sum + upgradeBatchFigure(batch, arrival),
    0n,
  )
}

const RUNS_KEY = "metadata-migration/runs"

/**
 * The upgrade runs this account started and their refund batches, for activity. The batches are the
 * run's own records, so this reads them and never tracks anything itself; a migration session
 * reports each write through `changed`.
 */
export class UpgradeActivity {
  private static instances = new WeakMap<object, UpgradeActivity>()
  private listeners = new Set<() => void>()
  private cached: UpgradeBatchItem[] = []
  private cachedRecipients: ReadonlySet<string> = new Set()
  private loads = 0
  private read = false
  private registering = Promise.resolve()

  static get(storage: Pick<IStorageAdapter, "getItem" | "setItem">): UpgradeActivity {
    let activity = UpgradeActivity.instances.get(storage)
    if (!activity) UpgradeActivity.instances.set(storage, (activity = new UpgradeActivity(storage)))
    return activity
  }

  private constructor(private readonly storage: Pick<IStorageAdapter, "getItem" | "setItem">) {}

  async runs(storage = this.storage): Promise<string[]> {
    const raw = await storage.getItem(RUNS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  }

  /** Through the writing session's storage, which refuses another account's namespace. */
  async addRun(key: string, storage = this.storage): Promise<void> {
    await this.register(key, storage)
    await this.changed()
  }

  private register(key: string, storage: Pick<IStorageAdapter, "getItem" | "setItem">) {
    const register = this.registering.then(async () => {
      const runs = await this.runs(storage)
      if (!runs.includes(key)) await storage.setItem(RUNS_KEY, JSON.stringify([...runs, key]))
    })
    this.registering = register.catch(() => {})
    return register
  }

  /**
   * `storage` with each of run `key`'s writes reported here. The run is listed before its record is
   * written, or the write fails, so nothing it sends goes unlisted. A failed refresh never fails a
   * write, which a send may be waiting on.
   */
  reporting(
    key: string,
    storage: Pick<IStorageAdapter, "getItem" | "setItem">,
  ): Pick<IStorageAdapter, "getItem" | "setItem"> {
    return {
      getItem: (k) => storage.getItem(k),
      setItem: async (k, value) => {
        if (k === key) await this.register(key, storage)
        await storage.setItem(k, value)
        void this.changed().catch((error) =>
          logger.warn("[upgrade] activity refresh failed:", error),
        )
      },
    }
  }

  /** The last loaded batches, oldest run first. */
  items(): readonly UpgradeBatchItem[] {
    return this.cached
  }

  /** Every deposit address a run's batches pay, lowercase. */
  recipients(): ReadonlySet<string> {
    return this.cachedRecipients
  }

  /** A load has finished, so `items` is what storage held rather than nothing yet. */
  loaded(): boolean {
    return this.read
  }

  /** Reload the batches and tell listeners. Only the latest load publishes. */
  async changed(): Promise<void> {
    const load = ++this.loads
    try {
      const { items, recipients } = await this.load()
      if (load === this.loads) {
        this.cached = items
        this.cachedRecipients = recipients
      }
    } finally {
      if (load === this.loads) {
        this.read = true
        this.listeners.forEach((listener) => listener())
      }
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A refund batch, with its selection. */
  private async batch(
    run: string,
    id: string,
    recipients: Set<string>,
  ): Promise<MigrationFundingBatch | undefined> {
    const raw = await this.storage.getItem(`${run}/source/${id}`)
    const batch = raw ? (JSON.parse(raw) as MigrationFundingBatch) : undefined
    if (batch) recipients.add(batchRecipient(batch).toLowerCase())
    return batch?.sourceSelection ? batch : undefined
  }

  /**
   * Every sent batch the migration executor deposits straight into a portal, with no SIPA. The
   * deposit rail finds each one's deposit by its commitment.
   */
  async directBatches(): Promise<UpgradeBatchItem[]> {
    const { items } = await this.load()
    return items.filter((item) => item.direct && item.state !== "planned")
  }

  private async load(): Promise<{ items: UpgradeBatchItem[]; recipients: Set<string> }> {
    const out: UpgradeBatchItem[] = []
    const recipients = new Set<string>()
    for (const run of await this.runs()) {
      for (let index = 0; ; index++) {
        const id = `remaining-${index}`
        const batch = await this.batch(run, id, recipients)
        if (!batch) break
        if (batch.abandoned) continue
        out.push({
          ...item(run, id, batch),
          state: batch.received
            ? "received"
            : batch.refunded
            ? "refunded"
            : batch.broadcastTx
            ? "sent"
            : "planned",
          approved: !!batch.approved,
          tx: batch.broadcastTx,
        })
      }
    }
    return { items: out, recipients }
  }
}

/** Where a batch's deposit is recorded: its SIPA, or a direct deposit's record key. */
function batchRecipient(batch: MigrationFundingBatch): string {
  return batch.direct ? directDepositKey(batch.direct.recipientCommitment) : batch.recipient
}

function item(run: string, id: string, batch: MigrationFundingBatch) {
  return {
    run,
    id,
    recipient: batchRecipient(batch),
    ...(batch.direct ? { direct: batch.direct } : {}),
    fromBlock: batch.fromBlock,
    amount: batch.amount,
    startTime: batch.sentAt ?? batch.createdAt ?? 0,
  }
}
