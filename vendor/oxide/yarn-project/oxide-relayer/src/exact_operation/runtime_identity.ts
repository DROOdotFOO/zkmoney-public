import { hostname } from 'node:os';
import { lstat, readFile } from 'node:fs/promises';

import { parseExactOperationRuntimeIdentity, type ExactOperationRuntimeIdentity } from './contract.js';
import {
  EXACT_DATA_DIRECTORY,
  EXACT_RUNTIME_IDENTITY_PATH,
  EXACT_SOURCE_COMMIT_PATH,
} from './paths.js';
import { exactStateSetDigest } from './state_set.js';

export async function loadExactRuntimeIdentity(): Promise<ExactOperationRuntimeIdentity> {
  await assertFixedIdentityFile(EXACT_RUNTIME_IDENTITY_PATH);
  const [input, sourceCommit, stateSetDigest] = await Promise.all([
    readFile(EXACT_RUNTIME_IDENTITY_PATH, 'utf8'),
    readFile(EXACT_SOURCE_COMMIT_PATH, 'utf8'),
    exactStateSetDigest(EXACT_DATA_DIRECTORY),
  ]);
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
    stateSetDigest,
  };
  if (JSON.stringify(identity) !== JSON.stringify(derived)) {
    throw new Error('Fixed exact-operation runtime identity does not match the running host, source and state bytes');
  }
  return identity;
}

async function assertFixedIdentityFile(filename: string): Promise<void> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error('Fixed exact-operation runtime identity must be one regular file');
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error('Fixed exact-operation runtime identity must not be group- or world-writable');
  }
}
