import { chmod, lstat, open as openFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { type Database, open } from 'sqlite';
import sqlite3Driver, { type Database as Sqlite3Database, type Statement as Sqlite3Statement } from 'sqlite3';

const SCHEMA_VERSION = 1;
const META_TABLE_SQL = `CREATE TABLE submission_journal_meta (schema_version INTEGER NOT NULL)`;
const SUBMISSIONS_TABLE_SQL = `CREATE TABLE submissions (
  operation_identity TEXT PRIMARY KEY,
  signer_commitment TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  signed_tx_hash TEXT NOT NULL UNIQUE,
  signed_tx BLOB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'sending', 'response_received', 'accepted', 'ambiguous')),
  response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

type SqliteDatabase = Database<Sqlite3Database, Sqlite3Statement>;
export type GenericSubmissionState = 'prepared' | 'sending' | 'response_received' | 'accepted' | 'ambiguous';

export interface DurableGenericSubmission {
  operationIdentity: string;
  signerCommitment: string;
  chainId: number;
  nonce: number;
  signedTxHash: string;
  signedTx: Buffer;
  state: GenericSubmissionState;
  response?: string;
}

export interface DurableSubmissionJournal {
  assertNoUnresolved(): Promise<void>;
  prepare(record: Omit<DurableGenericSubmission, 'state' | 'response'>): Promise<void>;
  beginSend(operationIdentity: string): Promise<void>;
  recordResponse(operationIdentity: string, response: string): Promise<void>;
  recordAccepted(operationIdentity: string): Promise<void>;
  recordAmbiguous(operationIdentity: string, response?: string): Promise<void>;
  read(operationIdentity: string): Promise<DurableGenericSubmission | undefined>;
}

export class GenericSubmissionJournal implements DurableSubmissionJournal {
  private constructor(
    readonly path: string,
    private readonly db: SqliteDatabase,
  ) {}

  static async open(filename: string): Promise<GenericSubmissionJournal> {
    const resolved = path.resolve(filename);
    await assertSecureParent(resolved);
    await createOrValidateFile(resolved);
    await assertEmptyOrExactFile(resolved);
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
      await assertEmptyOrExact(db);
      await initialize(db);
      await chmod(resolved, 0o600);
      return new GenericSubmissionJournal(resolved, db);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async assertNoUnresolved(): Promise<void> {
    const unresolved = await this.db.get<{ operation_identity: string; state: GenericSubmissionState }>(
      "SELECT operation_identity, state FROM submissions WHERE state != 'accepted' ORDER BY created_at LIMIT 1",
    );
    if (unresolved) {
      throw new Error('A durable L1 submission has an unresolved outcome; signing and submission are blocked');
    }
  }

  async prepare(record: Omit<DurableGenericSubmission, 'state' | 'response'>): Promise<void> {
    await this.transaction(async () => {
      const existing = await this.db.get<{ state: GenericSubmissionState }>(
        'SELECT state FROM submissions WHERE operation_identity = ? OR signed_tx_hash = ? LIMIT 1',
        record.operationIdentity,
        record.signedTxHash,
      );
      if (existing) {
        throw new Error('The durable L1 operation identity or signed transaction was already journaled');
      }
      const now = new Date().toISOString();
      await this.db.run(
        `INSERT INTO submissions
          (operation_identity, signer_commitment, chain_id, nonce, signed_tx_hash, signed_tx, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        record.operationIdentity,
        record.signerCommitment,
        record.chainId,
        record.nonce,
        record.signedTxHash,
        record.signedTx,
        now,
        now,
      );
    });
  }

  async beginSend(operationIdentity: string): Promise<void> {
    await this.transition(operationIdentity, 'prepared', 'sending');
  }

  async recordResponse(operationIdentity: string, response: string): Promise<void> {
    await this.transaction(async () => {
      await this.requireState(operationIdentity, 'sending');
      await this.db.run(
        "UPDATE submissions SET state = 'response_received', response = ?, updated_at = ? WHERE operation_identity = ?",
        response,
        new Date().toISOString(),
        operationIdentity,
      );
    });
  }

  async recordAccepted(operationIdentity: string): Promise<void> {
    await this.transition(operationIdentity, 'response_received', 'accepted');
  }

  async recordAmbiguous(operationIdentity: string, response?: string): Promise<void> {
    await this.transaction(async () => {
      const state = await this.state(operationIdentity);
      if (state === 'accepted') {
        throw new Error('An accepted durable L1 submission cannot become ambiguous');
      }
      await this.db.run(
        "UPDATE submissions SET state = 'ambiguous', response = ?, updated_at = ? WHERE operation_identity = ?",
        response ?? null,
        new Date().toISOString(),
        operationIdentity,
      );
    });
  }

  async read(operationIdentity: string): Promise<DurableGenericSubmission | undefined> {
    const row = await this.db.get<{
      operation_identity: string;
      signer_commitment: string;
      chain_id: number;
      nonce: number;
      signed_tx_hash: string;
      signed_tx: Buffer;
      state: GenericSubmissionState;
      response: string | null;
    }>(
      `SELECT operation_identity, signer_commitment, chain_id, nonce, signed_tx_hash, signed_tx, state, response
       FROM submissions WHERE operation_identity = ?`,
      operationIdentity,
    );
    return row === undefined
      ? undefined
      : {
          operationIdentity: row.operation_identity,
          signerCommitment: row.signer_commitment,
          chainId: row.chain_id,
          nonce: row.nonce,
          signedTxHash: row.signed_tx_hash,
          signedTx: row.signed_tx,
          state: row.state,
          ...(row.response === null ? {} : { response: row.response }),
        };
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private async transition(
    operationIdentity: string,
    from: GenericSubmissionState,
    to: GenericSubmissionState,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireState(operationIdentity, from);
      await this.db.run(
        'UPDATE submissions SET state = ?, updated_at = ? WHERE operation_identity = ?',
        to,
        new Date().toISOString(),
        operationIdentity,
      );
    });
  }

  private async state(operationIdentity: string): Promise<GenericSubmissionState> {
    const row = await this.db.get<{ state: GenericSubmissionState }>(
      'SELECT state FROM submissions WHERE operation_identity = ?',
      operationIdentity,
    );
    if (!row) throw new Error('Durable L1 submission is not journaled');
    return row.state;
  }

  private async requireState(operationIdentity: string, expected: GenericSubmissionState): Promise<void> {
    if ((await this.state(operationIdentity)) !== expected) {
      throw new Error(`Durable L1 submission is not in expected state ${expected}`);
    }
  }

  private async transaction(action: () => Promise<void>): Promise<void> {
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      await action();
      await this.db.exec('COMMIT');
    } catch (error) {
      try {
        await this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Generic submission journal transaction rollback failed');
      }
      throw error;
    }
  }
}

