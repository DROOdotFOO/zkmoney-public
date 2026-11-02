/**
 * Gas model for ClaimFPC's per-call policy entries.
 *
 * The kernel meters a transaction on what it emits: nullifiers, note hashes, private-log fields and
 * L2->L1 messages. This file lists what each sponsorable call emits and prices it with the kernel's
 * constants, so a per-call entry's `max_fee` is a worst-case shape, not a measured sample plus a
 * fudge factor. The deploy prices these shapes into the entries (backend claimFpcConfig.ts) and the
 * wallet declares the same shapes as a batch's gas limits (`claimFpcBatchGas`); the FPC compares
 * declared limits against the entries, so both sides have to agree.
 *
 * Three words used throughout:
 *   - side effects: what a call emits, as the kernel counts it (`SideEffects`).
 *   - marginal: the gas one batched call adds on top of the entrypoint overhead the FPC charges
 *     anyway (`CLAIM_FPC_OVERHEAD_GAS`, the "base").
 *   - AVM execution gas: when a tx enqueues public calls, the whole tx is metered at the AVM's
 *     rates and the public call's own execution costs gas too. That last part cannot be derived
 *     from counts, so it is read off a measured tx and carried as a constant.
 *
 * The FPC budgets a batch as the base plus one entry per call, so every entry has to hold whatever
 * else rides the batch. Once any call enqueues a public call the whole tx pays AVM rates, and each
 * AVM rate is at least its private one. So every entry prices its own call's side effects at AVM
 * rates, and a call that enqueues public calls also carries the public surcharge (see
 * `publicCallSurcharge`). publish_da runs once per batch, so its capsule ceiling is its own entry.
 * Two public-call entries in one batch both carry the surcharge's per-tx part; nothing else is
 * counted twice.
 *
 * Shapes fall in three groups:
 *   - Fixed private shapes (authorize_intents, the registration gate, gift_voucher, the SIPA
 *     notify, the link announce): the side-effect model must equal the measured table to the gas.
 *   - Spends (transfer, withdraw, paylink deposit): the oxide token spends notes through a recursion
 *     ladder, so these are budgeted at the ladder's sponsored maximum.
 *   - Public calls (L1-operation broadcasts, the email paylink's registry view): their execution gas
 *     is read off a measured tx.
 */
import {
  AVM_EMITNOTEHASH_BASE_L2_GAS,
  AVM_EMITNULLIFIER_BASE_L2_GAS,
  AVM_SENDL2TOL1MSG_BASE_L2_GAS,
  DA_GAS_PER_FIELD,
  FIXED_AVM_STARTUP_L2_GAS,
  L2_GAS_PER_L2_TO_L1_MSG,
  L2_GAS_PER_NOTE_HASH,
  L2_GAS_PER_NULLIFIER,
  L2_GAS_PER_PRIVATE_LOG,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  PRIVATE_LOG_CIPHERTEXT_LEN,
  PUBLIC_TX_L2_GAS_OVERHEAD,
} from "@aztec-labs/constants"
import { computePublishDaLogEmittedLengths } from "../../../oxide/token/publishDaLogs.js"
import { SUBSCRIPTION_NOTE_LOG_EMITTED_LENGTH } from "./claimFpcOverhead.js"
import type { ClaimFpcMeasuredTx } from "./claimFpcGasTable.js"

/** What a call (or a whole tx) emits. Log entries are their emitted lengths in fields. */
export interface SideEffects {
  nullifiers: number
  noteHashes: number
  privateLogEmittedLengths: number[]
  l2ToL1Msgs: number
}

/** Every MessageDelivery.onchain_* note-delivery and event log is 16 fields. */
const DELIVERY_LOG_LENGTH = SUBSCRIPTION_NOTE_LOG_EMITTED_LENGTH
/** The recovery chunk events a wallet withdrawal emits: one, plus one for an escrow's memo
 * (`withdrawalMemo.ts`). */
const WITHDRAWAL_RECOVERY_CHUNKS = 2
/** TEEMetadata: 4 pubkey limbs, the anchor block hash and the signer's registration leaf index. */
export const TEE_METADATA_FIELDS = 6

