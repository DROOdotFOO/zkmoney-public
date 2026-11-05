import { startAnvil } from '@aztec-labs/ethereum/test';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  type PublicActions,
  type TestClient,
  TransactionRequestEIP1559,
  type Transport,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { l1Transport } from './client.js';
import { L1TxQueue, type SentL1Tx } from './l1_tx_queue.js';
import { GenericSubmissionJournal } from './submission_journal.js';

/** Anvil's first dev account, funded at genesis. */
const ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
/** A plain transfer to a second dev account: it always succeeds, so two sends differ only in nonce. */
const REQUEST = { to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address, data: '0x' as const };
const BLOCK_WINDOW = 2;

describe('L1 submission broadcasts against anvil', () => {
  let stopAnvil: () => Promise<void>;
  let url: string;
  let chain: TestClient<'anvil', Transport, typeof foundry> & PublicActions<Transport, typeof foundry>;
  let l1TxQueue: L1TxQueue;
  /** Every send of the current test, so the teardown can wait for the monitors that still read. */
  let sent: SentL1Tx[];
  let journal: GenericSubmissionJournal;
  let directory: string;

  beforeAll(async () => {
    ({ rpcUrl: url, stop: stopAnvil } = await startAnvil({ port: 0 }));
    chain = createTestClient({ chain: foundry, mode: 'anvil', transport: http(url) }).extend(publicActions);
    // Mining off: blocks come only from the test, which makes the expiry clock deterministic.
    await chain.setAutomine(false);
  }, 30_000);

  afterAll(async () => {
    await stopAnvil?.();
  });

  beforeEach(async () => {
    sent = [];
    directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-l1-queue-anvil-')));
    journal = await GenericSubmissionJournal.open(join(directory, 'submission.sqlite3'));
    l1TxQueue = new L1TxQueue({
      client: createPublicClient({ chain: foundry, transport: l1Transport(url) }),
      wallet: createWalletClient({ chain: foundry, account: ACCOUNT, transport: l1Transport(url) }),
      submissionJournal: journal,
      blockWindow: BLOCK_WINDOW,
      pollIntervalMs: 50,
    });
  });

  // A monitor stops only when its nonce is used or the chain passes its expiry bound, so the teardown mines past it.
  afterEach(async () => {
    await l1TxQueue.stop();
    await chain.mine({ blocks: BLOCK_WINDOW + 3 });
    await Promise.allSettled(sent.map(tx => tx.settled));
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });

  function senderNonce(): Promise<number> {
    return chain.getTransactionCount({ address: ACCOUNT.address, blockTag: 'latest' });
  }

  it('broadcasts a sequential nonce batch before any transaction is mined', async () => {
    const before = await senderNonce();
    const gases: TransactionRequestEIP1559[] = [
      { gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n },
      { gas: 21_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 200_000_000n },
      { gas: 21_000n, maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 300_000_000n },
    ];

    const batch = await l1TxQueue.enqueue(send =>
      Promise.all(
        gases.map((gas, index) =>
          send({ ...REQUEST, ...gas }, { kind: 'l1-operation', id: `anvil-batch-${index}` }),
        ),
      ),
    );
    sent.push(...batch);

    expect(batch.map(tx => tx.nonce)).toEqual([before, before + 1, before + 2]);
    await expect(chain.getTransactionCount({ address: ACCOUNT.address, blockTag: 'pending' })).resolves.toBe(
      before + 3,
    );
    const pending = await Promise.all(batch.map(tx => chain.getTransaction({ hash: tx.txHash })));
    expect(
      pending.map(tx => ({
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      })),
    ).toEqual(gases);

    await chain.mine({ blocks: 1 });
    await expect(Promise.all(batch.map(tx => tx.settled))).resolves.toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    ]);
    expect(await senderNonce()).toBe(before + 3);
  }, 30_000);
});
