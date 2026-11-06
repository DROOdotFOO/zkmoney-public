import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EXACT_CANONICAL_DIRECTORY, EXACT_CONTROL_DIRECTORY } from './paths.js';

export interface ExactStorageRoots {
  canonicalState: string;
  controlDir: string;
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
  if (contains(canonical, control) || contains(control, canonical)) {
    throw new Error('Exact-operation canonical and control roots must not overlap');
  }
  const [controlMetadata, controlReal] = await Promise.all([lstat(control), realpath(control)]);
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
  return exactPaths(canonical, control);
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function exactPaths(canonicalState: string, controlDir: string): ExactStorageRoots {
  return {
    canonicalState,
    controlDir,
    exactJournal: path.join(controlDir, 'exact-operation.sqlite3'),
    runtimeLease: path.join(controlDir, 'oxide-relayer.runtime-lease.sqlite3'),
  };
}
