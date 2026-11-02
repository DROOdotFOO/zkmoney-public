/**
 * SIPADepositStore — storage for oxide SIPA deposit tracking, the only
 * deposit store since the legacy stealth stack was removed.
 *
 * Records are keyed by the counterfactual SIPA address. In the primary
 * third-party flow the record is created at `broadcast` — SIPA event discovery is
 * the recipient's first observable signal (`resolved`/`funded` are reachable
 * only in the self-initiated flow where this device is also the sender; the
 * receive screen is a passive share surface, not a phase renderer).
 *
 * Singleton + IStorageAdapter pattern over the RecordStorage kernel.
 */

import type { SIPADepositPhase } from "@obsidion/core/types"
import type { IStorageAdapter } from "../../storages/adapter"
import { getAddress, keccak256, type Address, type Hash, type Hex } from "viem"
import { RecordStorage } from "../bridge/RecordStorage"
import { notElsewhere, type OnNetwork } from "../../../types/networkStamp"

// Defined in the DTO leaf so sdk services share the vocabulary.
export type { SIPADepositPhase }

export type SipaOrigin = {
  sipaFactory: Address
  implementation: Address
  intentHash: Hex
  rollupVersion: string
  resweepable: boolean
} & (
  | { protocol: "legacy-eoa"; recoveryAddress: Address }
  | {
      protocol: "account"
      recoveryAccount: Address
      recoveryCommitment: Hex
      accountFactory: Address
      /** The ForwardingTable the address commits to; its rows route each sweep. */
      forwardingTable: Address
    }
)

/**
 * One claimed sweep of a SIPA. The record's amount fields describe the latest; the ledger keeps
 * every one, since a re-used address is swept again and the export reports each.
 */
export interface SIPASweep {
  inboxIndex: string
  sweepTxHash: Hash
  /** ms epoch of the sweep's L1 block. */
  settledAt?: number
  /** The portal of the row the sweep settled on, and that row's L2 token, where it is claimed. */
  portal?: Address
  l2Token?: string
  /** The row's token: what the sweep credited, and the units of `netAmount` and `fee`. */
  tokenAddress?: Address
  tokenSymbol?: string
  tokenDecimals?: number
  /** The row's sweep fee, raw units of the credited token. */
  fee?: string
  /** Credited on L2, raw units of the credited token. */
  netAmount: string
  /** The L1→L2 message the sweep sent, when the entry carries it. */
  messageKey?: Hex
  /**
   * What the sweep took out of the SIPA, raw units of `fundingTokenDecimals`: every funding
   * transfer it settled. Unset when the sweep tx moved more than one token out.
   */
  grossAmount?: string
  fundingTokenSymbol?: string
  fundingTokenDecimals?: number
}

/** A sweep seen on L1 and not yet claimed: its claim inputs, kept so a later pass claims it without
 *  reading L1 again. Decimal strings for the bigints. */
export interface SIPAPendingSweep {
  inboxIndex: string
  amount: string
  messageKey: Hex
  blockNumber: string
  sweepTxHash: Hash
  /** The portal whose `Deposit` the sweep made, which names its row. Absent on a sweep saved before rows. */
  portal?: Address
  /** What the sweep took out of the SIPA and in which token, once the window it was seen in is gone. */
  grossAmount?: string
  fundingToken?: Address
}

/**
 * One portal deposit the rail tracks: a SIPA's sweep, or a direct (migration) deposit that no SIPA made.
 * TODO: Rename to PortalDepositRecord, as this type is used for more than just SIPA deposits.
 */
