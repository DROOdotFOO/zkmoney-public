import { sleep } from '@aztec-labs/foundation/sleep';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
  type TransactionRequestEIP1559,
  type Transport,
  type WalletClient,
  keccak256,
  toHex,
} from 'viem';

import { LogRecorder } from '../log_recorder.js';
import { L1TxQueue, type SendL1Tx, type SentL1Tx, isAboveMaxFeePerGas } from './l1_tx_queue.js';
import type {
  DurableGenericSubmission,
  DurableSubmissionJournal,
  GenericSubmissionState,
  GenericSigningReservation,
} from './submission_journal.js';

const ADDRESS: Address = '0x00000000000000000000000000000000000000aa';
const REQUEST = { to: '0x0000000000000000000000000000000000000001', data: '0x' } satisfies TransactionRequestEIP1559;
const GAS: TransactionRequestEIP1559 = { gas: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
const BLOCK_WINDOW = 5;

class MemorySubmissionJournal implements DurableSubmissionJournal {
  readonly rows = new Map<string, DurableGenericSubmission>();

  async assertNoUnresolved(): Promise<void> {
    if (
      [...this.rows.values()].some(
        row => !['confirmed', 'reverted', 'dropped_or_replaced'].includes(row.state),
      )
    ) {
      throw new Error('unresolved');
    }
  }

  async reserveSigning(record: GenericSigningReservation): Promise<void> {
    if (this.rows.has(record.operationIdentity)) throw new Error('already journaled');
    this.rows.set(record.operationIdentity, { ...record, state: 'signing' });
  }

  async recordPrepared(operationIdentity: string, signedTxHash: string, signedTx: Buffer): Promise<void> {
    const row = this.require(operationIdentity);
    if (row.state !== 'signing') throw new Error('expected signing');
    this.rows.set(operationIdentity, { ...row, state: 'prepared', signedTxHash, signedTx });
  }

  async beginSend(operationIdentity: string): Promise<void> {
    this.transition(operationIdentity, 'prepared', 'sending');
  }

  async recordResponse(operationIdentity: string, response: string): Promise<void> {
    this.transition(operationIdentity, 'sending', 'response_received', response);
  }

  async recordAccepted(operationIdentity: string): Promise<void> {
    this.transition(operationIdentity, 'response_received', 'accepted');
  }

  async recordTerminal(
    operationIdentity: string,
    state: 'confirmed' | 'reverted' | 'dropped_or_replaced',
    response?: string,
  ): Promise<void> {
    this.transition(operationIdentity, 'accepted', state, response);
  }

  async recordAmbiguous(operationIdentity: string, response?: string): Promise<void> {
    const row = this.require(operationIdentity);
    this.rows.set(operationIdentity, { ...row, state: 'ambiguous', ...(response === undefined ? {} : { response }) });
  }

  async read(operationIdentity: string): Promise<DurableGenericSubmission | undefined> {
    return this.rows.get(operationIdentity);
  }

  private transition(
    operationIdentity: string,
    expected: GenericSubmissionState,
    state: GenericSubmissionState,
    response?: string,
  ): void {
    const row = this.require(operationIdentity);
    if (row.state !== expected) throw new Error(`expected ${expected}`);
    this.rows.set(operationIdentity, { ...row, state, ...(response === undefined ? {} : { response }) });
  }

  private require(operationIdentity: string): DurableGenericSubmission {
    const row = this.rows.get(operationIdentity);
    if (!row) throw new Error('not journaled');
    return row;
  }
}

/** The chain behind a fake client. A broadcast raises the pending count; the test moves the rest. */
class FakeChain {
  blockNumber = 100n;
  pendingNonce = 0;
  /** The latest count: every nonce below it is used by a mined transaction. */
  minedNonce = 0;
  inFlight = 0;
  maxInFlight = 0;
  readonly receipts = new Map<Hex, TransactionReceipt>();
  /** The transactions of each mined block. */
  readonly blocks = new Map<bigint, Array<{ hash: Hex; from: Address; nonce: number }>>();
  readonly broadcasts: Array<{ hash: Hex; nonce: number; to?: Hex }> = [];
  /** Errors for the next broadcasts, in order. */
  readonly broadcastFailures: Error[] = [];
  /** Errors for the next block number reads, in order. */
  readonly blockReadFailures: Error[] = [];
  readonly signed = new Map<Hex, { nonce: number; to?: Hex }>();

  readonly client = {
    chain: { id: 31337 },
    account: {
      address: ADDRESS,
      signTransaction: jest.fn(async ({ nonce, to }: { nonce: number; to?: Hex } & Record<string, unknown>) => {
        const serialized = keccak256(toHex(`${nonce}:${to ?? ''}`));
        this.signed.set(serialized, { nonce, to });
        return serialized;
      }),
    },
    getBlockNumber: jest.fn(() => {
      const failure = this.blockReadFailures.shift();
      return failure ? Promise.reject(failure) : Promise.resolve(this.blockNumber);
    }),
    getTransactionCount: jest.fn(({ blockTag }: { blockTag: 'pending' | 'latest' }) =>
      Promise.resolve(blockTag === 'pending' ? this.pendingNonce : this.minedNonce),
    ),
    sendRawTransaction: jest.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        await sleep(0);
        const failure = this.broadcastFailures.shift();
        if (failure) throw failure;
        const signed = this.signed.get(serializedTransaction);
        if (!signed) throw new Error('unknown signed transaction');
        const hash = keccak256(serializedTransaction);
        this.broadcasts.push({ hash, nonce: signed.nonce, to: signed.to });
        this.pendingNonce = Math.max(this.pendingNonce, signed.nonce + 1);
        return hash;
      } finally {
        this.inFlight--;
      }
    }),
    getTransactionReceipt: jest.fn(({ hash }: { hash: Hex }) => {
      const receipt = this.receipts.get(hash);
      return receipt ? Promise.resolve(receipt) : Promise.reject(new TransactionReceiptNotFoundError({ hash }));
    }),
    getBlock: jest.fn(({ blockNumber }: { blockNumber: bigint; includeTransactions?: boolean }) =>
      Promise.resolve({ transactions: this.blocks.get(blockNumber) ?? [] }),
    ),
  };

  /** Mines `tx` in a new block, with a receipt of `status`. */
  mine(tx: SentL1Tx, status: 'success' | 'reverted' = 'success'): TransactionReceipt {
    const receipt = { transactionHash: tx.txHash, status } as TransactionReceipt;
    this.receipts.set(tx.txHash, receipt);
    this.mineHash(tx.txHash, tx.nonce);
    return receipt;
  }

  /** Mines a transaction with `hash` and `nonce` in a new block, without a receipt. */
  mineHash(hash: Hex, nonce: number): void {
    this.blockNumber++;
    this.blocks.set(this.blockNumber, [{ hash, from: ADDRESS, nonce }]);
    this.minedNonce = Math.max(this.minedNonce, nonce + 1);
  }
}

