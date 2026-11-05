import { exactApprovalDigest } from './approval.js';
import {
  type ExactOperationApproval,
  type ExactOperationObservation,
  assertExactOperationMatches,
} from './contract.js';
import type { ExactOperationJournal } from './journal.js';

export interface SignedExactOperation {
  hash: string;
  bytes: Buffer;
}

export interface ExactOperationExecution {
  /** Point reads for the named deployment, source event and operation only. */
  observe(approval: ExactOperationApproval): Promise<ExactOperationObservation>;
  /** Builds all finalization material and signs one L1 transaction exactly once. */
  signOnce(approval: ExactOperationApproval): Promise<SignedExactOperation>;
  /** Makes one transport call with the durable signed bytes. */
  sendOnce(signedTransaction: Buffer): Promise<string>;
  /** Observation only; this method cannot sign, send or replace a transaction. */
  waitForReceipt(txHash: string): Promise<{ status: 'success' | 'reverted' }>;
}

export interface RelayExactOperationOptions {
  approval: ExactOperationApproval;
  journal: ExactOperationJournal;
  execution: ExactOperationExecution;
}

export async function relayExactOperation({
  approval,
  journal,
  execution,
}: RelayExactOperationOptions): Promise<{ l1TxHash: string }> {
  const observation = await execution.observe(approval);
  assertExactOperationMatches(approval, observation);

  await journal.consumeApproval(exactApprovalDigest(approval), approval.operation.id);
  await journal.beginSigning(approval.operation.id);

  let signed: SignedExactOperation;
  try {
    signed = await execution.signOnce(approval);
  } catch (cause) {
    await journal.recordAmbiguous(approval.operation.id);
    throw new Error('Exact-operation signing outcome is ambiguous; approval is permanently locked', { cause });
  }
  await journal.recordSigned(approval.operation.id, signed.hash, signed.bytes);
  await journal.beginSend(approval.operation.id);

  let l1TxHash: string;
  try {
    l1TxHash = await execution.sendOnce(signed.bytes);
    await journal.recordSent(approval.operation.id, l1TxHash);
  } catch (cause) {
    await journal.recordAmbiguous(approval.operation.id);
    throw new Error('Exact-operation send outcome is ambiguous; no second send is permitted', { cause });
  }

  let receipt: { status: 'success' | 'reverted' };
  try {
    receipt = await execution.waitForReceipt(l1TxHash);
  } catch (cause) {
    await journal.recordAmbiguous(approval.operation.id);
    throw new Error('Exact-operation receipt outcome is ambiguous; no second send is permitted', { cause });
  }
  if (receipt.status === 'reverted') {
    await journal.recordFailed(approval.operation.id);
    throw new Error('Exact-operation transaction reverted; approval is consumed and no retry is permitted');
  }
  await journal.recordConfirmed(approval.operation.id);
  return { l1TxHash };
}