export interface SIPADepositRecord {
  /** Counterfactual SIPA address (canonical key, lowercased on store). */
  sipaAddress: Address
  /** The {@link SIPA_DEPOSIT_RECORD_VERSION} the record was written or migrated at; absent is 1. */
  version?: number
  /** The recipient's L2 account — the feed's group identity for SIPA deposits. */
  recipientL2Address: string
  /**
   * The SIPA event's `shared_secret_salt` (Fr hex). Everything else re-derives from it;
   * persisting it lets a claim resume across restarts. Device-local like the
   * rest of the store; it is half the recovery key (the other half is the
   * user's stealth scalar, which is never persisted).
   */
  messageSecret: string
  /** Derived recipient hash (Fr hex) the SIPA is bound to. */
  recipientHash: string
  /** Derived recovery address (the recoverERC20 signer identity). */
  recoveryAddress: string
  origin?: SipaOrigin
  /** L1 chain the SIPA lives on. */
  l1ChainId: number
  /** L2 network the record was created on: see `OnNetwork`. */
  networkId?: string
  /** Decimal display amount (gross before the sweep, net once known). */
  amount: string
  /** Token ticker for display. */
  tokenSymbol: string
  /** Current phase. */
  phase: SIPADepositPhase
  /** ms epoch of the L1 funding transfer's block; the record's creation until that is read. */
  startTime: number
  /**
   * Created from a discovered SIPA event with no local record: history replayed onto this device rather
   * than an address it handed out. Such a record gets no fresh-broadcast scan window.
   */
  replayed?: boolean
  /** ms epoch when the record reached a terminal phase. */
  endTime?: number
  /** Incremented on each reorg demote; stale forward writes carry an older epoch. */
  reorgEpoch?: number
  /** The resolved name (self-initiated flow), e.g. "alice.oxidestaging.eth". */
  resolvedName?: string
  /**
   * Set when the SIPA is not a plain deposit — the intent its address commits to. `user-op` is a
   * backup passkey rotation's funding, paid to the SIPA that runs the account's user operation.
   */
  intent?: "registration" | "user-op"
  /**
   * Set when no SIPA exists: an upgrade's migration executor deposited straight into the portal under
   * `recipientCommitment`. The record's key is then {@link directDepositKey}, not an L1 address.
   * `expected` is the batch's amount in raw units, when this device sent the batch. The commitment
   * is public, so another sender can deposit under it too: the rail observes the record until it
   * has claimed `expected` in total, and observes a record with no `expected` always. `portal` is
   * the destination portal, from the row of the token that announced the deposit.
   */
  direct?: { recipientCommitment: Hex; executor?: Address; expected?: string; portal?: Address }
  /** L1 token address of the funding transfer. */
  tokenAddress?: Address
  /**
   * The row token unswept funds settle in, when `tokenAddress` is a token the SIPA swaps into it
   * (the mainnet USDC and USDT, into DAI).
   */
  rowToken?: Address
  /** Decimals of `tokenAddress` (6 for the mainnet USDC/USDT swap route, else 18). */
  tokenDecimals?: number
  /** Sweep log values — the claim inputs. Strings for JSON-safe bigints. */
  inboxIndex?: string
  /**
   * Inbox indexes already claimed off this SIPA. A SIPA paid again is swept again once it is
   * published again, and each sweep claims independently — this is its dedup.
   */
  claimedInboxIndexes?: string[]
  /** Every claimed sweep, in inbox order. */
  sweeps?: SIPASweep[]
  /** Net amount forwarded to the portal (gross − fee), raw token units. */
  netAmount?: string
  /** Deductions between the gross and L2 credit, raw token units. */
  fee?: string
  /** Registration fee paid to the beneficiary, raw token units. */
  registrationFee?: string
  /** L1 deploy-and-sweep tx hash. */
  sweepTxHash?: Hash
  /** L2 claim (store_deposit consumer) tx hash, once one exists. */
  claimTxHash?: string
  /** L1 recoverERC20/recoverETH tx hash. */
  recoveryTxHash?: Hash
  /** Error message when phase === "failed". */
  error?: string
  /**
   * The head (decimal string) of the pass that first read this SIPA's whole history. From then on
   * it rides the deployment's cursor.
   */
  observedFrom?: string
  /** A block (decimal string) a failed pass left this SIPA to re-read from. */
  rescanFrom?: string
  /**
   * The sweep whose claim landed and when, ms epoch. Set before the record reads `claimed`. A balance
   * read resolved after it holds the deposit.
   */
  claimLanded?: { inboxIndex: string; at: number }
  /** Sweeps seen and not yet claimed, in inbox order. */
  pendingSweeps?: SIPAPendingSweep[]
  /** ms epoch the rail last asked for this funded, overdue SIPA to be published again. */
  republishAskedAt?: number
  /**
   * The largest balance the rail last observed at the SIPA across its accepted tokens, raw units of
   * the fee token. What the registration tick reads as funded.
   */
  heldBalance?: string
  /**
   * On-chain funding attribution, read from the token's `Transfer(to = sipa)`. The self-initiated
   * flow also stamps `fundingTxHash` from its own receipt, which lands first; the sender address is
   * only ever the log's.
   */
  fundingTxHash?: Hash
  fundingFromAddress?: Address
  /**
   * Ticker of the token the sweep takes: what the funder sent, or the balance the sweep picks
   * when several accepted tokens were sent. `tokenSymbol` is the credited token once swept.
   */
  fundingTokenSymbol?: string
  /**
   * Sender-wallet display identity: the connected wallet on self-initiated
   * deposits, backfilled from `fundingFromAddress` on third-party ones once
   * the funding transfer is observed.
   */
  walletName?: string
  walletAddress?: string
  walletProvider?: string
  walletImageUrl?: string
}

