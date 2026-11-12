import { describe, expect, it } from '@jest/globals';

import {
  assertExactApprovalWindow,
  assertExactOperationMatches,
  parseExactOperationApproval,
} from './contract.js';
import { approvedSigningChainId } from './execution.js';
import { exactApprovalFixture } from './test_fixture.js';

const approval = exactApprovalFixture();

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

  it('enforces the signed v4 window and maximum duration', () => {
    expect(() => assertExactApprovalWindow(approval, new Date())).not.toThrow();
    expect(() =>
      assertExactApprovalWindow(
        { ...approval, notBefore: '2026-11-06T00:00:00Z', expiresAt: '2026-11-06T04:00:01Z' },
        new Date('2026-11-06T01:00:00Z'),
      ),
    ).toThrow(/execution window/);
    expect(() => assertExactApprovalWindow(approval, new Date(approval.expiresAt))).toThrow(/execution window/);
  });

  it('binds every Stage A identity field', () => {
    expect(() =>
      assertExactOperationMatches(approval, {
        ...approval,
        stageA: { ...approval.stageA, approvalDigest: `sha256:${'ff'.repeat(32)}` },
      }),
    ).toThrow(/stageA.approvalDigest/);
  });

  it('requires the dedicated runtime UID and GID in the signed v4 contract', () => {
    expect(parseExactOperationApproval(approval).runtime).toMatchObject({ runtimeUid: 65532, runtimeGid: 65532 });
    expect(() =>
      parseExactOperationApproval({
        ...approval,
        runtime: { ...approval.runtime, runtimeUid: 1000, runtimeGid: 1000 },
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
