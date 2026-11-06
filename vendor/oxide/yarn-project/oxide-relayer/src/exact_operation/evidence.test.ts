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
import { deriveExactOperationObservation } from './evidence.js';
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
    operations: [operation],
    ...overrides,
  };
}

function expected(overrides: Partial<ExactOperationApproval> = {}): ExactOperationApproval {
  return structuredClone({ ...approval, ...overrides });
}

describe('deriveExactOperationObservation', () => {
  it('derives one finalized withdrawal operation from exact source evidence', () => {
    expect(deriveExactOperationObservation(expected(), evidence())).toEqual(approval);
  });

  it('fails when the operation targets another portal', () => {
    const wrong = { ...operation, target: EthAddress.fromString('0x9999999999999999999999999999999999999999') };
    expect(() => deriveExactOperationObservation(expected(), evidence({ operations: [wrong] }))).toThrow(/portal/);
  });

  it('fails when source evidence belongs to another deployment', () => {
    expect(() =>
      deriveExactOperationObservation(
        expected({ deployment: { ...approval.deployment, broadcaster: `0x${'44'.repeat(32)}` } }),
        evidence(),
      ),
    ).toThrow(/deployment.broadcaster/);
  });

  it('fails when the source transaction changes the operation ID', () => {
    expect(() =>
      deriveExactOperationObservation(
        expected(),
        evidence({ sourceTxHash: TxHash.fromString(`0x${'22'.repeat(32)}`) }),
      ),
    ).toThrow(/operation.id/);
  });
  it('fails when the finalized source event block identity changes', () => {
    expect(() =>
      deriveExactOperationObservation(expected(), evidence({ sourceBlockHash: `0x${'ab'.repeat(32)}` })),
    ).toThrow(/operation.sourceBlockHash/);
  });


  it('fails before finality', () => {
    expect(() => deriveExactOperationObservation(expected(), evidence({ provenBlockNumber: 1233n }))).toThrow(/not proven/);
  });

  it('fails when a second matching operation exists', () => {
    expect(() => deriveExactOperationObservation(expected(), evidence({ operations: [operation, operation] }))).toThrow(
      /exactly one/,
    );
  });
});
