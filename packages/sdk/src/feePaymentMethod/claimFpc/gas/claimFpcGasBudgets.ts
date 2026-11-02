/**
 * The ClaimFPC gas budgets: what each sponsorable call may cost, checked against the measured table
 * (CLAIM_FPC_GAS_TABLE) before anything uses the numbers.
 *
 * Three consumers, one derivation. A per-call deploy prices these into its entries' `max_fee`
 * (backend claimFpcConfig.ts adds the fee-per-gas); a wallet under such a policy declares them as
 * a sponsored tx's gas limits (`claimFpcBatchGas`); and the flat caps the shipped open policy uses
 * are sized against them. The circuit compares declared limits times fee-per-gas with the batch's
 * budget, so the deploy and the client must use the same numbers: a batch that declares more gas
 * than its budget cannot be proven at any price.
 *
 * The base — the entrypoint's own overhead — is the contract's `CLAIM_FPC_OVERHEAD_GAS`, charged
 * once per batch. Each entry budgets the worst case of its call from the side-effect model
 * (claimFpcGasModel.ts). The table is the check on the model: fixed shapes must match it to the gas,
 * worst-case batches must cover it, and the publish_da chunking must reproduce the measured direct
 * claim. A
 * missing row or a failed check throws wherever the numbers are used; the fix is to re-measure
 * (CLAIMFPC_GAS_REPORT=1, the sdk fpc suites) and correct the model, never to guess.
 */
import {
  authorizeIntentsEffects,
  firstDepositTxGas,
  giftVoucherEffects,
  linkAnnounceEffects,
  mergeEffects,
  operationAvmExecutionGas,
  operationBroadcastMarginal,
  paylinkClaimTxGas,
  privateSideEffectGas,
  publicSideEffectGas,
  registrationGateEffects,
  sipaNotifyEffects,
  worstPaylinkClaimMarginal,
  worstPaylinkClaimToL1Marginal,
  worstPaylinkClaimWithWithdrawalMarginal,
  worstPaylinkDepositMarginal,
  worstPaylinkEmailClaimMarginal,
  worstPaylinkEmailClaimToL1Marginal,
  worstGiftVoucherMarginal,
  worstPublishDaMarginal,
  worstTransferMarginal,
  worstWithdrawMarginal,
} from "./claimFpcGasModel.js"
import { meterClaimFpcOverheadGas } from "./claimFpcOverhead.js"
import { CLAIM_FPC_GAS_TABLE, type ClaimFpcMeasuredTx } from "./claimFpcGasTable.js"

/** The 2k L1-operation broadcast: a SIPA sweep, and the release every wallet burn carries. */
const RELEASE = "broadcaster.broadcast_l1_operation_2k"

function measuredTx(key: string): ClaimFpcMeasuredTx {
  const measured = CLAIM_FPC_GAS_TABLE[key]
  if (!measured) {
    throw new Error(
      `ClaimFPC gas table has no measurement "${key}" — regenerate it with ` +
        `CLAIMFPC_GAS_REPORT=1 (packages/sdk fpc test suites) before deploying`,
    )
  }
  return measured
}

const gasAdd = (a: ClaimFpcMeasuredTx, b: ClaimFpcMeasuredTx): ClaimFpcMeasuredTx => ({
  daGas: a.daGas + b.daGas,
  l2Gas: a.l2Gas + b.l2Gas,
})

function gasSub(a: ClaimFpcMeasuredTx, b: ClaimFpcMeasuredTx, what: string): ClaimFpcMeasuredTx {
  const daGas = a.daGas - b.daGas
  const l2Gas = a.l2Gas - b.l2Gas
  if (daGas < 0 || l2Gas < 0) {
    throw new Error(
      `ClaimFPC gas derivation: negative marginal for ${what} (da=${daGas}, l2=${l2Gas}) — ` +
        `the gas table is inconsistent; re-measure it whole with CLAIMFPC_GAS_REPORT=1`,
    )
  }
  return { daGas, l2Gas }
}
/** A fixed shape's model must equal its measurement to the gas. */
function assertModelExact(what: string, model: ClaimFpcMeasuredTx, measured: ClaimFpcMeasuredTx) {
  if (model.daGas !== measured.daGas || model.l2Gas !== measured.l2Gas) {
    throw new Error(
      `ClaimFPC gas model drift for ${what}: model da=${model.daGas} l2=${model.l2Gas}, ` +
        `measured da=${measured.daGas} l2=${measured.l2Gas} — a metering constant or the ` +
        `contract's side effects moved; fix claimFpcGasModel.ts and re-measure the table ` +
        `(CLAIMFPC_GAS_REPORT=1, sdk fpc suites)`,
    )
  }
}

