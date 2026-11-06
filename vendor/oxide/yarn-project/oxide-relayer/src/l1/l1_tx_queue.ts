import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';

import { createHash, randomBytes } from 'node:crypto';
import {
  type Address,
  type Chain,
  type Hash,
  type LocalAccount,
  type PublicClient,
  TransactionReceiptNotFoundError,
  type TransactionReceipt,
  type TransactionRequestEIP1559,
  type Transport,
  type WalletClient,
  createWalletClient,
  hexToBytes,
  isAddressEqual,
  keccak256,
  toHex,
  zeroHash,
} from 'viem';

import { l1Transport } from './client.js';
import { protectEndpoints } from './flashbots_protect.js';
import type { DurableSubmissionJournal } from './submission_journal.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const PROTECT_TX_STATUS_TIMEOUT_MS = 5_000;

/** A broadcast transaction and its settlement result. */
export interface SentL1Tx {
  txHash: Hash;
  nonce: number;
  /** Resolves with a mined receipt; rejects on proven replacement or Protect expiry. */
  settled: Promise<TransactionReceipt>;
  /** True when submission is disabled: the tx was not sent and `settled` holds a fake receipt. */
  simulated?: boolean;
}

export interface DurableSubmissionIdentity {
  kind: 'l1-operation' | 'fpc-funding' | 'prover-claims';
  id: string;
}

/** Broadcasts within the current submission batch. */
export type SendL1Tx = (
  request: TransactionRequestEIP1559,
  identity: DurableSubmissionIdentity,
) => Promise<SentL1Tx>;

export class DurableSubmissionAmbiguityError extends Error {
  constructor(cause: unknown) {
    super('L1 submission outcome is durably ambiguous; reconciliation approval is required', { cause });
  }
}
/**
 * Shares one account across relayer flows. Each batch is a fixed snapshot of queued callbacks, with retries first.
 * Broadcasts use serial nonces, and each transaction settles independently. The next batch waits until Protect
 * drops the current batch or reports it terminal. On a public mempool, it waits until every nonce is consumed.
 */
export class L1TxQueue {
  readonly address: Address;
  readonly blockWindow: number;
  /** Operator cap on `maxFeePerGas`, in wei. Each flow defers when the fee ceiling of its quote is above the cap. */
  readonly maxFeePerGasCap: bigint | undefined;
  private readonly disableSubmission: boolean;
  private readonly client: PublicClient;
  private readonly wallet: WalletClient<Transport, Chain, LocalAccount>;
  private readonly protectTxStatusUrl: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly submissionJournal: DurableSubmissionJournal;
  private readonly submissionHooks:
    | {
        afterPrepared?(): Promise<void> | void;
        afterResponse?(): Promise<void> | void;
      }
    | undefined;
  private readonly forbiddenOperationIds: ReadonlySet<string>;
  private readonly log: Logger;
  private readonly queue: {
    retry: boolean;
    submit(send: SendL1Tx): Promise<unknown>;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }[] = [];
  private readonly stoppedSignal: Promise<void>;
  private resolveStoppedSignal = () => {};
  private worker: Promise<void> | undefined;
  private resetBeforeNextBatch = false;
  private stopped = false;
  private broadcasts: Promise<void> = Promise.resolve();
  /** Lower bound when the read RPC has not seen the last broadcast. */
  private lastSentNonce: number | undefined;
  /** A send call failed after it may have reached the RPC. Exact-operation handoff is permanently forbidden. */
  private ambiguousBroadcastResult = false;

  constructor(options: {
    client: PublicClient;
    wallet: WalletClient<Transport, Chain, LocalAccount>;
    submissionJournal: DurableSubmissionJournal;
    submissionHooks?: {
      afterPrepared?(): Promise<void> | void;
      afterResponse?(): Promise<void> | void;
    };
    forbiddenOperationIds?: ReadonlySet<string>;
    blockWindow: number;
    protectTxStatusUrl?: string;
    /** Skip each send instead of signing and broadcasting it, and report it as mined. */
    disableSubmission?: boolean;
    maxFeePerGasCap?: bigint;
    pollIntervalMs?: number;
    logger?: Logger;
  }) {
    if (!Number.isInteger(options.blockWindow) || options.blockWindow < 1) {
      throw new Error(`invalid L1 block window '${options.blockWindow}'`);
    }
    this.client = options.client;
    this.wallet = options.wallet;
    this.submissionJournal = options.submissionJournal;
    this.submissionHooks = options.submissionHooks;
    this.forbiddenOperationIds = options.forbiddenOperationIds ?? new Set();
    this.address = options.wallet.account.address;
    this.blockWindow = options.blockWindow;
    this.protectTxStatusUrl = options.protectTxStatusUrl;
    this.disableSubmission = options.disableSubmission ?? false;
    this.maxFeePerGasCap = options.maxFeePerGasCap;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.log = options.logger ?? createLogger('oxide-relayer:l1-tx-queue');
    this.stoppedSignal = new Promise(resolve => {
      this.resolveStoppedSignal = resolve;
    });
  }

