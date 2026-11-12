import { lstat, open as openFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { type Database, open } from 'sqlite';
import sqlite3Driver, { type Database as Sqlite3Database, type Statement as Sqlite3Statement } from 'sqlite3';

/** File checks and schema checks shared by the owner-only SQLite files: journals and the runtime lease. */
export type SqliteDatabase = Database<Sqlite3Database, Sqlite3Statement>;

export type SqliteAccess = 'read-write' | 'read-only' | 'immutable';

interface SchemaObject {
  type: string;
  name: string;
  sql: string | null;
}

/** Rejects a parent that is not one canonical directory, or that a group or other users can write. */
export async function assertOwnerOnlyParent(filename: string, label: string): Promise<void> {
  const parent = path.dirname(filename);
  const [metadata, canonical] = await Promise.all([lstat(parent), realpath(parent)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== parent || (metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} parent must be one canonical owner-only directory`);
  }
}

/** Rejects anything but one regular, mode-0600 file of the current user with a single link. */
export async function assertOwnerOnlyFile(filename: string, label: string): Promise<void> {
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

/** Creates the file as mode 0600 when it is absent, then applies `assertOwnerOnlyFile`. */
export async function createOrValidateOwnerOnlyFile(filename: string, label: string): Promise<void> {
  try {
    const handle = await openFile(filename, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await assertOwnerOnlyFile(filename, label);
}

/**
 * Opens `filename` through a `nofollow` URI, so a path swapped for a symlink is rejected. `immutable` reads a file on
 * a read-only mount without creating a lock or journal beside it.
 */
export async function openSqlite(filename: string, access: SqliteAccess): Promise<SqliteDatabase> {
  // sqlite3 is a CJS native addon whose runtime constructor is on the default export.
  // eslint-disable-next-line import-x/no-named-as-default-member
  const { OPEN_READWRITE, OPEN_CREATE, OPEN_READONLY, OPEN_FULLMUTEX, OPEN_URI } = sqlite3Driver;
  const query = { 'read-write': 'mode=rwc', 'read-only': 'mode=ro', immutable: 'mode=ro&immutable=1' }[access];
  return await open({
    filename: `file:${filename}?${query}&nofollow=1`,
    driver: sqlite3Driver.Database,
    mode:
      (access === 'read-write' ? OPEN_READWRITE | OPEN_CREATE : OPEN_READONLY) | OPEN_FULLMUTEX | OPEN_URI,
  });
}

/** Runs `action` on a read-only connection that is always closed afterwards. */
export async function withReadOnlySqlite<T>(
  filename: string,
  access: Exclude<SqliteAccess, 'read-write'>,
  action: (db: SqliteDatabase) => Promise<T>,
): Promise<T> {
  const db = await openSqlite(filename, access);
  try {
    return await action(db);
  } finally {
    await db.close();
  }
}

/**
 * True when the file has no schema objects. False when its tables are exactly `expected` (name to `CREATE TABLE`
 * text, compared with whitespace normalized). Throws `mismatch` for anything else.
 */
export async function isEmptySchema(
  db: SqliteDatabase,
  expected: ReadonlyMap<string, string>,
  mismatch: string,
): Promise<boolean> {
  const objects = await db.all<SchemaObject[]>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  if (objects.length === 0) {
    return true;
  }
  if (!matchesSchema(objects, expected)) {
    throw new Error(mismatch);
  }
  return false;
}

/** True when the file's tables are exactly `expected`. Never throws on a mismatch. */
export async function hasSchema(db: SqliteDatabase, expected: ReadonlyMap<string, string>): Promise<boolean> {
  const objects = await db.all<SchemaObject[]>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  return matchesSchema(objects, expected);
}

function matchesSchema(objects: SchemaObject[], expected: ReadonlyMap<string, string>): boolean {
  return (
    objects.length === expected.size &&
    objects.every(
      object =>
        object.type === 'table' &&
        object.sql !== null &&
        normalizeSql(expected.get(object.name) ?? '') === normalizeSql(object.sql),
    )
  );
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
