/**
 * Shared types for the on-device bridge-flow stores.
 *
 * Withdrawal records model an L2→L1 exit the client only *observes*: the burn
 * happens on L2, finalization happens on L1 via oxide's relayer, and the client
 * watches chain state to advance the record. This module hosts the withdrawal
 * record shape plus the small types the activity aggregator uses to unify
 * withdrawals with SIPA deposits at read time.
 */

import type { WithdrawalGroupLeg, WithdrawalPhase } from "@obsidion/core/types"
import type { QueueStatus, SwapEscrowLayout, SwapEscrowOutput } from "@obsidion/sdk"
import type { Address, Hash, Hex } from "viem"
import type { Failure } from "../../../engine/errors"

/**
 * Why a withdrawal terminalized in `failed` phase, on records written by an
 * earlier version of the wallet. Nothing writes this any more — a user could
 * once stop a withdrawal before its burn was signed, and the rows that captured
 * it are still in people's browsers. Readers keep honouring it so those
 * withdrawals stay distinguishable from an ordinary pre-mine failure.
 */
export type WithdrawalCancelReason = "before-signing"

// Defined in the DTO leaf so sdk services share the vocabulary.
export type { WithdrawalGroupLeg, WithdrawalPhase }

/**
 * Whether the destination is a wallet the user previously proved control of by
 * depositing from it, or an L1 address they pasted manually. Drives the
 * activity-thread label precedence and the group provenance.
 */
export type WithdrawalProvenance =
  | "deposit-attested" // Recipient is a linked wallet the user proved control of by depositing from it.
  | "saved-recipient" // Recipient is an L1 address the user entered manually.

/** The oxide deployment a burn targeted. Finalization lives on THIS portal even after the live
 *  deployment rolls, so the tracker reads `$isWithdrawalSpent` here, not on the current tuple. */
export interface WithdrawalDeployment {
  portal: Hex
  l2Token: string
  /** The withdrawal executor the burn pays. A self-finalize releases through it even after the
   *  bridge's executor is replaced. Absent where the record predates it and no migration found it. */
  executor?: Hex
}

/** The record schema {@link WithdrawalStorage} writes: version 2 stamps `deployment.executor`. */
export const WITHDRAWAL_RECORD_VERSION = 2

export interface WithdrawalRecord {
  /**
   * Locally-generated stable ID, assigned when the user taps Confirm, and this
   * store's persistence key. The `wdraw_*` prefix is a debug-readable
   * breadcrumb only — never consulted for routing.
   */
  localId: string

  /**
   * Op-id minted at submit so proving-progress stage events can correlate to
   * this row before the L2 tx hash is known.
   */
  operationId?: string

  /**
   * Pre-mine in-flight status mirrored from proving-progress: SIMULATING →
   * PROVING → MINING. Drives the activity-row in-flight bubble copy. Cleared
   * once the row reaches a terminal phase.
   */
  detailedStatus?: QueueStatus

  /**
   * Why a `phase === "failed"` row terminalized, on rows an earlier version
   * wrote. Nothing sets it now; a pre-mine burn throw leaves it undefined with
   * a `failure`.
   */
  cancelReason?: WithdrawalCancelReason

  /** The {@link WITHDRAWAL_RECORD_VERSION} the record was written or migrated at; absent is 1. */
  version?: number

  /** L2 burn hash, persisted at broadcast when available; receipt recovery may still be pending. */
  l2TxHash?: Hash

  /** L2 block number containing the burn tx. */
  blockNumber?: number

  /** Hash of the L2 block containing the burn tx (reorg anchor, re-writable). */
  blockHash?: string

  /** Network the record was created on: see `OnNetwork`. */
  networkId?: string

  /** Incremented on each reorg demote; stale forward writes carry an older epoch. */
  reorgEpoch?: number

  /**
   * The record failed because its burn read as dropped or reverted. The reorg monitor returns it
   * to tracking if the burn is later seen included.
   */
  droppedBurn?: boolean

  /**
   * When the burn first read as dropped, while it has read dropped on every look since. Persisted
   * so the settle window spans page loads.
   */
  burnDroppedAt?: number