  enqueue<T>(submit: (send: SendL1Tx) => Promise<T>, { retry = false } = {}): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error('L1 submission batcher is stopped'));
    }

    const result = new Promise<T>((resolve, reject) => {
      this.queue.push({
        retry,
        submit,
        resolve: value => resolve(value as T),
        reject,
      });
    });
    this.#startWorker();
    return result;
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.resolveStoppedSignal();
      this.#rejectQueued(new Error('L1 submission batcher stopped before queued work could run'));
    }
    await this.worker;
    if (this.ambiguousBroadcastResult) {
      throw new Error('An L1 broadcast has an unknown result; exact-operation handoff is forbidden');
    }
  }

  #startWorker(): void {
    if (this.worker) {
      return;
    }
    this.worker = this.#processQueue()
      .catch(error => {
        this.log.error('L1 submission batch worker failed', {
          event: 'l1_submission_batch_worker_failed',
          error: errMessage(error),
        });
        this.#rejectQueued(error);
      })
      .finally(() => {
        this.worker = undefined;
        if (!this.stopped && this.queue.length > 0) {
          this.#startWorker();
        }
      });
  }

  async #processQueue(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      // Collect callbacks enqueued in the same turn before closing this batch's fixed snapshot.
      await Promise.resolve();
      const snapshot = this.queue.splice(0);
      snapshot.sort((left, right) => Number(right.retry) - Number(left.retry));
      if (this.resetBeforeNextBatch) {
        this.lastSentNonce = undefined;
        this.resetBeforeNextBatch = false;
      }

      const sent: SentL1Tx[] = [];
      for (const submission of snapshot) {
        if (this.stopped) {
          submission.reject(new Error('L1 submission batcher stopped before queued work could run'));
          continue;
        }
        try {
          submission.resolve(
            await submission.submit(async (request, identity) => {
              const transaction = await this.#send(request, identity);
              sent.push(transaction);
              return transaction;
            }),
          );
        } catch (error) {
          submission.reject(error);
        }
      }

      if (sent.length > 0 && !this.stopped && !this.disableSubmission) {
        await this.#waitForBatchWindow(sent);
      }
    }
  }

  /**
   * Holds the next snapshot while a tx in `sent` can still land. Through Protect a tx is dead once the relay reports
   * it terminal or the drop window has passed, and its nonce is free again, so the cached nonce is reset before the
   * next batch. Through a public mempool nothing drops a tx and a local expiry does not kill it, so the hold lasts
   * until the chain consumes every nonce the batch sent; the cached nonce then already points past them.
   */
  async #waitForBatchWindow(sent: SentL1Tx[]): Promise<void> {
    if (!this.protectTxStatusUrl) {
      await this.#waitForNoncesConsumed(sent);
      return;
    }
    this.resetBeforeNextBatch = true;
    const expiresAfterBlock = (await this.client.getBlockNumber()) + 1n + BigInt(this.blockWindow);
    let reportedStatusError = false;
    let reportedBlockError = false;
    while (!this.stopped) {
      try {
        const terminal = await Promise.all(
          sent.map(transaction => this.#isProtectTransactionTerminal(transaction.txHash)),
        );
        if (terminal.every(Boolean)) {
          return;
        }
      } catch (error) {
        if (!reportedStatusError) {
          reportedStatusError = true;
          this.log.warn('Failed to read Protect transaction status; waiting for the block window', {
            event: 'l1_submission_batch_status_failed',
            error: errMessage(error),
          });
        }
      }
      try {
        if ((await this.client.getBlockNumber()) > expiresAfterBlock) {
          return;
        }
      } catch (error) {
        if (!reportedBlockError) {
          reportedBlockError = true;
          this.log.warn('Failed to read the L1 block number while waiting for the submission window', {
            event: 'l1_submission_batch_block_read_failed',
            error: errMessage(error),
          });
        }
      }
      await Promise.race([sleep(this.pollIntervalMs), this.stoppedSignal]);
    }
  }

  async #waitForNoncesConsumed(sent: SentL1Tx[]): Promise<void> {
    const address = this.address;
    const lastNonce = Math.max(...sent.map(transaction => transaction.nonce));
    let reportedNonceError = false;
    while (!this.stopped) {
      try {
        if ((await this.client.getTransactionCount({ address, blockTag: 'latest' })) > lastNonce) {
          return;
        }
      } catch (error) {
        if (!reportedNonceError) {
          reportedNonceError = true;
          this.log.warn('Failed to read the L1 nonce while waiting for the batch to land', {
            event: 'l1_submission_batch_nonce_read_failed',
            error: errMessage(error),
          });
        }
      }
      await Promise.race([sleep(this.pollIntervalMs), this.stoppedSignal]);
    }
  }

  #rejectQueued(error: Error): void {
    for (const submission of this.queue.splice(0)) {
      submission.reject(error);
    }
  }

  /** Broadcasts `request` after all earlier broadcasts, then starts its monitor. */
  async #send(request: TransactionRequestEIP1559, identity: DurableSubmissionIdentity): Promise<SentL1Tx> {
    if (identity.kind === 'l1-operation' && this.forbiddenOperationIds.has(identity.id)) {
      throw new Error('Exact operation is permanently quarantined from generic submission');
    }
    if (this.disableSubmission) {
      return this.#skipSend(request);
    }
    const { txHash, nonce, sentAtBlock, operationIdentity } = await this.#inOrder(() =>
      this.#broadcast(request, identity),
    );
    const settled = this.#monitor(txHash, nonce, sentAtBlock).then(
      async receipt => {
        await this.submissionJournal.recordTerminal(
          operationIdentity,
          receipt.status === 'success' ? 'confirmed' : 'reverted',
          JSON.stringify({ txHash, receiptStatus: receipt.status }),
        );
        return receipt;
      },
      async error => {
        await this.submissionJournal.recordTerminal(
          operationIdentity,
          'dropped_or_replaced',
          JSON.stringify({ txHash, outcome: 'dropped_or_replaced' }),
        );
        throw error;
      },
    );
    // Callers see a failure through `settled`. This catch only prevents an unhandled rejection.
    void settled.catch(() => {});
    return { txHash, nonce, settled };
  }

  /**
   * The send when submission is disabled. The callers already simulated the tx, so we just skip. We return a fake
   * receipt of a successful tx. We cannot know the gas that the tx uses or its gas price, so the receipt uses the gas
   * limit and `maxFeePerGas`: the most that the tx can cost.
   */
  #skipSend(request: TransactionRequestEIP1559): SentL1Tx {
    const txHash = toHex(randomBytes(32));
    const gas = request.gas ?? 0n;
    const receipt: TransactionReceipt = {
      status: 'success',
      type: 'eip1559',
      transactionHash: txHash,
      transactionIndex: 0,
      blockHash: zeroHash,
      blockNumber: 0n,
      from: this.address,
      to: request.to ?? null,
      contractAddress: null,
      gasUsed: gas,
      cumulativeGasUsed: gas,
      effectiveGasPrice: request.maxFeePerGas ?? 0n,
      logs: [],
      logsBloom: `0x${'00'.repeat(256)}`,
    };
    return { txHash, nonce: 0, settled: Promise.resolve(receipt), simulated: true };
  }

  /** Runs `broadcast` after the earlier broadcasts settle. A failed broadcast does not stop the next one. */
  #inOrder<T>(broadcast: () => Promise<T>): Promise<T> {
    const result = this.broadcasts.then(broadcast);
    this.broadcasts = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #broadcast(request: TransactionRequestEIP1559, identity: DurableSubmissionIdentity) {
    if (this.ambiguousBroadcastResult) {
      throw new Error('A prior L1 submission has an unresolved outcome; no further signing is permitted');
    }
    const [pendingNonce, sentAtBlock] = await Promise.all([
      this.client.getTransactionCount({ address: this.address, blockTag: 'pending' }),
      this.client.getBlockNumber({ cacheTime: 0 }),
    ]);
    const nonce =
      this.lastSentNonce !== undefined && pendingNonce <= this.lastSentNonce ? this.lastSentNonce + 1 : pendingNonce;
    const chainId = this.wallet.chain.id;
    const operationIdentity = durableOperationIdentity(identity);
    await this.submissionJournal.reserveSigning({
      operationIdentity,
      signerCommitment: signerCommitment(this.address),
      chainId,
      nonce,
      requestDigest: durableRequestDigest(request, chainId, nonce),
    });
    let serialized: `0x${string}`;
    try {
      serialized = await this.wallet.account.signTransaction({
        ...request,
        chainId,
        nonce,
        type: 'eip1559',
      });
      const signedTxHash = keccak256(serialized);
      await this.submissionJournal.recordPrepared(
        operationIdentity,
        signedTxHash,
        Buffer.from(hexToBytes(serialized)),
      );
    } catch (error) {
      this.ambiguousBroadcastResult = true;
      await this.submissionJournal.recordAmbiguous(operationIdentity);
      throw new DurableSubmissionAmbiguityError(error);
    }
    const signedTxHash = keccak256(serialized);
    try {
      await this.submissionHooks?.afterPrepared?.();
      await this.submissionJournal.beginSend(operationIdentity);
      const txHash = await this.wallet.sendRawTransaction({ serializedTransaction: serialized });
      const response = JSON.stringify({ txHash });
      await this.submissionJournal.recordResponse(operationIdentity, response);
      await this.submissionHooks?.afterResponse?.();
      if (txHash.toLowerCase() !== signedTxHash.toLowerCase()) {
        throw new Error('L1 RPC returned a transaction hash that does not match the durable signed bytes');
      }
      await this.submissionJournal.recordAccepted(operationIdentity);
      this.lastSentNonce = nonce;
      this.log.debug('Sent L1 transaction', {
        event: 'l1_tx_sent',
        txHash,
        nonce,
        sentAtBlock: sentAtBlock.toString(),
        to: request.to,
        gasLimit: request.gas?.toString(),
        maxFeePerGas: request.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: request.maxPriorityFeePerGas?.toString(),
      });
      return { txHash, nonce, sentAtBlock, operationIdentity };
    } catch (error) {
      this.ambiguousBroadcastResult = true;
      try {
        const current = await this.submissionJournal.read(operationIdentity);
        if (current?.state === 'sending' || current?.state === 'response_received') {
          await this.submissionJournal.recordAmbiguous(operationIdentity, current.response);
        }
      } catch (journalError) {
        throw new DurableSubmissionAmbiguityError(
          new AggregateError([error, journalError], 'Failed to persist durable L1 submission ambiguity'),
        );
      }
      throw new DurableSubmissionAmbiguityError(error);
    }
  }

  /**
   * Reads the chain until it uses the nonce. Protect can also prove a drop after
   * `sentAtBlock + 1 + blockWindow`; public-mempool expiry is never terminal.
   */
  async #monitor(txHash: Hash, nonce: number, sentAtBlock: bigint): Promise<TransactionReceipt> {
    const lastBlock = sentAtBlock + BigInt(this.blockWindow + 2);
    let reportedReadError = false;
    for (;;) {
      let terminalError: string | undefined;
      try {
        const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
        const minedNonce = await this.client.getTransactionCount({ address: this.address, blockTag: 'latest' });
        if (minedNonce > nonce) {
          const receipt = await this.#readReceipt(txHash);
          if (receipt) {
            return receipt;
          }
          // A node can count the nonce before it serves the receipt. Only a different transaction with the nonce in
          // a block shows a replacement.
          const nonceUser = await this.#findNonceUser(nonce, sentAtBlock);
          if (nonceUser !== undefined && nonceUser !== txHash) {
            terminalError = `L1 transaction ${txHash} has no receipt, and a different transaction used its nonce ${nonce}`;
          }
        } else if (this.protectTxStatusUrl && blockNumber > lastBlock) {
          terminalError = `L1 transaction ${txHash} with nonce ${nonce} is not in a block up to block ${lastBlock}`;
        }
      } catch (err) {
        if (!reportedReadError) {
          reportedReadError = true;
          this.log.warn('Failed to read the state of an L1 transaction; retrying', {
            event: 'l1_tx_monitor_read_failed',
            txHash,
            nonce,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (terminalError) {
        throw new Error(terminalError);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /**
   * Returns the hash of the transaction of this account with `nonce` in a block from `fromBlock` to the head. Returns
   * `undefined` when the node does not serve that block yet.
   */
  async #findNonceUser(nonce: number, fromBlock: bigint): Promise<Hash | undefined> {
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    for (let blockNumber = fromBlock; blockNumber <= head; blockNumber++) {
      const block = await this.client.getBlock({ blockNumber, includeTransactions: true });
      const tx = block.transactions.find(tx => tx.nonce === nonce && isAddressEqual(tx.from, this.address));
      if (tx) {
        return tx.hash;
      }
    }
    return undefined;
  }

  async #readReceipt(txHash: Hash): Promise<TransactionReceipt | undefined> {
    try {
      return await this.client.getTransactionReceipt({ hash: txHash });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) {
        return undefined;
      }
      throw err;
    }
  }

  async #isProtectTransactionTerminal(txHash: Hash): Promise<boolean> {
    const response = await fetch(`${this.protectTxStatusUrl}${txHash}`, {
      signal: AbortSignal.timeout(PROTECT_TX_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Protect tx-status request failed with HTTP ${response.status}`);
    }
    const status = (await response.json()) as { status: string; simError?: string; isRevert?: boolean };
    return (
      status.status === 'INCLUDED' ||
      status.status === 'FAILED' ||
      status.status === 'CANCELLED' ||
      status.isRevert === true ||
      status.simError === 'ExecutionReverted'
    );
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durableOperationIdentity(identity: DurableSubmissionIdentity): string {
  if (!/^[A-Za-z0-9:._/-]{1,512}$/.test(identity.id)) {
    throw new Error('Durable L1 submission identity is malformed');
  }
  return `${identity.kind}:${identity.id}`;
}

function signerCommitment(address: Address): string {
  return `sha256:${createHash('sha256').update(Buffer.from(address.slice(2), 'hex')).digest('hex')}`;
}

/** True when `maxFeePerGas` is above the operator cap `maxFeePerGasCap`. Always false when no cap is set. */
export function isAboveMaxFeePerGas(
  { maxFeePerGasCap }: { readonly maxFeePerGasCap?: bigint },
  maxFeePerGas: bigint,
): boolean {
  return maxFeePerGasCap !== undefined && maxFeePerGas > maxFeePerGasCap;
}

/**
 * Creates the L1 tx queue for `account` on the route of `client`'s chain. On a chain with a Protect endpoint,
 * the wallet sends transactions to Protect and does all other requests on `readL1RpcUrl`.
 */
export function createL1TxQueue(options: {
  client: PublicClient<Transport, Chain>;
  account: LocalAccount;
  readL1RpcUrl: string;
  flashbotsBlockRange: number;
  submissionJournal: DurableSubmissionJournal;
  disableSubmission?: boolean;
  maxFeePerGasCap?: bigint;
  forbiddenOperationIds?: ReadonlySet<string>;
}): L1TxQueue {
  const {
    client,
    account,
    readL1RpcUrl,
    flashbotsBlockRange,
    submissionJournal,
    disableSubmission,
    maxFeePerGasCap,
    forbiddenOperationIds,
  } = options;
  const endpoints = protectEndpoints(client.chain.id, flashbotsBlockRange);
  const wallet = createWalletClient({
    account,
    chain: client.chain,
    transport: l1Transport(readL1RpcUrl, endpoints?.rpcUrl),
  });
  return new L1TxQueue({
    client,
    wallet,
    blockWindow: flashbotsBlockRange,
    protectTxStatusUrl: endpoints?.txStatusUrl,
    disableSubmission,
    maxFeePerGasCap,
    submissionJournal,
    forbiddenOperationIds,
  });
}

function durableRequestDigest(request: TransactionRequestEIP1559, chainId: number, nonce: number): string {
  const canonical = JSON.stringify(
    { ...request, chainId, nonce, type: 'eip1559' },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString(10) : value),
  );
  return `sha256:${createHash('sha256')
    .update('oxide-relayer/generic-signing-request/v1\0')
    .update(canonical)
    .digest('hex')}`;
}
