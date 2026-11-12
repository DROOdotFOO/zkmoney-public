import { chmod, open as openFile, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  type SqliteDatabase,
  assertOwnerOnlyFile,
  assertOwnerOnlyParent,
  createOrValidateOwnerOnlyFile,
  isEmptySchema,
  openSqlite,
  withReadOnlySqlite,
} from '../state/secure_sqlite.js';

const RUNTIME_LEASE_TABLE_SQL =
  'CREATE TABLE runtime_lease (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), kind TEXT NOT NULL)';
const RUNTIME_LEASE_SCHEMA = new Map([['runtime_lease', RUNTIME_LEASE_TABLE_SQL]]);
const RUNTIME_LEASE_SCHEMA_MISMATCH = 'Existing SQLite file is not the canonical runtime lease schema';
export type RuntimeKind = 'generic' | 'exact-operation';

export interface RuntimeLeaseOptions {
  /**
   * Generic runtime only: where its clean shutdown writes the handoff marker. The marker belongs beside the generic
   * state, so that the exact runtime reads it from the same files under its read-only canonical mount.
   */
  cleanHandoffPath?: string;
  /** Exact runtime only: the digest of the clean-handoff marker that the privileged preflight read. */
  prevalidatedExactHandoffDigest?: `sha256:${string}`;
}

/**
 * The exclusive SQLite lock that keeps the generic and exact runtimes from running at the same time. The lock is a
 * transaction that is never committed, so the lease file holds no state of its own.
 */
export class RuntimeLease {
  private closed = false;
  private exactHandoffActivated: boolean;

  private constructor(
    readonly path: string,
    readonly kind: RuntimeKind,
    private readonly db: SqliteDatabase,
    private readonly cleanHandoffPath: string | undefined,
    private readonly prevalidatedExactHandoffDigest?: `sha256:${string}`,
  ) {
    this.exactHandoffActivated = kind === 'generic';
  }

  static async acquire(filename: string, kind: RuntimeKind, options: RuntimeLeaseOptions = {}): Promise<RuntimeLease> {
    const resolved = path.resolve(filename);
    const handoffPath = options.cleanHandoffPath === undefined ? undefined : path.resolve(options.cleanHandoffPath);
    if (kind === 'generic' && handoffPath === undefined) {
      throw new Error('Generic runtime lease requires the clean handoff marker path');
    }
    if (kind === 'exact-operation' && !/^sha256:[0-9a-f]{64}$/.test(options.prevalidatedExactHandoffDigest ?? '')) {
      throw new Error('Exact-operation runtime requires privileged prevalidated clean handoff evidence');
    }
    await assertOwnerOnlyParent(resolved, 'Runtime lease');
    await createOrValidateOwnerOnlyFile(resolved, 'runtime lease');
    try {
      await withReadOnlySqlite(resolved, 'read-only', db =>
        isEmptySchema(db, RUNTIME_LEASE_SCHEMA, RUNTIME_LEASE_SCHEMA_MISMATCH),
      );
    } catch (error) {
      throw leaseError(filename, error);
    }
    const db = await openSqlite(resolved, 'read-write');
    try {
      await db.exec('PRAGMA busy_timeout = 0');
      await db.exec('PRAGMA journal_mode = DELETE');
      await db.exec('PRAGMA synchronous = FULL');
      await isEmptySchema(db, RUNTIME_LEASE_SCHEMA, RUNTIME_LEASE_SCHEMA_MISMATCH);
      await db.exec(RUNTIME_LEASE_TABLE_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
      await db.exec('BEGIN EXCLUSIVE');
      if (handoffPath !== undefined) {
        await removeFile(handoffPath);
      }
      await chmod(resolved, 0o600);
      return new RuntimeLease(resolved, kind, db, handoffPath, options.prevalidatedExactHandoffDigest);
    } catch (error) {
      await db.close();
      throw leaseError(filename, error);
    }
  }

  async activateExactHandoff(prevalidatedExactHandoffDigest: `sha256:${string}`): Promise<void> {
    if (this.kind !== 'exact-operation' || this.exactHandoffActivated) {
      throw new Error('Exact-operation handoff activation is not available');
    }
    if (prevalidatedExactHandoffDigest !== this.prevalidatedExactHandoffDigest) {
      throw new Error('Exact-operation handoff evidence changed after privileged preflight');
    }
    this.exactHandoffActivated = true;
  }

  async close({ cleanHandoff = false }: { cleanHandoff?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (cleanHandoff && (this.kind !== 'generic' || this.cleanHandoffPath === undefined)) {
      throw new Error('Only the generic runtime can create a clean handoff');
    }
    if (cleanHandoff && this.cleanHandoffPath !== undefined) {
      const marker = this.cleanHandoffPath;
      const temporary = `${marker}.tmp`;
      await recoverCleanHandoffWrite(temporary, marker);
      const handle = await openFile(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ schema: 1, kind: 'generic', clean: true }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, marker);
      await syncParent(marker);
    }
    await this.db.exec('ROLLBACK');
    await this.db.close();
  }
}

async function recoverCleanHandoffWrite(temporary: string, marker: string): Promise<void> {
  try {
    await assertOwnerOnlyFile(temporary, 'interrupted clean handoff');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const input = await readFile(temporary, 'utf8');
  try {
    const handoff = JSON.parse(input) as { schema?: unknown; kind?: unknown; clean?: unknown };
    if (handoff.schema !== 1 || handoff.kind !== 'generic' || handoff.clean !== true) throw new Error('malformed');
  } catch {
    // A torn write of our own marker: the generic lease is held, so nothing else writes it.
    await removeFile(temporary);
    return;
  }
  await rename(temporary, marker);
  await syncParent(marker);
}

function leaseError(filename: string, error: unknown): unknown {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return new Error(`Oxide runtime lease ${filename} is already held`, { cause: error });
  }
  return error;
}

async function removeFile(filename: string): Promise<void> {
  try {
    await unlink(filename);
    await syncParent(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function syncParent(filename: string): Promise<void> {
  const directory = await openFile(path.dirname(filename), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
