import { randomUUID } from 'node:crypto';
import { chmod, lstat, open as openFile, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { type Database, open } from 'sqlite';
import sqlite3Driver, { type Database as Sqlite3Database, type Statement as Sqlite3Statement } from 'sqlite3';

type SqliteDatabase = Database<Sqlite3Database, Sqlite3Statement>;
export type RuntimeKind = 'generic' | 'exact-operation';
export function runtimeLeasePath(sqlitePath: string): string {
  return `${sqlitePath}.runtime-lease.sqlite3`;
}
export function cleanHandoffPath(leasePath: string): string {
  return `${leasePath}.clean-handoff.json`;
}



export class RuntimeLease {
  private closed = false;

  private constructor(
    readonly path: string,
    readonly kind: RuntimeKind,
    private readonly db: SqliteDatabase,
  ) {}

  static async acquire(filename: string, kind: RuntimeKind): Promise<RuntimeLease> {
    const resolved = path.resolve(filename);
    await assertSecureLeasePath(resolved);
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
      await db.exec(
        'CREATE TABLE IF NOT EXISTS runtime_lease (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), kind TEXT NOT NULL)',
      );
      await db.exec('BEGIN EXCLUSIVE');
      const handoffPath = cleanHandoffPath(resolved);
      if (kind === 'exact-operation') {
        try {
          await assertSecureFile(handoffPath, 'clean generic handoff');
          const handoff = JSON.parse(await readFile(handoffPath, 'utf8')) as {
            schema?: unknown;
            kind?: unknown;
            clean?: unknown;
          };
          if (handoff.schema !== 1 || handoff.kind !== 'generic' || handoff.clean !== true) {
            throw new Error('invalid clean generic handoff marker');
          }
        } catch (cause) {
          throw new Error('Exact-operation runtime requires a clean generic handoff', { cause });
        }
      }
      await removeFile(handoffPath);
      await db.run(
        `INSERT INTO runtime_lease (singleton, kind) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET kind = excluded.kind`,
        kind,
      );
      await chmod(resolved, 0o600);
      return new RuntimeLease(resolved, kind, db);
    } catch (error) {
      await db.close();
      if (isBusy(error)) {
        throw new Error(`Oxide runtime lease ${filename} is already held`, { cause: error });
      }
      throw error;
    }
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
      const temporary = `${marker}.${randomUUID()}.tmp`;
      const handle = await openFile(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ schema: 1, kind: 'generic', clean: true }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, marker);
    }
    await this.db.exec('ROLLBACK');
    await this.db.close();
  }
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

async function removeFile(filename: string): Promise<void> {
  try {
    await unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}
