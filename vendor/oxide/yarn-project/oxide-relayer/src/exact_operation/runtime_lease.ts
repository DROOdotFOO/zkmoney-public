import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    // sqlite3 is a CJS native addon whose runtime constructor is on the default export.
    // eslint-disable-next-line import-x/no-named-as-default-member
    const db = await open({ filename, driver: sqlite3Driver.Database });
    try {
      await db.exec('PRAGMA busy_timeout = 0');
      await db.exec('PRAGMA journal_mode = DELETE');
      await db.exec('PRAGMA synchronous = FULL');
      await db.exec(
        'CREATE TABLE IF NOT EXISTS runtime_lease (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), kind TEXT NOT NULL)',
      );
      await db.exec('BEGIN EXCLUSIVE');
      const handoffPath = cleanHandoffPath(filename);
      if (kind === 'exact-operation') {
        try {
          const handoff = JSON.parse(await readFile(handoffPath, 'utf8')) as { kind?: unknown; clean?: unknown };
          if (handoff.kind !== 'generic' || handoff.clean !== true) {
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
      await chmod(filename, 0o600);
      return new RuntimeLease(filename, kind, db);
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
      const temporary = `${marker}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ schema: 1, kind: 'generic', clean: true }), { mode: 0o600 });
      await rename(temporary, marker);
    }
    await this.db.exec('ROLLBACK');
    await this.db.close();
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
