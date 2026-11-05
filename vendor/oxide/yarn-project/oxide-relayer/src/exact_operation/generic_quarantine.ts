import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { lstat, open as openFile, readFile, rename } from 'node:fs/promises';

import { hostname } from 'node:os';
import { z } from 'zod';

import { EXACT_DATABASE_SCHEMA_IDENTITY } from './contract.js';
import { auditExactOperationJournal, type ExactOperationRecord } from './journal.js';
import {
  S3ExactApprovalClaimStore,
  type ExactApprovalClaim,
  type ExactApprovalClaimReceipt,
} from './monotonic_claim.js';
import {
  EXACT_APPROVAL_AUTHORITY_PATH,
  EXACT_DATA_DIRECTORY,
  EXACT_JOURNAL_PATH,
  EXACT_RUNTIME_IDENTITY_PATH,
  EXACT_SOURCE_COMMIT_PATH,
  EXACT_STATE_INVENTORY_PATH,
  EXACT_WITNESS_ACCESS_KEY_ID_PATH,
  EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
} from './paths.js';
import { verifyStateInventory } from './state_inventory.js';

const RESTORE_MARKER_PATH = `${EXACT_DATA_DIRECTORY}/generic-restore.json`;
const RESTORE_DOMAIN = 'oxide-relayer/generic-restore-approval/v1\0';
const restoreApprovalSchema = z.strictObject({
  schema: z.literal('oxide-relayer.generic-restore.v1'),
  approvalNonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  runtime: z.strictObject({
    host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    schemaIdentity: z.literal(EXACT_DATABASE_SCHEMA_IDENTITY),
    stateInventoryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    canonicalStateDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  witness: z.strictObject({
    bucket: z.string().min(3),
    region: z.string().min(1),
    expectedOwner: z.string().regex(/^[0-9]{12}$/),
    prefix: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/),
  }),
  claimSetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  terminalEvidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
type RestoreApproval = z.infer<typeof restoreApprovalSchema>;

export interface WitnessClaim {
  claim: ExactApprovalClaim;
  receipt: ExactApprovalClaimReceipt;
}

export interface RestoreMarker {
  schema: 'oxide-relayer.generic-restore-marker.v1';
  restoreEvidenceDigest: string;
  claimSetDigest: string;
  terminalEvidenceDigest: string;
  schemaIdentity: typeof EXACT_DATABASE_SCHEMA_IDENTITY;
  stateInventoryDigest: string;
  canonicalStateDigest: string;
}

export async function genericSubmissionQuarantine(): Promise<ReadonlySet<string>> {
  const runtime = await fixedRuntimeIdentity();
  const witness = configuredWitnessAuthority();
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
  const runtime = await fixedRuntimeIdentity();
  if (canonicalJson(approval.runtime) !== canonicalJson(runtime)) {
    throw new Error('Generic restore approval runtime identity does not match current immutable state');
  }
  const configuredWitness = configuredWitnessAuthority();
  if (canonicalJson(approval.witness) !== canonicalJson(configuredWitness)) {
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
    schema: 'oxide-relayer.generic-restore-marker.v1',
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
    args.marker.schema !== 'oxide-relayer.generic-restore-marker.v1' ||
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
      operationId: record.operationId,
      state: record.state,
      signedTxHash: record.signedTxHash,
      l1TxHash: record.l1TxHash,
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  return digest('oxide-relayer/exact-terminal-evidence/v1\0', canonicalJson(evidence));
}

async function fixedRuntimeIdentity() {
  const [input, sourceCommit, state] = await Promise.all([
    readFile(EXACT_RUNTIME_IDENTITY_PATH, 'utf8'),
    readFile(EXACT_SOURCE_COMMIT_PATH, 'utf8'),
    verifyStateInventory(EXACT_STATE_INVENTORY_PATH, EXACT_DATA_DIRECTORY),
  ]);
  const identity = restoreApprovalSchema.shape.runtime.parse(JSON.parse(input));
  const derived = { ...identity, host: hostname(), sourceCommit: sourceCommit.trim(), ...state };
  if (canonicalJson(identity) !== canonicalJson(derived)) {
    throw new Error('Generic restore runtime identity does not match current source and state');
  }
  return identity;
}

export function configuredWitnessAuthority(): RestoreApproval['witness'] {
  return restoreApprovalSchema.shape.witness.parse({
    bucket: requiredEnvironment('OXIDE_EXACT_WITNESS_BUCKET'),
    region: requiredEnvironment('OXIDE_EXACT_WITNESS_REGION'),
    expectedOwner: requiredEnvironment('OXIDE_EXACT_WITNESS_EXPECTED_OWNER'),
    prefix: requiredEnvironment('OXIDE_EXACT_WITNESS_PREFIX'),
  });
}

export async function loadWitnessCredentials(): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const [accessKeyId, secretAccessKey] = await Promise.all([
    readFile(EXACT_WITNESS_ACCESS_KEY_ID_PATH, 'utf8'),
    readFile(EXACT_WITNESS_SECRET_ACCESS_KEY_PATH, 'utf8'),
  ]);
  if (!accessKeyId.trim() || !secretAccessKey.trim()) throw new Error('Witness credentials are empty');
  return { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() };
}

async function readRestoreMarker(): Promise<RestoreMarker | undefined> {
  try {
    const metadata = await lstat(RESTORE_MARKER_PATH);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error('Generic restore marker is not one owner-only regular file');
    }
    const input = await readFile(RESTORE_MARKER_PATH, 'utf8');
    const value = JSON.parse(input) as RestoreMarker;
    if (`${canonicalJson(value)}\n` !== input) throw new Error('not canonical');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Generic restore marker is missing or malformed', { cause: error });
  }
}

async function writeRestoreMarker(marker: RestoreMarker): Promise<void> {
  const existing = await readRestoreMarker();
  if (existing && canonicalJson(existing) === canonicalJson(marker)) return;
  const temporary = `${RESTORE_MARKER_PATH}.${randomUUID()}.tmp`;
  const handle = await openFile(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(marker)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, RESTORE_MARKER_PATH);
  const directory = await openFile(EXACT_DATA_DIRECTORY, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readBundle(fd: number): Promise<{ approval: unknown; approvalToken: string }> {
  const input = await readFile(`/dev/fd/${fd}`, 'utf8');
  if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Generic restore approval exceeds 64 KiB');
  const value = JSON.parse(input.trim()) as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'approval,approvalToken' || typeof value.approvalToken !== 'string') {
    throw new Error('Generic restore approval bundle is malformed');
  }
  return { approval: value.approval, approvalToken: value.approvalToken };
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Generic quarantine configuration is missing ${name}`);
  return value;
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
