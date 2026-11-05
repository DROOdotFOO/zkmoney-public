import { chmod, lstat, open as openFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { type Database, open } from 'sqlite';
import sqlite3Driver, { type Database as Sqlite3Database, type Statement as Sqlite3Statement } from 'sqlite3';

const SCHEMA_VERSION = 1;
const META_TABLE_SQL = `CREATE TABLE exact_operation_meta (schema_version INTEGER NOT NULL)`;
const OPERATIONS_TABLE_SQL = `CREATE TABLE exact_operations (
  approval_digest TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('approved', 'signing', 'signed', 'send_started', 'sent', 'confirmed', 'failed', 'ambiguous')),
  signed_tx BLOB,
  signed_tx_hash TEXT,
  l1_tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

type SqliteDatabase = Database<Sqlite3Database, Sqlite3Statement>;

export type ExactOperationState =
  | 'approved'
  | 'signing'
  | 'signed'
  | 'send_started'
  | 'sent'
  | 'confirmed'
  | 'failed'
  | 'ambiguous';
export interface ExactOperationRecord {
  state: ExactOperationState;
  operationId: string;
  approvalDigest: string;
  signedTx?: Buffer;
  signedTxHash?: string;
  l1TxHash?: string;
}


export class ExactOperationJournal {
  private constructor(
    readonly path: string,
    private readonly db: SqliteDatabase,
  ) {}

  static async open(filename: string): Promise<ExactOperationJournal> {
    const resolved = path.resolve(filename);
    await assertSecureParent(resolved);
    await createOrValidateJournalFile(resolved);
    await assertEmptyOrExactJournalFile(resolved);
    // OPEN_URI enables SQLite's nofollow flag, so a path swap to a symlink is rejected.
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
      await db.exec('PRAGMA locking_mode = EXCLUSIVE');
      await db.exec('PRAGMA journal_mode = DELETE');
      await db.exec('PRAGMA synchronous = FULL');
      await db.exec('BEGIN EXCLUSIVE; COMMIT');
      await assertEmptyOrExactJournal(db);
      await initialize(db);
      await chmod(resolved, 0o600);
      return new ExactOperationJournal(resolved, db);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async consumeApproval(approvalDigest: string, operationId: string): Promise<void> {
    await this.transaction(async () => {
      const existing = await this.db.get<{ operation_id: string }>(
        'SELECT operation_id FROM exact_operations WHERE approval_digest = ? OR operation_id = ? LIMIT 1',
        approvalDigest,
        operationId,
      );
      if (existing) {
        throw new Error(`Exact operation ${operationId} approval was already consumed`);
      }
      await this.db.run(
        `INSERT INTO exact_operations
          (approval_digest, operation_id, state, created_at, updated_at)
         VALUES (?, ?, 'approved', ?, ?)`,
        approvalDigest,
        operationId,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
  }


  async beginSigning(operationId: string): Promise<void> {
    await this.transition(operationId, 'approved', 'signing');
  }

  async recordSigned(operationId: string, signedTxHash: string, signedTx: Buffer): Promise<void> {
    await this.transaction(async () => {
      await this.requireState(operationId, 'signing');
      await this.db.run(
        `UPDATE exact_operations
         SET state = 'signed', signed_tx_hash = ?, signed_tx = ?, updated_at = ?
         WHERE operation_id = ?`,
        signedTxHash,
        signedTx,
        new Date().toISOString(),
        operationId,
      );
    });
  }

  async beginSend(operationId: string): Promise<void> {
    await this.transition(operationId, 'signed', 'send_started');
  }

  async recordSent(operationId: string, l1TxHash: string): Promise<void> {
    await this.transaction(async () => {
      await this.requireState(operationId, 'send_started');
      const signed = await this.db.get<{ signed_tx_hash: string }>(
        'SELECT signed_tx_hash FROM exact_operations WHERE operation_id = ?',
        operationId,
      );
      if (signed?.signed_tx_hash.toLowerCase() !== l1TxHash.toLowerCase()) {
        throw new Error(`Exact operation ${operationId} returned a transaction hash that does not match its signed bytes`);
      }
      await this.db.run(
        `UPDATE exact_operations
         SET state = 'sent', l1_tx_hash = ?, updated_at = ?
         WHERE operation_id = ?`,
        l1TxHash,
        new Date().toISOString(),
        operationId,
      );
    });
  }

  async recordConfirmed(operationId: string): Promise<void> {
    await this.transition(operationId, 'sent', 'confirmed');
  }

  async recordFailed(operationId: string): Promise<void> {
    await this.transition(operationId, 'sent', 'failed');
  }

  async recordAmbiguous(operationId: string): Promise<void> {
    await this.transaction(async () => {
      const state = await this.state(operationId);
      if (!['signing', 'signed', 'send_started', 'sent'].includes(state)) {
        throw new Error(`Exact operation ${operationId} is ${state}; cannot mark it ambiguous`);
      }
      await this.db.run(
        `UPDATE exact_operations SET state = 'ambiguous', updated_at = ? WHERE operation_id = ?`,
        new Date().toISOString(),
        operationId,
      );
    });
  }

  async read(operationId: string): Promise<ExactOperationRecord> {
    const row = await this.db.get<{
      state: ExactOperationState;
      operation_id: string;
      approval_digest: string;
      signed_tx: Buffer | null;
      signed_tx_hash: string | null;
      l1_tx_hash: string | null;
    }>(
      `SELECT state, operation_id, approval_digest, signed_tx, signed_tx_hash, l1_tx_hash
       FROM exact_operations WHERE operation_id = ?`,
      operationId,
    );
    if (!row) {
      throw new Error(`Exact operation ${operationId} is not journaled`);
    }
    return {
      state: row.state,
      operationId: row.operation_id,
      approvalDigest: row.approval_digest,
      ...(row.signed_tx === null ? {} : { signedTx: row.signed_tx }),
      ...(row.signed_tx_hash === null ? {} : { signedTxHash: row.signed_tx_hash }),
      ...(row.l1_tx_hash === null ? {} : { l1TxHash: row.l1_tx_hash }),
    };
  }

  private async transition(
    operationId: string,
    from: ExactOperationState,
    to: ExactOperationState,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireState(operationId, from);
      await this.db.run(
        'UPDATE exact_operations SET state = ?, updated_at = ? WHERE operation_id = ?',
        to,
        new Date().toISOString(),
        operationId,
      );
    });
  }

  private async state(operationId: string): Promise<ExactOperationState> {
    const row = await this.db.get<{ state: ExactOperationState }>(
      'SELECT state FROM exact_operations WHERE operation_id = ?',
      operationId,
    );
    if (!row) {
      throw new Error(`Exact operation ${operationId} is not journaled`);
    }
    return row.state;
  }

  private async requireState(operationId: string, expected: ExactOperationState): Promise<void> {
    const state = await this.state(operationId);
    if (state !== expected) {
      throw new Error(`Exact operation ${operationId} is ${state}; expected ${expected}`);
    }
  }
  async close(): Promise<void> {
    await this.db.close();
  }

  private async transaction(action: () => Promise<void>): Promise<void> {
    let committed = false;
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      await action();
      await this.db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) {
        await this.db.exec('ROLLBACK').catch(() => undefined);
      }
    }
  }
}

async function assertSecureParent(filename: string): Promise<void> {
  const parent = path.dirname(filename);
  const [metadata, canonical] = await Promise.all([lstat(parent), realpath(parent)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== parent) {
    throw new Error('Exact-operation journal parent must be one canonical directory');
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error('Exact-operation journal parent must not be group- or world-writable');
  }
}

async function createOrValidateJournalFile(filename: string): Promise<void> {
  try {
    const handle = await openFile(filename, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Exact-operation journal must be one owner-only regular file');
  }
}

async function assertEmptyOrExactJournalFile(filename: string): Promise<void> {
  // sqlite3 is a CJS native addon whose runtime constructor is on the default export.
  // eslint-disable-next-line import-x/no-named-as-default-member
  const mode = sqlite3Driver.OPEN_READONLY | sqlite3Driver.OPEN_FULLMUTEX | sqlite3Driver.OPEN_URI;
  const db = await open({
    filename: `file:${filename}?mode=ro&nofollow=1`,
    driver: sqlite3Driver.Database,
    mode,
  });
  try {
    await assertEmptyOrExactJournal(db);
  } finally {
    await db.close();
  }
}

async function assertEmptyOrExactJournal(db: SqliteDatabase): Promise<void> {
  const objects = await db.all<{ type: string; name: string; sql: string | null }[]>(
    `SELECT type, name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  );
  if (objects.length === 0) {
    return;
  }
  const expected = new Map([
    ['exact_operation_meta', normalizeSql(META_TABLE_SQL)],
    ['exact_operations', normalizeSql(OPERATIONS_TABLE_SQL)],
  ]);
  if (
    objects.length !== expected.size ||
    objects.some(
      object =>
        object.type !== 'table' ||
        object.sql === null ||
        expected.get(object.name) !== normalizeSql(object.sql),
    )
  ) {
    throw new Error('Existing SQLite file is not the canonical exact-operation journal schema');
  }
  const versions = await db.all<{ schema_version: number }[]>('SELECT schema_version FROM exact_operation_meta');
  if (versions.length !== 1 || versions[0]?.schema_version !== SCHEMA_VERSION) {
    throw new Error('Existing exact-operation journal has an unrecognized schema version');
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

async function initialize(db: SqliteDatabase): Promise<void> {
  const meta = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exact_operation_meta'",
  );
  if (!meta) {
    await db.exec(`
      BEGIN IMMEDIATE;
      ${META_TABLE_SQL};
      INSERT INTO exact_operation_meta (schema_version) VALUES (${SCHEMA_VERSION});
      ${OPERATIONS_TABLE_SQL};
      COMMIT;
    `);
    return;
  }
  const version = await db.get<{ schema_version: number }>('SELECT schema_version FROM exact_operation_meta');
  if (version?.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Exact-operation journal schema ${String(version?.schema_version)} is not supported; expected ${SCHEMA_VERSION}. ` +
        'No automatic migration is available.',
    );
  }
}