/**
 * How many notes and deposits the oxide token spends per call, from the vendored contract
 * (vendor/oxide/noir-projects/oxide_token_contract/src/main.nr:67-70). A test greps that source, so
 * a pin bump that moves these fails loudly.
 */
export const SPEND_LADDER = {
  initialNotes: 2,
  recursiveNotes: 8,
  initialDeposits: 2,
  recursiveDeposits: 8,
}
/**
 * How many maxed-out recursive spend calls a sponsored tx is budgeted for, after the initial call.
 * With 2, one tx covers 18 input notes and 18 consumed deposits; a more fragmented wallet
 * consolidates first (a self-transfer is itself sponsorable).
 */
export const SPONSORED_SPEND_RECURSIONS = 2

const ladderNotes = () =>
  SPEND_LADDER.initialNotes + SPONSORED_SPEND_RECURSIONS * SPEND_LADDER.recursiveNotes
const ladderDeposits = () =>
  SPEND_LADDER.initialDeposits + SPONSORED_SPEND_RECURSIONS * SPEND_LADDER.recursiveDeposits

/** DA fields: one per nullifier, note hash and message, and each log's length plus its header. */
const daFields = (effects: SideEffects): number =>
  effects.nullifiers +
  effects.noteHashes +
  effects.l2ToL1Msgs +
  effects.privateLogEmittedLengths.reduce((acc, len) => acc + len + 1, 0)

/** Gas of side effects in a tx with no public calls. No per-tx overhead: this is a marginal. */
export function privateSideEffectGas(effects: SideEffects): ClaimFpcMeasuredTx {
  return {
    daGas: daFields(effects) * DA_GAS_PER_FIELD,
    l2Gas:
      effects.nullifiers * L2_GAS_PER_NULLIFIER +
      effects.noteHashes * L2_GAS_PER_NOTE_HASH +
      effects.l2ToL1Msgs * L2_GAS_PER_L2_TO_L1_MSG +
      effects.privateLogEmittedLengths.length * L2_GAS_PER_PRIVATE_LOG,
  }
}

/** Gas of side effects in a tx with public calls, at the AVM's rates. No per-tx overhead. This is
 * what an entry budgets, since it cannot know whether its batch has a public call. */
export function publicSideEffectGas(effects: SideEffects): ClaimFpcMeasuredTx {
  return {
    daGas: daFields(effects) * DA_GAS_PER_FIELD,
    l2Gas:
      effects.nullifiers * AVM_EMITNULLIFIER_BASE_L2_GAS +
      effects.noteHashes * AVM_EMITNOTEHASH_BASE_L2_GAS +
      effects.l2ToL1Msgs * AVM_SENDL2TOL1MSG_BASE_L2_GAS +
      effects.privateLogEmittedLengths.length * L2_GAS_PER_PRIVATE_LOG,
  }
}

/**
 * Gas of a whole tx that enqueues `publicCalls` public calls: the public per-tx overhead, a fixed
 * AVM startup per call, and every side effect at the AVM's rates. The public calls' own execution
 * is not in here; see `avmExecutionGas`. The fee payer's public-data write costs no DA in this
 * mode (contract_function_simulator.ts meterGasUsed), so none is added.
 */
export function txGasWithPublicCalls(
  effects: SideEffects,
  publicCalls: number,
): ClaimFpcMeasuredTx {
  const sideEffects = publicSideEffectGas(effects)
  return {
    daGas: sideEffects.daGas,
    l2Gas: PUBLIC_TX_L2_GAS_OVERHEAD + publicCalls * FIXED_AVM_STARTUP_L2_GAS + sideEffects.l2Gas,
  }
}

export const mergeEffects = (...parts: SideEffects[]): SideEffects => ({
  nullifiers: parts.reduce((a, p) => a + p.nullifiers, 0),
  noteHashes: parts.reduce((a, p) => a + p.noteHashes, 0),
  privateLogEmittedLengths: parts.flatMap((p) => p.privateLogEmittedLengths),
  l2ToL1Msgs: parts.reduce((a, p) => a + p.l2ToL1Msgs, 0),
})

