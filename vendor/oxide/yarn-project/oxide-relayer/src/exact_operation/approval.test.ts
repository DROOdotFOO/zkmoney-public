import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { assertExactApprovalToken, exactApprovalTokenCommitment, signExactApproval } from './approval.js';
import { exactApprovalFixture } from './test_fixture.js';

const approval = exactApprovalFixture();

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
    expect(exactApprovalTokenCommitment(token)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(exactApprovalTokenCommitment(token)).not.toContain(approval.approvalNonce);
  });

  it('rejects legacy enable phrases and non-Ed25519 token encodings', () => {
    const authority = generateKeyPairSync('ed25519');
    expect(() => assertExactApprovalToken(approval, 'ENABLE EXACT OPERATION', authority.publicKey)).toThrow(/malformed/);
  });
});
