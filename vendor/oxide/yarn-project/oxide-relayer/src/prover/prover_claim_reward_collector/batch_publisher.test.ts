import { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { sleep } from '@aztec-labs/foundation/sleep';

import { ProverClaim } from '@oxide/l1-contracts/oxide_portal.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ProverClaimPortalConfig } from '../prover_claim_lib/index.js';
import { BatchPublisher, BatchPublisherOptions } from './batch_publisher.js';

const POLL_MS = 5;

const claim: ProverClaim = {
  claimArgs: {
    content: { executor: EthAddress.random(), userPayloadHash: Fr.random(), amount: 1n, proverTip: 1n, randomness: 0n },
    checkpointNumber: CheckpointNumber(1),
    withdrawalId: '0x'.padEnd(66, '0') as any,
    teeSignature: '0x' as any,
  },
  epochNumber: 1n as any,
  messageLeafIndex: 0n,
  path: [],
  proofLength: 1n,
  checkpointNumber: CheckpointNumber(1),
};

const l1Portal = EthAddress.random();
const portal = {
  context: { l1Portal, proverSubsidy: EthAddress.random() },
  contract: {
    address: l1Portal,
    getContract: () => ({ simulate: { claimProverTips: () => Promise.resolve() } }),
  },
} as unknown as ProverClaimPortalConfig;

const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
const GAS = 250_000n;

type MinedReceipt = { blockNumber: bigint; transactionHash: `0x${string}`; status: 'success' | 'reverted' };

describe('BatchPublisher', () => {
  let head: bigint;
  let getBlockNumber: jest.Mock<() => Promise<bigint>>;
  let getTransactionReceipt: jest.Mock<(arg: { hash: `0x${string}` }) => Promise<MinedReceipt>>;
  let send: jest.Mock<
    (request: any) => Promise<{ txHash: `0x${string}`; nonce: number; settled: Promise<MinedReceipt> }>
  >;

  const minedReceipt: MinedReceipt = { blockNumber: 100n, transactionHash: '0xabc', status: 'success' };

  const build = (overrides: Partial<BatchPublisherOptions> = {}) => {
    // The queue monitors its own sends, so `settled` is the mined receipt.
    const l1TxQueue = {
      address: EthAddress.random().toString(),
      enqueue: (submit: (send: any) => Promise<unknown>) => submit(send),
    } as any;
    const client = {
      estimateGas: () => Promise.resolve(GAS),
      getBlockNumber: () => getBlockNumber(),
      getTransactionReceipt: (arg: any) => getTransactionReceipt(arg),
    } as any;
    const publisher = new BatchPublisher({
      client,
      l1TxQueue,
      confirmations: 3n,
      confirmationPollIntervalMs: POLL_MS,
      ...overrides,
    });
    publisher.start();
    return publisher;
  };

  // Resolves to 'resolved'/'rejected' once settled, or 'pending' if still unsettled after a short grace period.
  const settle = async (p: Promise<void>): Promise<'resolved' | 'rejected' | 'pending'> => {
    let state: 'resolved' | 'rejected' | 'pending' = 'pending';
    p.then(
      () => (state = 'resolved'),
      () => (state = 'rejected'),
    );
    await sleep(POLL_MS * 6);
    return state;
  };

  beforeEach(() => {
    head = 100n;
    getBlockNumber = jest.fn(() => Promise.resolve(head));
    getTransactionReceipt = jest.fn(() => Promise.resolve(minedReceipt));
    send = jest.fn(() =>
      Promise.resolve({ txHash: '0xabc' as const, nonce: 0, settled: Promise.resolve(minedReceipt) }),
    );
  });

  it('sends the claim tx with the fee values the batch was priced at and the estimated gas', async () => {
    const publisher = build({ confirmations: 0n });

    await publisher.publish(portal, [claim], FEES);

    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({ to: l1Portal.toString(), gas: GAS, ...FEES }));
  });

  it('simulates and sends each batch on its own portal, with that portal subsidy', async () => {
    const makePortal = () => {
      const address = EthAddress.random();
      const proverSubsidy = EthAddress.random();
      const simulate = jest.fn((_args: any, _opts: any) => Promise.resolve());
      const config = {
        context: { l1Portal: address, proverSubsidy },
        contract: { address, getContract: () => ({ simulate: { claimProverTips: simulate } }) },
      } as unknown as ProverClaimPortalConfig;
      return { address, proverSubsidy, simulate, config };
    };
    const a = makePortal();
    const b = makePortal();
    const publisher = build({ confirmations: 0n });

    await publisher.publish(a.config, [claim], FEES);
    await publisher.publish(b.config, [claim], FEES);

    expect(send.mock.calls.map(([request]) => request.to)).toEqual([a.address.toString(), b.address.toString()]);
    for (const { simulate, proverSubsidy } of [a, b]) {
      expect(simulate).toHaveBeenCalledTimes(1);
      expect(simulate.mock.calls[0][0][0]).toBe(proverSubsidy.toString());
    }
  });

  it('publish resolves at mined; confirmed resolves only once the tx is confirmations blocks deep', async () => {
    const publisher = build();
    const { confirmed } = await publisher.publish(portal, [claim], FEES); // resolves at mined

    expect(await settle(confirmed)).toBe('pending'); // head 100, mined at 100 => 1 block deep < 3

    head = 102n; // 100..102 => 3 blocks deep
    await expect(confirmed).resolves.toBeUndefined();
    expect(getTransactionReceipt).toHaveBeenCalled();
  });

  it('confirmed rejects when the tx was reorged out (receipt missing at depth)', async () => {
    getTransactionReceipt.mockRejectedValue(new Error('not found'));
    const publisher = build();
    head = 102n;

    const { confirmed } = await publisher.publish(portal, [claim], FEES);
    await expect(confirmed).rejects.toThrow(/reorged out or reverted/);
  });

  it('confirmed rejects when the re-checked receipt is reverted', async () => {
    getTransactionReceipt.mockResolvedValue({ ...minedReceipt, status: 'reverted' });
    const publisher = build();
    head = 102n;

    const { confirmed } = await publisher.publish(portal, [claim], FEES);
    await expect(confirmed).rejects.toThrow(/reorged out or reverted/);
  });

  it('confirmed keeps waiting when re-mined into a deeper block and resolves at the new depth', async () => {
    getTransactionReceipt.mockResolvedValue({ ...minedReceipt, blockNumber: 105n });
    const publisher = build();
    head = 102n; // first depth check passes (100..102) but fresh receipt is at 105
    const { confirmed } = await publisher.publish(portal, [claim], FEES);

    expect(await settle(confirmed)).toBe('pending'); // now measuring from 105; head 102 < 105

    head = 107n; // 105..107 => 3 blocks deep
    await expect(confirmed).resolves.toBeUndefined();
  });

  it('confirmed resolves immediately at the mined receipt when confirmations is 0n', async () => {
    const publisher = build({ confirmations: 0n });

    const { confirmed } = await publisher.publish(portal, [claim], FEES);
    await expect(confirmed).resolves.toBeUndefined();
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("keeps a later publish's confirmed independent of an earlier tx that fails to confirm", async () => {
    const publisher = build();
    head = 102n;

    // The first tx is reorged out; the second confirms normally.
    getTransactionReceipt.mockRejectedValueOnce(new Error('not found'));
    const first = await publisher.publish(portal, [claim], FEES);
    await expect(first.confirmed).rejects.toThrow(/reorged out or reverted/);

    const second = await publisher.publish(portal, [claim], FEES);
    // Confirmations are not chained: the collector retries the first batch, so a later batch must still settle.
    await expect(second.confirmed).resolves.toBeUndefined();
  });
});