const NO_EFFECTS: SideEffects = {
  nullifiers: 0,
  noteHashes: 0,
  privateLogEmittedLengths: [],
  l2ToL1Msgs: 0,
}

const addGas = (a: ClaimFpcMeasuredTx, b: ClaimFpcMeasuredTx): ClaimFpcMeasuredTx => ({
  daGas: a.daGas + b.daGas,
  l2Gas: a.l2Gas + b.l2Gas,
})

const subGas = (a: ClaimFpcMeasuredTx, ...parts: ClaimFpcMeasuredTx[]): ClaimFpcMeasuredTx => ({
  daGas: parts.reduce((acc, p) => acc - p.daGas, a.daGas),
  l2Gas: parts.reduce((acc, p) => acc - p.l2Gas, a.l2Gas),
})

/**
 * What a public call's own execution cost in a measured tx: the measurement minus everything the
 * side-effect model can count for that tx's shape. Throws if the model already exceeds the
 * measurement, which means the modeled shape is wrong, not that execution was free.
 */
function avmExecutionGas(
  measuredTx: ClaimFpcMeasuredTx,
  effects: SideEffects,
  publicCalls: number,
  what: string,
): ClaimFpcMeasuredTx {
  const counted = txGasWithPublicCalls(effects, publicCalls)
  const gas = subGas(measuredTx, counted)
  if (gas.daGas < 0 || gas.l2Gas < 0) {
    throw new Error(
      `ClaimFPC gas model: the side-effect model for ${what} exceeds its measured tx ` +
        `(da=${gas.daGas}, l2=${gas.l2Gas} left) — the modeled shape no longer matches the ` +
        `contracts; fix the effects in claimFpcGasModel.ts and re-measure`,
    )
  }
  return gas
}

/** The FPC entrypoint itself: claim or note-pop nullifier + tx-request nullifier, the refreshed
 * SubscriptionNote and its delivery log. This is the shape `CLAIM_FPC_OVERHEAD_GAS` charges. */
export const entrypointEffects = (): SideEffects => ({
  nullifiers: 2,
  noteHashes: 1,
  privateLogEmittedLengths: [DELIVERY_LOG_LENGTH],
  l2ToL1Msgs: 0,
})

/** authorize_intents: intent-hash init nullifier, one BoolNote, its delivery log. */
export const authorizeIntentsEffects = (): SideEffects => ({
  nullifiers: 1,
  noteHashes: 1,
  privateLogEmittedLengths: [DELIVERY_LOG_LENGTH],
  l2ToL1Msgs: 0,
})

/** The registration gate: nothing. It proves the message exists without consuming it and checks the
 * key in-circuit, like the NameClaim gate. */
export const registrationGateEffects = (): SideEffects => ({
  nullifiers: 0,
  noteHashes: 0,
  privateLogEmittedLengths: [],
  l2ToL1Msgs: 0,
})

/** gift_voucher: the gifter's note, re-inserted by the entrypoint during setup, is popped again in the
 * app phase (a note from an earlier phase is not squashed, so its nullifier stands), then two notes
 * are inserted, the gifter's refreshed one and the recipient's voucher, each with its delivery log. */
export const giftVoucherEffects = (): SideEffects => ({
  nullifiers: 1,
  noteHashes: 2,
  privateLogEmittedLengths: [DELIVERY_LOG_LENGTH, DELIVERY_LOG_LENGTH],
  l2ToL1Msgs: 0,
})

/** A private event: aztec-nr pushes its commitment as a nullifier, plus one log per delivery. */
const eventEffects = (deliveries: number): SideEffects => ({
  ...NO_EFFECTS,
  nullifiers: 1,
  privateLogEmittedLengths: Array.from({ length: deliveries }, () => DELIVERY_LOG_LENGTH),
})

/**
 * Handshakes a call may open. Delivering to an address the sending wallet holds no keys for, with no
 * handshake yet for the pair, makes the PXE's default tagging strategy open a non-interactive one:
 * the registry's note (a nullifier, a note hash, its delivery log) and an announcement log. Budgets
 * count one per such delivery; a measured tx may open none. zk.money registers paylink escrows as
 * wallet accounts, so an unconstrained delivery to one opens none.
 */
