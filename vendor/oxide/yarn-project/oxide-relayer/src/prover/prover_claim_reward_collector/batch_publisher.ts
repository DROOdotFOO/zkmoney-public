import { Logger, createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { sleep } from '@aztec-labs/foundation/sleep';

import { OxidePortalAbi } from '@oxide/l1-contracts';
import { ProverClaim, toProverTipClaim } from '@oxide/l1-contracts/oxide_portal.js';

import { type FeeValuesEIP1559, type Hex, type PublicClient, encodeFunctionData, keccak256 } from 'viem';

import type { L1TxQueue, SendL1Tx } from '../../l1/l1_tx_queue.js';
import { ProverClaimPortalConfig } from '../prover_claim_lib/index.js';

const DEFAULT_CONFIRMATION_POLL_INTERVAL_MS = 2_000;

export interface BatchPublisherOptions {
  client: Pick<PublicClient, 'estimateGas' | 'getBlockNumber' | 'getTransactionReceipt'>;
  // Must sign with the prover's key: `claimProverTips` credits `msg.sender`, and `ProverClaimLib` requires it
  // to be the rollup's first prover for each claim.
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address'>;
  // Block depth a claim tx must reach before its `confirmed` promise resolves. 0n confirms at the first mined receipt
  // (dev/e2e).
  confirmations: bigint;
  confirmationPollIntervalMs?: number;
  log?: Logger;
}

type MinedReceipt = { blockNumber: bigint; transactionHash: Hex; status: 'success' | 'reverted' };

export class BatchPublisher {
  private readonly queue = new SerialQueue();
  private readonly log: Logger;
  private stopped = false;
  private retryNextBatch = false;

  constructor(private readonly options: BatchPublisherOptions) {
    this.log = options.log ?? createLogger('atlatl:batch-publisher');
  }

  start(): void {
    this.queue.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue.cancel();
  }

  // Resolves once the tx is MINED; submission stays serial so batch N+1 estimates against the state batch N left.
  // The returned `confirmed` resolves once the tx is `confirmations` deep. The tx carries `feeValues`, the fee values
  // that the batch was priced at.
  async publish(
    portal: ProverClaimPortalConfig,
    claims: ProverClaim[],
    feeValues: FeeValuesEIP1559,
  ): Promise<{ confirmed: Promise<void> }> {
    const receipt = await this.queue.put(() => this.submit(portal, claims, feeValues));
    const confirmed = this.awaitConfirmations(receipt);
    // Keep an unawaited `confirmed` from surfacing as an unhandled rejection; the returned promise still rejects.
    void confirmed.catch(() => {});
    return { confirmed };
  }

  private async submit(
    portal: ProverClaimPortalConfig,
    claims: ProverClaim[],
    feeValues: FeeValuesEIP1559,
  ): Promise<MinedReceipt> {
    const retry = this.retryNextBatch;
    this.retryNextBatch = false;
    const sent = await this.options.l1TxQueue.enqueue(send => this.prepareAndSubmit(portal, claims, feeValues, send), {
      retry,
    });
    const receipt = await sent.settled.catch(error => {
      this.retryNextBatch = true;
      throw error;
    });
    // A revert-protected relay drops a reverting tx; a public mempool (Sepolia, dev) mines it and charges the gas.
    if (receipt.status === 'reverted') {
      throw new Error(`Prover claim tx ${receipt.transactionHash} reverted`);
    }
    return {
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      status: receipt.status,
    };
  }

  private async prepareAndSubmit(
    portal: ProverClaimPortalConfig,
    claims: ProverClaim[],
    feeValues: FeeValuesEIP1559,
    send: SendL1Tx,
  ) {
    const args = [portal.context.proverSubsidy.toString(), claims.map(toProverTipClaim)] as const;

    const contract = portal.contract.getContract();
    const account = this.options.l1TxQueue.address;

    // Simulate first so a batch that would revert fails before we spend gas.
    await contract.simulate.claimProverTips(args, { account });
    const data: Hex = encodeFunctionData({ abi: OxidePortalAbi, functionName: 'claimProverTips', args });
    const to = portal.contract.address.toString();
    const gas = await this.options.client.estimateGas({ account, to, data });

    this.log.info(`Submitting ${claims.length} prover claim(s) for portal ${portal.context.l1Portal}`);
    return await send(
      { to, data, gas, ...feeValues },
      { kind: 'prover-claims', id: `${portal.context.l1Portal.toString().toLowerCase()}/${keccak256(data)}` },
    );
  }

  // Wait until the mined tx is `confirmations` blocks deep, re-checking the receipt each time depth is reached so a
  // reorg that drops or reverts it throws (so the collector retries its batch) and a re-mine into a different block
  // restarts the depth count from there.
  private async awaitConfirmations(receipt: MinedReceipt): Promise<void> {
    if (this.options.confirmations === 0n) {
      return;
    }
    const client = this.options.client;
    const pollIntervalMs = this.options.confirmationPollIntervalMs ?? DEFAULT_CONFIRMATION_POLL_INTERVAL_MS;
    while (true) {
      if (this.stopped) {
        throw new Error('BatchPublisher stopped while awaiting confirmations');
      }
      const head = await client.getBlockNumber();
      if (head - receipt.blockNumber + 1n >= this.options.confirmations) {
        const fresh = await client.getTransactionReceipt({ hash: receipt.transactionHash }).catch(() => undefined);
        if (!fresh || fresh.status === 'reverted') {
          throw new Error(`Prover claim tx ${receipt.transactionHash} was reorged out or reverted before confirming`);
        }
        if (fresh.blockNumber === receipt.blockNumber) {
          return;
        }
        receipt = { blockNumber: fresh.blockNumber, transactionHash: fresh.transactionHash, status: fresh.status };
      } else {
        await sleep(pollIntervalMs);
      }
    }
  }
}
