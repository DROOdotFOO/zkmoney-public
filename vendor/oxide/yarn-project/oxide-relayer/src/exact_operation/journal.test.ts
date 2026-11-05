import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { ExactOperationJournal } from './journal.js';

const directories: string[] = [];

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oxide-exact-operation-'));
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
});
