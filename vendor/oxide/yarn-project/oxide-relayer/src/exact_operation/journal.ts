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
import {
  type ExactApprovalClaimJournalReceipt,
  type ExactApprovalClaimReceipt,
  exactApprovalClaimJournalReceipt,
} from './monotonic_claim.js';

const SCHEMA_VERSION = 4;
const META_TABLE_SQL = `CREATE TABLE exact_operation_meta (schema_version INTEGER NOT NULL)`;
const OPERATIONS_TABLE_SQL = `CREATE TABLE exact_operations (
  approval_digest TEXT PRIMARY KEY,
  stage_a_approval_digest TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('approved', 'signing', 'signed', 'send_started', 'sent', 'confirmed', 'failed', 'ambiguous')),
  witness_key_commitment TEXT NOT NULL,
  witness_version_id TEXT NOT NULL,
  witness_checksum_sha256 TEXT NOT NULL,
  witness_retain_until TEXT NOT NULL,
  witness_body TEXT NOT NULL,
  signed_tx BLOB,
  signed_tx_hash TEXT,
  l1_tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const OPERATIONS_SCHEMA = new Map([
  ['exact_operation_meta', META_TABLE_SQL],
  ['exact_operations', OPERATIONS_TABLE_SQL],
]);
const SCHEMA_MISMATCH = 'Existing SQLite file is not the canonical exact-operation journal schema';
const JOURNAL_LABEL = 'Exact-operation journal';

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
  approvalCommitment: string;
  stageAApprovalDigest: string;
  signedTx?: Buffer;
  signedTxHash?: string;
  l1TxHash?: string;
  witness: ExactApprovalClaimJournalReceipt;
}


export class ExactOperationJournal {
  private constructor(
    readonly path: string,
    private readonly db: SqliteDatabase,
  ) {}

  static async open(filename: string): Promise<ExactOperationJournal> {
    const resolved = path.resolve(filename);
    await assertOwnerOnlyParent(resolved, JOURNAL_LABEL);
    await createOrValidateOwnerOnlyFile(resolved, JOURNAL_LABEL);
    await withReadOnlySqlite(resolved, 'read-only', assertEmptyOrExactJournal);
    const db = await openSqlite(resolved, 'read-write');
    try {
      await db.exec('PRAGMA busy_timeout = 0');
      await db.exec('PRAGMA locking_mode = NORMAL');
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

  /**
   * Durably notes, before the external witness claim, that this approval is about to be claimed. A crash after the
   * claim but before `consumeApproval` leaves the note, which lets the next run adopt its own claim. Without the note
   * an existing claim stays a collision, so a local journal rollback still fails closed.
   */
  async recordClaimIntent(approvalCommitment: string, operationId: string): Promise<void> {
    const temporary = `${this.claimIntentPath}.tmp`;
    await removeFile(temporary);
    const handle = await openFile(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(claimIntentBody(approvalCommitment, operationId));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.claimIntentPath);
    await syncDirectory(path.dirname(this.path));
  }

  /** True when `recordClaimIntent` ran for exactly this approval and operation and no row consumed it since. */
  async hasClaimIntent(approvalCommitment: string, operationId: string): Promise<boolean> {
    try {
      await assertOwnerOnlyFile(this.claimIntentPath, 'Exact-operation claim intent');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    return (await readFile(this.claimIntentPath, 'utf8')) === claimIntentBody(approvalCommitment, operationId);
  }

  private get claimIntentPath(): string {
    return `${this.path}.claim-intent.json`;
  }

  async consumeApproval(
    approvalCommitment: string,
    operationId: string,
    stageAApprovalDigest: string,
    witness: ExactApprovalClaimReceipt,
  ): Promise<void> {
    const journalWitness = exactApprovalClaimJournalReceipt(witness);
    await this.transaction(async () => {
      const existing = await this.db.get<{ operation_id: string }>(
        'SELECT operation_id FROM exact_operations WHERE approval_digest = ? OR operation_id = ? LIMIT 1',
        approvalCommitment,
        operationId,
      );
      if (existing) {
        throw new Error(`Exact operation ${operationId} approval was already consumed`);
      }
      await this.db.run(
        `INSERT INTO exact_operations
          (approval_digest, operation_id, stage_a_approval_digest, state, witness_key_commitment, witness_version_id,
           witness_checksum_sha256, witness_retain_until, witness_body, created_at, updated_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
        approvalCommitment,
        operationId,
        stageAApprovalDigest,
        journalWitness.keyCommitment,
        journalWitness.versionId,
        journalWitness.checksumSha256,
        journalWitness.retainUntil,
        journalWitness.body,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
    await removeFile(this.claimIntentPath);
    await syncDirectory(path.dirname(this.path));
  }

  async findConsumption(
    approvalCommitment: string,
    operationId: string,
  ): Promise<ExactApprovalClaimJournalReceipt | undefined> {
    const row = await this.db.get<{
      witness_key_commitment: ExactApprovalClaimJournalReceipt['keyCommitment'];
      witness_version_id: string;
      witness_checksum_sha256: string;
      witness_retain_until: string;
      witness_body: string;
    }>(
      `SELECT witness_key_commitment, witness_version_id, witness_checksum_sha256, witness_retain_until, witness_body
       FROM exact_operations WHERE approval_digest = ? OR operation_id = ? LIMIT 1`,
      approvalCommitment,
      operationId,
    );
    return row === undefined
      ? undefined
      : {
          keyCommitment: row.witness_key_commitment,
          versionId: row.witness_version_id,
          checksumSha256: row.witness_checksum_sha256,
          retainUntil: row.witness_retain_until,
          body: row.witness_body,
        };
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
      witness_key_commitment: ExactApprovalClaimJournalReceipt['keyCommitment'];
      stage_a_approval_digest: string;
      witness_version_id: string;
      witness_checksum_sha256: string;
      witness_retain_until: string;
      witness_body: string;
      signed_tx: Buffer | null;
      signed_tx_hash: string | null;
      l1_tx_hash: string | null;
    }>(
      `SELECT state, operation_id, approval_digest, stage_a_approval_digest, witness_key_commitment,
              witness_version_id, witness_checksum_sha256, witness_retain_until, witness_body,
              signed_tx, signed_tx_hash, l1_tx_hash
       FROM exact_operations WHERE operation_id = ?`,
      operationId,
    );
    if (!row) {
      throw new Error(`Exact operation ${operationId} is not journaled`);
    }
    return {
      state: row.state,
      operationId: row.operation_id,
      approvalCommitment: row.approval_digest,
      stageAApprovalDigest: row.stage_a_approval_digest,
      witness: {
        keyCommitment: row.witness_key_commitment,
        versionId: row.witness_version_id,
        checksumSha256: row.witness_checksum_sha256,
        retainUntil: row.witness_retain_until,
        body: row.witness_body,
      },
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
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      await action();
      await this.db.exec('COMMIT');
    } catch (error) {
      try {
        await this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Exact-operation journal transaction rollback failed');
      }
      throw error;
    }
  }
}

