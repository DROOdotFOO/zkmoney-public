import { startAnvil } from '@aztec-labs/ethereum/test';
import { sleep } from '@aztec-labs/foundation/sleep';

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
  type TransactionSerialized,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http as httpTransport,
  keccak256,
  parseTransaction,
  publicActions,
  recoverTransactionAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { l1Transport } from './l1/client.js';
import { L1TxQueue, type SendL1Tx, type SentL1Tx } from './l1/l1_tx_queue.js';
import { GenericSubmissionJournal } from './l1/submission_journal.js';

const ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const SUCCESS_TARGET = '0x1111111111111111111111111111111111111111' as Address;
const REVERT_TARGET = '0x2222222222222222222222222222222222222222' as Address;
const LATER_OPERATION_COUNT = 8;
const OTHER_L1_ACTION_COUNT = 6;
const LATER_OPERATION_TARGETS = makeTargets(0x1000, LATER_OPERATION_COUNT);
const OTHER_L1_ACTION_TARGETS = makeTargets(0x2000, OTHER_L1_ACTION_COUNT);
const LATE_L1_ACTION_TARGET = makeTargets(0x3000, 1)[0];
const GAS_PRICE = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
const BLOCK_RANGE = 2;

type ProtectStatus = 'PENDING' | 'INCLUDED' | 'FAILED' | 'UNKNOWN';

interface PrivateTransaction {
  raw: Hex;
  hash: Hex;
  sender: Address;
  nonce: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxBlockNumber: number;
  status: ProtectStatus;
  simError?: string;
}

/**
 * Implements only the Protect behavior needed by this test. Transactions stay private until `buildBlock` selects
 * them, and a simulation revert leaves its nonce unconsumed.
 */
class TestProtectRelay {
  private readonly chain: TestClient & PublicClient;
  private readonly transactions = new Map<Hex, PrivateTransaction>();
  private server: http.Server | undefined;
  private baseUrl = '';