const handshakeEffects = (count: number): SideEffects => ({
  nullifiers: count,
  noteHashes: count,
  privateLogEmittedLengths: Array.from({ length: 2 * count }, () => DELIVERY_LOG_LENGTH),
  l2ToL1Msgs: 0,
})

/** link_locator.announce: one log, the tag plus a full ciphertext. */
export const linkAnnounceEffects = (): SideEffects => ({
  nullifiers: 0,
  noteHashes: 0,
  privateLogEmittedLengths: [1 + PRIVATE_LOG_CIPHERTEXT_LEN],
  l2ToL1Msgs: 0,
})

/** The token's `Transfer` event, delivered to both parties. */
const transferEventEffects = () => eventEffects(2)

/** notify_sipa_recipient: the `SIPA` event, delivered to the recipient. */
export const sipaNotifyEffects = () => eventEffects(1)

/** Worst-case gift_voucher marginal: the voucher goes to another user. */
export function worstGiftVoucherMarginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(mergeEffects(giftVoucherEffects(), handshakeEffects(1)))
}

/** The one public call an L1-operation broadcast enqueues (two for the pair). */
const OPERATION_PUBLIC_CALLS = 1

/** The public call's execution cost, read off a measured lone broadcast. */
export function operationAvmExecutionGas(
  measuredBroadcastTx: ClaimFpcMeasuredTx,
  publicCalls: 1 | 2,
): ClaimFpcMeasuredTx {
  return avmExecutionGas(
    measuredBroadcastTx,
    entrypointEffects(),
    publicCalls,
    "L1 operation broadcast",
  )
}

/**
 * What enqueuing `publicCalls` public calls adds to a batch whose calls already price their own
 * effects at AVM rates: the public per-tx overhead and AVM startup, the calls' execution, and the
 * AVM rates on the base's and the gate's effects, which the contract charges at private rates. No
 * gate emits anything, so the registration gate stands for every gate. DA is floored at zero: the
 * base's DA covers a public tx's.
 */
function publicCallSurcharge(
  execution: ClaimFpcMeasuredTx,
  publicCalls: number,
  budgetedBase: ClaimFpcMeasuredTx,
): ClaimFpcMeasuredTx {
  const surcharge = subGas(
    addGas(
      txGasWithPublicCalls(
        mergeEffects(entrypointEffects(), registrationGateEffects()),
        publicCalls,
      ),
      execution,
    ),
    budgetedBase,
    privateSideEffectGas(registrationGateEffects()),
  )
  return { daGas: Math.max(0, surcharge.daGas), l2Gas: surcharge.l2Gas }
}

/** An L1-operation broadcast emits nothing privately, so its entry is the surcharge alone. */
export function operationBroadcastMarginal(
  measured: ClaimFpcMeasuredTx,
  publicCalls: 1 | 2,
  budgetedBase: ClaimFpcMeasuredTx,
): ClaimFpcMeasuredTx {
  return publicCallSurcharge(
    operationAvmExecutionGas(measured, publicCalls),
    publicCalls,
    budgetedBase,
  )
}

/**
 * The first deposit of a fresh account, as one tx: a subscribe through `gate`, the SIPA notify and
 * the broadcast. The budgets assert the model reproduces that measured row from the lone
 * broadcast's execution gas, which is the check that the public-call pricing is right.
 */
export function firstDepositTxGas(
  operationExecutionGas: ClaimFpcMeasuredTx,
  gate: SideEffects,
): ClaimFpcMeasuredTx {
  return addGas(
    txGasWithPublicCalls(
      mergeEffects(entrypointEffects(), gate, sipaNotifyEffects()),
      OPERATION_PUBLIC_CALLS,
    ),
    operationExecutionGas,
  )
}

/** publish_da's private logs for the given capsule item counts (da.nr chunks 15 items per log). */
export function publishDaEffects(counts: {
  teeNotes: number
  requiredNullifiers: number
  withdrawalMessageHashes: number
}): SideEffects {
  return {
    nullifiers: 0,
    noteHashes: 0,
    privateLogEmittedLengths: computePublishDaLogEmittedLengths({
      ...counts,
      metadataFields: TEE_METADATA_FIELDS,
    }),
    l2ToL1Msgs: 0,
  }
}

