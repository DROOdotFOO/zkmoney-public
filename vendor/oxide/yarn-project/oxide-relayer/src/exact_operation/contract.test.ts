import { describe, expect, it } from '@jest/globals';

import {
  assertExactOperationMatches,
  parseExactOperationApproval,
  type ExactOperationApproval,
} from './contract.js';
import { approvedSigningChainId } from './execution.js';

const approval: ExactOperationApproval = {
  schema: 'oxide-relayer.exact-operation.v1',
  runtime: {
    host: 'ovh-ubuntu1',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    imageDigest: `sha256:${'11'.repeat(32)}`,
    stateSetDigest: `sha256:${'22'.repeat(32)}`,
  },
  deployment: {
    label: 'dep-v6',
    chainId: '1',
    rollupVersion: '2070860440',
    portal: '0x1111111111111111111111111111111111111111',
    l2Token: `0x${'22'.repeat(32)}`,
    broadcaster: `0x${'33'.repeat(32)}`,
    operationExecutor: '0x4444444444444444444444444444444444444444',
  },
  operation: {
    id: `0x${'55'.repeat(32)}`,
    kind: 'withdrawal_finalization',
    sourceTxHash: `0x${'66'.repeat(32)}`,
    sourceBlockNumber: '1234',
    sourceBlockHash: `0x${'77'.repeat(32)}`,
    sourceFinalized: true,
    sourceEventCount: 1,
    target: '0x1111111111111111111111111111111111111111',
    payoutToken: '0x8888888888888888888888888888888888888888',
    calldataSha256: `0x${'99'.repeat(32)}`,
  },
  withdrawal: {
    executor: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    recipientCommitment: `0x${'bb'.repeat(32)}`,
    amount: '1000000000000000000',
    proverTip: '1000000000000000',
    relayerTip: '2000000000000000',
  },
  economics: {
    executorVersion: 'gas-to-cover',
    minimumPayout: '1',
    maximumGasToCover: '500000',
    tokenWeiPerEth: '1000000000000000000',
    maximumGas: '1000000',
    maximumFeePerGas: '30000000000',
    maximumPriorityFeePerGas: '2000000000',
    maximumTotalFee: '30000000000000000',
  },
};

describe('assertExactOperationMatches', () => {
  it('accepts one exact finalized withdrawal operation', () => {
    expect(() => assertExactOperationMatches(approval, structuredClone(approval))).not.toThrow();
  });

  it('rejects unreviewed fields', () => {
    expect(() => parseExactOperationApproval({ ...approval, modes: ['l1-operations'] })).toThrow(/unrecognized/i);
  });

  it('requires the exact source event to be finalized', () => {
    const finalized = {
      ...approval,
      operation: { ...approval.operation, sourceFinalized: true },
    };
    expect(parseExactOperationApproval(finalized).operation.sourceFinalized).toBe(true);
    expect(() =>
      parseExactOperationApproval({
        ...finalized,
        operation: { ...finalized.operation, sourceFinalized: false },
      }),
    ).toThrow();
  });
});

describe('approvedSigningChainId', () => {
  it('uses only the startup-verified approved chain', () => {
    expect(approvedSigningChainId(approval, 1)).toBe(1);
    expect(() => approvedSigningChainId(approval, 11155111)).toThrow(/approved chain/);
  });
});