/** A worst-case budget must cover every measured shape of its call, in both gas dimensions. */
function assertBudgetCovers(what: string, model: ClaimFpcMeasuredTx, measured: ClaimFpcMeasuredTx) {
  if (model.daGas < measured.daGas || model.l2Gas < measured.l2Gas) {
    throw new Error(
      `ClaimFPC worst-case budget for ${what} (da=${model.daGas}, l2=${model.l2Gas}) does not ` +
        `cover the measured shape (da=${measured.daGas}, l2=${measured.l2Gas}) — the sponsored ` +
        `shape policy in claimFpcGasModel.ts is too tight or the model dropped a side effect`,
    )
  }
}

/**
 * The overhead the circuit charges per batch, checked against the same value computed from the
 * kernel's metering constants: a mismatch means Noir and TS drifted, usually after an aztec bump the
 * contract's literal did not follow. The measured table ties it down right after this:
 * `sponsor[authorize_intents]` has to be exactly the base plus the authorize_intents marginal.
 *
 * `declared` is the contract's `CLAIM_FPC_OVERHEAD_GAS` when the caller has the compiled artifact
 * (the deploy does, via `claimFpcOverheadGas()`) and the constants-derived value otherwise, since a
 * wallet must not load a megabyte of contract JSON to price a batch.
 */
function verifiedOverheadGas(declared: ClaimFpcMeasuredTx): ClaimFpcMeasuredTx {
  const base = declared
  const metered = meterClaimFpcOverheadGas()
  if (base.daGas !== metered.daGas || base.l2Gas !== metered.l2Gas) {
    throw new Error(
      `ClaimFPC overhead gas drift: CLAIM_FPC_OVERHEAD_GAS charges da=${base.daGas} ` +
        `l2=${base.l2Gas}, the kernel's metering constants give da=${metered.daGas} ` +
        `l2=${metered.l2Gas} — update the global in claim_fpc/src/main.nr, rebuild the artifact, ` +
        "and re-measure the gas table",
    )
  }
  return base
}

/**
 * Every budget a per-call policy is built from: the checked base and one worst-case entry per
 * sponsorable call. A per-call deploy prices these into its entries' `max_fee`; a client under it
 * declares their sum as a batch's gas limits.
 */
