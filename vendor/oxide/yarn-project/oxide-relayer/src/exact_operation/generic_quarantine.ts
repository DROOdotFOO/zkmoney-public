import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, open as openFile, readFile, rename, unlink } from 'node:fs/promises';

import { z } from 'zod';

import { EXACT_DATABASE_SCHEMA_IDENTITY } from './contract.js';
import { auditExactOperationJournal, type ExactOperationRecord } from './journal.js';
import {
  S3ExactApprovalClaimStore,
  type ExactApprovalClaim,
  type ExactApprovalClaimReceipt,
} from './monotonic_claim.js';
import { EXACT_APPROVAL_AUTHORITY_PATH, EXACT_CONTROL_DIRECTORY, EXACT_JOURNAL_PATH } from './paths.js';
import { loadExactRuntimeIdentity } from './runtime_identity.js';
import { consumePreparedInheritedBundle } from './runtime_sandbox.js';
import { loadWitnessConfiguration, loadWitnessCredentials } from './witness_configuration.js';

const RESTORE_MARKER_PATH = `${EXACT_CONTROL_DIRECTORY}/generic-restore.json`;
const RESTORE_MARKER_TEMP_PATH = `${RESTORE_MARKER_PATH}.tmp`;
const RESTORE_DOMAIN = 'oxide-relayer/generic-restore-approval/v2\0';
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const restoreRuntimeIdentitySchema = z.strictObject({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  imageDigest: sha256,
  runtimeUid: z.number().int().positive().refine(value => value !== 1000, 'runtime must not use legacy uid/gid'),
  runtimeGid: z.number().int().positive().refine(value => value !== 1000, 'runtime must not use legacy uid/gid'),
  signerAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  schemaIdentity: z.literal(EXACT_DATABASE_SCHEMA_IDENTITY),
  stateInventoryDigest: sha256,
  canonicalStateDigest: sha256,
  expectedNonce: z.number().int().nonnegative(),
});
const restoreApprovalSchema = z.strictObject({
  schema: z.literal('oxide-relayer.generic-restore.v2'),
  approvalNonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  runtime: restoreRuntimeIdentitySchema,
  witness: z.strictObject({
    configurationDigest: sha256,
    authorityCommitment: sha256,
  }),
  claimSetDigest: sha256,
  terminalEvidenceDigest: sha256,
});
type RestoreApproval = z.infer<typeof restoreApprovalSchema>;

export interface WitnessClaim {
  claim: ExactApprovalClaim;
  receipt: ExactApprovalClaimReceipt;
}

export interface RestoreMarker {
  schema: 'oxide-relayer.generic-restore-marker.v2';
  restoreEvidenceDigest: string;
  claimSetDigest: string;
  terminalEvidenceDigest: string;
  schemaIdentity: typeof EXACT_DATABASE_SCHEMA_IDENTITY;
  stateInventoryDigest: string;
  canonicalStateDigest: string;
}

export async function genericSubmissionQuarantine(): Promise<ReadonlySet<string>> {
  const runtime = await loadExactRuntimeIdentity();
  const witness = await loadWitnessConfiguration();
  const store = new S3ExactApprovalClaimStore(witness, { credentials: await loadWitnessCredentials() });
  const [claims, records, marker] = await Promise.all([
    store.readClaims(witness.prefix),
    auditExactOperationJournal(EXACT_JOURNAL_PATH),
    readRestoreMarker(),
  ]);
  return evaluateGenericQuarantine({ claims, records, marker, runtime });
}

