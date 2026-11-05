import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';

import type { ExactOperationApproval } from './contract.js';
import { ExactOperationJournal } from './journal.js';
import { relayExactOperation, type ExactOperationExecution } from './runner.js';

const directories: string[] = [];
const approval: ExactOperationApproval = {
  schema: 'oxide-relayer.exact-operation.v1',
  runtime: {
    host: 'ovh-ubuntu1',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    imageDigest: `sha256:${'11'.repeat(32)}`,
    stateSetDigest: `sha256:${'22'.repeat(32)}`,
  },
  deployment: {
    label: 'dep-v6',
    chainId: '1',
    rollupVersion: '2070860440',
    portal: '0x1111111111111111111111111111111111111111',
    l2Token: `0x${'22'.repeat(32)}`,
    broadcaster: `0x${'33'.repeat(32)}`,
    operationExecutor: '0x4444444444444444444444444444444444444444',
  },
  operation: {
    id: `0x${'55'.repeat(32)}`,
    kind: 'withdrawal_finalization',
    sourceTxHash: `0x${'66'.repeat(32)}`,
    sourceBlockNumber: '1234',
    sourceBlockHash: `0x${'77'.repeat(32)}`,
    sourceFinalized: true,
    sourceEventCount: 1,
    target: '0x1111111111111111111111111111111111111111',
    payoutToken: '0x8888888888888888888888888888888888888888',
    calldataSha256: `0x${'99'.repeat(32)}`,
  },
  withdrawal: {
    executor: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    recipientCommitment: `0x${'bb'.repeat(32)}`,
    amount: '1000000000000000000',
    proverTip: '1000000000000000',
    relayerTip: '2000000000000000',
  },
  economics: {
    executorVersion: 'gas-to-cover',
    minimumPayout: '1',
    maximumGasToCover: '500000',
    tokenWeiPerEth: '1000000000000000000',
    maximumGas: '1000000',
    maximumFeePerGas: '30000000000',
    maximumPriorityFeePerGas: '2000000000',
    maximumTotalFee: '30000000000000000',
  },
};

class RecordingExecution implements ExactOperationExecution {
  signingCount = 0;
  sendCount = 0;

  async observe() {
    return structuredClone(approval);
  }

  async signOnce() {
    this.signingCount++;
    return {
      hash: `0x${'aa'.repeat(32)}`,
      bytes: Buffer.from('signed transaction'),
    };
  }

  async sendOnce() {
    this.sendCount++;
    return `0x${'aa'.repeat(32)}`;
  }

  async waitForReceipt() {
    return { status: 'success' as const };
  }
}

async function journal(): Promise<ExactOperationJournal> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-exact-runner-')));
  directories.push(directory);
  return await ExactOperationJournal.open(join(directory, 'journal.sqlite3'));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}


describe('relayExactOperation', () => {
  it('signs and submits one exact matching operation once', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    const unrelatedState = join(directories.at(-1)!, `oxide-relayer-0x${'11'.repeat(20)}.sqlite3`);
    const generic = await open({ filename: unrelatedState, driver: sqlite3Driver.Database });
    await generic.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE obligations (kind TEXT PRIMARY KEY, status TEXT NOT NULL, evidence BLOB NOT NULL);
      INSERT INTO obligations VALUES
        ('unrelated-backlog', 'pending', X'01'),
        ('historical', 'due', X'02'),
        ('retryable', 'deferred', X'03');
    `);
    const unrelatedWal = `${unrelatedState}-wal`;
    const rowsBefore = await generic.all('SELECT * FROM obligations ORDER BY kind');
    const before = await Promise.all([fileSha256(unrelatedState), fileSha256(unrelatedWal)]);
    await expect(relayExactOperation({ approval, journal: state, execution })).resolves.toEqual({
      l1TxHash: `0x${'aa'.repeat(32)}`,
    });
    await expect(relayExactOperation({ approval, journal: state, execution })).rejects.toThrow(/already consumed/);
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(1);
    await expect(generic.all('SELECT * FROM obligations ORDER BY kind')).resolves.toEqual(rowsBefore);
    await expect(Promise.all([fileSha256(unrelatedState), fileSha256(unrelatedWal)])).resolves.toEqual(before);
    await generic.close();
    await state.close();
  });

  it('locks an ambiguous first send and never sends a second time', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    execution.sendOnce = async () => {
      execution.sendCount++;
      throw new Error('transport result unknown');
    };

    await expect(relayExactOperation({ approval, journal: state, execution })).rejects.toThrow(
      /no second send is permitted/,
    );
    await expect(relayExactOperation({ approval, journal: state, execution })).rejects.toThrow(/already consumed/);
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(1);
    await expect(state.read(approval.operation.id)).resolves.toMatchObject({ state: 'ambiguous' });
    await state.close();
  });
});
