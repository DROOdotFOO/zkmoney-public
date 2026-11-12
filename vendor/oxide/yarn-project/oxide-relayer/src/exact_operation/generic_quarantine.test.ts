import { describe, expect, it } from '@jest/globals';

import { EXACT_DATABASE_SCHEMA_IDENTITY } from './contract.js';
import type { ExactOperationRecord } from './journal.js';
import {
  evaluateGenericQuarantine,
  genericRestoreDigests,
  restoreRuntimeIdentitySchema,
  type RestoreMarker,
  type WitnessClaim,
} from './generic_quarantine.js';
import { exactApprovalClaimJournalReceipt } from './monotonic_claim.js';

const receipt = {
  key: 'oxide/exact/claim.json',
  versionId: 'immutable-version',
  checksumSha256: 'checksum',
  retainUntil: '9999-12-31T23:59:59.000Z',
  body: '{}',
};
const claim = {
  claim: {
    schema: 'oxide-relayer.exact-operation-consumption.v2' as const,
    approvalCommitment: `sha256:${'11'.repeat(32)}`,
    stageAApprovalDigest: `sha256:${'12'.repeat(32)}`,
    chainId: '1',
    rollupVersion: '2',
    deploymentLabel: 'reviewed',
    portal: `0x${'33'.repeat(20)}`,
    operationId: `0x${'44'.repeat(32)}`,
    sourceCommit: '55'.repeat(20),
    imageDigest: `sha256:${'66'.repeat(32)}`,
    targetHost: 'relayer-safe',
    signerAddress: `0x${'10'.repeat(20)}`,
    schemaIdentity: EXACT_DATABASE_SCHEMA_IDENTITY,
    stateInventoryDigest: `sha256:${'77'.repeat(32)}`,
    canonicalStateDigest: `sha256:${'88'.repeat(32)}`,
  },
  receipt,
} satisfies WitnessClaim;
const runtime = {
  schemaIdentity: EXACT_DATABASE_SCHEMA_IDENTITY,
  stateInventoryDigest: `sha256:${'77'.repeat(32)}`,
  canonicalStateDigest: `sha256:${'88'.repeat(32)}`,
};
const restoreRuntime = {
  host: 'relayer-safe',
  sourceCommit: '55'.repeat(20),
  imageDigest: `sha256:${'66'.repeat(32)}`,
  runtimeUid: 65532,
  runtimeGid: 65532,
  signerAddress: `0x${'10'.repeat(20)}`,
  ...runtime,
  expectedNonce: 7,
};

function record(state: ExactOperationRecord['state'] = 'confirmed'): ExactOperationRecord {
  return {
    state,
    operationId: claim.claim.operationId,
    approvalCommitment: claim.claim.approvalCommitment,
    stageAApprovalDigest: claim.claim.stageAApprovalDigest,
    signedTxHash: `0x${'99'.repeat(32)}`,
    l1TxHash: `0x${'99'.repeat(32)}`,
    witness: exactApprovalClaimJournalReceipt(receipt),
  };
}

function marker(records: ExactOperationRecord[]): RestoreMarker {
  return {
    schema: 'oxide-relayer.generic-restore-marker.v2',
    restoreEvidenceDigest: `sha256:${'aa'.repeat(32)}`,
    ...genericRestoreDigests([claim], records),
    ...runtime,
  };
}

describe('generic exact-operation quarantine', () => {
  it('accepts the signer-bound deployment runtime identity', () => {
    expect(restoreRuntimeIdentitySchema.parse(restoreRuntime)).toEqual(restoreRuntime);
  });

  it('rejects a restore runtime without the reviewed signer', () => {
    const { signerAddress: _, ...withoutSigner } = restoreRuntime;
    expect(() => restoreRuntimeIdentitySchema.parse(withoutSigner)).toThrow();
  });

  it('allows a never-cut-over runtime with no witness or local record', () => {
    expect(evaluateGenericQuarantine({ claims: [], records: [], runtime })).toEqual(new Set());
  });

  it('detects local-volume rollback from an external witness record', () => {
    expect(() => evaluateGenericQuarantine({ claims: [claim], records: [], runtime })).toThrow(
      'missing or inconsistent',
    );
  });

  it('fails closed when the local journal exists but the witness is missing', () => {
    expect(() => evaluateGenericQuarantine({ claims: [], records: [record()], runtime })).toThrow(
      'missing or inconsistent',
    );
  });

  it('fails closed when the journal witness-coordinate commitment differs', () => {
    const mismatched = record();
    mismatched.witness = {
      ...mismatched.witness,
      keyCommitment: `sha256:${'ff'.repeat(32)}`,
    };
    expect(() => evaluateGenericQuarantine({ claims: [claim], records: [mismatched], runtime })).toThrow(
      'missing or inconsistent',
    );
  });

  it.each(['approved', 'signing', 'signed', 'send_started', 'sent', 'failed', 'ambiguous'] as const)(
    'blocks generic restore for exact state %s',
    state => {
      const records = [record(state)];
      expect(() => evaluateGenericQuarantine({ claims: [claim], records, marker: marker(records), runtime })).toThrow(
        'generic submission remains blocked',
      );
    },
  );

  it('requires a separately consumed restore approval after exact success', () => {
    expect(() => evaluateGenericQuarantine({ claims: [claim], records: [record()], runtime })).toThrow(
      'explicit restore approval',
    );
  });

  it('rejects a restore approval marker bound to another state digest', () => {
    const records = [record()];
    const wrong = { ...marker(records), canonicalStateDigest: `sha256:${'ff'.repeat(32)}` };
    expect(() => evaluateGenericQuarantine({ claims: [claim], records, marker: wrong, runtime })).toThrow(
      'does not bind current witness',
    );
  });

  it('permanently returns the exact operation quarantine after approved restore', () => {
    const records = [record()];
    expect(evaluateGenericQuarantine({ claims: [claim], records, marker: marker(records), runtime })).toEqual(
      new Set([claim.claim.operationId]),
    );
  });
});