  constructor(anvilUrl: string) {
    this.chain = createTestClient({ chain: foundry, mode: 'anvil', transport: httpTransport(anvilUrl) }).extend(
      publicActions,
    ) as unknown as TestClient & PublicClient;
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get submissionUrl(): string {
    return `${this.baseUrl}/fast?blockRange=${BLOCK_RANGE}`;
  }

  get statusUrl(): string {
    return `${this.baseUrl}/tx/`;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }

  async getStatus(hash: Hex): Promise<{ status: ProtectStatus; simError?: string; maxBlockNumber?: number }> {
    const transaction = this.transactions.get(hash);
    if (!transaction) {
      return { status: 'UNKNOWN' };
    }
    const blockNumber = (await this.chain.getBlock({ blockTag: 'latest' })).number;
    if (transaction.status === 'PENDING' && blockNumber > BigInt(transaction.maxBlockNumber)) {
      transaction.status = 'FAILED';
      transaction.simError = transaction.simError ?? 'Expired';
    }
    return {
      status: transaction.status,
      simError: transaction.simError,
      maxBlockNumber: transaction.maxBlockNumber,
    };
  }

  /**
   * Builds from each sender's confirmed nonce. Successful transactions are forwarded and mined. A simulation
   * failure stops that nonce chain, so every higher transaction stays private.
   */
  async buildBlock(): Promise<Hex[]> {
    const included: PrivateTransaction[] = [];
    const senders = new Set([...this.transactions.values()].map(transaction => transaction.sender.toLowerCase()));
    for (const senderKey of senders) {
      const sender = [...this.transactions.values()].find(
        transaction => transaction.sender.toLowerCase() === senderKey,
      )!.sender;
      let nextNonce = await this.chain.getTransactionCount({ address: sender, blockTag: 'latest' });
      for (;;) {
        const transaction = [...this.transactions.values()].find(
          candidate =>
            candidate.sender.toLowerCase() === senderKey &&
            candidate.nonce === nextNonce &&
            candidate.status === 'PENDING',
        );
        if (!transaction) {
          break;
        }
        try {
          await this.chain.call({
            account: transaction.sender,
            to: transaction.to,
            data: transaction.data,
            value: transaction.value,
            gas: transaction.gas,
          });
        } catch (error) {
          if (transaction.to.toLowerCase() !== REVERT_TARGET.toLowerCase()) {
            throw error;
          }
          transaction.status = 'FAILED';
          transaction.simError = 'ExecutionReverted';
          for (const later of this.transactions.values()) {
            if (later.sender.toLowerCase() === senderKey && later.nonce > nextNonce && later.status === 'PENDING') {
              later.simError = 'NonceTooHigh';
            }
          }
          break;
        }

        await this.chain.sendRawTransaction({ serializedTransaction: transaction.raw });
        included.push(transaction);
        nextNonce++;
      }
    }
    if (included.length > 0) {
      await this.chain.mine({ blocks: 1 });
    }
    for (const transaction of included) {
      const receipt = await this.chain.getTransactionReceipt({ hash: transaction.hash });
      if (receipt.status !== 'success') {
        throw new Error(`Transaction ${transaction.hash} reverted after a successful simulation`);
      }
      transaction.status = 'INCLUDED';
      transaction.simError = undefined;
    }
    return included.map(transaction => transaction.hash);
  }

  private async acceptRawTransaction(raw: Hex, blockRange: number): Promise<Hex> {
    const parsed = parseTransaction(raw);
    const sender = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
    if (!parsed.to) {
      throw new Error('Contract creation is not supported by this test relay');
    }
    const hash = keccak256(raw);
    const blockNumber = (await this.chain.getBlock({ blockTag: 'latest' })).number;
    this.transactions.set(hash, {
      raw,
      hash,
      sender,
      nonce: parsed.nonce ?? 0,
      to: parsed.to,
      data: parsed.data ?? '0x',
      value: parsed.value ?? 0n,
      gas: parsed.gas ?? 0n,
      maxBlockNumber: Number(blockNumber) + 1 + blockRange,
      status: 'PENDING',
    });
    return hash;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname.startsWith('/tx/')) {
      const status = await this.getStatus(url.pathname.slice('/tx/'.length) as Hex);
      this.respond(response, { statusCode: 200, body: status });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    let id: unknown = null;
    try {
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: unknown;
        method: string;
        params?: unknown[];
      };
      id = rpc.id;
      if (rpc.method !== 'eth_sendRawTransaction') {
        throw new Error(`Unsupported relay method ${rpc.method}`);
      }
      const blockRange = Number(url.searchParams.get('blockRange') ?? BLOCK_RANGE);
      const result = await this.acceptRawTransaction(rpc.params?.[0] as Hex, blockRange);
      this.respond(response, { statusCode: 200, body: { jsonrpc: '2.0', id, result } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respond(response, {
        statusCode: 200,
        body: { jsonrpc: '2.0', id, error: { code: -32000, message } },
      });
    }
  }

  private respond(response: http.ServerResponse, result: { statusCode: number; body: unknown }): void {
    response.writeHead(result.statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  }
}

describe('Relayer submission through Protect', () => {
  let stopAnvil: () => Promise<void>;
  let anvilUrl: string;
  let chain: TestClient & PublicClient;
  let relay: TestProtectRelay;
  let batcher: L1TxQueue;
  let sent: SentL1Tx[] = [];
  let journal: GenericSubmissionJournal;
  let journalDirectory: string;
  let operationSequence = 0;

  beforeAll(async () => {
    ({ rpcUrl: anvilUrl, stop: stopAnvil } = await startAnvil({ port: 0 }));
    chain = createTestClient({ chain: foundry, mode: 'anvil', transport: httpTransport(anvilUrl) }).extend(
      publicActions,
    ) as unknown as TestClient & PublicClient;
    // Mining off: a submitted tx stays pending until the test mines a block.
    await chain.setAutomine(false);
    await chain.setCode({ address: REVERT_TARGET, bytecode: '0x60006000fd' });

    relay = new TestProtectRelay(anvilUrl);
    await relay.start();
    journalDirectory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-protect-submission-')));
    journal = await GenericSubmissionJournal.open(join(journalDirectory, 'submission.sqlite3'));
    batcher = new L1TxQueue({
      client: createPublicClient({ chain: foundry, transport: l1Transport(anvilUrl) }),
      wallet: createWalletClient({
        chain: foundry,
        account: ACCOUNT,
        transport: l1Transport(anvilUrl, relay.submissionUrl),
      }),
      blockWindow: BLOCK_RANGE,
      protectTxStatusUrl: relay.statusUrl,
      pollIntervalMs: 25,
      submissionJournal: journal,
    });
  }, 30_000);

  // A monitor stops only when its nonce is used or the chain passes its expiry bound, so the teardown mines past it.
  afterEach(async () => {
    await batcher?.stop();
    await chain.mine({ blocks: BLOCK_RANGE + 3 });
    await Promise.allSettled(sent.map(transaction => transaction.settled));
    sent = [];
  });

  afterAll(async () => {
    await journal?.close();
    if (journalDirectory) await rm(journalDirectory, { recursive: true, force: true });
    await relay?.stop();
    await stopAnvil?.();
  });

  it('does not let a rejected L1 operation transaction time out later L1 actions', async () => {
    const before = await chain.getTransactionCount({ address: ACCOUNT.address, blockTag: 'latest' });
    const submit = (sender: SendL1Tx, to: Address) =>
      sender(
        { to, data: '0x', gas: 100_000n, ...GAS_PRICE },
        { kind: 'l1-operation', id: `protect-${operationSequence++}-${to}` },
      );
    // The batcher sends in arrival order: the operations enqueued first get the first nonces.
    const operationBatch = batcher.enqueue(sender =>
      Promise.all([
        submit(sender, SUCCESS_TARGET),
        submit(sender, REVERT_TARGET),
        ...LATER_OPERATION_TARGETS.map(target => submit(sender, target)),
      ]),
    );
    const otherBatch = batcher.enqueue(sender =>
      Promise.all(OTHER_L1_ACTION_TARGETS.map(target => submit(sender, target))),
    );
    const [operationTransactions, otherTransactions] = await Promise.all([operationBatch, otherBatch]);
    const [successfulOperationTx, revertingOperationTx, ...laterOperationTransactions] = operationTransactions;
    const laterTransactions = [...laterOperationTransactions, ...otherTransactions];
    sent = [...operationTransactions, ...otherTransactions];

    expect(sent.map(transaction => transaction.nonce)).toEqual(sent.map((_transaction, index) => before + index));
    await expect(relay.buildBlock()).resolves.toEqual([successfulOperationTx.txHash]);
    await expect(successfulOperationTx.settled).resolves.toMatchObject({ status: 'success' });

    await expect(
      fetch(`${relay.statusUrl}${revertingOperationTx.txHash}`).then(response => response.json()),
    ).resolves.toMatchObject({
      status: 'FAILED',
      simError: 'ExecutionReverted',
    });

    const expectLaterTransactionsBlocked = async (status: ProtectStatus) => {
      const statuses = await Promise.all(laterTransactions.map(transaction => relay.getStatus(transaction.txHash)));
      for (const actual of statuses) {
        expect(actual).toMatchObject({ status, simError: 'NonceTooHigh' });
      }
      return statuses;
    };
    const initialStatuses = await expectLaterTransactionsBlocked('PENDING');
    const maxBlockNumber = initialStatuses.at(-1)!.maxBlockNumber!;

    // Work queued after the snapshot must wait. Retried work gets the first nonces in the next application batch.
    const lateAction = batcher.enqueue(sender => submit(sender, LATE_L1_ACTION_TARGET));
    const retryTargets = [...LATER_OPERATION_TARGETS, ...OTHER_L1_ACTION_TARGETS];
    const retriedBatch = batcher.enqueue(sender => Promise.all(retryTargets.map(target => submit(sender, target))), {
      retry: true,
    });

    while ((await chain.getBlock({ blockTag: 'latest' })).number <= BigInt(maxBlockNumber)) {
      await expect(relay.buildBlock()).resolves.toEqual([]);
      await expectLaterTransactionsBlocked('PENDING');
      await chain.mine({ blocks: 1 });
    }
    await expectLaterTransactionsBlocked('FAILED');

    const [lateTransaction, retriedTransactions] = await Promise.all([lateAction, retriedBatch]);
    sent.push(...retriedTransactions, lateTransaction);
    expect(retriedTransactions.map(transaction => transaction.nonce)).toEqual(
      retriedTransactions.map((_transaction, index) => before + 1 + index),
    );
    expect(lateTransaction.nonce).toBe(before + 1 + retriedTransactions.length);
    await expect(relay.buildBlock()).resolves.toEqual([
      ...retriedTransactions.map(transaction => transaction.txHash),
      lateTransaction.txHash,
    ]);
    await expect(
      Promise.all([...retriedTransactions, lateTransaction].map(transaction => transaction.settled)),
    ).resolves.toEqual(
      [...retriedTransactions, lateTransaction].map(() => expect.objectContaining({ status: 'success' })),
    );

    // The retried transactions used the nonces of the dropped ones.
    await expect(revertingOperationTx.settled).rejects.toThrow();
    for (const transaction of laterTransactions) {
      await expect(transaction.settled).rejects.toThrow();
    }
    await expect(chain.getTransactionCount({ address: ACCOUNT.address, blockTag: 'latest' })).resolves.toBe(
      before + 2 + retriedTransactions.length,
    );
  }, 30_000);
});

describe('Relayer submission through the read RPC', () => {
  let stopAnvil: () => Promise<void>;
  let chain: TestClient & PublicClient;
  let batcher: L1TxQueue;
  let sent: SentL1Tx[] = [];
  let journal: GenericSubmissionJournal;
  let journalDirectory: string;
  let operationSequence = 0;

  beforeAll(async () => {
    const { rpcUrl: anvilUrl, stop } = await startAnvil({ port: 0 });
    stopAnvil = stop;
    chain = createTestClient({ chain: foundry, mode: 'anvil', transport: httpTransport(anvilUrl) }).extend(
      publicActions,
    ) as unknown as TestClient & PublicClient;
    // Mining off: a submitted tx stays pending until the test mines a block.
    await chain.setAutomine(false);
    journalDirectory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-public-submission-')));
    journal = await GenericSubmissionJournal.open(join(journalDirectory, 'submission.sqlite3'));
    batcher = new L1TxQueue({
      client: createPublicClient({ chain: foundry, transport: l1Transport(anvilUrl) }),
      wallet: createWalletClient({ chain: foundry, account: ACCOUNT, transport: l1Transport(anvilUrl) }),
      blockWindow: BLOCK_RANGE,
      pollIntervalMs: 25,
      submissionJournal: journal,
    });
  }, 30_000);

  // A monitor stops only when its nonce is used or the chain passes its expiry bound, so the teardown mines past it.
  afterEach(async () => {
    await batcher?.stop();
    await chain.mine({ blocks: BLOCK_RANGE + 3 });
    await Promise.allSettled(sent.map(transaction => transaction.settled));
    sent = [];
  });

  afterAll(async () => {
    await journal?.close();
    if (journalDirectory) await rm(journalDirectory, { recursive: true, force: true });
    await stopAnvil?.();
  });

  it('holds the next batch past the block window and the local expiry until the pending transaction lands', async () => {
    const submit = (sender: SendL1Tx, to: Address) =>
      sender(
        { to, data: '0x', gas: 100_000n, ...GAS_PRICE },
        { kind: 'l1-operation', id: `public-${operationSequence++}-${to}` },
      );
    const [first, second] = await batcher.enqueue(sender =>
      Promise.all([submit(sender, SUCCESS_TARGET), submit(sender, LATER_OPERATION_TARGETS[0])]),
    );
    sent = [first, second];
    const nextBatch = batcher.enqueue(sender => submit(sender, LATE_L1_ACTION_TARGET));
    const held = Symbol('held');
    const expectHeld = async () => {
      await expect(chain.getTransactionCount({ address: ACCOUNT.address, blockTag: 'latest' })).resolves.toBe(
        first.nonce,
      );
      await expect(Promise.race([nextBatch, sleep(200).then(() => held)])).resolves.toBe(held);
    };

    // A block gas limit below the tx's gas leaves it pending while the head moves past the window.
    await chain.setBlockGasLimit({ gasLimit: 30_000n });
    await chain.mine({ blocks: BLOCK_RANGE + 3 });
    await expectHeld();

    // The expiry bound passed while the tx is still pending: the monitor gives up, the batch does not.
    await expect(first.settled).rejects.toThrow();
    await expect(second.settled).rejects.toThrow();
    await expectHeld();

    await chain.setBlockGasLimit({ gasLimit: 30_000_000n });
    await chain.mine({ blocks: 1 });
    await expect(chain.getTransactionReceipt({ hash: second.txHash })).resolves.toMatchObject({ status: 'success' });
    const next = await nextBatch;
    sent.push(next);
    expect(next.nonce).toBe(second.nonce + 1);
    await chain.mine({ blocks: 1 });
    await expect(next.settled).resolves.toMatchObject({ status: 'success' });
  }, 30_000);
});

function makeTargets(start: number, count: number): Address[] {
  return Array.from(
    { length: count },
    (_value, index) => `0x${(start + index).toString(16).padStart(40, '0')}` as Address,
  );
}
