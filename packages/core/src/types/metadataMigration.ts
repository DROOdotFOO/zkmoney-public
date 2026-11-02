/**
 * What a frozen source refunds in one batch: the account's notes together, one payment link's notes
 * together, a deposit alone.
 */
export type FrozenRefundKind = "note" | "escrow-note" | "frozen-deposit" | "unprocessed-deposit"

/** A swept deposit's public refund inputs, as found on L1. Strings only; the shared secret salt is never logged. */
export interface FrozenDepositDescriptor {
  /** Fr hex. */
  messageKey: string
  /** Inbox global leaf index, decimal. */
  messageLeafIndex: string
  /** L1 block of the portal `Deposit` event, decimal. */
  l1BlockNumber: string
  /** Fr hex. */
  sharedSecretSalt: string
  /** Credited amount, decimal. */
  amount: string
}

/**
 * A batch that the destination's `MigrationExecutor` deposits straight into the destination portal, with no SIPA.
 * The deposit rail claims it from the portal's `Deposit` events by `recipientCommitment`.
 */
export interface MigrationDirectDeposit {
  /**
   * The `MigrationExecutor` the refund names. Informational: the rail claims by commitment. Absent
   * on a record rebuilt from the deposit's L2 announcement on another device.
   */
  executor?: `0x${string}`
  /** The `MigrationSubsidy` the L1 operation targets. */
  subsidy: `0x${string}`
  /** The coordinates the commitment derives from, as a DepositSIPA's do. */
  day: number
  nonce: number
  /** The deposit commitment on the destination portal, 32-byte hex. */
  recipientCommitment: `0x${string}`
}

/** A broadcast L1 operation as saved, so a re-send gives the relayer the identical operation. */
export interface MigrationSavedOperation {
  target: `0x${string}`
  payoutToken: `0x${string}`
  /** The refund calldata, proof included. */
  calldata: `0x${string}`
  /** `L1OperationCondition`: its kind and, for a balance condition, its token and recipient. */
  condition: { kind: number; token: `0x${string}`; recipient: `0x${string}` }
}

/** Public recovery coordinates. Never contains source keys or a destination message secret. */
export interface MigrationFundingBatch {
  binding: string
  /** The deposit address the refund pays. On a `direct` batch, its `recipientCommitment`. */
  recipient: string
  amount: string
  /** What the source withholds before the recipient: 0, since a frozen batch pays no tip and no fee. */
  exitFee: string
  /** What its deposit pays on the destination, so activity can show what lands. */
  depositFee?: string
  fromBlock: string
  /** When it was planned, and when its carrier was sent: activity orders by them. */
  createdAt?: number
  sentAt?: number
  broadcastTx?: string
  received?: boolean
  /** Its approval was given; a rebuild uses the saved one. */
  approved?: boolean
  /** Its refund executed on L1, whatever its carrier transaction's receipt says. */
  refunded?: boolean
  /** Its selection stopped holding before it was sent; a later plan covers its funds. */
  abandoned?: boolean
  /** Source generation identifiers, never note preimages or keys. */
  sourceSelection?: string[]
  /** Absent on records written before deposit refunds: notes. */
  sourceKind?: FrozenRefundKind
  /** How many times a direct batch's broadcast was sent again, and when last; see `MIGRATION_RESEND_AFTER_MS`. */
  resends?: number
  resentAt?: number
  /**
   * A direct batch's operation as first sent. A re-send broadcasts these bytes, so the relayer
   * sees the same operation id, never a second operation for the same refund.
   */
  operation?: MigrationSavedOperation
  /** The migration executor deposit that carries the batch, with no SIPA. Absent on records saved by older builds. */
  direct?: MigrationDirectDeposit
}

/** A frozen source's batch: it always moves through the migration executor. */
export type FrozenMigrationFundingBatch = MigrationFundingBatch & { direct: MigrationDirectDeposit }