export async function authorizeGenericRestore(bundleFd: number): Promise<void> {
  const bundle = await readBundle(bundleFd);
  const approval = restoreApprovalSchema.parse(bundle.approval);
  const authority = await readFile(EXACT_APPROVAL_AUTHORITY_PATH, 'utf8');
  const restoreApprovalCommitment = assertRestoreSignature(approval, bundle.approvalToken, authority);
  const runtime = await loadExactRuntimeIdentity();
  if (canonicalJson(approval.runtime) !== canonicalJson(runtime)) {
    throw new Error('Generic restore approval runtime identity does not match current immutable state');
  }
  const configuredWitness = await loadWitnessConfiguration();
  if (
    approval.witness.configurationDigest !== configuredWitness.configurationDigest ||
    approval.witness.authorityCommitment !== configuredWitness.authorityCommitment
  ) {
    throw new Error('Generic restore approval witness authority does not match reviewed configuration');
  }
  const store = new S3ExactApprovalClaimStore(configuredWitness, {
    credentials: await loadWitnessCredentials(),
  });
  const [claims, records] = await Promise.all([
    store.readClaims(configuredWitness.prefix),
    auditExactOperationJournal(EXACT_JOURNAL_PATH),
  ]);
  assertWitnessJournalConsistency(claims, records);
  assertRestorable(records);
  const { claimSetDigest, terminalEvidenceDigest } = genericRestoreDigests(claims, records);
  if (
    approval.claimSetDigest !== claimSetDigest ||
    approval.terminalEvidenceDigest !== terminalEvidenceDigest
  ) {
    throw new Error('Generic restore approval does not bind current exact terminal evidence');
  }
  const marker: RestoreMarker = {
    schema: 'oxide-relayer.generic-restore-marker.v2',
    restoreEvidenceDigest: restoreApprovalCommitment,
    claimSetDigest,
    terminalEvidenceDigest,
    schemaIdentity: runtime.schemaIdentity,
    stateInventoryDigest: runtime.stateInventoryDigest,
    canonicalStateDigest: runtime.canonicalStateDigest,
  };
  await writeRestoreMarker(marker);
}

export function evaluateGenericQuarantine(args: {
  claims: WitnessClaim[];
  records: ExactOperationRecord[];
  marker?: RestoreMarker;
  runtime: {
    schemaIdentity: typeof EXACT_DATABASE_SCHEMA_IDENTITY;
    stateInventoryDigest: string;
    canonicalStateDigest: string;
  };
}): ReadonlySet<string> {
  if (args.claims.length === 0 && args.records.length === 0) return new Set();
  assertWitnessJournalConsistency(args.claims, args.records);
  assertRestorable(args.records);
  if (!args.marker) throw new Error('Generic submission remains blocked until an explicit restore approval is consumed');
  const expected = {
    ...genericRestoreDigests(args.claims, args.records),
    schemaIdentity: args.runtime.schemaIdentity,
    stateInventoryDigest: args.runtime.stateInventoryDigest,
    canonicalStateDigest: args.runtime.canonicalStateDigest,
  };
  if (
    args.marker.schema !== 'oxide-relayer.generic-restore-marker.v2' ||
    !/^sha256:[0-9a-f]{64}$/.test(args.marker.restoreEvidenceDigest) ||
    Object.entries(expected).some(([key, value]) => args.marker?.[key as keyof RestoreMarker] !== value)
  ) {
    throw new Error('Generic restore marker does not bind current witness, terminal evidence, and state');
  }
  return new Set(args.records.map(record => record.operationId));
}

function assertWitnessJournalConsistency(claims: WitnessClaim[], records: ExactOperationRecord[]): void {
  if (claims.length !== records.length) {
    throw new Error('Exact-operation witness and local journal are missing or inconsistent');
  }
  const recordsByOperation = new Map(records.map(record => [record.operationId, record]));
  for (const { claim, receipt } of claims) {
    const record = recordsByOperation.get(claim.operationId);
    if (
      !record ||
      record.approvalCommitment !== claim.approvalCommitment ||
      record.stageAApprovalDigest !== claim.stageAApprovalDigest ||
      canonicalJson(record.witness) !== canonicalJson(receipt)
    ) {
      throw new Error('Exact-operation witness and local journal are missing or inconsistent');
    }
  }
}

function assertRestorable(records: ExactOperationRecord[]): void {
  if (records.some(record => record.state !== 'confirmed')) {
    throw new Error('Exact operation is active, ambiguous, or failed before send; generic submission remains blocked');
  }
}

