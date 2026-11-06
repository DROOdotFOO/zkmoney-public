import { createHash } from 'node:crypto';
import { DomainSeparator } from '@aztec-labs/constants';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';

import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import {
  L1OperationConditionKind,
  computeL1OperationId,
  type BroadcastL1OperationCall,
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
  sourceBlockTimestamp: string;
  /** The current proven L2 tip; proven inclusion is the fail-closed finality boundary. */
  provenBlockNumber: bigint;
  /** Operations and source-call identities extracted only from the named transaction and deployment broadcaster. */
  operationCalls: BroadcastL1OperationCall[];
  outboxMessageHash: Fr;
  outboxWitness: { leafIndex: bigint; siblingPath: readonly Fr[] };
}

export async function deriveExactOperationObservation(
  approval: ExactOperationApproval,
  evidence: ExactSourceEvidence,
): Promise<ExactOperationObservation> {
  if (evidence.provenBlockNumber < evidence.sourceBlockNumber) {
    throw new Error(
      `Exact-operation source block ${evidence.sourceBlockNumber} is not proven; proven tip is ${evidence.provenBlockNumber}`,
    );
  }
  if (evidence.operationCalls.length !== 1) {
    throw new Error(
      `Exact-operation source must contain exactly one deployment operation; found ${evidence.operationCalls.length}`,
    );
  }

  const observedCall = evidence.operationCalls[0]!;
  const operation = observedCall.operation;
  const portal = EthAddress.fromString(evidence.deployment.portal);
  if (!operation.target.equals(portal)) {
    throw new Error('Exact-operation target does not match the reviewed deployment portal');
  }
  if (operation.condition.kind !== L1OperationConditionKind.MessageInOutbox) {
    throw new Error('Exact-operation withdrawal must be conditioned on its Outbox message');
  }

  const finalization = decodeFinalizationData(operation.calldata);
  const migration = decodeMigrationPayload(finalization.userPayload);
  const outbox = await deriveOutboxEvidence(evidence.outboxMessageHash, evidence.outboxWitness);
  const observation: ExactOperationObservation = {
    ...approval,
    runtime: evidence.runtime,
    deployment: evidence.deployment,
    operation: {
      id: computeL1OperationId(operation, evidence.sourceTxHash),
      kind: 'withdrawal_finalization',
      sourceTxHash: evidence.sourceTxHash.toString().toLowerCase(),
      sourceBlockNumber: evidence.sourceBlockNumber.toString(),
      sourceBlockHash: evidence.sourceBlockHash.toLowerCase(),
      sourceBlockTimestamp: evidence.sourceBlockTimestamp,
      sourceFinalized: true,
      sourceEventCount: 1,
      target: operation.target.toString().toLowerCase(),
      payoutToken: operation.payoutToken.toString().toLowerCase(),
      calldataSha256: `0x${createHash('sha256').update(operation.calldata).digest('hex')}`,
      broadcasterEvent: {
        contract: observedCall.broadcasterContract,
        eventSignature: observedCall.eventSelector,
        logIndex: observedCall.callIndex.toString(),
        callSha256: observedCall.callSha256,
      },
      outboxWitness: outbox,
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

/**
 * Canonical witness evidence. Root is Poseidon2 MERKLE_HASH(message, siblings leaf-first). The proof digest is
 * SHA-256 over the UTF-8 domain `oxide/exact-operation-outbox-proof/v1\0`, the 32-byte message field, a 32-byte
 * big-endian leaf index, a 4-byte big-endian sibling count, then each 32-byte sibling field in leaf-to-root order.
 */
export async function deriveOutboxEvidence(
  messageHash: Fr,
  witness: { leafIndex: bigint; siblingPath: readonly Fr[] },
): Promise<ExactOperationApproval['operation']['outboxWitness']> {
  if (witness.leafIndex < 0n || witness.leafIndex >= 1n << BigInt(witness.siblingPath.length)) {
    throw new Error('Exact-operation Outbox witness leaf index is outside its sibling path');
  }
  let root = messageHash;
  let index = witness.leafIndex;
  for (const sibling of witness.siblingPath) {
    root =
      (index & 1n) === 1n
        ? await poseidon2HashWithSeparator([sibling, root], DomainSeparator.MERKLE_HASH)
        : await poseidon2HashWithSeparator([root, sibling], DomainSeparator.MERKLE_HASH);
    index >>= 1n;
  }

  const leafIndex = Buffer.alloc(32);
  leafIndex.writeBigUInt64BE(witness.leafIndex, 24);
  const pathLength = Buffer.alloc(4);
  pathLength.writeUInt32BE(witness.siblingPath.length);
  const proofDigest = createHash('sha256')
    .update('oxide/exact-operation-outbox-proof/v1\0')
    .update(messageHash.toBuffer())
    .update(leafIndex)
    .update(pathLength);
  for (const sibling of witness.siblingPath) proofDigest.update(sibling.toBuffer());
  return {
    root: root.toString().toLowerCase(),
    leafIndex: witness.leafIndex.toString(),
    proofDigest: `sha256:${proofDigest.digest('hex')}`,
  };
}