export async function auditExactOperationJournal(filename: string): Promise<ExactOperationRecord[]> {
  const resolved = path.resolve(filename);
  await assertOwnerOnlyParent(resolved, JOURNAL_LABEL);
  try {
    await assertOwnerOnlyFile(resolved, JOURNAL_LABEL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return await withReadOnlySqlite(resolved, 'read-only', async db => {
    if (await assertEmptyOrExactJournal(db)) return [];
    const rows = await db.all<
      Array<{
        state: ExactOperationState;
        operation_id: string;
        approval_digest: string;
        stage_a_approval_digest: string;
        signed_tx: Buffer | null;
        signed_tx_hash: string | null;
        l1_tx_hash: string | null;
        witness_key_commitment: ExactApprovalClaimJournalReceipt['keyCommitment'];
        witness_version_id: string;
        witness_checksum_sha256: string;
        witness_retain_until: string;
        witness_body: string;
      }>
    >(
      `SELECT state, operation_id, approval_digest, stage_a_approval_digest, signed_tx, signed_tx_hash, l1_tx_hash,
              witness_key_commitment, witness_version_id, witness_checksum_sha256, witness_retain_until, witness_body
       FROM exact_operations ORDER BY operation_id`,
    );
    return rows.map(row => ({
      state: row.state,
      operationId: row.operation_id,
      approvalCommitment: row.approval_digest,
      stageAApprovalDigest: row.stage_a_approval_digest,
      ...(row.signed_tx === null ? {} : { signedTx: row.signed_tx }),
      ...(row.signed_tx_hash === null ? {} : { signedTxHash: row.signed_tx_hash }),
      ...(row.l1_tx_hash === null ? {} : { l1TxHash: row.l1_tx_hash }),
      witness: {
        keyCommitment: row.witness_key_commitment,
        versionId: row.witness_version_id,
        checksumSha256: row.witness_checksum_sha256,
        retainUntil: row.witness_retain_until,
        body: row.witness_body,
      },
    }));
  });
}

/** True for an empty file. Throws unless the file is exactly the canonical journal schema at `SCHEMA_VERSION`. */
async function assertEmptyOrExactJournal(db: SqliteDatabase): Promise<boolean> {
  if (await isEmptySchema(db, OPERATIONS_SCHEMA, SCHEMA_MISMATCH)) {
    return true;
  }
  const versions = await db.all<{ schema_version: number }[]>('SELECT schema_version FROM exact_operation_meta');
  if (versions.length !== 1 || versions[0]?.schema_version !== SCHEMA_VERSION) {
    throw new Error('Existing exact-operation journal has an unrecognized schema version');
  }
  return false;
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

function claimIntentBody(approvalCommitment: string, operationId: string): string {
  return `${JSON.stringify({ schema: 'oxide-relayer.exact-claim-intent.v1', approvalCommitment, operationId })}\n`;
}

async function removeFile(filename: string): Promise<void> {
  try {
    await unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await openFile(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
