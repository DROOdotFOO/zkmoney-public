import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';

import type { ExactOperationApproval } from './contract.js';
import { ExactOperationJournal } from './journal.js';
import { ExactApprovalClaimCollisionError, type ExactApprovalClaimStore } from './monotonic_claim.js';
import { relayExactOperation, type ExactOperationExecution } from './runner.js';
import { exactApprovalFixture } from './test_fixture.js';

const directories: string[] = [];
const approval = exactApprovalFixture();
const approvalCommitment = `sha256:${'cc'.repeat(32)}` as const;

class RecordingExecution implements ExactOperationExecution {
  signingCount = 0;
  observationCount = 0;
  signerCheckCount = 0;
  sendCount = 0;

  async observe(input: ExactOperationApproval) {
    this.observationCount++;
    return structuredClone(input);
  }

  async assertSignerIdentity() {
    this.signerCheckCount++;
  }

  async signOnce(_approval: ExactOperationApproval, assertApprovalWindow: () => void) {
    assertApprovalWindow();
    this.signingCount++;
    return {
      hash: `0x${'aa'.repeat(32)}`,
      bytes: Buffer.from('signed transaction'),
    };
  }

  async sendOnce(_signedTransaction: Buffer, assertApprovalWindow: () => void) {
    assertApprovalWindow();
    this.sendCount++;
    return `0x${'aa'.repeat(32)}`;
  }

  async waitForReceipt() {
    return {
      status: 'success' as const,
      transactionHash: `0x${'aa'.repeat(32)}`,
    };
  }
}

class RecordingClaimStore implements ExactApprovalClaimStore {
  claim:
    | { key: string; body: string; versionId: string; checksumSha256: string; retainUntil: Date }
    | undefined;

  async assertComplianceRetention(): Promise<void> {}

  async createIfAbsent(
    args: {
      key: string;
      body: string;
      checksumSha256: string;
      retainUntil: Date;
    },
    assertApprovalWindow: () => void,
  ): Promise<{ versionId: string }> {
    assertApprovalWindow();
    if (this.claim) throw new ExactApprovalClaimCollisionError();
    this.claim = { ...args, versionId: 'version-1' };
    return { versionId: this.claim.versionId };
  }

  async verify(args: {
    key: string;
    versionId: string;
    checksumSha256: string;
    retainUntil: Date;
  }): Promise<void> {
    expect(this.claim).toMatchObject(args);
  }

