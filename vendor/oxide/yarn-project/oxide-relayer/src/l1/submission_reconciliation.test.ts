import { createLogger } from '@aztec-labs/foundation/log';

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
import { type Address, type Hash, type TransactionReceipt, TransactionReceiptNotFoundError } from 'viem';

import { signerCommitment } from './l1_tx_queue.js';
import { GenericSubmissionJournal } from './submission_journal.js';
import { reconcileUnresolvedSubmissions } from './submission_reconciliation.js';

const ADDRESS: Address = '0x00000000000000000000000000000000000000aa';
const OTHER_ADDRESS: Address = '0x00000000000000000000000000000000000000bb';
const CHAIN_ID = 31337;
const log = createLogger('oxide-relayer:test:submission-reconciliation');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** A chain with mined receipts and a finalized nonce of `ADDRESS`. */
class ReconciliationChain {
  finalizedNonce = 0;
  readonly receipts = new Map<Hash, TransactionReceipt>();

  readonly client = {
    getChainId: () => Promise.resolve(CHAIN_ID),
    getTransactionCount: ({ blockTag }: { address: Address; blockTag: 'finalized' }) => {
      expect(blockTag).toBe('finalized');
      return Promise.resolve(this.finalizedNonce);
    },
    getTransactionReceipt: ({ hash }: { hash: Hash }) => {
      const receipt = this.receipts.get(hash);
      return receipt ? Promise.resolve(receipt) : Promise.reject(new TransactionReceiptNotFoundError({ hash }));
    },
  };
}

async function openJournal(): Promise<GenericSubmissionJournal> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-generic-reconciliation-')));
  directories.push(directory);
  return await GenericSubmissionJournal.open(join(directory, 'submission.sqlite3'));
}

/** Leaves an accepted attempt, as a process killed while its monitor waited for the receipt. */
async function acceptedAttempt(
  journal: GenericSubmissionJournal,
  identity: string,
  nonce: number,
  signedTxHash: Hash,
  signer: Address = ADDRESS,
): Promise<void> {
  await journal.reserveSigning({
    operationIdentity: identity,
    signerCommitment: signerCommitment(signer),
    chainId: CHAIN_ID,
    nonce,
    requestDigest: `sha256:${'33'.repeat(32)}`,
  });
  await journal.recordPrepared(identity, signedTxHash, Buffer.from('signed bytes'));
  await journal.beginSend(identity);
  await journal.recordResponse(identity, JSON.stringify({ txHash: signedTxHash }));
  await journal.recordAccepted(identity);
}

const reconcile = (journal: GenericSubmissionJournal, chain: ReconciliationChain) =>
  reconcileUnresolvedSubmissions({ journal, client: chain.client, address: ADDRESS, log });

describe('reconcileUnresolvedSubmissions', () => {
  it('records the mined receipt of an attempt left accepted by a killed process', async () => {
    const journal = await openJournal();
    const chain = new ReconciliationChain();
    const hash: Hash = `0x${'11'.repeat(32)}`;
    await acceptedAttempt(journal, 'l1-operation:mined', 0, hash);
    chain.receipts.set(hash, { status: 'reverted', blockNumber: 12n } as TransactionReceipt);

    await expect(reconcile(journal, chain)).resolves.toBeUndefined();
    await expect(journal.read('l1-operation:mined')).resolves.toMatchObject({
      state: 'reverted',
      response: expect.stringContaining('"reconciled":true'),
    });
    await journal.close();
  });

  it('records a drop once a finalized transaction uses the nonce of the signed bytes', async () => {
    const journal = await openJournal();
    const chain = new ReconciliationChain();
    await acceptedAttempt(journal, 'fpc-funding:dropped', 3, `0x${'22'.repeat(32)}`);

    chain.finalizedNonce = 3;
    await expect(reconcile(journal, chain)).rejects.toThrow('unresolved outcome');
    await expect(journal.read('fpc-funding:dropped')).resolves.toMatchObject({ state: 'accepted' });

    chain.finalizedNonce = 4;
    await expect(reconcile(journal, chain)).resolves.toBeUndefined();
    await expect(journal.read('fpc-funding:dropped')).resolves.toMatchObject({ state: 'dropped_or_replaced' });
    await journal.close();
  });

  it('keeps refusing an attempt of another signer', async () => {
    const journal = await openJournal();
    const chain = new ReconciliationChain();
    await acceptedAttempt(journal, 'prover-claims:other', 0, `0x${'33'.repeat(32)}`, OTHER_ADDRESS);
    chain.finalizedNonce = 10;

    await expect(reconcile(journal, chain)).rejects.toThrow('unresolved outcome');
    await expect(journal.read('prover-claims:other')).resolves.toMatchObject({ state: 'accepted' });
    await journal.close();
  });
});
