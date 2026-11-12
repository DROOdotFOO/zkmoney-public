import { chmod, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';

import { GenericSubmissionJournal, assertNoUnresolvedGenericSubmissions } from './submission_journal.js';

const directories: string[] = [];
const prepared = {
  operationIdentity: 'l1-operation:reviewed-operation',
  signerCommitment: `sha256:${'11'.repeat(32)}`,
  chainId: 1,
  nonce: 7,
  requestDigest: `sha256:${'33'.repeat(32)}`,
  signedTxHash: `0x${'22'.repeat(32)}`,
  signedTx: Buffer.from('private signed bytes'),
};

async function openJournal() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-generic-submission-')));
  directories.push(directory);
  return await GenericSubmissionJournal.open(join(directory, 'submission.sqlite3'));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function reserveAndPrepare(journal: GenericSubmissionJournal): Promise<void> {
  const { signedTxHash, signedTx, ...reservation } = prepared;
  await journal.reserveSigning(reservation);
  await journal.recordPrepared(prepared.operationIdentity, signedTxHash, signedTx);
}

describe('generic submission journal', () => {
  it('fsyncs private signed bytes before send and remains owner-only', async () => {
    const journal = await openJournal();
    await reserveAndPrepare(journal);
    await expect(journal.read(prepared.operationIdentity)).resolves.toMatchObject({
      ...prepared,
      state: 'prepared',
    });
    expect((await stat(journal.path)).mode & 0o777).toBe(0o600);
    await expect(journal.assertNoUnresolved()).rejects.toThrow('unresolved outcome');
    await journal.close();
  });

  it('persists the exact RPC response before accepting the send', async () => {
    const journal = await openJournal();
    await reserveAndPrepare(journal);
    await journal.beginSend(prepared.operationIdentity);
    const response = JSON.stringify({ txHash: prepared.signedTxHash });
    await journal.recordResponse(prepared.operationIdentity, response);
    await expect(journal.read(prepared.operationIdentity)).resolves.toMatchObject({
      state: 'response_received',
      response,
    });
    await journal.recordAccepted(prepared.operationIdentity);
    await expect(journal.assertNoUnresolved()).rejects.toThrow('unresolved outcome');
    await journal.recordTerminal(prepared.operationIdentity, 'confirmed');
    await expect(journal.assertNoUnresolved()).resolves.toBeUndefined();
    await journal.close();
  });

  it('makes send ambiguity durable across restart', async () => {
    const journal = await openJournal();
    const path = journal.path;
    await reserveAndPrepare(journal);
    await journal.beginSend(prepared.operationIdentity);
    await journal.recordAmbiguous(prepared.operationIdentity, 'disconnect');
    await journal.close();
    const restarted = await GenericSubmissionJournal.open(path);
    await expect(restarted.assertNoUnresolved()).rejects.toThrow('unresolved outcome');
    await expect(restarted.read(prepared.operationIdentity)).resolves.toMatchObject({
      state: 'ambiguous',
      response: 'disconnect',
    });
    await restarted.close();
  });

  it('refuses a second signing identity after accepted submission', async () => {
    const journal = await openJournal();
    const { signedTxHash, signedTx, ...reservation } = prepared;
    await journal.reserveSigning(reservation);
    await journal.recordPrepared(prepared.operationIdentity, signedTxHash, signedTx);
    await journal.beginSend(prepared.operationIdentity);
    await journal.recordResponse(prepared.operationIdentity, '{}');
    await journal.recordAccepted(prepared.operationIdentity);
    await expect(journal.reserveSigning(reservation)).rejects.toThrow('already journaled');
    await journal.close();
  });

  it('starts a new attempt of an identity only after the earlier attempt is terminal', async () => {
    const journal = await openJournal();
    const { signedTxHash: _hash, signedTx, ...reservation } = prepared;
    await reserveAndPrepare(journal);
    await journal.beginSend(prepared.operationIdentity);
    await journal.recordResponse(prepared.operationIdentity, '{}');
    await journal.recordAccepted(prepared.operationIdentity);
    await journal.recordTerminal(prepared.operationIdentity, 'reverted');

    await journal.reserveSigning({ ...reservation, nonce: 8 });
    await expect(journal.read(prepared.operationIdentity)).resolves.toMatchObject({
      attempt: 2,
      nonce: 8,
      state: 'signing',
    });
    await journal.recordPrepared(prepared.operationIdentity, `0x${'44'.repeat(32)}`, signedTx);
    await expect(journal.reserveSigning({ ...reservation, nonce: 9 })).rejects.toThrow('already journaled');
    await expect(journal.listUnresolved()).resolves.toEqual([
      expect.objectContaining({ attempt: 2, state: 'prepared', signedTxHash: `0x${'44'.repeat(32)}` }),
    ]);
    await journal.close();
  });

  it('migrates a schema 2 journal in place and keeps its rows as first attempts', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-generic-submission-v2-')));
    directories.push(directory);
    const path = join(directory, 'submission.sqlite3');
    const legacy = await open({ filename: path, driver: sqlite3Driver.Database });
    await legacy.exec(`
      CREATE TABLE submission_journal_meta (schema_version INTEGER NOT NULL);
      INSERT INTO submission_journal_meta VALUES (2);
      CREATE TABLE submissions (
        operation_identity TEXT PRIMARY KEY,
        signer_commitment TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        nonce INTEGER NOT NULL,
        request_digest TEXT NOT NULL,
        signed_tx_hash TEXT UNIQUE,
        signed_tx BLOB,
        state TEXT NOT NULL CHECK (state IN ('signing', 'prepared', 'sending', 'response_received', 'accepted', 'confirmed', 'reverted', 'dropped_or_replaced', 'ambiguous')),
        response TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO submissions VALUES (
        '${prepared.operationIdentity}', '${prepared.signerCommitment}', 1, 7, '${prepared.requestDigest}',
        '${prepared.signedTxHash}', NULL, 'confirmed', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    await legacy.close();
    await chmod(path, 0o600);
    await expect(assertNoUnresolvedGenericSubmissions(path)).resolves.toBeUndefined();

    const journal = await GenericSubmissionJournal.open(path);
    await expect(journal.read(prepared.operationIdentity)).resolves.toMatchObject({ attempt: 1, state: 'confirmed' });
    const { signedTxHash: _hash, signedTx: _bytes, ...reservation } = prepared;
    await journal.reserveSigning({ ...reservation, nonce: 8 });
    await expect(journal.read(prepared.operationIdentity)).resolves.toMatchObject({ attempt: 2, nonce: 8 });
    await journal.close();
    await expect(assertNoUnresolvedGenericSubmissions(path)).rejects.toThrow('unresolved outcome');
  });

  it('makes a crash during signing permanently unresolved without signed bytes', async () => {
    const journal = await openJournal();
    const path = journal.path;
    const { signedTxHash: _hash, signedTx: _bytes, ...reservation } = prepared;
    await journal.reserveSigning(reservation);
    await journal.close();
    const restarted = await GenericSubmissionJournal.open(path);
    await expect(restarted.assertNoUnresolved()).rejects.toThrow('unresolved outcome');
    await expect(restarted.read(prepared.operationIdentity)).resolves.toMatchObject({
      ...reservation,
      state: 'signing',
    });
    await restarted.close();
  });
});