export const KEY_SIPA_DEPOSITS = "@obsidion/sipa-deposits/records"
const KEY_OBSERVED_THROUGH = "@obsidion/sipa-deposits/observed-through/"

const cursorKey = (portal: Address, recipient: string) =>
  `${KEY_OBSERVED_THROUGH}${portal.toLowerCase()}/${recipient.toLowerCase()}`

/** The record schema {@link SIPADepositStore} writes: version 2 stamps each sweep with the row it settled on. */
export const SIPA_DEPOSIT_RECORD_VERSION = 2

/** The bridge every version 1 sweep was claimed through: one portal, its L2 token and its token. */
export interface SipaSweepRow {
  portal: Address
  l2Token: string
  token: { address: Address; symbol: string; decimals: number }
}

type UpdatedListener = (record: SIPADepositRecord) => void
type ListChangedListener = (records: SIPADepositRecord[]) => void

/**
 * Phases with nothing left to observe: the deposit is credited (`claimed`),
 * abandoned (`failed`), or pulled back out on L1 (`recovered`). Stamps
 * `endTime`, and tells the sync loop this SIPA needs no per-tick log scan.
 */
const SETTLED_PHASES: ReadonlySet<SIPADepositPhase> = new Set(["claimed", "failed", "recovered"])

export function isSettledSipaPhase(phase: SIPADepositPhase): boolean {
  return SETTLED_PHASES.has(phase)
}

/** Whether the rail has claimed every sweep it saw at the address, and at least one. */
export function sipaSweepsReceived(record: SIPADepositRecord | null | undefined): boolean {
  return (
    record?.phase === "claimed" &&
    !!record.claimedInboxIndexes?.length &&
    !record.pendingSweeps?.length
  )
}

/**
 * The key of a direct deposit's record: an address-shaped value from its commitment. It holds
 * nothing on L1, and no SIPA has it.
 */
export function directDepositKey(recipientCommitment: Hex): Address {
  return getAddress(`0x${keccak256(recipientCommitment.toLowerCase() as Hex).slice(-40)}`)
}