/** publish_da at the capsule schema's hard maxima (the BoundedVec caps in da.nr). The TEE decides
 * the item counts, so the budget takes the bound the contract enforces rather than guessing. */
export const publishDaCeilingEffects = (): SideEffects =>
  publishDaEffects({
    teeNotes: MAX_NOTE_HASHES_PER_TX,
    requiredNullifiers: MAX_NULLIFIERS_PER_TX,
    withdrawalMessageHashes: MAX_L2_TO_L1_MSGS_PER_TX,
  })

/** Worst-case publish_da entry: the capsule ceiling. One runs per TEE-op batch. */
export function worstPublishDaMarginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(publishDaCeilingEffects())
}

/** A token spend at the full sponsored ladder: the authwit nullifier, one nullifier per input note
 * and consumed deposit, and a change note plus an optional recipient note with a delivery log each. */
const spendEffects = (opts: { recipientNote: boolean }): SideEffects => {
  const createdNotes = (opts.recipientNote ? 1 : 0) + 1 // + change note
  return {
    nullifiers: 1 + ladderNotes() + ladderDeposits(),
    noteHashes: createdNotes,
    privateLogEmittedLengths: Array.from({ length: createdNotes }, () => DELIVERY_LOG_LENGTH),
    l2ToL1Msgs: 0,
  }
}

/** Worst-case oxide_token.transfer marginal: the recipient's note and Transfer copy may each open a
 * handshake. */
export function worstTransferMarginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(
    mergeEffects(
      spendEffects({ recipientNote: true }),
      transferEventEffects(),
      handshakeEffects(2),
    ),
  )
}

/** The burn's own emissions beside the spend: the L2->L1 message and its recovery chunk events,
 * delivered to the withdrawer. */
const withdrawEffects = (): SideEffects =>
  mergeEffects(
    { ...NO_EFFECTS, l2ToL1Msgs: 1 },
    ...Array.from({ length: WITHDRAWAL_RECOVERY_CHUNKS }, () => eventEffects(1)),
  )

/** Worst-case oxide_token.withdraw marginal: a ladder spend with a change note only, and the
 * burn's emissions. */
export function worstWithdrawMarginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(
    mergeEffects(spendEffects({ recipientNote: false }), withdrawEffects()),
  )
}

/** A paylink exit: the escrow note's nullifier, then the burn a withdraw makes. */
const paylinkExitWorstEffects = (): SideEffects =>
  mergeEffects(
    { ...NO_EFFECTS, nullifiers: 1 },
    spendEffects({ recipientNote: false }),
    withdrawEffects(),
  )

/** Worst-case paylink_direct.claim_to_l1 marginal. */
export function worstPaylinkClaimToL1Marginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(paylinkExitWorstEffects())
}

/** Worst-case paylink_direct.claim_with_withdrawal marginal: an exit's burn and a claim's payout in
 * one call. Counting both legs whole double-counts the replay nullifier and a recipient authwit the
 * call never consumes, which only loosens the bound. */
export function worstPaylinkClaimWithWithdrawalMarginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(mergeEffects(paylinkExitWorstEffects(), worstClaimEffects()))
}

/** Worst-case paylink_email.claim_to_l1 marginal: the exit plus the registry view it enqueues,
 * whose execution is read off the measured email claim. */
export function worstPaylinkEmailClaimToL1Marginal(
  measuredEmailClaim: ClaimFpcMeasuredTx,
  budgetedBase: ClaimFpcMeasuredTx,
): ClaimFpcMeasuredTx {
  return addGas(
    publicSideEffectGas(paylinkExitWorstEffects()),
    publicCallSurcharge(
      emailClaimAvmExecutionGas(measuredEmailClaim),
      EMAIL_CLAIM_PUBLIC_CALLS,
      budgetedBase,
    ),
  )
}