/** True when `promise` has not settled after every queued microtask has run. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise(resolve => setImmediate(resolve));
  return !settled;
}

describe('L1TxQueue', () => {
  let chain: FakeChain;
  let sent: SentL1Tx[];
  let queues: L1TxQueue[];
  let statuses: Map<Hex, { status: string; simError?: string; isRevert?: boolean }>;

  let operationSequence: number;
  beforeEach(() => {
    chain = new FakeChain();
    sent = [];
    queues = [];
    statuses = new Map();
    operationSequence = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(url => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(Response.json(statuses.get(target.split('/').at(-1) as Hex) ?? { status: 'PENDING' }));
    });
  });

  afterEach(async () => {
    await Promise.allSettled(queues.map(queue => queue.stop()));
    // Give every public-route monitor authoritative receipts; Protect monitors
    // that already proved a drop remain rejected.
    sent.filter(tx => !tx.simulated).forEach(tx => chain.mine(tx));
    await Promise.allSettled(sent.map(tx => tx.settled));
    jest.restoreAllMocks();
  });

  function makeQueue(options: Partial<ConstructorParameters<typeof L1TxQueue>[0]> = {}) {
    const queue = new L1TxQueue({
      client: chain.client as unknown as PublicClient,
      wallet: chain.client as unknown as WalletClient<Transport, Chain, LocalAccount>,
      blockWindow: BLOCK_WINDOW,
      pollIntervalMs: 1,
      submissionJournal: new MemorySubmissionJournal(),
      ...options,
    });
    queues.push(queue);
    return queue;
  }

  function enqueue<T>(
    queue: L1TxQueue,
    submit: (send: (request: TransactionRequestEIP1559) => Promise<SentL1Tx>) => Promise<T>,
    options = {},
  ) {
    return queue.enqueue(
      send =>
        submit(async request => {
          const tx = await send(request, {
            kind: 'l1-operation',
            id: `test-operation-${operationSequence++}`,
          });
          sent.push(tx);
          return tx;
        }),
      options,
    );
  }

  function send(queue: L1TxQueue, request: TransactionRequestEIP1559 = {}, options = {}) {
    return enqueue(queue, send => send({ ...REQUEST, ...GAS, ...request }), options);
  }

  it('gives concurrent sends sequential nonces and broadcasts one at a time', async () => {
    const results = await enqueue(makeQueue(), send =>
      Promise.all([send({ ...REQUEST, ...GAS }), send({ ...REQUEST, ...GAS }), send({ ...REQUEST, ...GAS })]),
    );
    expect(results.map(tx => tx.nonce)).toEqual([0, 1, 2]);
    expect(chain.broadcasts.map(tx => tx.nonce)).toEqual([0, 1, 2]);
    expect(chain.maxInFlight).toBe(1);
  });

  it('broadcasts with the requested gas and fee caps', async () => {
    const tx = await send(makeQueue(), { gas: 50_000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 3n });
    expect(chain.client.account.signTransaction).toHaveBeenCalledWith({
      to: REQUEST.to,
      data: REQUEST.data,
      nonce: 0,
      chainId: 31337,
      gas: 50_000n,
      maxFeePerGas: 7n,
      maxPriorityFeePerGas: 3n,
      type: 'eip1559',
    });
    expect(tx).toMatchObject({ txHash: chain.broadcasts[0].hash, nonce: 0 });
  });

  it('broadcasts later transactions in a callback without waiting for earlier receipts', async () => {
    const [first, second] = await enqueue(makeQueue(), async send => {
      const first = await send({ ...REQUEST, ...GAS });
      const second = await send({ ...REQUEST, ...GAS });
      return [first, second];
    });
    expect(second.nonce).toBe(1);
    await expect(isPending(first.settled)).resolves.toBe(true);
  });

  it('durably blocks every later signing after an unknown send result', async () => {
    chain.broadcastFailures.push(new Error('disconnect during send'));
    const journal = new MemorySubmissionJournal();
    const queue = makeQueue({ submissionJournal: journal });
    await enqueue(queue, async send => {
      const first = send({ ...REQUEST, ...GAS });
      const second = send({ ...REQUEST, ...GAS });
      await expect(first).rejects.toThrow('durably ambiguous');
      await expect(second).rejects.toThrow('no further signing is permitted');
    });
    expect(chain.client.account.signTransaction).toHaveBeenCalledTimes(1);
    expect(chain.client.sendRawTransaction).toHaveBeenCalledTimes(1);
    await expect(journal.assertNoUnresolved()).rejects.toThrow('unresolved');
    expect(journal.rows.get('l1-operation:test-operation-0')?.state).toBe('ambiguous');
  });

  it('blocks restart after a crash immediately before send', async () => {
    const journal = new MemorySubmissionJournal();
    const queue = makeQueue({
      submissionJournal: journal,
      submissionHooks: { afterPrepared: () => Promise.reject(new Error('crash before send')) },
    });
    await expect(send(queue)).rejects.toThrow('durably ambiguous');
    expect(chain.client.account.signTransaction).toHaveBeenCalledTimes(1);
    expect(chain.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(journal.rows.get('l1-operation:test-operation-0')?.state).toBe('prepared');
    await expect(journal.assertNoUnresolved()).rejects.toThrow('unresolved');
  });

  it('persists the exact response before a crash immediately after send', async () => {
    const journal = new MemorySubmissionJournal();
    const queue = makeQueue({
      submissionJournal: journal,
      submissionHooks: { afterResponse: () => Promise.reject(new Error('crash after response')) },
    });
    await expect(send(queue)).rejects.toThrow('durably ambiguous');
    const row = journal.rows.get('l1-operation:test-operation-0');
    expect(row).toMatchObject({ state: 'ambiguous', response: expect.stringContaining('txHash') });
    expect(chain.client.account.signTransaction).toHaveBeenCalledTimes(1);
    expect(chain.client.sendRawTransaction).toHaveBeenCalledTimes(1);
    await expect(journal.assertNoUnresolved()).rejects.toThrow('unresolved');
  });

  it('keeps the last broadcast as a lower bound when the RPC gives a stale pending count', async () => {
    await enqueue(makeQueue(), async send => {
      await send({ ...REQUEST, ...GAS });
      chain.pendingNonce = 0;
      await expect(send({ ...REQUEST, ...GAS })).resolves.toMatchObject({ nonce: 1 });
    });
  });

  it('resolves with the receipt for success and revert', async () => {
    const [success, reverted] = await enqueue(makeQueue(), send =>
      Promise.all([send({ ...REQUEST, ...GAS }), send({ ...REQUEST, ...GAS })]),
    );
    const successReceipt = chain.mine(success);
    const revertedReceipt = chain.mine(reverted, 'reverted');
    await expect(success.settled).resolves.toBe(successReceipt);
    await expect(reverted.settled).resolves.toBe(revertedReceipt);
  });

  it('waits for a receipt that the node serves late', async () => {
    const tx = await send(makeQueue());
    chain.client.getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: tx.txHash }));
    const receipt = chain.mine(tx);
    await expect(tx.settled).resolves.toBe(receipt);
  });

  it('keeps reading a late receipt when the nonce belongs to the original transaction', async () => {
    const tx = await send(makeQueue());
    chain.mineHash(tx.txHash, tx.nonce);
    await sleep(20);
    await expect(isPending(tx.settled)).resolves.toBe(true);
    const receipt = { transactionHash: tx.txHash, status: 'success' } as TransactionReceipt;
    chain.receipts.set(tx.txHash, receipt);
    await expect(tx.settled).resolves.toBe(receipt);
  });

  it('waits when the node counts the nonce but does not serve its block', async () => {
    const tx = await send(makeQueue());
    chain.minedNonce = 1;
    await sleep(20);
    await expect(isPending(tx.settled)).resolves.toBe(true);
    chain.mineHash(`0x${'ff'.repeat(32)}`, tx.nonce);
    await expect(tx.settled).rejects.toThrow(`a different transaction used its nonce ${tx.nonce}`);
  });

  it('finds a replacement when the latest nonce initially lags behind the block number', async () => {
    const tx = await send(makeQueue());
    chain.mineHash(`0x${'ff'.repeat(32)}`, tx.nonce);
    chain.minedNonce = 0;
    await sleep(20);
    chain.minedNonce = 1;
    chain.blockNumber += 100n;
    const outcome = await Promise.race([tx.settled.catch(error => error), sleep(100).then(() => 'still pending')]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('a different transaction used its nonce 0');
    expect(chain.client.getBlock).toHaveBeenCalledWith({ blockNumber: 101n, includeTransactions: true });
  });

  it('rejects with the hash and nonce when a different transaction uses the nonce', async () => {
    const tx = await send(makeQueue());
    chain.mineHash(`0x${'ff'.repeat(32)}`, tx.nonce);
    await expect(tx.settled).rejects.toThrow(
      `L1 transaction ${tx.txHash} has no receipt, and a different transaction used its nonce 0`,
    );
  });

  it('expires Protect transactions only after the chain passes the block bound', async () => {
    const fromBlock = chain.blockNumber;
    const tx = await send(makeQueue({ protectTxStatusUrl: 'https://protect.example/tx/' }));
    const lastBlock = fromBlock + BigInt(BLOCK_WINDOW + 2);
    chain.blockNumber = lastBlock;
    await sleep(20);
    await expect(isPending(tx.settled)).resolves.toBe(true);
    chain.blockNumber++;
    await expect(tx.settled).rejects.toThrow(
      `L1 transaction ${tx.txHash} with nonce 0 is not in a block up to block ${lastBlock}`,
    );
  });

  it('retries failed receipt reads and logs the failure once', async () => {
    const recorder = new LogRecorder();
    const tx = await send(makeQueue({ logger: recorder.logger('l1-tx-queue') }));
    chain.client.getTransactionReceipt
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockRejectedValueOnce(new Error('rpc down'));
    const receipt = chain.mine(tx);
    await expect(tx.settled).resolves.toBe(receipt);
    expect(recorder.lines.filter(line => line.event === 'l1_tx_monitor_read_failed')).toHaveLength(1);
  });

  it('orders retries first and keeps FIFO order in both groups', async () => {
    const queue = makeQueue();
    const labels = ['first', 'second', 'retry one', 'third', 'retry two'];
    await Promise.all(
      labels.map((_, index) =>
        send(
          queue,
          {
            to: `0x${(index + 1).toString(16).padStart(40, '0')}`,
          },
          { retry: index === 2 || index === 4 },
        ),
      ),
    );
    expect(chain.broadcasts.map(tx => labels[Number(BigInt(tx.to!)) - 1])).toEqual([
      'retry one',
      'retry two',
      'first',
      'second',
      'third',
    ]);
  });

  it('holds Protect NonceTooHigh transactions until the window ends, then reuses the dropped nonce', async () => {
    const queue = makeQueue({ protectTxStatusUrl: 'https://protect.example/tx/' });
    const first = await send(queue);
    statuses.set(first.txHash, { status: 'PENDING', simError: 'NonceTooHigh' });
    const next = send(queue);
    await sleep(10);
    expect(chain.broadcasts).toHaveLength(1);
    chain.pendingNonce = 0;
    chain.blockNumber = 107n;
    await expect(next).resolves.toMatchObject({ nonce: 0 });
    expect(chain.broadcasts.map(tx => tx.nonce)).toEqual([0, 0]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://protect.example/tx/${first.txHash}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    { status: 'INCLUDED' },
    { status: 'FAILED' },
    { status: 'CANCELLED' },
    { status: 'PENDING', isRevert: true },
    { status: 'PENDING', simError: 'ExecutionReverted' },
  ])('opens the next batch early for terminal Protect status %j', async status => {
    const queue = makeQueue({ protectTxStatusUrl: 'https://protect.example/tx/' });
    const first = await send(queue);
    statuses.set(first.txHash, status);
    chain.pendingNonce = 0;
    await expect(send(queue)).resolves.toMatchObject({ nonce: 0 });
  });

  it('holds the Protect batch until every transaction is terminal', async () => {
    const queue = makeQueue({ protectTxStatusUrl: 'https://protect.example/tx/' });
    const [first, second] = await Promise.all([send(queue), send(queue)]);
    statuses.set(first.txHash, { status: 'FAILED' });
    const next = send(queue);
    await sleep(10);
    expect(chain.broadcasts).toHaveLength(2);
    statuses.set(second.txHash, { status: 'CANCELLED' });
    chain.pendingNonce = 0;
    await expect(next).resolves.toMatchObject({ nonce: 0 });
  });

  it('waits for the Protect window when the status endpoint fails', async () => {
    const recorder = new LogRecorder();
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 503 }));
    const queue = makeQueue({
      protectTxStatusUrl: 'https://protect.example/tx/',
      logger: recorder.logger('l1-tx-queue'),
    });
    await send(queue);
    const next = send(queue);
    await sleep(10);
    expect(chain.broadcasts).toHaveLength(1);
    expect(recorder.lines.filter(line => line.event === 'l1_submission_batch_status_failed')).toHaveLength(1);
    chain.blockNumber = 107n;
    chain.pendingNonce = 0;
    await expect(next).resolves.toMatchObject({ nonce: 0 });
  });

  it('keeps public transactions nonterminal past local expiry until every nonce is mined', async () => {
    const queue = makeQueue();
    const [first, second] = await Promise.all([send(queue), send(queue)]);
    const next = send(queue);
    chain.blockNumber = 200n;
    expect(await isPending(first.settled)).toBe(true);
    expect(await isPending(second.settled)).toBe(true);
    chain.mine(first);
    await expect(first.settled).resolves.toMatchObject({ status: 'success' });
    await sleep(10);
    expect(chain.broadcasts).toHaveLength(2);
    chain.mine(second);
    await expect(second.settled).resolves.toMatchObject({ status: 'success' });
    await expect(next).resolves.toMatchObject({ nonce: 2 });
  });

  it('opens the next public batch as soon as the nonce is consumed', async () => {
    const queue = makeQueue();
    const first = await send(queue);
    const next = send(queue);
    await sleep(10);
    expect(chain.broadcasts).toHaveLength(1);
    chain.mine(first);
    await expect(next).resolves.toMatchObject({ nonce: 1 });
  });

  it('continues the batch after a preparation callback fails', async () => {
    const queue = makeQueue();
    const failed = queue.enqueue(() => Promise.reject(new Error('prepare failed')));
    const succeeded = send(queue);
    await expect(failed).rejects.toThrow('prepare failed');
    await expect(succeeded).resolves.toMatchObject({ nonce: 0 });
  });
  it('forbids a clean handoff after a broadcast result is unknown', async () => {
    chain.broadcastFailures.push(new Error('transport response lost'));
    const queue = makeQueue();
    await expect(send(queue)).rejects.toThrow('durably ambiguous');
    await expect(queue.stop()).rejects.toThrow('exact-operation handoff is forbidden');
    queues = queues.filter(candidate => candidate !== queue);
  });


  it('stops a held queue and rejects queued and new work', async () => {
    const queue = makeQueue();
    await send(queue);
    const pending = send(queue);
    const rejected = expect(pending).rejects.toThrow('stopped before queued work could run');
    await queue.stop();
    await rejected;
    await expect(send(queue)).rejects.toThrow('is stopped');
  });

  it('rejects an invalid block window', () => {
    expect(() => makeQueue({ blockWindow: 0 })).toThrow('invalid L1 block window');
    expect(() => makeQueue({ blockWindow: 2.5 })).toThrow('invalid L1 block window');
  });

  it('permanently excludes an exact operation even when generic submission is disabled', async () => {
    const queue = makeQueue({
      disableSubmission: true,
      forbiddenOperationIds: new Set(['quarantined-operation']),
    });
    await expect(
      queue.enqueue(send =>
        send(
          { ...REQUEST, ...GAS },
          { kind: 'l1-operation', id: 'quarantined-operation' },
        ),
      ),
    ).rejects.toThrow('permanently quarantined');
    expect(chain.client.account.signTransaction).not.toHaveBeenCalled();
    expect(chain.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('skips the send with submission disabled and resolves a mined receipt without reading the chain', async () => {
    const tx = await send(makeQueue({ disableSubmission: true }), { gas: 60_000n, maxFeePerGas: 100n });
    expect(chain.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(chain.client.getTransactionCount).not.toHaveBeenCalled();
    expect(tx.simulated).toBe(true);
    await expect(tx.settled).resolves.toMatchObject({
      status: 'success',
      transactionHash: tx.txHash,
      gasUsed: 60_000n,
      effectiveGasPrice: 100n,
    });
  });

  it('opens the next snapshot without waiting on status or nonces with submission disabled', async () => {
    const queue = makeQueue({ disableSubmission: true, protectTxStatusUrl: 'https://protect.example/tx/' });
    await send(queue);
    await expect(send(queue)).resolves.toBeDefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(chain.client.getBlockNumber).not.toHaveBeenCalled();
  });
});

describe('isAboveMaxFeePerGas', () => {
  it('is true only above a set cap', () => {
    expect(isAboveMaxFeePerGas({ maxFeePerGasCap: undefined }, 10n ** 30n)).toBe(false);
    expect(isAboveMaxFeePerGas({ maxFeePerGasCap: 100n }, 100n)).toBe(false);
    expect(isAboveMaxFeePerGas({ maxFeePerGasCap: 100n }, 101n)).toBe(true);
  });
});