/** The total of the sweeps the rail has claimed off `record`, raw units of their tokens. */
export function claimedSweepsTotal(record: SIPADepositRecord | null | undefined): bigint {
  const claimed = new Set(record?.claimedInboxIndexes ?? [])
  return (record?.sweeps ?? [])
    .filter((sweep) => claimed.has(sweep.inboxIndex))
    .reduce((sum, sweep) => sum + BigInt(sweep.netAmount), 0n)
}

/**
 * Whether nothing more is expected under a direct deposit's commitment: the rail has claimed
 * every deposit it saw, and in total at least the batch's `expected` amount. A record with no
 * `expected` never settles, since a deposit from another sender can come first.
 */
export function directDepositSettled(record: SIPADepositRecord | null | undefined): boolean {
  const expected = record?.direct?.expected
  return (
    expected !== undefined &&
    sipaSweepsReceived(record) &&
    claimedSweepsTotal(record) >= BigInt(expected)
  )
}

/**
 * The total the rail has claimed from the direct deposits to `recipientCommitment`, raw units. A
 * deposit it saw and has not claimed yet does not count.
 */
export async function directDepositClaimed(
  store: Pick<SIPADepositStore, "load" | "get">,
  recipientCommitment: Hex,
): Promise<bigint> {
  await store.load()
  return claimedSweepsTotal(store.get(directDepositKey(recipientCommitment)))
}

/**
 * A deposit address that was derived and broadcast but never paid. Opening Add funds publishes one
 * whether or not the visitor goes on to send anything, and discovery records it at `amount: "0"` —
 * publishing an address is not an incoming payment, so it must neither sit in the feed as "Pending"
 * nor spin under the bell. Any evidence that funds arrived (a nonzero amount, a sweep, an
 * advanced phase) shows the row.
 */
export function isUnfundedSipaDeposit(record: SIPADepositRecord): boolean {
  return (
    (record.phase === "broadcast" || record.phase === "resolved") &&
    Number(record.amount) === 0 &&
    !record.sweepTxHash &&
    !record.inboxIndex
  )
}

/**
 * A SIPA the account pays itself, not a deposit from someone else: a backup passkey rotation's
 * funding. The wallet reports it as the account's own move.
 */
export function isAccountMoveSipa(record: Pick<SIPADepositRecord, "intent">): boolean {
  return record.intent === "user-op"
}

type SIPADepositPatch = Partial<SIPADepositRecord> & Pick<SIPADepositRecord, "phase">

/** A new record's fields but its key and phase. */
export type SIPADepositFields = OnNetwork<Omit<SIPADepositRecord, "sipaAddress" | "phase">>

function needsSweepRows(record: SIPADepositRecord, networkId: string): boolean {
  return (record.version ?? 1) < SIPA_DEPOSIT_RECORD_VERSION && notElsewhere(record, networkId)
}

function withSweepRows(record: SIPADepositRecord, pinned: SipaSweepRow): SIPADepositRecord {
  const row = {
    portal: pinned.portal,
    l2Token: pinned.l2Token,
    tokenAddress: pinned.token.address,
    tokenSymbol: pinned.token.symbol,
    tokenDecimals: pinned.token.decimals,
  }
  // The record's fee is its latest sweep's; no older sweep's fee is known.
  const feeOf = (sweep: SIPASweep) =>
    record.fee !== undefined && sweep.inboxIndex === record.inboxIndex ? { fee: record.fee } : {}
  return {
    ...record,
    version: SIPA_DEPOSIT_RECORD_VERSION,
    ...(record.sweeps
      ? { sweeps: record.sweeps.map((sweep) => ({ ...row, ...feeOf(sweep), ...sweep })) }
      : {}),
  }
}