  async readExisting(key: string) {
    if (this.claim?.key !== key) throw new ExactApprovalClaimCollisionError();
    return { ...this.claim, retainUntil: this.claim.retainUntil.toISOString() };
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
  it('fails a signer mismatch before witness consumption or signing', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    execution.assertSignerIdentity = async () => {
      execution.signerCheckCount++;
      throw new Error('signer mismatch');
    };
    const claimStore = new RecordingClaimStore();
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore }),
    ).rejects.toThrow('signer mismatch');
    expect(execution.signerCheckCount).toBe(1);
    expect(execution.signingCount).toBe(0);
    expect(claimStore.claim).toBeUndefined();
    await state.close();
  });

  it('rejects an expired approval before observation, claim consumption or signing', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    const claimStore = new RecordingClaimStore();
    const expired = exactApprovalFixture(new Date('2020-01-01T00:00:00Z'));
    await expect(
      relayExactOperation({ approval: expired, approvalCommitment, journal: state, execution, claimStore }),
    ).rejects.toThrow(/execution window/);
    expect(execution.observationCount).toBe(0);
    expect(execution.signingCount).toBe(0);
    expect(claimStore.claim).toBeUndefined();
    await state.close();
  });

  it('does not publish the immutable claim when approval expires at its boundary', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    const claimStore = new RecordingClaimStore();
    const live = new Date(approval.notBefore);
    const expired = new Date(approval.expiresAt);
    const times = [live, expired];
    await expect(
      relayExactOperation({
        approval,
        approvalCommitment,
        journal: state,
        execution,
        claimStore,
        now: () => times.shift() ?? expired,
      }),
    ).rejects.toThrow(/execution window/);
    expect(claimStore.claim).toBeUndefined();
    expect(execution.signingCount).toBe(0);
    expect(execution.sendCount).toBe(0);
    await state.close();
  });
  it('refuses the L1 signature when approval expires at its boundary', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    const claimStore = new RecordingClaimStore();
    const live = new Date(approval.notBefore);
    const expired = new Date(approval.expiresAt);
    const times = [live, live, live, expired];
    await expect(
      relayExactOperation({
        approval,
        approvalCommitment,
        journal: state,
        execution,
        claimStore,
        now: () => times.shift() ?? expired,
      }),
    ).rejects.toThrow(/signing outcome is ambiguous/);
    expect(execution.signingCount).toBe(0);
    expect(execution.sendCount).toBe(0);
    await state.close();
  });

  it('refuses submission when approval expires at the send boundary', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    const claimStore = new RecordingClaimStore();
    const live = new Date(approval.notBefore);
    const expired = new Date(approval.expiresAt);
    const times = [live, live, live, live, expired];
    await expect(
      relayExactOperation({
        approval,
        approvalCommitment,
        journal: state,
        execution,
        claimStore,
        now: () => times.shift() ?? expired,
      }),
    ).rejects.toThrow(/send outcome is ambiguous/);
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(0);
    await state.close();
  });

  it('marks a replacement receipt ambiguous without confirming or failing the exact operation', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    execution.waitForReceipt = async () => ({
      status: 'success',
      transactionHash: `0x${'bb'.repeat(32)}`,
    });
    const claimStore = new RecordingClaimStore();

    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore }),
    ).rejects.toThrow(/replacement transaction/);
    await expect(state.read(approval.operation.id)).resolves.toMatchObject({
      state: 'ambiguous',
      l1TxHash: `0x${'aa'.repeat(32)}`,
    });
    expect(execution.sendCount).toBe(1);
    await state.close();
  });


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
    const claimStore = new RecordingClaimStore();
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore }),
    ).resolves.toEqual({
      l1TxHash: `0x${'aa'.repeat(32)}`,
    });
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore }),
    ).rejects.toThrow(
      /already consumed/,
    );
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(1);
    await expect(generic.all('SELECT * FROM obligations ORDER BY kind')).resolves.toEqual(rowsBefore);
    await expect(Promise.all([fileSha256(unrelatedState), fileSha256(unrelatedWal)])).resolves.toEqual(before);
    await generic.close();
    await state.close();
  });

  it('detects local journal rollback from the non-rollbackable claim', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-exact-rollback-')));
    directories.push(directory);
    const path = join(directory, 'journal.sqlite3');
    let state = await ExactOperationJournal.open(path);
    const execution = new RecordingExecution();
    const claimStore = new RecordingClaimStore();
    await relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore });
    await state.close();
    await rm(path);
    state = await ExactOperationJournal.open(path);
    await expect(
      relayExactOperation({
        approval: { ...approval, approvalNonce: `0x${'dd'.repeat(32)}` },
        approvalCommitment: `sha256:${'ee'.repeat(32)}`,
        journal: state,
        execution,
        claimStore,
      }),
    ).rejects.toBeInstanceOf(ExactApprovalClaimCollisionError);
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(1);
    await state.close();
  });

  it('adopts its own claim after a crash between the claim and the journal row', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-exact-claim-crash-')));
    directories.push(directory);
    const path = join(directory, 'journal.sqlite3');
    const crashed = await ExactOperationJournal.open(path);
    crashed.consumeApproval = async () => {
      throw new Error('process killed after the external claim');
    };
    const execution = new RecordingExecution();
    const claimStore = new RecordingClaimStore();
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: crashed, execution, claimStore }),
    ).rejects.toThrow('process killed');
    await crashed.close();
    const claim = claimStore.claim;
    expect(claim).toBeDefined();

    const restarted = await ExactOperationJournal.open(path);
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: restarted, execution, claimStore }),
    ).resolves.toEqual({ l1TxHash: `0x${'aa'.repeat(32)}` });
    expect(claimStore.claim).toBe(claim);
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(1);
    await restarted.close();
  });

  it('fails before signing when the local journal exists but its witness version is unavailable', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    const claimStore = new RecordingClaimStore();
    await relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore });
    claimStore.claim = undefined;
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore }),
    ).rejects.toThrow();
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(1);
    await state.close();
  });

  it('locks an ambiguous first send and never sends a second time', async () => {
    const state = await journal();
    const execution = new RecordingExecution();
    execution.sendOnce = async () => {
      execution.sendCount++;
      throw new Error('transport result unknown');
    };

    const claimStore = new RecordingClaimStore();
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore }),
    ).rejects.toThrow(
      /no second send is permitted/,
    );
    await expect(
      relayExactOperation({ approval, approvalCommitment, journal: state, execution, claimStore }),
    ).rejects.toThrow(
      /already consumed/,
    );
    expect(execution.signingCount).toBe(1);
    expect(execution.sendCount).toBe(1);
    await expect(state.read(approval.operation.id)).resolves.toMatchObject({ state: 'ambiguous' });
    await state.close();
  });
});
