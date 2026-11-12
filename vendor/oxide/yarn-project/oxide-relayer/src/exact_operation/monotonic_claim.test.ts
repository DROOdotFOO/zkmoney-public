import { describe, expect, it, jest } from '@jest/globals';
import { ListObjectVersionsCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import {
  ExactApprovalClaimCollisionError,
  type ExactApprovalClaimReceipt,
  type ExactApprovalClaimStore,
  consumeExactApprovalExternally,
  exactApprovalClaimKey,
  S3ExactApprovalClaimStore,
} from './monotonic_claim.js';
import { exactApprovalFixture } from './test_fixture.js';

const approval = exactApprovalFixture();
const approvalCommitment = `sha256:${'ca'.repeat(32)}` as const;
const approvalLive = () => {};

class MemoryClaimStore implements ExactApprovalClaimStore {
  readonly claims = new Map<string, { body: string; checksumSha256: string; retainUntil: Date; versionId: string }>();
  unavailable = false;

  async assertComplianceRetention(): Promise<void> {
    if (this.unavailable) throw new Error('unavailable');
  }

  async createIfAbsent(
    args: {
      key: string;
      body: string;
      checksumSha256: string;
      retainUntil: Date;
    },
    assertApprovalWindow: () => void,
  ): Promise<{ versionId: string }> {
    assertApprovalWindow();
    if (this.unavailable) throw new Error('unavailable');
    if (this.claims.has(args.key)) throw new ExactApprovalClaimCollisionError();
    const versionId = `version-${this.claims.size + 1}`;
    this.claims.set(args.key, {
      body: args.body,
      checksumSha256: args.checksumSha256,
      retainUntil: args.retainUntil,
      versionId,
    });
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

  async readExisting(key: string): Promise<ExactApprovalClaimReceipt> {
    const claim = this.claims.get(key);
    if (!claim) throw new ExactApprovalClaimCollisionError();
    return {
      key,
      versionId: claim.versionId,
      checksumSha256: claim.checksumSha256,
      retainUntil: claim.retainUntil.toISOString(),
      body: claim.body,
    };
  }
}

describe('external exact-operation approval consumption', () => {
  it('uses one conditional claim and permanently refuses a collision', async () => {
    const store = new MemoryClaimStore();
    const first = await consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive);
    expect(first.key).toBe(exactApprovalClaimKey(approval, approvalCommitment));
    await expect(
      consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive),
    ).rejects.toBeInstanceOf(
      ExactApprovalClaimCollisionError,
    );
  });

  it('adopts only its own claim, and only when the journal holds its intent', async () => {
    const store = new MemoryClaimStore();
    const first = await consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive);
    await expect(
      consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive, { adoptOwnClaim: true }),
    ).resolves.toEqual(first);

    const otherCommitment = `sha256:${'cb'.repeat(32)}` as const;
    await expect(
      consumeExactApprovalExternally(approval, otherCommitment, store, approvalLive, { adoptOwnClaim: true }),
    ).rejects.toBeInstanceOf(ExactApprovalClaimCollisionError);
  });

  it('fails before eligibility when the authority is unavailable', async () => {
    const store = new MemoryClaimStore();
    store.unavailable = true;
    await expect(
      consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive),
    ).rejects.toThrow('unavailable');
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
    await expect(
      consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive),
    ).rejects.toBeInstanceOf(
      ExactApprovalClaimCollisionError,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rechecks the approval window immediately before the immutable PutObject', async () => {
    const send = jest.fn(async (_command: unknown) => ({
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
    }));
    const store = new S3ExactApprovalClaimStore(
      { bucket: 'oxide-approval-witness', region: 'us-east-1', expectedOwner: '123456789012' },
      { client: { send } as unknown as S3Client },
    );

    await expect(
      consumeExactApprovalExternally(approval, approvalCommitment, store, () => {
        throw new Error('approval execution window expired');
      }),
    ).rejects.toThrow('approval execution window expired');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('refuses a hidden retained version or delete marker after conditional creation', async () => {
    const send = jest.fn(async command => {
      if (command instanceof PutObjectCommand) return { VersionId: 'new-version' };
      if (command instanceof ListObjectVersionsCommand) {
        return {
          IsTruncated: false,
          Versions: [
            { Key: exactApprovalClaimKey(approval, approvalCommitment), VersionId: 'retained-version' },
            { Key: exactApprovalClaimKey(approval, approvalCommitment), VersionId: 'new-version' },
          ],
          DeleteMarkers: [
            { Key: exactApprovalClaimKey(approval, approvalCommitment), VersionId: 'delete-marker' },
          ],
        };
      }
      return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } };
    });
    const store = new S3ExactApprovalClaimStore(
      { bucket: 'oxide-approval-witness', region: 'us-east-1', expectedOwner: '123456789012' },
      { client: { send } as unknown as S3Client },
    );

    await expect(
      consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive),
    ).rejects.toBeInstanceOf(
      ExactApprovalClaimCollisionError,
    );
  });

  it('keeps recipient linkage and approval nonce out of the object key and body', async () => {
    const store = new MemoryClaimStore();
    const receipt = await consumeExactApprovalExternally(approval, approvalCommitment, store, approvalLive);
    expect(receipt.key).not.toContain(approval.withdrawal.executor);
    expect(receipt.key).not.toContain(approval.withdrawal.recipientCommitment);
    expect(receipt.key).not.toContain(approval.approvalNonce);
    expect(receipt.body).not.toContain(approval.withdrawal.executor);
    expect(receipt.body).not.toContain(approval.withdrawal.recipientCommitment);
    expect(receipt.body).not.toContain(approval.approvalNonce);
    expect(JSON.parse(receipt.body)).toMatchObject({ approvalCommitment });
  });

  it('uses one operation lock across fresh approval nonces and runtime state', () => {
    const freshApproval = structuredClone(approval);
    freshApproval.approvalNonce = `0x${'dd'.repeat(32)}`;
    freshApproval.runtime.stateInventoryDigest = `sha256:${'ee'.repeat(32)}`;
    expect(exactApprovalClaimKey(freshApproval, `sha256:${'ff'.repeat(32)}`)).toBe(
      exactApprovalClaimKey(approval, approvalCommitment),
    );
  });
});