/** The record a patch leaves, or null when the reorg-epoch guard refuses it. */
function merge(
  sipaAddress: Address,
  existing: SIPADepositRecord | null,
  patch: SIPADepositPatch,
  fallback?: SIPADepositFields,
): SIPADepositRecord | null {
  let next: SIPADepositRecord
  if (existing) {
    // Reorg-epoch guard: a demoted record (epoch > 0) ignores forward writes
    // that don't carry the matching epoch.
    const epoch = existing.reorgEpoch ?? 0
    if (epoch > 0 && (patch.reorgEpoch ?? 0) !== epoch) return null
    next = { ...existing, ...patch, sipaAddress }
  } else {
    if (!fallback) {
      throw new Error(
        `SIPADepositStore.upsert: no existing record for ${sipaAddress} and no fallback supplied`,
      )
    }
    next = { ...fallback, ...patch, sipaAddress, networkId: fallback.networkId.toLowerCase() }
    next.version ??= SIPA_DEPOSIT_RECORD_VERSION
  }

  if (SETTLED_PHASES.has(next.phase) && !next.endTime) {
    next.endTime = Date.now()
  }
  return next
}

export class SIPADepositStore {
  private static instance: SIPADepositStore | null = null
  private store: RecordStorage<SIPADepositRecord>

  private constructor(private readonly storage: IStorageAdapter) {
    this.store = new RecordStorage<SIPADepositRecord>({
      storage,
      storageKey: KEY_SIPA_DEPOSITS,
      keyOf: (r) => r.sipaAddress.toLowerCase(),
      sortBy: (r) => r.startTime,
      label: "SIPADepositStore",
    })
  }

  static get(storage?: IStorageAdapter): SIPADepositStore {
    if (!SIPADepositStore.instance) {
      if (!storage) {
        throw new Error("First call to SIPADepositStore.get() requires a storage adapter")
      }
      SIPADepositStore.instance = new SIPADepositStore(storage)
    }
    return SIPADepositStore.instance
  }

  async load(): Promise<void> {
    return this.store.load()
  }

  get(sipaAddress: Address): SIPADepositRecord | null {
    return this.store.getByKey(sipaAddress.toLowerCase())
  }

  list(): SIPADepositRecord[] {
    return this.store.list()
  }

  /**
   * Insert or merge a record. Partial updates are shallow-merged onto the
   * existing record; sets endTime automatically when transitioning into a
   * terminal phase.
   */
  async upsert(
    sipaAddress: Address,
    patch: SIPADepositPatch,
    fallback?: SIPADepositFields,
    opts?: { strict?: boolean },
  ): Promise<SIPADepositRecord> {
    const stored = await this.store.updateRecord(
      sipaAddress.toLowerCase(),
      (existing) => merge(sipaAddress, existing, patch, fallback),
      opts,
    )
    return stored as SIPADepositRecord
  }

  /**
   * Writes `record` unless one is already stored at `sipaAddress`; resolves to it, or null if not.
   * `strict` rejects when the write does not reach storage.
   */
  async create(
    sipaAddress: Address,
    record: SIPADepositFields & Pick<SIPADepositRecord, "phase">,
    opts?: { strict?: boolean },
  ): Promise<SIPADepositRecord | null> {
    let created: SIPADepositRecord | null = null
    await this.store.updateRecord(
      sipaAddress.toLowerCase(),
      (existing) =>
        existing ? null : (created = merge(sipaAddress, null, { phase: record.phase }, record)),
      opts,
    )
    return created
  }

  /**
   * Merge a patch worked out from the record as it stands at the write, so a check on the record
   * and the write it decides cannot straddle another writer. `patch` returns null to write nothing;
   * a missing record is left missing.
   */
  async update(
    sipaAddress: Address,
    patch: (current: SIPADepositRecord) => SIPADepositPatch | null,
  ): Promise<SIPADepositRecord | null> {
    return this.store.updateRecord(sipaAddress.toLowerCase(), (existing) => {
      const next = existing && patch(existing)
      return next ? merge(existing.sipaAddress, existing, next) : null
    })
  }

