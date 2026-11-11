import type { Logger } from '@aztec-labs/foundation/log';

import { type Address, type Hash, TransactionReceiptNotFoundError } from 'viem';

import { signerCommitment } from './l1_tx_queue.js';
import type {
  DurableGenericSubmission,
  ReconcilableSubmissionJournal,
  TerminalGenericSubmissionState,
} from './submission_journal.js';

/** The chain reads of reconciliation; a viem `PublicClient` satisfies it. */
export interface ReconciliationClient {
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Address; blockTag: 'finalized' }): Promise<number>;
  getTransactionReceipt(args: { hash: Hash }): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
}

/**
 * Resolves the journal attempts that an earlier process of this signer left without a terminal outcome, from chain
 * evidence only: the receipt of the durable signed bytes, or a finalized nonce past the attempt's nonce, which no
 * longer lets those bytes be mined. It never signs or sends. Throws while any attempt stays unresolved.
 */
export async function reconcileUnresolvedSubmissions({
  journal,
  client,
  address,
  log,
}: {
  journal: ReconcilableSubmissionJournal;
  client: ReconciliationClient;
  address: Address;
  log: Logger;
}): Promise<void> {
  const unresolved = await journal.listUnresolved();
  if (unresolved.length > 0) {
    const commitment = signerCommitment(address);
    const [chainId, finalizedNonce] = await Promise.all([
      client.getChainId(),
      client.getTransactionCount({ address, blockTag: 'finalized' }),
    ]);
    for (const submission of unresolved) {
      if (submission.signerCommitment !== commitment || submission.chainId !== chainId) {
        // Another signer or chain: this process cannot read its outcome, so the check below refuses to start.
        continue;
      }
      const outcome = await provenOutcome(client, submission, finalizedNonce);
      if (outcome === undefined) {
        continue;
      }
      await journal.recordReconciled(
        submission.operationIdentity,
        submission.attempt,
        outcome.state,
        JSON.stringify(outcome.evidence),
      );
      log.info('Reconciled an unresolved L1 submission from chain evidence', {
        event: 'l1_submission_reconciled',
        operationIdentity: submission.operationIdentity,
        attempt: submission.attempt,
        nonce: submission.nonce,
        state: outcome.state,
      });
    }
  }
  await journal.assertNoUnresolved();
}

async function provenOutcome(
  client: ReconciliationClient,
  submission: DurableGenericSubmission,
  finalizedNonce: number,
): Promise<{ state: TerminalGenericSubmissionState; evidence: Record<string, unknown> } | undefined> {
  const txHash = submission.signedTxHash as Hash | undefined;
  if (txHash !== undefined) {
    const receipt = await readReceipt(client, txHash);
    if (receipt) {
      return {
        state: receipt.status === 'success' ? 'confirmed' : 'reverted',
        evidence: {
          txHash,
          receiptStatus: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          reconciled: true,
        },
      };
    }
  }
  if (finalizedNonce > submission.nonce) {
    // A finalized transaction used the nonce, and none of them is these signed bytes: they can never be mined.
    return {
      state: 'dropped_or_replaced',
      evidence: { ...(txHash === undefined ? {} : { txHash }), finalizedNonce, reconciled: true },
    };
  }
  return undefined;
}

async function readReceipt(client: ReconciliationClient, hash: Hash) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return undefined;
    }
    throw error;
  }
}
