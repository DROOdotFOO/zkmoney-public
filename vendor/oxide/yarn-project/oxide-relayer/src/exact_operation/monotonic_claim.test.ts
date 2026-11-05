import { describe, expect, it, jest } from '@jest/globals';
import { ListObjectVersionsCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import type { ExactOperationApproval } from './contract.js';
import {
  ExactApprovalClaimCollisionError,
  type ExactApprovalClaimStore,
  consumeExactApprovalExternally,
  exactApprovalClaimKey,
  S3ExactApprovalClaimStore,
} from './monotonic_claim.js';

const approval: ExactOperationApproval = {
  schema: 'oxide-relayer.exact-operation.v2',
  approvalNonce: `0x${'aa'.repeat(32)}`,
  runtime: {
    host: 'relayer-1',
    sourceCommit: 'a'.repeat(40),
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
    rollupVersion: '6',
    portal: `0x${'33'.repeat(20)}`,
    l2Token: `0x${'44'.repeat(32)}`,
    broadcaster: `0x${'55'.repeat(32)}`,
    operationExecutor: `0x${'66'.repeat(20)}`,
  },
  operation: {
    id: `0x${'77'.repeat(32)}`,
    kind: 'withdrawal_finalization',
    sourceTxHash: `0x${'88'.repeat(32)}`,
    sourceBlockNumber: '100',
    sourceBlockHash: `0x${'99'.repeat(32)}`,
    sourceFinalized: true,
    sourceEventCount: 1,
    target: `0x${'ab'.repeat(20)}`,
    payoutToken: `0x${'bc'.repeat(20)}`,
    calldataSha256: `0x${'cd'.repeat(32)}`,
  },
  withdrawal: {
    executor: `0x${'de'.repeat(20)}`,
    recipientCommitment: `0x${'ef'.repeat(32)}`,
    amount: '1000',
    proverTip: '1',
    relayerTip: '2',
  },
  economics: {
    executorVersion: 'legacy',
    minimumPayout: '0',
    maximumGasToCover: '0',
    tokenWeiPerEth: '0',
    maximumGas: '100000',
    maximumFeePerGas: '100',
    maximumPriorityFeePerGas: '2',
    maximumTotalFee: '10000000',
  },
};

class MemoryClaimStore implements ExactApprovalClaimStore {
  readonly claims = new Map<string, { checksumSha256: string; retainUntil: Date; versionId: string }>();
  unavailable = false;

  async assertComplianceRetention(): Promise<void> {
    if (this.unavailable) throw new Error('unavailable');
  }

  async createIfAbsent(args: {
    key: string;
    body: string;
    checksumSha256: string;
    retainUntil: Date;
  }): Promise<{ versionId: string }> {
    if (this.unavailable) throw new Error('unavailable');
    if (this.claims.has(args.key)) throw new ExactApprovalClaimCollisionError();
    const versionId = `version-${this.claims.size + 1}`;
    this.claims.set(args.key, { checksumSha256: args.checksumSha256, retainUntil: args.retainUntil, versionId });
    return { versionId };
  }

  async verify(args: {
    key: string;
    versionId: string;
    checksumSha256: string;
    retainUntil: Date;
  }): Promise<void> {
    if (this.unavailable) throw new Error('unavailable');
    const claim = this.claims.get(args.key);
    if (
      claim?.versionId !== args.versionId ||
      claim.checksumSha256 !== args.checksumSha256 ||
      claim.retainUntil.getTime() < args.retainUntil.getTime()
    ) {
      throw new Error('verification failed');
    }
  }
}

describe('external exact-operation approval consumption', () => {
  it('uses one conditional claim and permanently refuses a collision', async () => {
    const store = new MemoryClaimStore();
    const first = await consumeExactApprovalExternally(approval, store);
    expect(first.key).toBe(exactApprovalClaimKey(approval));
    await expect(consumeExactApprovalExternally(approval, store)).rejects.toBeInstanceOf(
      ExactApprovalClaimCollisionError,
    );
  });

  it('fails before eligibility when the authority is unavailable', async () => {
    const store = new MemoryClaimStore();
    store.unavailable = true;
    await expect(consumeExactApprovalExternally(approval, store)).rejects.toThrow('unavailable');
  });

  it('uses S3 If-None-Match rather than a read-then-write claim', async () => {
    const send = jest.fn(async command => {
      if (command instanceof PutObjectCommand) {
        expect(command.input.IfNoneMatch).toBe('*');
        throw Object.assign(new Error('collision'), { $metadata: { httpStatusCode: 412 } });
      }
      return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } };
    });
    const store = new S3ExactApprovalClaimStore(
      { bucket: 'oxide-approval-witness', region: 'us-east-1', expectedOwner: '123456789012' },
      { client: { send } as unknown as S3Client },
    );
    await expect(consumeExactApprovalExternally(approval, store)).rejects.toBeInstanceOf(
      ExactApprovalClaimCollisionError,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('refuses a hidden retained version or delete marker after conditional creation', async () => {
    const send = jest.fn(async command => {
      if (command instanceof PutObjectCommand) return { VersionId: 'new-version' };
      if (command instanceof ListObjectVersionsCommand) {
        return {
          IsTruncated: false,
          Versions: [
            { Key: exactApprovalClaimKey(approval), VersionId: 'retained-version' },
            { Key: exactApprovalClaimKey(approval), VersionId: 'new-version' },
          ],
          DeleteMarkers: [{ Key: exactApprovalClaimKey(approval), VersionId: 'delete-marker' }],
        };
      }
      return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } };
    });
    const store = new S3ExactApprovalClaimStore(
      { bucket: 'oxide-approval-witness', region: 'us-east-1', expectedOwner: '123456789012' },
      { client: { send } as unknown as S3Client },
    );

    await expect(consumeExactApprovalExternally(approval, store)).rejects.toBeInstanceOf(
      ExactApprovalClaimCollisionError,
    );
  });

  it('keeps recipient linkage out of the object key and body', async () => {
    const store = new MemoryClaimStore();
    const receipt = await consumeExactApprovalExternally(approval, store);
    expect(receipt.key).not.toContain(approval.withdrawal.executor);
    expect(receipt.key).not.toContain(approval.withdrawal.recipientCommitment);
    expect(receipt.body).not.toContain(approval.withdrawal.executor);
    expect(receipt.body).not.toContain(approval.withdrawal.recipientCommitment);
  });
});
