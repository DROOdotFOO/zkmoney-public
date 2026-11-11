import type { ExactApprovalCommitment } from './approval.js';
import {
  type ExactOperationApproval,
  type ExactOperationObservation,
  assertExactApprovalWindow,
  assertExactOperationMatches,
} from './contract.js';
import type { ExactOperationJournal } from './journal.js';
import {
  type ExactApprovalClaimStore,
  consumeExactApprovalExternally,
  exactApprovalClaimKey,
  restoreExactApprovalClaimReceipt,
  verifyExactApprovalClaimReceipt,
} from './monotonic_claim.js';

export interface SignedExactOperation {
  hash: string;
  bytes: Buffer;
}

export interface ExactOperationExecution {
  /** Point reads for the named deployment, source event and operation only. */
  observe(approval: ExactOperationApproval): Promise<ExactOperationObservation>;
  /** Loads the L1 account without signing and verifies the signed runtime identity. */
  assertSignerIdentity(approval: ExactOperationApproval): Promise<void>;
  /** Builds all finalization material and signs one L1 transaction exactly once. */
  signOnce(approval: ExactOperationApproval, assertApprovalWindow: () => void): Promise<SignedExactOperation>;
  /** Makes one transport call with the durable signed bytes. */
  sendOnce(signedTransaction: Buffer, assertApprovalWindow: () => void): Promise<string>;
  /** Observation only; this method cannot sign, send or replace a transaction. */
  waitForReceipt(txHash: string): Promise<{ status: 'success' | 'reverted'; transactionHash: string }>;
}

export interface RelayExactOperationOptions {
  approval: ExactOperationApproval;
  approvalCommitment: ExactApprovalCommitment;
  journal: ExactOperationJournal;
  execution: ExactOperationExecution;
  claimStore: ExactApprovalClaimStore;
  now?: () => Date;
}

export async function relayExactOperation({
  approval,
  approvalCommitment,
  journal,
  execution,
  claimStore,
  now = () => new Date(),
}: RelayExactOperationOptions): Promise<{ l1TxHash: string }> {
  const assertApprovalWindow = () => assertExactApprovalWindow(approval, now());
  assertApprovalWindow();
  const observation = await execution.observe(approval);
  assertExactOperationMatches(approval, observation);

  await execution.assertSignerIdentity(approval);
  const existing = await journal.findConsumption(approvalCommitment, approval.operation.id);
  if (existing) {
    const key = exactApprovalClaimKey(approval, approvalCommitment, claimStore.claimPrefix);
    await verifyExactApprovalClaimReceipt(claimStore, restoreExactApprovalClaimReceipt(key, existing));
    throw new Error(`Exact operation ${approval.operation.id} approval was already consumed`);
  }
  // Signing needs the journal row, so an intent without a row proves this approval was never signed.
  const adoptOwnClaim = await journal.hasClaimIntent(approvalCommitment, approval.operation.id);
  await journal.recordClaimIntent(approvalCommitment, approval.operation.id);
  const witness = await consumeExactApprovalExternally(approval, approvalCommitment, claimStore, assertApprovalWindow, {
    adoptOwnClaim,
  });
  await journal.consumeApproval(approvalCommitment, approval.operation.id, approval.stageA.approvalDigest, witness);
  await journal.beginSigning(approval.operation.id);
  assertApprovalWindow();

  let signed: SignedExactOperation;
  try {
    signed = await execution.signOnce(approval, assertApprovalWindow);
  } catch (cause) {
    await journal.recordAmbiguous(approval.operation.id);
    throw new Error('Exact-operation signing outcome is ambiguous; approval is permanently locked', { cause });
  }
  await journal.recordSigned(approval.operation.id, signed.hash, signed.bytes);
  await journal.beginSend(approval.operation.id);

  let l1TxHash: string;
  try {
    l1TxHash = await execution.sendOnce(signed.bytes, assertApprovalWindow);
    await journal.recordSent(approval.operation.id, l1TxHash);
  } catch (cause) {
    await journal.recordAmbiguous(approval.operation.id);
    throw new Error('Exact-operation send outcome is ambiguous; no second send is permitted', { cause });
  }

  let receipt: { status: 'success' | 'reverted'; transactionHash: string };
  try {
    receipt = await execution.waitForReceipt(l1TxHash);
  } catch (cause) {
    await journal.recordAmbiguous(approval.operation.id);
    throw new Error('Exact-operation receipt outcome is ambiguous; no second send is permitted', { cause });
  }
  if (receipt.transactionHash.toLowerCase() !== l1TxHash.toLowerCase()) {
    await journal.recordAmbiguous(approval.operation.id);
    throw new Error('Exact-operation receipt belongs to a replacement transaction; no exact outcome is known');
  }
  if (receipt.status === 'reverted') {
    await journal.recordFailed(approval.operation.id);
    throw new Error('Exact-operation transaction reverted; approval is consumed and no retry is permitted');
  }
  await journal.recordConfirmed(approval.operation.id);
  return { l1TxHash };
}