export function deriveClaimFpcGasBudgets(
  overheadGas: ClaimFpcMeasuredTx = meterClaimFpcOverheadGas(),
) {
  const base = verifiedOverheadGas(overheadGas)
  /** What a batch of these entries declares: the base plus each entry. */
  const batch = (...entries: ClaimFpcMeasuredTx[]) => entries.reduce(gasAdd, base)

  // Fixed shapes: the side-effect model must equal the measurement at the rates it ran at.
  assertModelExact(
    "authorize_intents",
    privateSideEffectGas(authorizeIntentsEffects()),
    gasSub(measuredTx("sponsor[authorize_intents]"), base, "authorize_intents"),
  )
  // The gate is read off a registration-gated subscribe that carries only `authorize_intents`.
  assertModelExact(
    "registration gate",
    privateSideEffectGas(mergeEffects(authorizeIntentsEffects(), registrationGateEffects())),
    gasSub(measuredTx("subscribe[registration,authorize_intents]"), base, "registration gate"),
  )
  assertModelExact(
    "gift_voucher",
    privateSideEffectGas(giftVoucherEffects()),
    gasSub(measuredTx("sponsor[claim_fpc.gift_voucher]"), base, "gift_voucher"),
  )
  assertModelExact(
    "link_locator.announce",
    privateSideEffectGas(linkAnnounceEffects()),
    gasSub(measuredTx("sponsor[link_locator.announce]"), base, "link_locator.announce"),
  )
  // The broadcast's execution gas, read off the lone broadcast, has to reproduce the first
  // deposit, which is the check that the public-call pricing is right.
  const bareOperation = measuredTx(`sponsor[${RELEASE}]`)
  assertModelExact(
    "registration + notify_sipa_recipient + broadcast_l1_operation_2k",
    firstDepositTxGas(operationAvmExecutionGas(bareOperation, 1), registrationGateEffects()),
    measuredTx(`subscribe[registration,oxide_token.notify_sipa_recipient,${RELEASE}]`),
  )
  // A direct claim is a fixed private shape, publish_da's chunking included.
  const claimRow = "sponsor[authorize_intents,paylink_direct.claim,oxide_token.publish_da]"
  assertModelExact("paylink_direct.claim tx", paylinkClaimTxGas(base), measuredTx(claimRow))

  const mAuth = publicSideEffectGas(authorizeIntentsEffects())
  const mGift = worstGiftVoucherMarginal()
  const mSipaNotify = publicSideEffectGas(sipaNotifyEffects())
  const mLinkAnnounce = publicSideEffectGas(linkAnnounceEffects())
  const mL1Operation = operationBroadcastMarginal(bareOperation, 1, base)
  const mL1Operation4k = operationBroadcastMarginal(
    measuredTx("sponsor[broadcaster.broadcast_l1_operation_4k]"),
    1,
    base,
  )
  const mL1OperationPair = operationBroadcastMarginal(
    measuredTx("sponsor[broadcaster.broadcast_l1_operation_pair_2k]"),
    2,
    base,
  )
  const mPublishDa = worstPublishDaMarginal()
  const mTransfer = worstTransferMarginal()
  const mWithdraw = worstWithdrawMarginal()
  const mPaylinkDeposit = worstPaylinkDepositMarginal()
  const mPaylinkClaim = worstPaylinkClaimMarginal()
  const mPaylinkClaimToL1 = worstPaylinkClaimToL1Marginal()
  const mPaylinkClaimWithWithdrawal = worstPaylinkClaimWithWithdrawalMarginal()
  const emailClaimRow = "sponsor[authorize_intents,paylink_email.claim,oxide_token.publish_da]"
  const mPaylinkEmailClaim = worstPaylinkEmailClaimMarginal(measuredTx(emailClaimRow), base)
  const mPaylinkEmailClaimToL1 = worstPaylinkEmailClaimToL1Marginal(measuredTx(emailClaimRow), base)

  // Each worst-case batch must cover the measured tx of the same shape.
  const covers = (row: string, ...entries: ClaimFpcMeasuredTx[]) =>
    assertBudgetCovers(row, batch(...entries), measuredTx(row))
  covers(`sponsor[oxide_token.notify_sipa_recipient,${RELEASE}]`, mSipaNotify, mL1Operation)
  covers(
    "sponsor[authorize_intents,oxide_token.transfer,oxide_token.publish_da]",
    mAuth,
    mTransfer,
    mPublishDa,
  )
  covers(
    `sponsor[authorize_intents,oxide_token.withdraw,${RELEASE},oxide_token.publish_da]`,
    mAuth,
    mWithdraw,
    mL1Operation,
    mPublishDa,
  )
  covers(
    "sponsor[authorize_intents,paylink_direct.deposit,link_locator.announce,oxide_token.publish_da]",
    mAuth,
    mPaylinkDeposit,
    mLinkAnnounce,
    mPublishDa,
  )
  covers(claimRow, mAuth, mPaylinkClaim, mPublishDa)
  covers(emailClaimRow, mAuth, mPaylinkEmailClaim, mPublishDa)
  covers(
    `sponsor[paylink_direct.claim_to_l1,${RELEASE},oxide_token.publish_da]`,
    mPaylinkClaimToL1,
    mL1Operation,
    mPublishDa,
  )
  covers(
    `sponsor[paylink_direct.claim_with_withdrawal,${RELEASE},oxide_token.publish_da]`,
    mPaylinkClaimWithWithdrawal,
    mL1Operation,
    mPublishDa,
  )
  covers(
    `sponsor[paylink_email.claim_to_l1,${RELEASE},oxide_token.publish_da]`,
    mPaylinkEmailClaimToL1,
    mL1Operation,
    mPublishDa,
  )
  covers(
    `sponsor[authorize_intents,paylink_email.claim_to_l1,${RELEASE},oxide_token.publish_da]`,
    mAuth,
    mPaylinkEmailClaimToL1,
    mL1Operation,
    mPublishDa,
  )

  return {
    base,
    mAuth,
    mGift,
    mSipaNotify,
    mLinkAnnounce,
    mL1Operation,
    mL1Operation4k,
    mL1OperationPair,
    mPublishDa,
    mTransfer,
    mWithdraw,
    mPaylinkDeposit,
    mPaylinkClaim,
    mPaylinkClaimToL1,
    mPaylinkClaimWithWithdrawal,
    mPaylinkEmailClaim,
    mPaylinkEmailClaimToL1,
  }
}
