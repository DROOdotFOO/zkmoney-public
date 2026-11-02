import type { Hex } from "viem"
import { RecordStorage } from "../services/bridge/RecordStorage.js"
import { PREVIOUS_ACCOUNT_WATCH_STORAGE_KEY } from "./storage-constants.js"
import type { IStorageAdapter } from "./adapter.js"

/** The move chunk in flight from the previous account, saved before its transfer leaves. */
export interface PreviousAccountMove {
  source: string
  destination: string
  txHash: Hex
  /** Capped when saved; never recomputed. */
  expiresAtMs: number
  /** Atomic units, decimal. */
  amount: string
}

/**
 * The watch over the one-key account a rotated wallet left: open until `watchUntilMs` and past it
 * until a check proves the account empty. `closedAtMs` dates the close and `lastCheckAtMs` a closed
 * watch's last daily check.
 */
export interface PreviousAccountWatch {
  /** The one-key account's L2 address; the record key. */
  address: string
  watchUntilMs: number
  closed?: true
  closedAtMs?: number
  lastCheckAtMs?: number
  move?: PreviousAccountMove
}

const isStr = (v: unknown): v is string => typeof v === "string"
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

function isMove(v: unknown): v is PreviousAccountMove {
  return (
    isObj(v) &&
    isStr(v.source) &&
    isStr(v.destination) &&
    isStr(v.txHash) &&
    /^0x[0-9a-fA-F]{64}$/.test(v.txHash) &&
    isNum(v.expiresAtMs) &&
    isStr(v.amount) &&
    /^\d+$/.test(v.amount)
  )
}

function isWatch(v: unknown, key: string): v is PreviousAccountWatch {
  return (
    isObj(v) &&
    isStr(v.address) &&
    v.address.toLowerCase() === key &&
    isNum(v.watchUntilMs) &&
    (v.closed === undefined || v.closed === true) &&
    (v.closedAtMs === undefined || isNum(v.closedAtMs)) &&
    (v.lastCheckAtMs === undefined || isNum(v.lastCheckAtMs)) &&
    (v.move === undefined || isMove(v.move))
  )
}

/** The saved watches could not be read; nothing is written over them until a read lands. */
export class PreviousAccountWatchUnreadableError extends Error {
  constructor() {
    super("previous account watch: saved records unreadable")
    this.name = "PreviousAccountWatchUnreadableError"
  }
}

/**
 * One watch per previous account. A write storage refuses rejects, and storage that cannot be read
 * never passes for empty, so no write over a failed load drops the chunk in flight.
 */
export class PreviousAccountWatchStore {
  private static instance: PreviousAccountWatchStore | null = null
  private readonly store: RecordStorage<PreviousAccountWatch>

  private constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<PreviousAccountWatch>({
      storage,
      storageKey: PREVIOUS_ACCOUNT_WATCH_STORAGE_KEY,
      keyOf: (record) => record.address.toLowerCase(),
      label: "PreviousAccountWatchStore",
      strict: true,
      retryLoadOnReadError: true,
      normalize: (record, key) => {
        if (!isWatch(record, key)) throw new Error("not a watch record")
        return record
      },
    })
  }

  static get(storage?: IStorageAdapter): PreviousAccountWatchStore {
    if (!PreviousAccountWatchStore.instance) {
      if (!storage) {
        throw new Error("First call to PreviousAccountWatchStore.get requires a storage adapter")
      }
      PreviousAccountWatchStore.instance = new PreviousAccountWatchStore(storage)
    }
    return PreviousAccountWatchStore.instance
  }

  /** Test seam — drops the singleton. Production code never calls this. */
  static resetForTests(): void {
    PreviousAccountWatchStore.instance = null
  }

  private async ready(): Promise<void> {
    await this.store.load()
    if (!this.store.isLoaded()) throw new PreviousAccountWatchUnreadableError()
  }

  async get(address: string): Promise<PreviousAccountWatch | null> {
    await this.ready()
    return this.store.getByKey(address.toLowerCase())
  }

  /**
   * Read-modify-write under the address in one step. `change` returns null to leave the record as
   * it is. Resolves to what the store holds afterwards.
   */
  async update(
    address: string,
    change: (current: PreviousAccountWatch | null) => PreviousAccountWatch | null,
  ): Promise<PreviousAccountWatch | null> {
    await this.ready()
    return this.store.updateRecord(address.toLowerCase(), change)
  }
}
