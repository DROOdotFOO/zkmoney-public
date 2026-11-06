import { chmod, lstat, open as openFile, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { type Database, open } from 'sqlite';
import sqlite3Driver, { type Database as Sqlite3Database, type Statement as Sqlite3Statement } from 'sqlite3';
import { EXACT_RUNTIME_LEASE_PATH } from './paths.js';

type SqliteDatabase = Database<Sqlite3Database, Sqlite3Statement>;
const RUNTIME_LEASE_TABLE_SQL =
  'CREATE TABLE runtime_lease (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), kind TEXT NOT NULL)';
export type RuntimeKind = 'generic' | 'exact-operation';
export function runtimeLeasePath(): string {
  return EXACT_RUNTIME_LEASE_PATH;
}
export function cleanHandoffPath(leasePath: string): string {
  return `${leasePath}.clean-handoff.json`;
}



export class RuntimeLease {
  private closed = false;
  private exactHandoffActivated: boolean;

  private constructor(
    readonly path: string,
    readonly kind: RuntimeKind,
    private readonly db: SqliteDatabase,
    private readonly prevalidatedExactHandoffDigest?: `sha256:${string}`,
  ) {
    this.exactHandoffActivated = kind === 'generic';
  }

  static async acquire(
    filename: string,
    kind: RuntimeKind,
    options: { cleanHandoffPath?: string; prevalidatedExactHandoffDigest?: `sha256:${string}` } = {},
  ): Promise<RuntimeLease> {
    const resolved = path.resolve(filename);
    await assertSecureLeasePath(resolved);
    try {
      await assertEmptyOrExactLeaseFile(resolved);
    } catch (error) {
      if (isBusy(error)) {
        throw new Error(`Oxide runtime lease ${filename} is already held`, { cause: error });
      }
      throw error;
    }
    // sqlite3 is a CJS native addon whose runtime constructor is on the default export.
    // eslint-disable-next-line import-x/no-named-as-default-member
    const mode =
      sqlite3Driver.OPEN_READWRITE |
      sqlite3Driver.OPEN_CREATE |
      sqlite3Driver.OPEN_FULLMUTEX |
      sqlite3Driver.OPEN_URI;
    const db = await open({
      filename: `file:${resolved}?mode=rwc&nofollow=1`,
      driver: sqlite3Driver.Database,
      mode,
    });
    try {
      await db.exec('PRAGMA busy_timeout = 0');
      await db.exec('PRAGMA journal_mode = DELETE');
      await db.exec('PRAGMA synchronous = FULL');
      await assertEmptyOrExactLease(db);
      await db.exec(RUNTIME_LEASE_TABLE_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
      await db.exec('BEGIN EXCLUSIVE');
      const handoffPath = path.resolve(options.cleanHandoffPath ?? cleanHandoffPath(resolved));
      if (kind === 'exact-operation') {
        if (!/^sha256:[0-9a-f]{64}$/.test(options.prevalidatedExactHandoffDigest ?? '')) {
          throw new Error('Exact-operation runtime requires privileged prevalidated clean handoff evidence');
        }
      } else {
        await removeFile(handoffPath);
        await setLeaseKind(db, kind);
      }
      await chmod(resolved, 0o600);
      return new RuntimeLease(resolved, kind, db, options.prevalidatedExactHandoffDigest);
    } catch (error) {
      await db.close();
      if (isBusy(error)) {
        throw new Error(`Oxide runtime lease ${filename} is already held`, { cause: error });
      }
      throw error;
    }
  }

  async activateExactHandoff(prevalidatedExactHandoffDigest: `sha256:${string}`): Promise<void> {
    if (this.kind !== 'exact-operation' || this.exactHandoffActivated) {
      throw new Error('Exact-operation handoff activation is not available');
    }
    if (prevalidatedExactHandoffDigest !== this.prevalidatedExactHandoffDigest) {
      throw new Error('Exact-operation handoff evidence changed after privileged preflight');
    }
    await setLeaseKind(this.db, this.kind);
    this.exactHandoffActivated = true;
  }

  async close({ cleanHandoff = false }: { cleanHandoff?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (cleanHandoff && this.kind !== 'generic') {
      throw new Error('Only the generic runtime can create a clean handoff');
    }
    if (cleanHandoff) {
      const marker = cleanHandoffPath(this.path);
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
    await assertSecureFile(temporary, 'interrupted clean handoff');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const input = await readFile(temporary, 'utf8');
  try {
    const handoff = JSON.parse(input) as { schema?: unknown; kind?: unknown; clean?: unknown };
    if (handoff.schema !== 1 || handoff.kind !== 'generic' || handoff.clean !== true) throw new Error('malformed');
  } catch {
    await removeFile(temporary);
    return;
  }
  await rename(temporary, marker);
  await syncParent(marker);
}


async function assertSecureLeasePath(filename: string): Promise<void> {
  const parent = path.dirname(filename);
  const [metadata, canonical] = await Promise.all([lstat(parent), realpath(parent)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== parent || (metadata.mode & 0o022) !== 0) {
    throw new Error('Runtime lease parent must be one canonical owner-only directory');
  }
  try {
    const handle = await openFile(filename, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await assertSecureFile(filename, 'runtime lease');
}

async function assertSecureFile(filename: string, label: string): Promise<void> {
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be one owner-only regular file`);
  }
}

async function assertEmptyOrExactLeaseFile(filename: string): Promise<void> {
  const mode = sqlite3Driver.OPEN_READONLY | sqlite3Driver.OPEN_FULLMUTEX | sqlite3Driver.OPEN_URI;
  const db = await open({
    filename: `file:${filename}?mode=ro&nofollow=1`,
    driver: sqlite3Driver.Database,
    mode,
  });
  try {
    await assertEmptyOrExactLease(db);
  } finally {
    await db.close();
  }
}

async function assertEmptyOrExactLease(db: SqliteDatabase): Promise<void> {
  const objects = await db.all<{ type: string; name: string; sql: string | null }[]>(
    `SELECT type, name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  );
  if (objects.length === 0) return;
  if (
    objects.length !== 1 ||
    objects[0]?.type !== 'table' ||
    objects[0]?.name !== 'runtime_lease' ||
    objects[0]?.sql === null ||
    normalizeSql(objects[0].sql) !== normalizeSql(RUNTIME_LEASE_TABLE_SQL)
  ) {
    throw new Error('Existing SQLite file is not the canonical runtime lease schema');
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

async function setLeaseKind(db: SqliteDatabase, kind: RuntimeKind): Promise<void> {
  await db.run(
    `INSERT INTO runtime_lease (singleton, kind) VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET kind = excluded.kind`,
    kind,
  );
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

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}
