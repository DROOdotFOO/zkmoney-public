import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, readFile } from 'node:fs/promises';

import { assertNoUnresolvedGenericSubmissions } from '../l1/submission_journal.js';
import { parseExactOperationRuntimeIdentity, type ExactOperationRuntimeIdentity } from './contract.js';
import {
  EXACT_CANONICAL_DIRECTORY,
  EXACT_CLEAN_HANDOFF_PATH,
  EXACT_GENERIC_SUBMISSION_JOURNAL_PATH,
  EXACT_RUNTIME_IDENTITY_PATH,
  EXACT_SOURCE_COMMIT_PATH,
  EXACT_STATE_INVENTORY_PATH,
  GENERIC_DATA_DIRECTORY,
} from './paths.js';
import type { RuntimeProfile } from './runtime_sandbox.js';
import { verifyStateInventory } from './state_inventory.js';

let preparedIdentity: ExactOperationRuntimeIdentity | undefined;
let preparedCleanHandoffDigest: `sha256:${string}` | undefined;

export async function preparePrivilegedRuntimeIdentity(
  profile: RuntimeProfile,
  runtimeUid: number,
  runtimeGid: number,
): Promise<void> {
  if (preparedIdentity) throw new Error('Runtime identity was already prepared');
  const canonicalDirectory = profile === 'generic-restore' ? GENERIC_DATA_DIRECTORY : EXACT_CANONICAL_DIRECTORY;
  await assertFixedIdentityFile(EXACT_RUNTIME_IDENTITY_PATH);
  await assertFixedIdentityFile(EXACT_STATE_INVENTORY_PATH);
  const [input, sourceCommit, state] = await Promise.all([
    readFile(EXACT_RUNTIME_IDENTITY_PATH, 'utf8'),
    readFile(EXACT_SOURCE_COMMIT_PATH, 'utf8'),
    verifyStateInventory(EXACT_STATE_INVENTORY_PATH, canonicalDirectory),
  ]);
  let cleanHandoffDigest: `sha256:${string}` | undefined;
  if (profile !== 'generic-restore') {
    await assertNoUnresolvedGenericSubmissions(EXACT_GENERIC_SUBMISSION_JOURNAL_PATH);
    cleanHandoffDigest = await readCleanHandoffDigest(EXACT_CLEAN_HANDOFF_PATH);
  }
  let supplied: unknown;
  try {
    supplied = JSON.parse(input);
  } catch (cause) {
    throw new Error('Fixed exact-operation runtime identity is malformed JSON', { cause });
  }
  const identity = parseExactOperationRuntimeIdentity(supplied);
  const derived = {
    ...identity,
    host: hostname(),
    sourceCommit: sourceCommit.trim(),
    runtimeUid,
    runtimeGid,
    ...state,
  };
  if (JSON.stringify(identity) !== JSON.stringify(derived)) {
    throw new Error('Fixed exact-operation runtime identity does not match the running host, source, identity and state bytes');
  }
  preparedIdentity = Object.freeze(identity);
  preparedCleanHandoffDigest = cleanHandoffDigest;
}

export async function loadExactRuntimeIdentity(): Promise<ExactOperationRuntimeIdentity> {
  if (!preparedIdentity) throw new Error('Privileged runtime identity preflight did not run');
  return preparedIdentity;
}

export function loadPreparedCleanHandoffDigest(): `sha256:${string}` {
  if (!preparedCleanHandoffDigest) {
    throw new Error('Privileged canonical-state preflight did not prepare clean handoff evidence');
  }
  return preparedCleanHandoffDigest;
}

export function assertCanonicalHandoffArtifact(metadata: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  nlink: number;
}): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error('Canonical clean handoff must be one regular file');
  }
}

async function readCleanHandoffDigest(filename: string): Promise<`sha256:${string}`> {
  const metadata = await lstat(filename);
  assertCanonicalHandoffArtifact(metadata);
  const contents = await readFile(filename);
  let handoff: unknown;
  try {
    handoff = JSON.parse(contents.toString('utf8'));
  } catch (cause) {
    throw new Error('Canonical clean handoff is malformed JSON', { cause });
  }
  if (
    typeof handoff !== 'object' ||
    handoff === null ||
    Array.isArray(handoff) ||
    Object.keys(handoff).sort().join(',') !== 'clean,kind,schema' ||
    (handoff as Record<string, unknown>).schema !== 1 ||
    (handoff as Record<string, unknown>).kind !== 'generic' ||
    (handoff as Record<string, unknown>).clean !== true
  ) {
    throw new Error('Canonical clean handoff marker is invalid');
  }
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

async function assertFixedIdentityFile(filename: string): Promise<void> {
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o777) !== 0o400
  ) {
    throw new Error('Fixed runtime configuration must be one root-owned mode-0400 regular file');
  }
}
