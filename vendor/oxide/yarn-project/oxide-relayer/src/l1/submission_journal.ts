import { chmod, lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  type SqliteDatabase,
  assertOwnerOnlyParent,
  createOrValidateOwnerOnlyFile,
  hasSchema,
  openSqlite,
  withReadOnlySqlite,
} from '../state/secure_sqlite.js';

const SCHEMA_VERSION = 3;
const META_TABLE_SQL = `CREATE TABLE submission_journal_meta (schema_version INTEGER NOT NULL)`;
const STATE_CHECK = `CHECK (state IN ('signing', 'prepared', 'sending', 'response_received', 'accepted', 'confirmed', 'reverted', 'dropped_or_replaced', 'ambiguous'))`;
/** One row per signing attempt. A new attempt of an identity starts only after the earlier attempt is terminal. */
const SUBMISSIONS_TABLE_SQL = `CREATE TABLE submissions (
  operation_identity TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  signer_commitment TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  request_digest TEXT NOT NULL,
  signed_tx_hash TEXT UNIQUE,
  signed_tx BLOB,
  state TEXT NOT NULL ${STATE_CHECK},
  response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_identity, attempt)
)`;
/** Schema 2 allowed one row per identity ever. Opening it read-write migrates it to schema 3. */
const V2_SUBMISSIONS_TABLE_SQL = `CREATE TABLE submissions (
  operation_identity TEXT PRIMARY KEY,
  signer_commitment TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  request_digest TEXT NOT NULL,
  signed_tx_hash TEXT UNIQUE,
  signed_tx BLOB,
  state TEXT NOT NULL ${STATE_CHECK},
  response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const SCHEMAS = new Map<number, ReadonlyMap<string, string>>([
  [
    SCHEMA_VERSION,
    new Map([
      ['submission_journal_meta', META_TABLE_SQL],
      ['submissions', SUBMISSIONS_TABLE_SQL],
    ]),
  ],
  [
    2,
    new Map([
      ['submission_journal_meta', META_TABLE_SQL],
      ['submissions', V2_SUBMISSIONS_TABLE_SQL],
    ]),
  ],
]);
const UNRESOLVED_SQL = "state NOT IN ('confirmed', 'reverted', 'dropped_or_replaced')";

export type GenericSubmissionState =
  | 'signing'
  | 'prepared'
  | 'sending'
  | 'response_received'
  | 'accepted'
  | 'confirmed'
  | 'reverted'
  | 'dropped_or_replaced'
  | 'ambiguous';

export type TerminalGenericSubmissionState = 'confirmed' | 'reverted' | 'dropped_or_replaced';

const IS_TERMINAL: Record<GenericSubmissionState, boolean> = {
  signing: false,
  prepared: false,
  sending: false,
  response_received: false,
  accepted: false,
  confirmed: true,
  reverted: true,
  dropped_or_replaced: true,
  ambiguous: false,
};

export interface GenericSigningReservation {
  operationIdentity: string;
  signerCommitment: string;
  chainId: number;
  nonce: number;
  requestDigest: string;
}

export interface DurableGenericSubmission extends GenericSigningReservation {
  /** 1 for the first signing of the identity; each later attempt follows a terminal one. */
  attempt: number;
  signedTxHash?: string;
  signedTx?: Buffer;
  state: GenericSubmissionState;
  response?: string;
}

/**
 * The write path of one L1 tx queue. Every method that takes an identity acts on its latest attempt; an identity
 * can be signed again once its latest attempt is terminal.
 */
export interface DurableSubmissionJournal {
  assertNoUnresolved(): Promise<void>;
  reserveSigning(record: GenericSigningReservation): Promise<void>;
  recordPrepared(operationIdentity: string, signedTxHash: string, signedTx: Buffer): Promise<void>;
  beginSend(operationIdentity: string): Promise<void>;
  recordResponse(operationIdentity: string, response: string): Promise<void>;
  recordAccepted(operationIdentity: string): Promise<void>;
  recordTerminal(operationIdentity: string, state: TerminalGenericSubmissionState, response?: string): Promise<void>;
  recordAmbiguous(operationIdentity: string, response?: string): Promise<void>;
  read(operationIdentity: string): Promise<DurableGenericSubmission | undefined>;
}

/** Startup reconciliation of attempts that a previous process left without a terminal outcome. */
export interface ReconcilableSubmissionJournal {
  listUnresolved(): Promise<DurableGenericSubmission[]>;
  recordReconciled(
    operationIdentity: string,
    attempt: number,
    state: TerminalGenericSubmissionState,
    evidence: string,
  ): Promise<void>;
  assertNoUnresolved(): Promise<void>;
}

interface SubmissionRow {
  operation_identity: string;
  attempt: number;
  signer_commitment: string;
  chain_id: number;
  nonce: number;
  request_digest: string;
  signed_tx_hash: string | null;
  signed_tx: Buffer | null;
  state: GenericSubmissionState;
  response: string | null;
}

const SUBMISSION_COLUMNS = `operation_identity, attempt, signer_commitment, chain_id, nonce, request_digest,
  signed_tx_hash, signed_tx, state, response`;

export class GenericSubmissionJournal implements DurableSubmissionJournal, ReconcilableSubmissionJournal {
  private constructor(
    readonly path: string,
    private readonly db: SqliteDatabase,
  ) {}
  private transactions: Promise<void> = Promise.resolve();

  static async open(filename: string): Promise<GenericSubmissionJournal> {
    const resolved = path.resolve(filename);
    await assertOwnerOnlyParent(resolved, 'Generic submission journal');
    await createOrValidateOwnerOnlyFile(resolved, 'Generic submission journal');
    await withReadOnlySqlite(resolved, 'read-only', schemaVersion);
    const db = await openSqlite(resolved, 'read-write');
    try {
      await db.exec('PRAGMA busy_timeout = 0');
      await db.exec('PRAGMA locking_mode = EXCLUSIVE');
      await db.exec('PRAGMA journal_mode = DELETE');
      await db.exec('PRAGMA synchronous = FULL');
      await db.exec('BEGIN EXCLUSIVE; COMMIT');
      const version = await schemaVersion(db);
      if (version === undefined) {
        await execInTransaction(db, [
          META_TABLE_SQL,
          `INSERT INTO submission_journal_meta VALUES (${SCHEMA_VERSION})`,
          SUBMISSIONS_TABLE_SQL,
        ]);
      } else if (version === 2) {
        await execInTransaction(db, [
          'ALTER TABLE submissions RENAME TO submissions_v2',
          SUBMISSIONS_TABLE_SQL,
          `INSERT INTO submissions (operation_identity, attempt, signer_commitment, chain_id, nonce, request_digest,
             signed_tx_hash, signed_tx, state, response, created_at, updated_at)
           SELECT operation_identity, 1, signer_commitment, chain_id, nonce, request_digest,
             signed_tx_hash, signed_tx, state, response, created_at, updated_at
           FROM submissions_v2`,
          'DROP TABLE submissions_v2',
          `UPDATE submission_journal_meta SET schema_version = ${SCHEMA_VERSION}`,
        ]);
      }
      await chmod(resolved, 0o600);
      return new GenericSubmissionJournal(resolved, db);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async assertNoUnresolved(): Promise<void> {
    await assertNoUnresolvedRows(this.db);
  }

  async listUnresolved(): Promise<DurableGenericSubmission[]> {
    const rows = await this.db.all<SubmissionRow[]>(
      `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE ${UNRESOLVED_SQL} ORDER BY nonce, created_at`,
    );
    return rows.map(toSubmission);
  }

  async reserveSigning(record: GenericSigningReservation): Promise<void> {
    await this.transaction(async () => {
      const latest = await this.latest(record.operationIdentity);
      if (latest && !IS_TERMINAL[latest.state]) {
        throw new Error('The durable L1 operation identity is already journaled with an unresolved outcome');
      }
      const now = new Date().toISOString();
      await this.db.run(
        `INSERT INTO submissions
          (operation_identity, attempt, signer_commitment, chain_id, nonce, request_digest, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'signing', ?, ?)`,
        record.operationIdentity,
        (latest?.attempt ?? 0) + 1,
        record.signerCommitment,
        record.chainId,
        record.nonce,
        record.requestDigest,
        now,
        now,
      );
    });
  }

  async recordPrepared(operationIdentity: string, signedTxHash: string, signedTx: Buffer): Promise<void> {
    await this.transaction(async () => {
      const attempt = await this.requireState(operationIdentity, 'signing');
      await this.db.run(
        `UPDATE submissions
         SET state = 'prepared', signed_tx_hash = ?, signed_tx = ?, updated_at = ?
         WHERE operation_identity = ? AND attempt = ?`,
        signedTxHash,
        signedTx,
        new Date().toISOString(),
        operationIdentity,
        attempt,
      );
    });
  }

  async beginSend(operationIdentity: string): Promise<void> {
    await this.transition(operationIdentity, 'prepared', 'sending');
  }

  async recordResponse(operationIdentity: string, response: string): Promise<void> {
    await this.transaction(async () => {
      const attempt = await this.requireState(operationIdentity, 'sending');
      await this.db.run(
        `UPDATE submissions SET state = 'response_received', response = ?, updated_at = ?
         WHERE operation_identity = ? AND attempt = ?`,
        response,
        new Date().toISOString(),
        operationIdentity,
        attempt,
      );
    });
  }

  async recordAccepted(operationIdentity: string): Promise<void> {
    await this.transition(operationIdentity, 'response_received', 'accepted');
  }

  async recordTerminal(
    operationIdentity: string,
    state: TerminalGenericSubmissionState,
    response?: string,
  ): Promise<void> {
    await this.transaction(async () => {
      const attempt = await this.requireState(operationIdentity, 'accepted');
      await this.setTerminal(operationIdentity, attempt, state, response);
    });
  }

  async recordReconciled(
    operationIdentity: string,
    attempt: number,
    state: TerminalGenericSubmissionState,
    evidence: string,
  ): Promise<void> {
    await this.transaction(async () => {
      const row = await this.db.get<{ state: GenericSubmissionState }>(
        'SELECT state FROM submissions WHERE operation_identity = ? AND attempt = ?',
        operationIdentity,
        attempt,
      );
      if (!row) throw new Error('Durable L1 submission attempt is not journaled');
      if (IS_TERMINAL[row.state]) {
        throw new Error('A terminal durable L1 submission cannot be reconciled again');
      }
      await this.setTerminal(operationIdentity, attempt, state, evidence);
    });
  }

  async recordAmbiguous(operationIdentity: string, response?: string): Promise<void> {
    await this.transaction(async () => {
      const latest = await this.latest(operationIdentity);
      if (!latest) throw new Error('Durable L1 submission is not journaled');
      if (IS_TERMINAL[latest.state]) {
        throw new Error('A terminal durable L1 submission cannot become ambiguous');
      }
      await this.db.run(
        `UPDATE submissions SET state = 'ambiguous', response = ?, updated_at = ?
         WHERE operation_identity = ? AND attempt = ?`,
        response ?? null,
        new Date().toISOString(),
        operationIdentity,
        latest.attempt,
      );
    });
  }

  async read(operationIdentity: string): Promise<DurableGenericSubmission | undefined> {
    const row = await this.db.get<SubmissionRow>(
      `SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE operation_identity = ? ORDER BY attempt DESC LIMIT 1`,
      operationIdentity,
    );
    return row === undefined ? undefined : toSubmission(row);
  }

  async close(): Promise<void> {
    await this.transactions;
    await this.db.close();
  }

  private async setTerminal(
    operationIdentity: string,
    attempt: number,
    state: TerminalGenericSubmissionState,
    response: string | undefined,
  ): Promise<void> {
    await this.db.run(
      `UPDATE submissions SET state = ?, response = COALESCE(?, response), updated_at = ?
       WHERE operation_identity = ? AND attempt = ?`,
      state,
      response ?? null,
      new Date().toISOString(),
      operationIdentity,
      attempt,
    );
  }

  private async transition(
    operationIdentity: string,
    from: GenericSubmissionState,
    to: GenericSubmissionState,
  ): Promise<void> {
    await this.transaction(async () => {
      const attempt = await this.requireState(operationIdentity, from);
      await this.db.run(
        'UPDATE submissions SET state = ?, updated_at = ? WHERE operation_identity = ? AND attempt = ?',
        to,
        new Date().toISOString(),
        operationIdentity,
        attempt,
      );
    });
  }

  private async latest(
    operationIdentity: string,
  ): Promise<{ attempt: number; state: GenericSubmissionState } | undefined> {
    return await this.db.get<{ attempt: number; state: GenericSubmissionState }>(
      'SELECT attempt, state FROM submissions WHERE operation_identity = ? ORDER BY attempt DESC LIMIT 1',
      operationIdentity,
    );
  }

  /** Returns the latest attempt, which must be in state `expected`. */
  private async requireState(operationIdentity: string, expected: GenericSubmissionState): Promise<number> {
    const latest = await this.latest(operationIdentity);
    if (!latest) throw new Error('Durable L1 submission is not journaled');
    if (latest.state !== expected) {
      throw new Error(`Durable L1 submission is not in expected state ${expected}`);
    }
    return latest.attempt;
  }

  private async transaction(action: () => Promise<void>): Promise<void> {
    const result = this.transactions.then(async () => {
      await this.db.exec('BEGIN IMMEDIATE');
      try {
        await action();
        await this.db.exec('COMMIT');
      } catch (error) {
        await rollback(this.db, error);
      }
    });
    this.transactions = result.catch(() => {});
    await result;
  }
}

/**
 * Read-only check of the canonical journal, for a runtime that must not create SQLite side files beside it. A missing
 * journal has no unresolved submission.
 */
export async function assertNoUnresolvedGenericSubmissions(filename: string): Promise<void> {
  const resolved = path.resolve(filename);
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error('Canonical generic submission journal must be one regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await withReadOnlySqlite(resolved, 'immutable', async db => {
    if ((await schemaVersion(db)) !== undefined) {
      await assertNoUnresolvedRows(db);
    }
  });
}

async function assertNoUnresolvedRows(db: SqliteDatabase): Promise<void> {
  const unresolved = await db.get<{ operation_identity: string; nonce: number; state: GenericSubmissionState }>(
    `SELECT operation_identity, nonce, state FROM submissions WHERE ${UNRESOLVED_SQL} ORDER BY created_at LIMIT 1`,
  );
  if (unresolved) {
    throw new Error(
      `A durable L1 submission has an unresolved outcome; signing and submission are blocked ` +
        `(${unresolved.operation_identity}, nonce ${unresolved.nonce}, state ${unresolved.state}). ` +
        'It resolves once the chain shows its receipt or a finalized transaction uses its nonce.',
    );
  }
}

/** The schema version of a canonical journal, or undefined for an empty file. Throws for anything else. */
async function schemaVersion(db: SqliteDatabase): Promise<number | undefined> {
  if (await hasSchema(db, new Map())) {
    return undefined;
  }
  for (const [version, tables] of SCHEMAS) {
    if (await hasSchema(db, tables)) {
      const versions = await db.all<{ schema_version: number }[]>('SELECT schema_version FROM submission_journal_meta');
      if (versions.length !== 1 || versions[0]?.schema_version !== version) {
        throw new Error('Existing generic submission journal has an unrecognized schema version');
      }
      return version;
    }
  }
  throw new Error('Existing SQLite file is not the canonical generic submission journal schema');
}

async function execInTransaction(db: SqliteDatabase, statements: string[]): Promise<void> {
  await db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of statements) {
      await db.exec(statement);
    }
    await db.exec('COMMIT');
  } catch (error) {
    await rollback(db, error);
  }
}

async function rollback(db: SqliteDatabase, error: unknown): Promise<never> {
  try {
    await db.exec('ROLLBACK');
  } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], 'Generic submission journal transaction rollback failed');
  }
  throw error;
}

function toSubmission(row: SubmissionRow): DurableGenericSubmission {
  return {
    operationIdentity: row.operation_identity,
    attempt: row.attempt,
    signerCommitment: row.signer_commitment,
    chainId: row.chain_id,
    nonce: row.nonce,
    requestDigest: row.request_digest,
    ...(row.signed_tx_hash === null ? {} : { signedTxHash: row.signed_tx_hash }),
    ...(row.signed_tx === null ? {} : { signedTx: row.signed_tx }),
    state: row.state,
    ...(row.response === null ? {} : { response: row.response }),
  };
}