async function assertSecureParent(filename: string): Promise<void> {
  const parent = path.dirname(filename);
  const [metadata, canonical] = await Promise.all([lstat(parent), realpath(parent)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== parent || (metadata.mode & 0o022) !== 0) {
    throw new Error('Generic submission journal parent must be one canonical owner-only directory');
  }
}

async function createOrValidateFile(filename: string): Promise<void> {
  try {
    const handle = await openFile(filename, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Generic submission journal must be one owner-only regular file');
  }
}

async function assertEmptyOrExactFile(filename: string): Promise<void> {
  const mode = sqlite3Driver.OPEN_READONLY | sqlite3Driver.OPEN_FULLMUTEX | sqlite3Driver.OPEN_URI;
  const db = await open({
    filename: `file:${filename}?mode=ro&nofollow=1`,
    driver: sqlite3Driver.Database,
    mode,
  });
  try {
    await assertEmptyOrExact(db);
  } finally {
    await db.close();
  }
}

async function assertEmptyOrExact(db: SqliteDatabase): Promise<void> {
  const objects = await db.all<{ type: string; name: string; sql: string | null }[]>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  if (objects.length === 0) return;
  const expected = new Map([
    ['submission_journal_meta', normalizeSql(META_TABLE_SQL)],
    ['submissions', normalizeSql(SUBMISSIONS_TABLE_SQL)],
  ]);
  if (
    objects.length !== expected.size ||
    objects.some(
      object =>
        object.type !== 'table' || object.sql === null || expected.get(object.name) !== normalizeSql(object.sql),
    )
  ) {
    throw new Error('Existing SQLite file is not the canonical generic submission journal schema');
  }
  const versions = await db.all<{ schema_version: number }[]>('SELECT schema_version FROM submission_journal_meta');
  if (versions.length !== 1 || versions[0]?.schema_version !== SCHEMA_VERSION) {
    throw new Error('Existing generic submission journal has an unrecognized schema version');
  }
}

async function initialize(db: SqliteDatabase): Promise<void> {
  const meta = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'submission_journal_meta'",
  );
  if (!meta) {
    await db.exec(`BEGIN IMMEDIATE; ${META_TABLE_SQL}; INSERT INTO submission_journal_meta VALUES (${SCHEMA_VERSION}); ${SUBMISSIONS_TABLE_SQL}; COMMIT;`);
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
