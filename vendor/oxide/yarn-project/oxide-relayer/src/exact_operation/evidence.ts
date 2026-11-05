import { createHash } from 'node:crypto';

import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import {
  L1OperationConditionKind,
  computeL1OperationId,
  type BroadcastL1Operation,
} from '@oxide/oxide-lib/l1_operation_calldata.js';
import { decodeMigrationPayload } from '@oxide/oxide-lib/migration_executor.js';
import { decodeFinalizationData } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import {
  type ExactDeploymentIdentity,
  type ExactOperationApproval,
  type ExactOperationEconomics,
  type ExactOperationObservation,
  type ExactOperationRuntimeIdentity,
  assertExactOperationMatches,
} from './contract.js';

export interface ExactSourceEvidence {
  runtime: ExactOperationRuntimeIdentity;
  deployment: ExactDeploymentIdentity;
  economics: ExactOperationEconomics;
  sourceTxHash: TxHash;
  sourceBlockNumber: bigint;
  sourceBlockHash: string;
  /** The current proven L2 tip; proven inclusion is the fail-closed finality boundary. */
  provenBlockNumber: bigint;
  /** Operations extracted only from the named transaction and named deployment broadcaster. */
  operations: BroadcastL1Operation[];
}

export function deriveExactOperationObservation(
  approval: ExactOperationApproval,
  evidence: ExactSourceEvidence,
): ExactOperationObservation {
  if (evidence.provenBlockNumber < evidence.sourceBlockNumber) {
    throw new Error(
      `Exact-operation source block ${evidence.sourceBlockNumber} is not proven; proven tip is ${evidence.provenBlockNumber}`,
    );
  }
  if (evidence.operations.length !== 1) {
    throw new Error(`Exact-operation source must contain exactly one deployment operation; found ${evidence.operations.length}`);
  }

  const operation = evidence.operations[0]!;
  const portal = EthAddress.fromString(evidence.deployment.portal);
  if (!operation.target.equals(portal)) {
    throw new Error('Exact-operation target does not match the reviewed deployment portal');
  }
  if (operation.condition.kind !== L1OperationConditionKind.MessageInOutbox) {
    throw new Error('Exact-operation withdrawal must be conditioned on its Outbox message');
  }

  const finalization = decodeFinalizationData(operation.calldata);
  const migration = decodeMigrationPayload(finalization.userPayload);
  const observation: ExactOperationObservation = {
    schema: 'oxide-relayer.exact-operation.v1',
    runtime: evidence.runtime,
    deployment: evidence.deployment,
    operation: {
      id: computeL1OperationId(operation, evidence.sourceTxHash),
      kind: 'withdrawal_finalization',
      sourceTxHash: evidence.sourceTxHash.toString().toLowerCase(),
      sourceBlockNumber: evidence.sourceBlockNumber.toString(),
      sourceBlockHash: evidence.sourceBlockHash.toLowerCase(),
      sourceFinalized: true,
      sourceEventCount: evidence.operations.length,
      target: operation.target.toString().toLowerCase(),
      payoutToken: operation.payoutToken.toString().toLowerCase(),
      calldataSha256: `0x${createHash('sha256').update(operation.calldata).digest('hex')}`,
    },
    withdrawal: {
      executor: finalization.executor.toString().toLowerCase(),
      recipientCommitment: migration.recipientCommitment.toString().toLowerCase(),
      amount: finalization.amount.toString(),
      proverTip: finalization.proverTip.toString(),
      relayerTip: migration.relayerTip.toString(),
    },
    economics: evidence.economics,
  };
  assertExactOperationMatches(approval, observation);
  return observation;
}
