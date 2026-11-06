import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { TxHash } from '@aztec-labs/stdlib/tx';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { verifyWithdrawalInTx } from '@oxide/oxide-client/withdrawal_in_tx.js';
import {
  type BroadcastL1Operation,
  extractL1Operations,
  l1OperationEventSelector,
} from '@oxide/oxide-lib/l1_operation_calldata.js';
import { decodeFinalizationData } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import type { ExactOperationApproval, ExactOperationObservation } from './contract.js';
import { type ExactSourceEvidence, deriveExactOperationObservation } from './evidence.js';


export class ExactOperationObserver {
  private operation: BroadcastL1Operation | undefined;

  constructor(
    private readonly node: Pick<
      AztecNode,
      'getTxByHash' | 'getTxReceipt' | 'getTxEffect' | 'getBlock' | 'getBlockNumber' | 'getL2ToL1MembershipWitness'
    >,
    private readonly portal: OxidePortalContract,
    private readonly identity: Pick<ExactSourceEvidence, 'runtime' | 'deployment' | 'economics'>,
  ) {}

  async observe(approval: ExactOperationApproval): Promise<ExactOperationObservation> {
    const sourceTxHash = TxHash.fromString(approval.operation.sourceTxHash);
    const [tx, receipt, provenBlockNumber] = await Promise.all([
      this.node.getTxByHash(sourceTxHash),
      this.node.getTxReceipt(sourceTxHash),
      this.node.getBlockNumber('proven'),
    ]);
    if (!tx) {
      throw new Error('Exact-operation source transaction is unavailable; refusing discovery or recovery');
    }
    if (!receipt?.blockNumber || !receipt.blockHash) {
      throw new Error('Exact-operation source transaction is not included in a block');
    }
    const sourceBlock = await this.node.getBlock(BlockNumber(receipt.blockNumber));
    if (!sourceBlock) {
      throw new Error('Exact-operation source block is unavailable');
    }

    const operations = extractL1Operations(
      tx,
      await l1OperationEventSelector(),
      AztecAddress.fromStringUnsafe(this.identity.deployment.broadcaster),
    );
    const observation = deriveExactOperationObservation(approval, {
      ...this.identity,
      sourceTxHash,
      sourceBlockNumber: BigInt(receipt.blockNumber),
      sourceBlockHash: receipt.blockHash.toString(),
      provenBlockNumber: BigInt(provenBlockNumber),
      sourceBlockTimestamp: new Date(Number(sourceBlock.header.globalVariables.timestamp) * 1000)
        .toISOString()
        .replace('.000Z', 'Z'),
      operations,
    });

    const operation = operations[0]!;
    const verified = await verifyWithdrawalInTx(
      this.node,
      await this.portal.getPortalDomain(),
      { txHash: sourceTxHash, finalizationData: decodeFinalizationData(operation.calldata) },
    );
    this.operation = operation;
    const witness = await this.node.getL2ToL1MembershipWitness(
      sourceTxHash,
      verified.messageHash,
      verified.messageIndexInTx,
    );
    if (!witness) {
      throw new Error('Exact-operation source event has no finalized Outbox witness');
    }
    if (witness.leafIndex.toString() !== approval.operation.outboxWitness.leafIndex) {
      throw new Error('Exact-operation Outbox leaf index differs from the approved witness');
    }
    return observation;
  }

  exactOperation(): BroadcastL1Operation {
    if (!this.operation) {
      throw new Error('Exact-operation source evidence has not been observed');
    }
    return this.operation;
  }
}