  /**
   * Reorg demote. Only `claimed` is demotable — it is the sole phase advanced
   * by an L2 tx (the store_unclaimed_deposit claim); every other phase is
   * L1-derived (funding/funded/sweeping/pendingClaim/recoverable/recovered) or
   * has no upstream (broadcast) and refuses (returned unchanged). Clears
   * `endTime`, bumps `reorgEpoch`, keeps `claimTxHash` as the re-check anchor.
   * Returns null when no record exists.
   */
  async demote(sipaAddress: Address, toPhase: SIPADepositPhase): Promise<SIPADepositRecord | null> {
    return this.store.updateRecord(sipaAddress.toLowerCase(), (existing) => {
      if (!existing || existing.phase !== "claimed" || SETTLED_PHASES.has(toPhase)) return null
      return {
        ...existing,
        phase: toPhase,
        endTime: undefined,
        reorgEpoch: (existing.reorgEpoch ?? 0) + 1,
        // The reorged-out claim is the record's latest (`inboxIndex`); drop it from the dedup set
        // and the ledger so the next scan re-attempts the claim.
        claimedInboxIndexes: existing.claimedInboxIndexes?.filter((i) => i !== existing.inboxIndex),
        sweeps: existing.sweeps?.filter((s) => s.inboxIndex !== existing.inboxIndex),
        // The sweep sits behind the deployment cursor, so the record reads its history again.
        observedFrom: undefined,
        rescanFrom: undefined,
      }
    })
  }

  /**
   * Migrate records written before {@link SIPA_DEPOSIT_RECORD_VERSION} 2. A version 1 record of
   * `networkId` was claimed through one bridge, `pinned`, so each sweep with no row of its own is
   * stamped with that row. The record's own fields already name what it holds. Records of another
   * network stay at version 1. Returns the records migrated.
   */
  async migrateSweepRows(networkId: string, pinned: SipaSweepRow): Promise<SIPADepositRecord[]> {
    await this.load()
    const migrated: SIPADepositRecord[] = []
    for (const record of this.store.list()) {
      if (!needsSweepRows(record, networkId)) continue
      const written = await this.store.updateRecord(record.sipaAddress.toLowerCase(), (current) =>
        current && needsSweepRows(current, networkId) ? withSweepRows(current, pinned) : null,
      )
      if (written) migrated.push(written)
    }
    return migrated
  }

  async remove(sipaAddress: Address): Promise<void> {
    await this.store.removeByKey(sipaAddress.toLowerCase())
  }

  async clearAll(): Promise<void> {
    await this.store.clearAll()
  }

  /**
   * The block through which every observed SIPA of `recipient` at the deployment at `portal` has
   * been read. One cursor per account: a pass reads only its own recipient's SIPAs.
   */
  async observedThrough(portal: Address, recipient: string): Promise<bigint | undefined> {
    const stored = await this.storage.getItem(cursorKey(portal, recipient))
    return stored ? BigInt(stored) : undefined
  }

  async setObservedThrough(portal: Address, recipient: string, block: bigint): Promise<void> {
    await this.storage.setItem(cursorKey(portal, recipient), block.toString())
  }

  /**
   * Moves a portal-wide cursor (one keyed by no account) to `recipient` and deletes it. Call it for
   * the one account whose passes wrote it; `recipient` keeps its own cursor when it has one, and
   * any other account starts from its history.
   */
  async adoptObservedThrough(portal: Address, recipient: string): Promise<void> {
    const legacyKey = KEY_OBSERVED_THROUGH + portal.toLowerCase()
    const legacy = await this.storage.getItem(legacyKey)
    if (legacy === null) return
    if ((await this.storage.getItem(cursorKey(portal, recipient))) === null)
      await this.storage.setItem(cursorKey(portal, recipient), legacy)
    await this.storage.removeItem(legacyKey)
  }

  onUpdated(listener: UpdatedListener): () => void {
    return this.store.onUpdated(listener)
  }

  onListChanged(listener: ListChangedListener): () => void {
    return this.store.onListChanged(listener)
  }
}
