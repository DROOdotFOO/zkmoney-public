import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { assertExactApprovalToken, signExactApproval } from './approval.js';
import type { ExactOperationApproval } from './contract.js';

const approval: ExactOperationApproval = {
  schema: 'oxide-relayer.exact-operation.v2',
  approvalNonce: `0x${'aa'.repeat(32)}`,
  runtime: {
    host: 'ovh-ubuntu1',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    imageDigest: `sha256:${'11'.repeat(32)}`,
    schemaIdentity: 'oxide-relayer.sqlite.portal-v4+exact-v2+generic-v1+lease-v1',
    stateInventoryDigest: `sha256:${'22'.repeat(32)}`,
    canonicalStateDigest: `sha256:${'33'.repeat(32)}`,
  },
  witness: {
    bucket: 'oxide-approval-witness',
    region: 'us-east-1',
    expectedOwner: '123456789012',
    prefix: 'oxide-relayer/production',
    retentionMode: 'COMPLIANCE',
    retainUntil: '9999-12-31T23:59:59.000Z',
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

describe('exact operation approval signature', () => {
  it('requires the reviewed authority and binds every reviewed identity', () => {
    const authority = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const token = signExactApproval(approval, authority.privateKey);
    expect(() => assertExactApprovalToken(approval, token, authority.publicKey)).not.toThrow();
    expect(() => assertExactApprovalToken(approval, token, attacker.publicKey)).toThrow(/reviewed authority/);
    expect(() =>
      assertExactApprovalToken(
        { ...approval, operation: { ...approval.operation, id: `0x${'ff'.repeat(32)}` } },
        token,
        authority.publicKey,
      ),
    ).toThrow(/reviewed authority/);
  });
});
