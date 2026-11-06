import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EXACT_CANONICAL_DIRECTORY, EXACT_CONTROL_DIRECTORY } from './paths.js';

export interface ExactStorageRoots {
  canonicalState: string;
  controlDir: string;
  cleanHandoff: string;
  genericSubmissionJournal: string;
  exactJournal: string;
  runtimeLease: string;
}


export async function resolveExactStorageRoots(
  canonicalState: string,
  controlDir: string,
): Promise<ExactStorageRoots> {
  const canonical = path.resolve(canonicalState);
  const control = path.resolve(controlDir);
  if (canonical !== EXACT_CANONICAL_DIRECTORY || control !== EXACT_CONTROL_DIRECTORY) {
    throw new Error('Exact-operation storage roots differ from the immutable runtime interface');
  }
  const [canonicalMetadata, controlMetadata, canonicalReal, controlReal] = await Promise.all([
    lstat(canonical),
    lstat(control),
    realpath(canonical),
    realpath(control),
  ]);
  if (
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink() ||
    canonicalReal !== canonical ||
    canonicalMetadata.uid !== 0 ||
    canonicalMetadata.gid !== 0 ||
    (canonicalMetadata.mode & 0o777) !== 0o555
  ) {
    throw new Error('Exact-operation canonical state must be one canonical read-only directory');
  }
  if (
    !controlMetadata.isDirectory() ||
    controlMetadata.isSymbolicLink() ||
    controlReal !== control ||
    controlMetadata.uid !== process.getuid?.() ||
    controlMetadata.gid !== process.getgid?.() ||
    (controlMetadata.mode & 0o777) !== 0o700
  ) {
    throw new Error('Exact-operation control state must be one runtime-owned owner-only directory');
  }
  if (contains(canonical, control) || contains(control, canonical)) {
    throw new Error('Exact-operation canonical and control roots must not overlap');
  }
  try {
    await access(canonical, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error;
    return exactPaths(canonical, control);
  }
  throw new Error('Exact-operation canonical state is writable by the runtime process');
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function exactPaths(canonicalState: string, controlDir: string): ExactStorageRoots {
  return {
    canonicalState,
    controlDir,
    cleanHandoff: path.join(canonicalState, 'oxide-relayer.runtime-lease.sqlite3.clean-handoff.json'),
    genericSubmissionJournal: path.join(canonicalState, 'generic-submission.sqlite3'),
    exactJournal: path.join(controlDir, 'exact-operation.sqlite3'),
    runtimeLease: path.join(controlDir, 'oxide-relayer.runtime-lease.sqlite3'),
  };
}