  /**
   * Destination L1 address (checksummed). For a swap-on-withdraw this is where the SWAP OUTPUT
   * lands; the burn itself pays `swapEscrow`.
   */
  recipient: Address

  /** Swap-on-withdraw output asset: DAI on an escrow that only swaps some DAI for gas. Absent on direct
   *  withdrawals, where all `swap*` fields are unset. */
  swapOutput?: SwapEscrowOutput

  /** The counterfactual SwapEscrow the burn pays into — the on-chain release recipient. */
  swapEscrow?: Address

  /**
   * Wallet randomness the escrow address commits to and the recovery salt derives from. Written
   * BEFORE the burn signs, and carried in the burn's recovery memo so a rescan rebuilds it.
   */
  swapNonce?: Hex

  /**
   * `deriveRecoveryCommitment(salt, account)`: the account that may recover the escrow, hidden by a
   * salt. The recovery re-derives both and refuses to sign unless they open this commitment.
   */
  swapRecoveryCommitment?: Hex

  /**
   * The `SwapEscrowFactory` the escrow address was derived from. A redeployed factory moves every
   * CREATE2 address, so a self-run swap or recovery must target this one, not the live tuple's.
   */
  swapEscrowFactory?: Address

  /** DAI tip the escrow pays the relayer that runs the swap (bigint serialized as string). */
  swapRelayerTip?: string

  /**
   * The `Args` layout of `swapEscrowFactory`. Absent on records written before the wallet used the
   * `swapEscrowFactoryV2` factory: those escrows are `legacy`.
   */
  swapEscrowLayout?: SwapEscrowLayout

  /** DAI the escrow swaps to ETH for gas (bigint as string). Absent when it swaps none. */
  swapDaiForGas?: string

  /** The least ETH the gas swap must pay (bigint as string). Absent when it is 0. */
  swapMinEthForGas?: string

  /**
   * The Sky savings move a rebuilt burn funds: what its escrow, `recipient`, commits to, read off
   * the burn's recovery memo. `savingsMoveOfWithdrawal` turns it back into the move.
   */
  skyMove?: {
    direction: "in" | "out"
    factory: Address
    recipientCommitment: Hex
    recoveryCommitment: Hex
    /** DAI tip the escrow pays whoever runs it (bigint serialized as string). */
    relayerTip: string
    nonce: Hex
    /** The L1 block the escrow's deposit is searched from: the head when the burn was built. */
    depositScanFrom?: string
    /** The quote's DAI value of what the move burns; a move out's shares are named by it. Absent on a rebuilt burn. */
    value?: string
  }

  /** L1 tx of the escrow execution that paid the recipient (set at `done` on a swap). */
  swapExecuteTxHash?: Hex

  /** L1 tx of the `recoverERC20` that moved the escrow's DAI to `recoveryTarget`. */
  recoveryTxHash?: Hex

  /** Where a recovery sent the DAI. */
  recoveryTarget?: Address

  /** The prover tip the burn offered (DAI base units as string); the portal deducts it first.
   *  Absent on burns that offered none. */
  proverTip?: string

  /** Submit-time quote for the swap output, atomic units of `swapOutput` (bigint as string). An
   *  estimate, not a fill. Absent when no quote was available. */
  swapEstimatedOut?: string

  /** Decimal exponent for `swapEstimatedOut`. */
  swapOutputDecimals?: number

  /** Submit-time quote for the ETH the gas swap pays, wei (bigint as string). Absent without a gas swap. */
  swapEstimatedGasOut?: string

  /** Optional user-provided label; becomes the linked-wallet display name when set. */
  recipientAlias?: string

  /** The burn spent a paylink escrow (`claim_to_l1`), not the account balance. */
  source?: "paylink"

  /**
   * The burn funded one of this wallet's own SIPAs, not a cash-out: its registration (a ticket
   * signup), its balance on a new deployment (a migration), or the deposit address that runs a
   * backup passkey rotation (backup).
   */
  intent?: "registration" | "migration" | "backup"

  /**
   * A migration's arrival fee (DAI base units as string): the new deployment's deposit fee, taken
   * as the relayer sweeps the release in. With the tips it prices what the new balance receives.
   */
  arrivalFee?: string

