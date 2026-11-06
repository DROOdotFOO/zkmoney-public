import { createHash } from 'node:crypto';

import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { TxHash } from '@aztec-labs/stdlib/tx';

import {
  L1OperationCondition,
  computeL1OperationId,
  type BroadcastL1Operation,
} from '@oxide/oxide-lib/l1_operation_calldata.js';
import { encodeMigrationPayload } from '@oxide/oxide-lib/migration_executor.js';
import { encodeFinalizationData } from '@oxide/oxide-lib/withdrawal_finalization_data.js';

import { describe, expect, it } from '@jest/globals';

import type { ExactOperationApproval } from './contract.js';
import { deriveExactOperationObservation, deriveOutboxEvidence } from './evidence.js';
import { exactApprovalFixture } from './test_fixture.js';

const portal = EthAddress.fromString('0x1111111111111111111111111111111111111111');
const payoutToken = EthAddress.fromString('0x8888888888888888888888888888888888888888');
const executor = EthAddress.fromString('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const sourceTxHash = TxHash.fromString(`0x${'11'.repeat(32)}`);
const recipientCommitment = new Fr(123n);
const operation: BroadcastL1Operation = {
  target: portal,
  payoutToken,
  condition: L1OperationCondition.messageInOutbox(),
  calldata: encodeFinalizationData({
    executor,
    amount: 1_000_000n,
    proverTip: 1_000n,
    randomness: new Fr(456n),
    withdrawalSignature: { sLo: Fr.ONE, sHi: Fr.ONE, rLo: Fr.ONE, rHi: Fr.ONE },
    userPayload: encodeMigrationPayload({ recipientCommitment, relayerTip: 2_000n }),
  }),
};
const operationId = computeL1OperationId(operation, sourceTxHash);
const outboxMessageHash = new Fr(789n);
const outboxWitness = { leafIndex: 0n, siblingPath: [new Fr(321n)] };
const baseApproval = exactApprovalFixture();
const approval: ExactOperationApproval = {
  ...baseApproval,
  deployment: {
    ...baseApproval.deployment,
    portal: portal.toString().toLowerCase(),
  },
  operation: {
    ...baseApproval.operation,
    id: operationId,
    sourceTxHash: sourceTxHash.toString(),
    sourceBlockNumber: '1234',
    sourceBlockHash: `0x${'77'.repeat(32)}`,
    target: portal.toString().toLowerCase(),
    payoutToken: payoutToken.toString().toLowerCase(),
    calldataSha256: `0x${createHash('sha256').update(operation.calldata).digest('hex')}`,
  },
  withdrawal: {
    executor: executor.toString().toLowerCase(),
    recipientCommitment: recipientCommitment.toString(),
    amount: '1000000',
    proverTip: '1000',
    relayerTip: '2000',
  },
  economics: {
    executorVersion: 'gas-to-cover',
    minimumPayout: '1',
    minimumProceeds: '1',
    executorFeeCeiling: '30000000000000000',
    maximumGasToCover: '500000',
    tokenWeiPerEth: '1000000000000000000',
    maximumGas: '1000000',
    maximumFeePerGas: '30000000000',
    maximumPriorityFeePerGas: '2000000000',
    maximumTotalFee: '30000000000000000',
  },
};
const operationCall = {
  operation,
  broadcasterContract: approval.deployment.broadcaster as `0x${string}`,
  eventSelector: approval.operation.broadcasterEvent.eventSignature as `0x${string}`,
  callIndex: 0,
  callSha256: approval.operation.broadcasterEvent.callSha256 as `0x${string}`,
};


function evidence(overrides: Record<string, unknown> = {}) {
  return {
    runtime: approval.runtime,
    deployment: approval.deployment,
    economics: approval.economics,
    sourceTxHash,
    sourceBlockNumber: 1234n,
    sourceBlockHash: approval.operation.sourceBlockHash,
    sourceBlockTimestamp: approval.operation.sourceBlockTimestamp,
    provenBlockNumber: 1234n,
    operationCalls: [operationCall],
    outboxMessageHash,
    outboxWitness,
    ...overrides,
  };
}

async function expected(overrides: Partial<ExactOperationApproval> = {}): Promise<ExactOperationApproval> {
  const reviewed = structuredClone({ ...approval, ...overrides });
  reviewed.operation.outboxWitness = await deriveOutboxEvidence(outboxMessageHash, outboxWitness);
  return reviewed;
}

describe('deriveExactOperationObservation', () => {
  it('derives one finalized withdrawal operation from exact source evidence', async () => {
    const reviewed = await expected();
    await expect(deriveExactOperationObservation(reviewed, evidence())).resolves.toEqual(reviewed);
  });

  it('fails when the operation targets another portal', async () => {
    const wrong = { ...operation, target: EthAddress.fromString('0x9999999999999999999999999999999999999999') };
    await expect(
      deriveExactOperationObservation(await expected(), evidence({ operationCalls: [{ ...operationCall, operation: wrong }] })),
    ).rejects.toThrow(/portal/);
  });

  it('fails when source evidence belongs to another deployment', async () => {
    await expect(
      deriveExactOperationObservation(
        await expected({ deployment: { ...approval.deployment, broadcaster: `0x${'44'.repeat(32)}` } }),
        evidence(),
      ),
    ).rejects.toThrow(/deployment.broadcaster/);
  });

  it('fails when the source transaction changes the operation ID', async () => {
    await expect(
      deriveExactOperationObservation(
        await expected(),
        evidence({ sourceTxHash: TxHash.fromString(`0x${'22'.repeat(32)}`) }),
      ),
    ).rejects.toThrow(/operation.id/);
  });

  it('fails when the finalized source event block identity changes', async () => {
    await expect(
      deriveExactOperationObservation(await expected(), evidence({ sourceBlockHash: `0x${'ab'.repeat(32)}` })),
    ).rejects.toThrow(/operation.sourceBlockHash/);
  });
  it.each<[string, (reviewed: ExactOperationApproval) => void]>([
    [
      'deployment registry',
      (reviewed: ExactOperationApproval) => {
        reviewed.deployment.registry = `0x${'31'.repeat(20)}`;
      },
    ],
    [
      'manifest digest',
      (reviewed: ExactOperationApproval) => {
        reviewed.deployment.manifestDigest = `sha256:${'32'.repeat(32)}`;
      },
    ],
    [
      'broadcaster contract',
      (reviewed: ExactOperationApproval) => {
        reviewed.operation.broadcasterEvent.contract = `0x${'33'.repeat(32)}`;
      },
    ],
    [
      'broadcaster selector',
      (reviewed: ExactOperationApproval) => {
        reviewed.operation.broadcasterEvent.eventSignature = `0x${'34'.repeat(32)}`;
      },
    ],
    [
      'broadcaster call index',
      (reviewed: ExactOperationApproval) => {
        reviewed.operation.broadcasterEvent.logIndex = '1';
      },
    ],
    [
      'broadcaster call digest',
      (reviewed: ExactOperationApproval) => {
        reviewed.operation.broadcasterEvent.callSha256 = `0x${'35'.repeat(32)}`;
      },
    ],
    [
      'Outbox root',
      (reviewed: ExactOperationApproval) => {
        reviewed.operation.outboxWitness.root = `0x${'36'.repeat(32)}`;
      },
    ],
    [
      'Outbox proof digest',
      (reviewed: ExactOperationApproval) => {
        reviewed.operation.outboxWitness.proofDigest = `sha256:${'37'.repeat(32)}`;
      },
    ],
    [
      'recipient commitment',
      (reviewed: ExactOperationApproval) => {
        reviewed.withdrawal.recipientCommitment = `0x${'38'.repeat(32)}`;
      },
    ],
    [
      'withdrawal amount',
      (reviewed: ExactOperationApproval) => {
        reviewed.withdrawal.amount = '1000001';
      },
    ],
    [
      'approved economics',
      (reviewed: ExactOperationApproval) => {
        reviewed.economics.maximumGas = '999999';
      },
    ],
  ])('fails when signed %s is substituted', async (_label, substitute) => {
    const reviewed = await expected();
    substitute(reviewed);
    await expect(deriveExactOperationObservation(reviewed, evidence())).rejects.toThrow(/mismatch/);
  });


  it('fails before finality', async () => {
    await expect(
      deriveExactOperationObservation(await expected(), evidence({ provenBlockNumber: 1233n })),
    ).rejects.toThrow(/not proven/);
  });

  it('fails when a second matching operation exists', async () => {
    await expect(
      deriveExactOperationObservation(
        await expected(),
        evidence({ operationCalls: [operationCall, operationCall] }),
      ),
    ).rejects.toThrow(/exactly one/);
  });
});