export function genericRestoreDigests(
  claims: WitnessClaim[],
  records: ExactOperationRecord[],
): { claimSetDigest: `sha256:${string}`; terminalEvidenceDigest: `sha256:${string}` } {
  return {
    claimSetDigest: digestClaims(claims),
    terminalEvidenceDigest: digestTerminalEvidence(records),
  };
}

function digestClaims(claims: WitnessClaim[]): `sha256:${string}` {
  const evidence = claims
    .map(({ claim, receipt }) => ({ claim, receipt }))
    .sort((left, right) => left.claim.operationId.localeCompare(right.claim.operationId));
  return digest('oxide-relayer/exact-claim-set/v1\0', canonicalJson(evidence));
}

function digestTerminalEvidence(records: ExactOperationRecord[]): `sha256:${string}` {
  const evidence = records
    .map(record => ({
      approvalCommitment: record.approvalCommitment,
      stageAApprovalDigest: record.stageAApprovalDigest,
      operationId: record.operationId,
      state: record.state,
      signedTxHash: record.signedTxHash,
      l1TxHash: record.l1TxHash,
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  return digest('oxide-relayer/exact-terminal-evidence/v1\0', canonicalJson(evidence));
}


async function readRestoreMarker(filename = RESTORE_MARKER_PATH): Promise<RestoreMarker | undefined> {
  try {
    const metadata = await lstat(filename);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error('Generic restore marker is not one owner-only regular file');
    }
    const input = await readFile(filename, 'utf8');
    const value = JSON.parse(input) as RestoreMarker;
    if (`${canonicalJson(value)}\n` !== input) throw new Error('not canonical');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Generic restore marker is missing or malformed', { cause: error });
  }
}

async function writeRestoreMarker(marker: RestoreMarker): Promise<void> {
  await recoverRestoreMarkerWrite();
  const existing = await readRestoreMarker();
  if (existing && canonicalJson(existing) === canonicalJson(marker)) return;
  const temporary = RESTORE_MARKER_TEMP_PATH;
  const handle = await openFile(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(marker)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, RESTORE_MARKER_PATH);
  const directory = await openFile(EXACT_CONTROL_DIRECTORY, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function recoverRestoreMarkerWrite(): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(RESTORE_MARKER_TEMP_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Interrupted generic restore marker is not one owner-only regular file');
  }
  const input = await readFile(RESTORE_MARKER_TEMP_PATH, 'utf8');
  try {
    const value = JSON.parse(input) as RestoreMarker;
    if (`${canonicalJson(value)}\n` !== input) throw new Error('not canonical');
  } catch {
    await unlink(RESTORE_MARKER_TEMP_PATH);
    const directory = await openFile(EXACT_CONTROL_DIRECTORY, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return;
  }
  await rename(RESTORE_MARKER_TEMP_PATH, RESTORE_MARKER_PATH);
  const directory = await openFile(EXACT_CONTROL_DIRECTORY, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}


async function readBundle(fd: number): Promise<{ approval: unknown; approvalToken: string }> {
  const bytes = consumePreparedInheritedBundle(fd);
  try {
    const value = JSON.parse(bytes.toString('utf8').trim()) as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'approval,approvalToken' || typeof value.approvalToken !== 'string') {
      throw new Error('Generic restore approval bundle is malformed');
    }
    return { approval: value.approval, approvalToken: value.approvalToken };
  } finally {
    bytes.fill(0);
  }
}

function assertRestoreSignature(
  approval: RestoreApproval,
  token: string,
  authority: string,
): `sha256:${string}` {
  if (!/^ed25519:[A-Za-z0-9_-]{86}$/.test(token)) throw new Error('Generic restore approval signature is malformed');
  const signature = Buffer.from(token.slice('ed25519:'.length), 'base64url');
  const message = Buffer.from(`${RESTORE_DOMAIN}${canonicalJson(approval)}`, 'utf8');
  if (!verify(null, message, createPublicKey(authority), signature)) {
    throw new Error('Generic restore approval signature is invalid');
  }
  return digest('oxide-relayer/generic-restore-signature-commitment/v1\0', signature.toString('base64url'));
}


function digest(domain: string, value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(domain).update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
