import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';

import { ExactOperationJournal } from './journal.js';

const directories: string[] = [];

async function journalPath(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-exact-operation-')));
  directories.push(directory);
  return join(directory, 'journal.sqlite3');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ExactOperationJournal', () => {
  it('consumes an operation approval exactly once across restarts', async () => {
    const path = await journalPath();
    const first = await ExactOperationJournal.open(path);
    await first.consumeApproval(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`);
    await first.close();

    const restarted = await ExactOperationJournal.open(path);
    await expect(restarted.consumeApproval(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`)).rejects.toThrow(
      /already consumed/,
    );
    await restarted.close();
  });

  it('locks the operation permanently after an ambiguous send', async () => {
    const path = await journalPath();
    const operationId = `0x${'22'.repeat(32)}`;
    const first = await ExactOperationJournal.open(path);
    await first.consumeApproval(`0x${'11'.repeat(32)}`, operationId);
    await first.beginSigning(operationId);
    await first.recordSigned(operationId, `0x${'33'.repeat(32)}`, Buffer.from('signed transaction'));
    await first.beginSend(operationId);
    await first.recordAmbiguous(operationId);
    await first.close();

    const restarted = await ExactOperationJournal.open(path);
    await expect(restarted.beginSend(operationId)).rejects.toThrow(/ambiguous/);
    await expect(restarted.read(operationId)).resolves.toMatchObject({
      state: 'ambiguous',
      signedTxHash: `0x${'33'.repeat(32)}`,
      signedTx: Buffer.from('signed transaction'),
    });
    await restarted.close();
  });

  it('rejects a symlink journal before SQLite opens it', async () => {
    const path = await journalPath();
    const target = `${path}.target`;
    await writeFile(target, 'not a journal', { mode: 0o600 });
    await symlink(target, path);
    await expect(ExactOperationJournal.open(path)).rejects.toThrow(/owner-only regular file/);
  });

  it('rejects an existing generic SQLite database without mutation', async () => {
    const path = await journalPath();
    const generic = await open({ filename: path, driver: sqlite3Driver.Database });
    await generic.exec('CREATE TABLE relayer_operation (operation_id TEXT PRIMARY KEY)');
    await generic.close();
    await chmod(path, 0o600);

    await expect(ExactOperationJournal.open(path)).rejects.toThrow(/not an exact-operation journal/);
    const reopened = await open({ filename: path, driver: sqlite3Driver.Database });
    const tables = await reopened.all<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    await reopened.close();
    expect(tables.map(table => table.name)).toEqual(['relayer_operation']);
  });
});