  /**
   * 16 random bytes as 0x-hex, shared by the legs of one fresh-address withdrawal. Written before
   * the burn signs.
   */
  groupId?: Hex

  /** Which leg of its group this burn is. Set with `groupId`. */
  groupLeg?: WithdrawalGroupLeg

  /**
   * Recreated from the burn's recovery events by a rescan (`rebuildWithdrawals`), not written at
   * Confirm: no submit-time quote, and `startTime` is the burn's block time.
   */
  rebuilt?: boolean
  /** `startTime` is the rebuild's clock, not the burn's block time; no deposit search may start from it. */
  startTimeEstimated?: boolean

  /** Whether this recipient is a previously-deposited-from wallet or a user-pasted one. */
  recipientProvenance: WithdrawalProvenance

  /** Hash of the link's secret, used to match a reopened link without storing it. */
  paylinkId?: string

  /** Decimal token-unit amount string (e.g. "12.5"). */
  amount: string

  /**
   * Raw on-chain amount (bigint serialized as string) emitted by the L2 burn —
   * the gross, before the portal deducts the tips. Set at
   * `l2_mined` alongside `l2TxHash`/`blockNumber`.
   */
  rawAmount?: string

  /**
   * Relayer tip the burn's user payload offered, raw token units. The plain withdrawal executor
   * pays it out of what the portal releases after the prover tip. Stamped with
   * the rest of the mined burn data. Absent where the writer did not record it, which leaves the
   * amount breakdown unrenderable rather than guessed.
   */
  relayerTip?: string

  /**
   * The fee the burn's executor (`deployment.executor`) takes (raw token units), ahead of the relayer
   * tip. Absent for an executor that takes none.
   */
  withdrawalFee?: string

  /** Token ticker for display. */
  tokenSymbol: string
  /** Decimals of the burned token; every amount on the record is in its units. */
  tokenDecimals: number

  /**
   * Finalization key: `sha256(burnTxHash ‖ withdrawMessageHash)` (a 0x-hex
   * bytes32). Binds the authoritative `$isWithdrawalSpent(withdrawalId)` poll
   * to this exact record. Derived lazily by the tracker once the burn's tx
   * effect is indexed on L2 — absent on a freshly-mined record.
   */
  withdrawalId?: Hex

  /** L1 tx hash of the release (set best-effort at `done`; omitted when ambiguous). */
  l1TxHash?: Hex

  /** What `l1TxHash` transferred to `recipient`, raw token units: the amount that arrived. */
  receivedAmount?: string

  /**
   * L1 tx hash of a self-finalize the user submitted themselves. The "already submitted" marker
   * that withdraws the manual-finalize affordance; the tracker's own `isSpent` pass is still what
   * moves the record to `done`.
   */
  finalizeTxHash?: Hex

  /** Stamped at create. Unset only on records written before deployments could roll. */
  deployment?: WithdrawalDeployment

  /** Current phase (see WithdrawalPhase). */
  phase: WithdrawalPhase

  /** Why it failed, when phase === "failed". */
  failure?: Failure

  /** ms epoch when the user tapped Confirm. */
  startTime: number

  /** ms epoch when the record reached a terminal phase (`done`, `recovered` or `failed`). */
  endTime?: number

  /**
   * ms epoch when the record last entered its current post-mine phase
   * (`l2_mined`/`awaiting_proven`/`finalizing_l1`/`swapping`). The non-terminal `delayed`
   * presentation is DERIVED from this + a threshold, so a stall in any
   * post-mine phase surfaces as "taking longer than usual" rather than a false
   * failure. Unset pre-mine.
   */
  phaseEnteredAt?: number

  /** ms epoch when the burn was first seen mined: when its shares left the balance. A rebuilt burn's `startTime` is its block's time. */
  minedAt?: number

  /**
   * Provider slug for the destination linked wallet (e.g. "rainbow",
   * "metamask"). Scopes counterparty identity as
   * `wallet:<provider>:<addressLower>`. Withdrawals to user-pasted addresses
   * write "unknown"; read sites default to "unknown" for legacy records.
   */
  walletProvider?: string
}

/** Phases that stop watching and stamp `endTime`. */
export const WITHDRAWAL_TERMINAL_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "done",
  "recovered",
  "failed",
])