/** Creating a PaylinkNote: init nullifier, note hash, delivery log. */
const paylinkNoteEffects = (): SideEffects => ({
  nullifiers: 1,
  noteHashes: 1,
  privateLogEmittedLengths: [DELIVERY_LOG_LENGTH],
  l2ToL1Msgs: 0,
})

/** Worst-case paylink_direct.deposit marginal: the PaylinkNote plus a full ladder transfer into
 * the escrow. The PaylinkNote's constrained delivery adds its sequence nullifier and, for the fresh
 * escrow, opens a handshake. */
export function worstPaylinkDepositMarginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(
    mergeEffects(
      paylinkNoteEffects(),
      { ...NO_EFFECTS, nullifiers: 1 },
      spendEffects({ recipientNote: true }),
      transferEventEffects(),
      handshakeEffects(1),
    ),
  )
}

/** What every claim emits: the escrow holds one deposit note and pays it out whole, so the inner
 * transfer spends one note with no change; plus the recipient's claim authwit, the paylink
 * replay nullifier and the Transfer event. */
const claimStructuralEffects = (): SideEffects =>
  mergeEffects(
    {
      nullifiers: 3,
      noteHashes: 1,
      privateLogEmittedLengths: [DELIVERY_LOG_LENGTH],
      l2ToL1Msgs: 0,
    },
    transferEventEffects(),
  )

/** The DA a claim publishes: the recipient's note and the spent escrow note. */
const claimPublishDaEffects = () =>
  publishDaEffects({ teeNotes: 1, requiredNullifiers: 1, withdrawalMessageHashes: 0 })

/** A direct claim's whole tx: the claim window is checked privately, so it has no public calls. */
export function paylinkClaimTxGas(base: ClaimFpcMeasuredTx): ClaimFpcMeasuredTx {
  return addGas(
    base,
    privateSideEffectGas(
      mergeEffects(authorizeIntentsEffects(), claimStructuralEffects(), claimPublishDaEffects()),
    ),
  )
}

/** What a claim may emit on top of that: a dust-topped escrow can add a change note, and the first
 * transfer call can pull its per-call maxima (the deposit note always covers the amount, so the
 * ladder never recurses). */
const claimWorstExtraEffects = (): SideEffects => ({
  nullifiers: SPEND_LADDER.initialNotes - 1 + SPEND_LADDER.initialDeposits,
  noteHashes: 1,
  privateLogEmittedLengths: [DELIVERY_LOG_LENGTH],
  l2ToL1Msgs: 0,
})

/** paylink_email.claim enqueues the OidcKeyRegistry `assert_valid` view; its exit does too. */
const EMAIL_CLAIM_PUBLIC_CALLS = 1

/** The registry view's execution cost, read off the measured email claim tx. */
function emailClaimAvmExecutionGas(measuredEmailClaimTx: ClaimFpcMeasuredTx): ClaimFpcMeasuredTx {
  return avmExecutionGas(
    measuredEmailClaimTx,
    mergeEffects(
      entrypointEffects(),
      authorizeIntentsEffects(),
      claimStructuralEffects(),
      claimPublishDaEffects(),
    ),
    EMAIL_CLAIM_PUBLIC_CALLS,
    "email paylink claim",
  )
}

const worstClaimEffects = (): SideEffects =>
  mergeEffects(claimStructuralEffects(), claimWorstExtraEffects())

/** Worst-case paylink_direct.claim marginal. */
export function worstPaylinkClaimMarginal(): ClaimFpcMeasuredTx {
  return publicSideEffectGas(worstClaimEffects())
}

/** Worst-case paylink_email.claim marginal: the claim plus the registry view it enqueues. */
export function worstPaylinkEmailClaimMarginal(
  measuredEmailClaimTx: ClaimFpcMeasuredTx,
  budgetedBase: ClaimFpcMeasuredTx,
): ClaimFpcMeasuredTx {
  return addGas(
    publicSideEffectGas(worstClaimEffects()),
    publicCallSurcharge(
      emailClaimAvmExecutionGas(measuredEmailClaimTx),
      EMAIL_CLAIM_PUBLIC_CALLS,
      budgetedBase,
    ),
  )
}
