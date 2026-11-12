import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { TimeoutError } from '@aztec-labs/foundation/error';
import { type DateProvider, TestDateProvider } from '@aztec-labs/foundation/timer';

import { OperationExecutorAbi, buildSipaSweepOperation } from '@oxide/l1-contracts';
import {
  LEGACY_OPERATION_EXECUTOR_ABI,
  MAX_TRANSACTION_GAS,
  type OperationExecutorVersion,
  SIMULATED_SENDER_BALANCE,
  UINT256_EXTRA_CALLDATA_GAS,
  WEI_PER_ETH,
} from '@oxide/oxide-client/l1_operation_quote.js';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { MAX_PRIORITY_FEE_WEI } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type FeeValuesEIP1559,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type TransactionRequestEIP1559,
  decodeFunctionData,
  pad,
  toEventSelector,
} from 'viem';

import type { L1OperationsSubmissionConfig } from '../cli/config.js';
import type { SentL1Tx } from '../l1/l1_tx_queue.js';
import { fixedPriceOracle } from '../price_oracle/fixed_price_oracle.js';
import type { PriceOracle } from '../price_oracle/price_oracle.js';
import type { RelayerTelemetry } from '../relayer_telemetry.js';
import { openSqliteStateStore } from '../state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from '../state/test_fixtures.js';
import type { PendingL1Operation, StateStore } from '../state/types.js';
import type { L1OperationOwnership } from './l1_operation_router.js';
import { L1OperationScreener } from './l1_operation_screener.js';
import { L1OperationSubmitter, type L1OperationSubmitterDeps } from './submitter.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

/** Every operation here is conditioned on something other than the Outbox, so completion is never reached. */
const NO_WITHDRAWALS = {
  resolveCalldata: () => Promise.reject(new Error('unexpected withdrawal completion')),
} as unknown as WithdrawalCompletion;

const SENDER = EthAddress.random();
const EXECUTOR = EthAddress.random();
const TARGET = EthAddress.random();
const PAYOUT_TOKEN = EthAddress.random();
const CALLDATA = Buffer.from('deadbeef', 'hex');
const OPERATION_ID = `0x${'ab'.repeat(32)}` as Hex;
const PAYOUT = 500_000n;
/** Gas a successful simulation uses unless the quote sets it. */
const SIMULATED_GAS_USED = 100_000n;
/** The sent gas to cover for the default simulation: the gas used, plus the calldata gas of two nonzero arguments. */
const GAS_TO_COVER = SIMULATED_GAS_USED + 2n * UINT256_EXTRA_CALLDATA_GAS;
/** The gas limit for the default simulation, before the calldata gas of two nonzero arguments: 3/2 of the gas used. */
const SIMULATED_GAS_LIMIT = (SIMULATED_GAS_USED * 3n) / 2n;
const RECIPIENT = EthAddress.random();
const MAX_PENDING_AGE_MS = 48 * 60 * 60_000;
const REVERT = () => Promise.resolve({ status: 'failure' as const, error: new Error('execution reverted') });
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');

/** The log the payout token emits when the target pays `RECIPIENT`. */
const RECIPIENT_TRANSFER_LOG = {
  address: PAYOUT_TOKEN.toString() as Hex,
  topics: [TRANSFER, pad(TARGET.toString() as Hex, { size: 32 }), pad(RECIPIENT.toString() as Hex, { size: 32 })],
  data: '0x',
} as unknown as Log;

type SimulatedCall =
  | { status: 'success'; result: bigint; logs?: Log[]; gasUsed?: bigint }
  | { status: 'failure'; error: Error; logs?: Log[] };

const OPERATION: PendingL1Operation = {
  operationId: OPERATION_ID,
  broadcaster: AztecAddress.fromBigIntUnsafe(7n),
  l2TxHash: '0xl2tx',
  l2BlockNumber: 5n,
  target: TARGET,
  payoutToken: PAYOUT_TOKEN,
  calldata: CALLDATA,
  condition: L1OperationCondition.immediate(),
  status: 'pending',
  attempts: 0,
  createdAt: new Date(),
};

interface FakeSenderOpts {
  /** The market fee values: the latest base fee plus the tip, and the tip. */
  feeValues?: FeeValuesEIP1559;
  /** The block numbers that successive `getBlock` reads return; 10 when omitted. */
  blockNumbers?: bigint[];
  /** The gas limit of each block that `getBlock` returns; 30M when omitted. */
  blockGasLimit?: bigint;
  maxFeePerGasCap?: bigint;
  /** Terminal outcome each send's `settled` monitor reports; a mined success when omitted. */
  outcome?: 'success' | 'reverted' | 'timeout';
  /** Each send is simulated, as with submission disabled. */
  simulated?: boolean;
  /** Each send's `settled` monitor reports its outcome only when `settle` is called. */
  held?: boolean;
}

function fakeSender(opts: FakeSenderOpts = {}) {
  let nextId = 0;
  const feeValues = opts.feeValues ?? { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  const held: Array<() => void> = [];

  const sendTransaction = jest.fn((_request: TransactionRequestEIP1559): Promise<SentL1Tx> => {
    const id = nextId++;
    const txHash = `0x${(id + 1).toString(16).padStart(64, '0')}` as Hex;
    const outcome = opts.outcome ?? 'success';
    const result =
      outcome === 'timeout'
        ? Promise.reject(new TimeoutError(`L1 transaction with nonce ${id} expired without a receipt`))
        : Promise.resolve({
            status: outcome,
            gasUsed: 50_000n,
            effectiveGasPrice: 3n,
          } as unknown as TransactionReceipt);
    const settled = opts.held ? new Promise<TransactionReceipt>(resolve => held.push(() => resolve(result))) : result;
    // Pre-handled branches, like the real L1 tx queue provides.
    result.catch(() => undefined);
    settled.catch(() => undefined);
    return Promise.resolve({ txHash, nonce: id, settled, simulated: opts.simulated });
  });

  const blockNumbers = [...(opts.blockNumbers ?? [])];
  const client = {
    getBlock: jest.fn(() =>
      Promise.resolve({
        number: blockNumbers.shift() ?? 10n,
        gasLimit: opts.blockGasLimit ?? 30_000_000n,
        baseFeePerGas: feeValues.maxFeePerGas - feeValues.maxPriorityFeePerGas,
      }),
    ),
    estimateMaxPriorityFeePerGas: jest.fn(() => Promise.resolve(feeValues.maxPriorityFeePerGas)),
  } as unknown as PublicClient;
  const l1TxQueue: L1OperationSubmitterDeps['l1TxQueue'] = {
    address: SENDER.toString(),
    enqueue: submit => submit(sendTransaction),
    maxFeePerGasCap: opts.maxFeePerGasCap,
  };

  /** Reports the outcome of every held send. */
  const settle = () => held.splice(0).forEach(release => release());
  return { client, l1TxQueue, sendTransaction, settle };
}

const identityOracle = fixedPriceOracle();

type SimulatedExecute = { blocks: Array<{ calls: Array<{ args: readonly unknown[]; gas: bigint }> }> };

/** The `execute` call of each simulation that `simulate` received, in order. */
function simulatedCalls(simulate: { mock: { calls: unknown[][] } }) {
  return simulate.mock.calls.map(([request]) => (request as SimulatedExecute).blocks[0].calls[0]);
}

/** The `minPayout` of each simulated `execute` call, in order. */
function simulatedMinPayouts(simulate: { mock: { calls: unknown[][] } }): bigint[] {
  return simulatedCalls(simulate).map(call => call.args[3] as bigint);
}

/** The sent `execute` arguments past the operation: the minimum payout, the gas to cover and the price. */
function sentPayoutArgs(data: Hex) {
  const { args } = decodeFunctionData({ abi: OperationExecutorAbi, data });
  const [, , , minPayout, gasToCover, tokenWeiPerEth] = args as readonly [string, Hex, string, bigint, bigint, bigint];
  return { minPayout, gasToCover, tokenWeiPerEth };
}

function buildSubmitter(
  store: StateStore,
  overrides: {
    /** The simulated call each quote resolves with; a successful `PAYOUT` quote when omitted. */
    quote?: (request: unknown) => Promise<SimulatedCall>;
    /** Addresses the fake SDN list holds. */
    listed?: EthAddress[];
    predicate?: { isCompliant: (address: EthAddress) => Promise<boolean> };
    config?: Partial<L1OperationsSubmissionConfig>;
    feeValues?: FeeValuesEIP1559;
    blockNumbers?: bigint[];
    blockGasLimit?: bigint;
    priceOracle?: PriceOracle;
    maxFeePerGasCap?: bigint;
    outcome?: FakeSenderOpts['outcome'];
    simulated?: boolean;
    held?: boolean;
    allowUnprofitable?: boolean;
    dateProvider?: DateProvider;
    /** The `balanceOf` read of a `Balance` condition; a nonzero balance when omitted. */
    balance?: () => Promise<bigint>;
    telemetry?: RelayerTelemetry;
    withdrawalCompletion?: WithdrawalCompletion;
    executorVersion?: OperationExecutorVersion;
    /** Which saved operations another worker owns and holds; none when omitted. */
    givesWayTo?: L1OperationOwnership['givesWayTo'];
    forbiddenOperationIds?: ReadonlySet<string>;
  } = {},
) {
  const l1 = fakeSender({
    feeValues: overrides.feeValues,
    blockNumbers: overrides.blockNumbers,
    blockGasLimit: overrides.blockGasLimit,
    maxFeePerGasCap: overrides.maxFeePerGasCap,
    outcome: overrides.outcome,
    simulated: overrides.simulated,
    held: overrides.held,
  });
  const quote = overrides.quote ?? (() => Promise.resolve({ status: 'success' as const, result: PAYOUT }));
  const simulateBlocks = jest.fn(async (args: unknown) => [
    { calls: [{ gasUsed: SIMULATED_GAS_USED, ...(await quote(args)) }] },
  ]);
  const readContract = jest.fn((_request: unknown) => (overrides.balance ?? (() => Promise.resolve(1n)))());
  Object.assign(l1.client, { simulateBlocks, readContract });
  const listed = overrides.listed ?? [];
  const screener = new L1OperationScreener(
    { isListed: address => listed.some(entry => entry.equals(address)) },
    overrides.predicate,
  );
  const submitter = new L1OperationSubmitter({
    executor: EXECUTOR,
    executorVersion: overrides.executorVersion ?? 'gas-to-cover',
    client: l1.client,
    l1TxQueue: l1.l1TxQueue,
    store,
    forbiddenOperationIds: overrides.forbiddenOperationIds ?? new Set(),
    priceOracle: overrides.priceOracle ?? identityOracle,
    screener,
    config: {
      retryBackoffMs: 0,
      maxPendingAgeMs: MAX_PENDING_AGE_MS,
      ...overrides.config,
    },
    withdrawalCompletion: overrides.withdrawalCompletion ?? NO_WITHDRAWALS,
    ownership: { owns: () => true, givesWayTo: overrides.givesWayTo ?? (() => Promise.resolve(undefined)) },
    allowUnprofitable: overrides.allowUnprofitable,
    dateProvider: overrides.dateProvider,
    telemetry: overrides.telemetry,
  });
  return { submitter, ...l1, simulateBlocks, readContract };
}

describe('L1OperationSubmitter', () => {
  it('defers when successful target execution costs more than its payout', async () => {
    await withStore(async store => {
      // A target can skip an inner call at low gas. Requiring payment forces the full execution path.
      const quote = jest.fn((request: unknown) => {
        const args = request as { blocks: Array<{ calls: Array<{ args: readonly unknown[] }> }> };
        const minPayout = args.blocks[0].calls[0].args[3];
        return Promise.resolve({
          status: 'success' as const,
          result: PAYOUT,
          gasUsed: minPayout === 0n ? 10_000n : 600_000n,
        });
      });
      const { submitter, sendTransaction } = buildSubmitter(store, { quote });

      const summary = await submitter.runOnce();

      expect(summary).toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
      expect((await store.getPendingL1Operation(OPERATION_ID))?.status).toBe('pending');
      // The gas simulation carries the quoted payout as its minimum payout.
      const gasSimulation = quote.mock.calls[1][0] as { blocks: Array<{ calls: Array<{ args: readonly unknown[] }> }> };
      expect(gasSimulation.blocks[0].calls[0].args[3]).toBe(PAYOUT);
    });
  });

  it('prices the gas cost on the simulated gas used, not on the gas limit', async () => {
    await withStore(async store => {
      const feeValues = { maxFeePerGas: 4n, maxPriorityFeePerGas: 1n };
      // Break-even on the gas used after refunds, below the break-even on the gas limit of 3/2 of it.
      const payout = GAS_TO_COVER * feeValues.maxFeePerGas;
      const { submitter, sendTransaction } = buildSubmitter(store, {
        feeValues,
        quote: () => Promise.resolve({ status: 'success' as const, result: payout }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      const [request] = sendTransaction.mock.calls[0];
      // The tx still carries the gas limit.
      expect(request.gas).toBe(SIMULATED_GAS_LIMIT + 2n * UINT256_EXTRA_CALLDATA_GAS);
      expect(sentPayoutArgs(request.data as Hex)).toEqual({
        minPayout: 0n,
        gasToCover: GAS_TO_COVER,
        tokenWeiPerEth: WEI_PER_ETH,
      });
    });
  });

  it('keeps each simulation and the gas limit within the transaction gas cap when the block gas limit is above it', async () => {
    await withStore(async store => {
      // Above the cap, an RPC node can price the call's gas differently, and a subsidy that pays for gas at
      // `tx.gasprice` then pays less than in the sent transaction. 3/2 of this gas is above the cap.
      const gasUsed = 14_000_000n;
      const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, {
        blockGasLimit: 200_000_000n,
        quote: () => Promise.resolve({ status: 'success' as const, result: 10n ** 18n, gasUsed }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      expect(simulatedCalls(simulateBlocks).map(call => call.gas)).toEqual([15_000_000n, 15_000_000n, 15_000_000n]);
      expect(sendTransaction.mock.calls[0][0].gas).toBeLessThanOrEqual(MAX_TRANSACTION_GAS);
    });
  });

  describe('when the target requires more gas left than it uses', () => {
    /** A target that reverts unless the call has `required` gas, as an ERC-4337 EntryPoint requires the user operation's gas limits. */
    const requiringGas =
      (required: bigint, result: bigint) =>
      (request: unknown): Promise<SimulatedCall> =>
        (request as SimulatedExecute).blocks[0].calls[0].gas < required
          ? REVERT()
          : Promise.resolve({ status: 'success' as const, result });

    it('doubles the gas limit until a simulation passes, and sends that gas limit', async () => {
      await withStore(async store => {
        const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, {
          quote: requiringGas(1_000_000n, 10n ** 6n),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
        expect(simulatedCalls(simulateBlocks).map(call => call.gas)).toEqual([
          15_000_000n,
          15_000_000n,
          SIMULATED_GAS_LIMIT,
          2n * SIMULATED_GAS_LIMIT,
          4n * SIMULATED_GAS_LIMIT,
          8n * SIMULATED_GAS_LIMIT,
        ]);
        expect(simulatedMinPayouts(simulateBlocks).slice(1)).toEqual(Array(5).fill(10n ** 6n));
        const [request] = sendTransaction.mock.calls[0];
        const gasLimit = 8n * SIMULATED_GAS_LIMIT + 2n * UINT256_EXTRA_CALLDATA_GAS;
        expect(request.gas).toBe(gasLimit);
        // The target can use all of the gas limit, so the gas to cover is 2/3 of it, not the 100k gas used.
        expect(sentPayoutArgs(request.data as Hex)).toEqual({
          minPayout: 0n,
          gasToCover: (2n * gasLimit + 2n) / 3n,
          tokenWeiPerEth: WEI_PER_ETH,
        });
      });
    });

    it('defers without an attempt when the simulation fails at the gas cap', async () => {
      await withStore(async store => {
        // The payout quote and the gas simulation pass. Each simulation at a gas limit fails, also at the cap.
        let calls = 0;
        const quote = (_request: unknown): Promise<SimulatedCall> =>
          ++calls <= 2 ? Promise.resolve({ status: 'success' as const, result: 10n ** 6n }) : REVERT();
        const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, { quote });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
        expect(sendTransaction).not.toHaveBeenCalled();
        expect(simulatedCalls(simulateBlocks).at(-1)?.gas).toBe(15_000_000n);
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
          status: 'pending',
          attempts: 0,
        });
      });
    });

    it('defers a payout that covers the gas used but not 2/3 of the gas limit', async () => {
      await withStore(async store => {
        // PAYOUT covers the 100k gas used, but not 2/3 of the 1.2M gas limit.
        const { submitter, sendTransaction } = buildSubmitter(store, { quote: requiringGas(1_000_000n, PAYOUT) });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
        expect(sendTransaction).not.toHaveBeenCalled();
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ lastReason: 'unprofitable' });
      });
    });
  });

  describe('with a legacy executor', () => {
    // The relayer's fee ceiling: twice the base fee of 3 plus the tip of 1. The quote price is 4.
    const feeValues = { maxFeePerGas: 4n, maxPriorityFeePerGas: 1n };
    const MAX_FEE_PER_GAS = 7n;

    it('sends the four-argument execute with the gas at the fee ceiling as its minimum payout', async () => {
      await withStore(async store => {
        const payout = GAS_TO_COVER * MAX_FEE_PER_GAS;
        const quote = jest.fn((_request: unknown) => Promise.resolve({ status: 'success' as const, result: payout }));
        const { submitter, sendTransaction } = buildSubmitter(store, {
          executorVersion: 'legacy',
          feeValues,
          quote,
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });

        // The three simulations call the legacy `execute`, and the two gas simulations require the quoted payout.
        expect(quote).toHaveBeenCalledTimes(3);
        for (const [request] of quote.mock.calls) {
          const call = (request as { blocks: Array<{ calls: Array<{ abi: unknown; args: readonly unknown[] }> }> })
            .blocks[0].calls[0];
          expect(call.abi).toBe(LEGACY_OPERATION_EXECUTOR_ABI);
          expect(call.args).toHaveLength(4);
        }
        expect(simulatedMinPayouts(quote)).toEqual([0n, payout, payout]);

        const sent = decodeFunctionData({
          abi: LEGACY_OPERATION_EXECUTOR_ABI,
          data: sendTransaction.mock.calls[0][0].data as Hex,
        });
        const [target, calldata, payoutToken, minPayout] = sent.args;
        expect([target.toLowerCase(), calldata, payoutToken.toLowerCase(), minPayout]).toEqual([
          TARGET.toString().toLowerCase(),
          `0x${CALLDATA.toString('hex')}`,
          PAYOUT_TOKEN.toString().toLowerCase(),
          payout,
        ]);
      });
    });

    it('defers a payout that covers the gas at the quote price but not at the fee ceiling', async () => {
      await withStore(async store => {
        const { submitter, sendTransaction } = buildSubmitter(store, {
          executorVersion: 'legacy',
          feeValues,
          quote: () => Promise.resolve({ status: 'success' as const, result: GAS_TO_COVER * MAX_FEE_PER_GAS - 1n }),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
        expect(sendTransaction).not.toHaveBeenCalled();
      });
    });
  });

  it('defers when the gas simulation fails', async () => {
    await withStore(async store => {
      let calls = 0;
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: () =>
          Promise.resolve(
            calls++ === 0
              ? { status: 'success' as const, result: PAYOUT }
              : { status: 'failure' as const, error: new Error('reverted') },
          ),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
      });
    });
  });

  it('prices a subsidy-only payout before using it as the minPayout of the gas simulations', async () => {
    await withStore(async store => {
      const feeValues = { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
      // The default 100% headroom doubles the base fee of 1, plus the tip of 1.
      const feeCeiling = 3n;
      const quote = jest.fn((request: unknown) => {
        const args = request as { blocks: Array<{ calls: Array<FeeValuesEIP1559> }> };
        // A zero-tip refund earns only a subsidy that depends on the gas price. An unpriced quote returns zero.
        const payout = args.blocks[0].calls[0].maxFeePerGas === feeCeiling ? PAYOUT : 0n;
        return Promise.resolve({ status: 'success' as const, result: payout });
      });
      const { submitter, sendTransaction } = buildSubmitter(store, { feeValues, quote });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1, deferred: 0 });
      // The payout quote, the gas simulation, and the simulation at the gas limit.
      expect(quote).toHaveBeenCalledTimes(3);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      // A zero minPayout permits the target to skip the inner call; the subsidy quote must make it nonzero.
      expect(simulatedMinPayouts(quote)).toEqual([0n, PAYOUT, PAYOUT]);
    });
  });

  it('does not inflate the minPayout of the gas simulations when the fee ceiling exceeds the effective price', async () => {
    await withStore(async store => {
      // The latest base fee is 3 and the tip is 1. A 100% headroom puts the ceiling at 3 x 2 + 1 = 7, above the
      // effective 4.
      const feeValues = { maxFeePerGas: 4n, maxPriorityFeePerGas: 1n };
      const tip = PAYOUT;
      const subsidyPerGasPrice = 100_000n;
      const effectivePrice = 4n;
      const payout = tip + subsidyPerGasPrice * effectivePrice;
      const quote = jest.fn((request: unknown) => {
        const args = request as {
          blocks: Array<{
            blockOverrides?: { baseFeePerGas: bigint };
            calls: Array<FeeValuesEIP1559 & { gasPrice?: bigint }>;
          }>;
        };
        const block = args.blocks[0];
        const call = block.calls[0];
        const baseFee = block.blockOverrides?.baseFeePerGas ?? 0n;
        const effective = baseFee + call.maxPriorityFeePerGas;
        const price = call.gasPrice ?? (call.maxFeePerGas < effective ? call.maxFeePerGas : effective);
        const result = tip + subsidyPerGasPrice * price;
        if (((call as unknown as { args: readonly unknown[] }).args[3] as bigint) > result) {
          return Promise.resolve({
            status: 'failure' as const,
            error: new Error('quoted payout exceeds the effective-price payout'),
          });
        }
        return Promise.resolve({ status: 'success' as const, result });
      });
      const { submitter, sendTransaction } = buildSubmitter(store, {
        feeValues,
        quote,
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1, deferred: 0 });
      expect(simulatedMinPayouts(quote)).toEqual([0n, payout, payout]);
      const sent = sendTransaction.mock.calls[0];
      expect(sent[0]).toMatchObject({ maxFeePerGas: 7n, maxPriorityFeePerGas: 1n });
      // The sent gas to cover is an amount of gas, which the executor prices at the gas price the tx pays, not at the
      // ceiling.
      expect(sentPayoutArgs(sent[0].data as Hex)).toEqual({
        minPayout: 0n,
        gasToCover: GAS_TO_COVER,
        tokenWeiPerEth: WEI_PER_ETH,
      });
    });
  });

  it('submits a gas cost that breaks even at the quote price', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction, simulateBlocks } = buildSubmitter(store);
      const summary = await submitter.runOnce();
      // The operation is submitted, awaited to a receipt, and confirmed within the same poll.
      expect(summary).toMatchObject({ submitted: 1, confirmed: 1, dropped: 0, blocked: 0 });

      // One block, one call, from the sender, with transfer tracing so ETH moves show up as logs.
      expect(simulateBlocks).toHaveBeenCalledWith({
        blockNumber: 10n,
        blocks: [
          {
            blockOverrides: { baseFeePerGas: 0n },
            stateOverrides: [{ address: SENDER.toString(), balance: SIMULATED_SENDER_BALANCE }],
            calls: [
              expect.objectContaining({
                to: EXECUTOR.toString(),
                functionName: 'execute',
                from: SENDER.toString(),
                gas: 15_000_000n,
              }),
            ],
          },
        ],
        traceTransfers: true,
        validation: true,
      });
      // The gas simulation and the simulation at the gas limit require the quoted payout.
      expect(simulatedCalls(simulateBlocks).map(call => [call.args[3], call.gas])).toEqual([
        [0n, 15_000_000n],
        [PAYOUT, 15_000_000n],
        [PAYOUT, SIMULATED_GAS_LIMIT],
      ]);
      const request = sendTransaction.mock.calls[0][0];
      expect(request.to).toBe(EXECUTOR.toString());
      const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: request.data as Hex });
      // The gas used plus the calldata gas of two nonzero arguments, at the identity oracle's price of one token unit
      // per wei.
      expect(decoded.args).toEqual([
        TARGET.toChecksumString(),
        `0x${CALLDATA.toString('hex')}`,
        PAYOUT_TOKEN.toChecksumString(),
        0n,
        GAS_TO_COVER,
        WEI_PER_ETH,
      ]);
    });
  });

  it('gives way to another worker that owns and holds the saved operation, without simulating or sending', async () => {
    await withStore(async store => {
      const telemetry = { l1OperationOutcome: jest.fn() } as unknown as RelayerTelemetry;
      const givesWayTo = jest.fn((_operation: unknown) => Promise.resolve<string | undefined>('dep-v6'));
      const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, { givesWayTo, telemetry });

      const summary = await submitter.runOnce();

      expect(givesWayTo).toHaveBeenCalledWith(expect.objectContaining({ operationId: OPERATION_ID }));
      expect(summary).toMatchObject({ submitted: 0, dropped: 0 });
      expect(simulateBlocks).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
      // The owner submits it, so giving way is not a failure outcome.
      expect((telemetry as unknown as { l1OperationOutcome: jest.Mock }).l1OperationOutcome).not.toHaveBeenCalled();
    });
  });

  it('keeps and submits the saved operation when the ownership lookup fails', async () => {
    await withStore(async store => {
      const givesWayTo = () => Promise.reject(new Error('store closed'));
      const { submitter } = buildSubmitter(store, { givesWayTo });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'executed' });
    });
  });

  it('marks the operation executed once its tx mines successfully', async () => {
    await withStore(async store => {
      const { submitter } = buildSubmitter(store);

      const summary = await submitter.runOnce();

      expect(summary).toMatchObject({ submitted: 1, confirmed: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'executed' });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
    });
  });

  describe('telemetry of an executed operation', () => {
    const telemetry = () => ({ l1OperationOutcome: jest.fn(), gasSpentWei: jest.fn() });

    it('records submitted, confirmed and the gas spent', async () => {
      await withStore(async store => {
        const fake = telemetry();
        const { submitter } = buildSubmitter(store, { telemetry: fake as unknown as RelayerTelemetry });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1 });
        expect(fake.l1OperationOutcome.mock.calls).toEqual([
          ['submitted', 'other'],
          ['confirmed', 'other'],
        ]);
        expect(fake.gasSpentWei).toHaveBeenCalledWith('l1_operation', 150_000n);
      });
    });

    it('records no outcome and no gas when the tx is simulated', async () => {
      await withStore(async store => {
        const fake = telemetry();
        const { submitter } = buildSubmitter(store, {
          simulated: true,
          telemetry: fake as unknown as RelayerTelemetry,
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 1 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'executed' });
        expect(fake.l1OperationOutcome).not.toHaveBeenCalled();
        expect(fake.gasSpentWei).not.toHaveBeenCalled();
      });
    });
  });

  it('doubles the backoff on each reverting quote, up to 15 min, and keeps the operation pending', async () => {
    await withStore(async store => {
      const dateProvider = new TestDateProvider();
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: REVERT,
        config: { retryBackoffMs: 30_000 },
        dateProvider,
      });

      const gaps: number[] = [];
      for (let poll = 0; poll < 9; poll++) {
        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
        const row = await store.getPendingL1Operation(OPERATION_ID);
        const gap = row!.nextCheckAt!.getTime() - row!.lastCheckedAt!.getTime();
        gaps.push(gap);
        dateProvider.advanceTime(gap / 1000);
      }

      expect(gaps.map(gap => gap / 1000)).toEqual([30, 60, 120, 240, 480, 900, 900, 900, 900]);
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 9,
        lastReason: 'simulation_reverted',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('operations of an older version', () => {
    it('continues the revert backoff from the attempts that an older relayer stored', async () => {
      await withStore(
        async store => {
          const { submitter } = buildSubmitter(store, { quote: REVERT, config: { retryBackoffMs: 30_000 } });

          await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
          const row = await store.getPendingL1Operation(OPERATION_ID);
          expect(row).toMatchObject({ status: 'pending', attempts: 5 });
          // The fifth revert waits 30 s x 2^4.
          expect(row!.nextCheckAt!.getTime() - row!.lastCheckedAt!.getTime()).toBe(480_000);
        },
        { ...OPERATION, attempts: 4 },
      );
    });

    it('retries an Immediate sweep from an older resolver without a balance read', async () => {
      await withStore(async store => {
        const { submitter, readContract } = buildSubmitter(store, {
          quote: REVERT,
          balance: () => Promise.resolve(0n),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'pending' });
        expect(readContract).not.toHaveBeenCalled();
      });
    });
  });

  describe('reverting Balance operation', () => {
    const BALANCE_TOKEN = EthAddress.random();
    const SIPA = EthAddress.random();
    const BALANCE_OPERATION: PendingL1Operation = {
      ...OPERATION,
      condition: L1OperationCondition.balance(BALANCE_TOKEN, SIPA),
    };

    it('drops the operation when the recipient no longer holds the token', async () => {
      await withStore(async store => {
        const { submitter, readContract } = buildSubmitter(store, {
          quote: REVERT,
          balance: () => Promise.resolve(0n),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 1, deferred: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
        expect(readContract).toHaveBeenCalledWith(
          expect.objectContaining({
            address: BALANCE_TOKEN.toString(),
            functionName: 'balanceOf',
            args: [SIPA.toString()],
          }),
        );
      }, BALANCE_OPERATION);
    });

    it('keeps the revert backoff when the recipient still holds the token', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store, { quote: REVERT, balance: () => Promise.resolve(1n) });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 0, deferred: 1 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
          status: 'pending',
          attempts: 1,
          lastReason: 'simulation_reverted',
        });
      }, BALANCE_OPERATION);
    });

    it('keeps the revert backoff when the balance read fails', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store, {
          quote: REVERT,
          balance: () => Promise.reject(new Error('rpc down')),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 0, deferred: 1 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'pending' });
      }, BALANCE_OPERATION);
    });

    it('does not simulate the operation again while its mined tx has no recorded outcome', async () => {
      await withStore(async store => {
        let swept = false;
        const { submitter, simulateBlocks, settle } = buildSubmitter(store, {
          held: true,
          // Once the tx sweeps the recipient, the operation reverts and the recipient holds nothing.
          quote: () => (swept ? REVERT() : Promise.resolve({ status: 'success' as const, result: PAYOUT })),
          balance: () => Promise.resolve(swept ? 0n : 1n),
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 0 });
        swept = true;
        const simulations = simulateBlocks.mock.calls.length;
        await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, dropped: 0, deferred: 0 });

        settle();
        await pollUntil(submitter, async () => (await store.getPendingL1Operation(OPERATION_ID))?.status !== 'pending');
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'executed' });
        expect(simulateBlocks).toHaveBeenCalledTimes(simulations);
      }, BALANCE_OPERATION);
    });
  });

  describe('max pending age', () => {
    const STALE = { ...OPERATION, createdAt: new Date(Date.now() - MAX_PENDING_AGE_MS) };

    it('drops a reverting operation instead of deferring it', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store, { quote: REVERT });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 1, deferred: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
      }, STALE);
    });

    it('drops an unprofitable operation instead of deferring it', async () => {
      await withStore(async store => {
        // Break-even (100k gas x 10^13 wei) far exceeds the 500k-unit payout.
        const { submitter, sendTransaction } = buildSubmitter(store, {
          feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 1, deferred: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'dropped' });
        expect(sendTransaction).not.toHaveBeenCalled();
      }, STALE);
    });

    it('still executes an old operation that succeeds', async () => {
      await withStore(async store => {
        const { submitter } = buildSubmitter(store);

        await expect(submitter.runOnce()).resolves.toMatchObject({ confirmed: 1, dropped: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'executed' });
      }, STALE);
    });

    it('keeps deferring an operation below the max age', async () => {
      await withStore(
        async store => {
          const { submitter } = buildSubmitter(store, { quote: REVERT });

          await expect(submitter.runOnce()).resolves.toMatchObject({ dropped: 0, deferred: 1 });
          await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'pending' });
        },
        { ...OPERATION, createdAt: new Date(Date.now() - MAX_PENDING_AGE_MS + 60_000) },
      );
    });
  });

  it('defers an expired tx and re-sends it on the next poll', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, { outcome: 'timeout' });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, confirmed: 0, deferred: 1 });
      // The operation stays pending without burning an attempt; the zero backoff makes it due again.
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1 });
      expect(sendTransaction).toHaveBeenCalledTimes(2);
    });
  });

  it('re-sends an operation only after the tx of an earlier batch expires', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction, settle } = buildSubmitter(store, { held: true, outcome: 'timeout' });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1 });
      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0 });

      settle();
      await pollUntil(submitter, () => sendTransaction.mock.calls.length === 2);
    });
  });

  it('defers an operation below the minimum payout without burning an attempt', async () => {
    await withStore(async store => {
      // Break-even (100k gas x 10^13 wei) far exceeds the 500k-unit payout.
      const { submitter, sendTransaction } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
      });
      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        lastReason: 'unprofitable',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('submits with a zero minPayout when allowUnprofitable drops the gas cost', async () => {
    await withStore(async store => {
      // The same break-even that defers the operation above, with the gas cost dropped.
      const { submitter, sendTransaction } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
        allowUnprofitable: true,
      });
      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      // The sent transaction carries zero payout arguments, so the executor cannot reject it on payout.
      const { data } = sendTransaction.mock.calls[0][0] as { data: Hex };
      expect(sentPayoutArgs(data)).toEqual({ minPayout: 0n, gasToCover: 0n, tokenWeiPerEth: 0n });
    });
  });

  it('simulates with the fee settings the transaction carries', async () => {
    await withStore(async store => {
      const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: 18n, maxPriorityFeePerGas: 2n },
        // Clears the break-even at the ceiling, which the default payout does not.
        quote: () => Promise.resolve({ status: 'success' as const, result: 2_000_000n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1 });

      const simulations = simulateBlocks.mock.calls.map(
        ([args]) =>
          (
            args as {
              blocks: [
                {
                  stateOverrides: Array<{ address: string; balance: bigint }>;
                  calls: [FeeValuesEIP1559 & { from: string; gasPrice?: bigint }];
                },
              ];
            }
          ).blocks[0],
      );
      expect(simulations).toHaveLength(3);
      for (const simulation of simulations) {
        // The ceiling the transaction carries is the base fee of 16 plus the 100% headroom, plus the tip of 2.
        expect(simulation.calls[0]).toMatchObject({
          from: SENDER.toString(),
          maxFeePerGas: 34n,
          maxPriorityFeePerGas: 2n,
        });
        expect(simulation.calls[0].gasPrice).toBeUndefined();
        // The balance override is what lets each priced call run without being capped by what the sender holds.
        expect(simulation.stateOverrides).toEqual([{ address: SENDER.toString(), balance: SIMULATED_SENDER_BALANCE }]);
      }
      expect(sendTransaction.mock.calls[0][0]).toMatchObject({ maxFeePerGas: 34n, maxPriorityFeePerGas: 2n });
    });
  });

  it('puts the max fee headroom on the fee ceiling only, not on the gas cost', async () => {
    await withStore(async store => {
      // Break-even at the quote price of 8, below the ceiling of 14: the base fee of 6 plus the 100% headroom, plus the
      // tip of 2.
      const payout = GAS_TO_COVER * 8n;
      const { submitter, sendTransaction } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        quote: () => Promise.resolve({ status: 'success' as const, result: payout }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      const [request] = sendTransaction.mock.calls[0];
      expect(request).toMatchObject({ maxFeePerGas: 14n, maxPriorityFeePerGas: 2n });
      expect(sentPayoutArgs(request.data as Hex)).toEqual({
        minPayout: 0n,
        gasToCover: GAS_TO_COVER,
        tokenWeiPerEth: WEI_PER_ETH,
      });
    });
  });

  it('defers a payout below the break-even at the quote price', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        quote: () => Promise.resolve({ status: 'success' as const, result: GAS_TO_COVER * 8n - 1n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers without simulating when the fee ceiling after headroom is above the max fee per gas', async () => {
    await withStore(async store => {
      const l1OperationOutcome = jest.fn();
      // The 100% headroom on the base fee of 6, plus the tip of 2, puts the ceiling at 14; a cap of 13 is below it.
      const { submitter, sendTransaction, simulateBlocks } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        maxFeePerGasCap: 13n,
        telemetry: { l1OperationOutcome } as unknown as RelayerTelemetry,
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
      expect(simulateBlocks).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(l1OperationOutcome).toHaveBeenCalledWith('deferred', 'other', 'gas_price_above_max');
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
      });
    });
  });

  it('records the operation kind with the defer reason', async () => {
    const sweep = buildSipaSweepOperation({
      sipa: TARGET.toString(),
      sweepArgs: { token: PAYOUT_TOKEN.toString(), relayer: EXECUTOR.toString(), intentData: '0x', proofs: '0x' },
      payoutToken: PAYOUT_TOKEN.toString(),
      condition: L1OperationCondition.immediate(),
    });
    await withStore(
      async store => {
        const l1OperationOutcome = jest.fn();
        const { submitter } = buildSubmitter(store, {
          feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
          maxFeePerGasCap: 13n,
          telemetry: { l1OperationOutcome } as unknown as RelayerTelemetry,
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1 });
        expect(l1OperationOutcome).toHaveBeenCalledWith('deferred', 'sweep', 'gas_price_above_max');
      },
      { ...OPERATION, ...sweep },
    );
  });

  it('submits when the fee ceiling equals the max fee per gas', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: 8n, maxPriorityFeePerGas: 2n },
        maxFeePerGasCap: 14n,
        quote: () => Promise.resolve({ status: 'success' as const, result: GAS_TO_COVER * 8n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      expect(sendTransaction.mock.calls[0][0]).toMatchObject({ maxFeePerGas: 14n, maxPriorityFeePerGas: 2n });
    });
  });

  it('prices the gas cost at the capped tip when the suggested tip is above the priority fee the subsidies pay for', async () => {
    await withStore(async store => {
      const baseFee = 2n * 10n ** 9n;
      const suggestedTip = 50n * MAX_PRIORITY_FEE_WEI;
      const quotePrice = baseFee + MAX_PRIORITY_FEE_WEI;
      const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, {
        feeValues: { maxFeePerGas: baseFee + suggestedTip, maxPriorityFeePerGas: suggestedTip },
        // Break-even at the capped price, far below the price with the suggested tip.
        quote: () => Promise.resolve({ status: 'success' as const, result: GAS_TO_COVER * quotePrice }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      const capped = { maxFeePerGas: 2n * baseFee + MAX_PRIORITY_FEE_WEI, maxPriorityFeePerGas: MAX_PRIORITY_FEE_WEI };
      const [simulation] = simulateBlocks.mock.calls[0] as [{ blocks: [{ calls: [FeeValuesEIP1559] }] }];
      expect(simulation.blocks[0].calls[0]).toMatchObject(capped);
      expect(sendTransaction.mock.calls[0][0]).toMatchObject(capped);
    });
  });

  it('prices the whole quote on one block', async () => {
    await withStore(async store => {
      // A later read of the latest block would see a newer one.
      const { submitter, client, simulateBlocks } = buildSubmitter(store, {
        blockNumbers: [10n, 11n, 12n],
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1 });
      expect(client.getBlock).toHaveBeenCalledTimes(1);
      const simulatedBlocks = simulateBlocks.mock.calls.map(([args]) => (args as { blockNumber: bigint }).blockNumber);
      expect(simulatedBlocks).toEqual([10n, 10n, 10n]);
    });
  });

  it('sends the oracle price with the gas to cover', async () => {
    await withStore(async store => {
      const usdPerEth = 2_741n;
      const priceOracle = fixedPriceOracle(usdPerEth);
      const { submitter, sendTransaction } = buildSubmitter(store, {
        priceOracle,
        quote: () => Promise.resolve({ status: 'success' as const, result: GAS_TO_COVER * usdPerEth }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      expect(sentPayoutArgs(sendTransaction.mock.calls[0][0].data as Hex)).toEqual({
        minPayout: 0n,
        gasToCover: GAS_TO_COVER,
        tokenWeiPerEth: usdPerEth * WEI_PER_ETH,
      });
    });
  });

  it('prices gas in the payout token of the operation', async () => {
    await withStore(async store => {
      const usdPerEth = 2_741n;
      // The payout token is worth two USD, for example a vault share, so the gas costs half as many units.
      const twoUsd = 2n * 10n ** 18n;
      const priceOracle: PriceOracle = {
        getEthPrice: () => Promise.resolve(usdPerEth * 10n ** 18n),
        getTokenPrice: token =>
          token.equals(PAYOUT_TOKEN)
            ? Promise.resolve({ usdPerToken: twoUsd, decimals: 18 })
            : Promise.reject(new Error(`unexpected token ${token.toString()}`)),
      };
      const { submitter, sendTransaction } = buildSubmitter(store, {
        priceOracle,
        quote: () => Promise.resolve({ status: 'success' as const, result: GAS_TO_COVER * usdPerEth }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 1, deferred: 0 });
      expect(sentPayoutArgs(sendTransaction.mock.calls[0][0].data as Hex)).toMatchObject({
        tokenWeiPerEth: (usdPerEth * WEI_PER_ETH) / 2n,
      });
    });
  });

  it('defers a payout one unit below the break-even at the oracle price', async () => {
    await withStore(async store => {
      const usdPerEth = 2_741n;
      const priceOracle = fixedPriceOracle(usdPerEth);
      const { submitter, sendTransaction } = buildSubmitter(store, {
        priceOracle,
        quote: () => Promise.resolve({ status: 'success' as const, result: GAS_TO_COVER * usdPerEth - 1n }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ submitted: 0, deferred: 1 });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers a simulation transport error without burning an attempt', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: () => Promise.reject(new Error('HTTP request failed')),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, dropped: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        lastReason: undefined,
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('skips a permanently quarantined operation before TEE completion or submission', async () => {
    await withStore(
      async store => {
        const resolveCalldata = jest.fn(() => Promise.reject(new Error('must not request TEE completion')));
        const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, {
          forbiddenOperationIds: new Set([OPERATION_ID]),
          withdrawalCompletion: { resolveCalldata } as unknown as WithdrawalCompletion,
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 0, submitted: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
          status: 'pending',
          attempts: 0,
          lastReason: undefined,
        });
        expect(resolveCalldata).not.toHaveBeenCalled();
        expect(simulateBlocks).not.toHaveBeenCalled();
        expect(sendTransaction).not.toHaveBeenCalled();
      },
      { ...OPERATION, condition: L1OperationCondition.messageInOutbox() },
    );
  });

  it('defers with completion_error when withdrawal calldata completion fails, without burning an attempt', async () => {
    await withStore(
      async store => {
        const { submitter, simulateBlocks, sendTransaction } = buildSubmitter(store, {
          withdrawalCompletion: {
            resolveCalldata: () => Promise.reject(new Error('aztec node down')),
          } as unknown as WithdrawalCompletion,
        });

        await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, submitted: 0 });
        await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
          status: 'pending',
          attempts: 0,
          lastReason: 'completion_error',
        });
        expect(simulateBlocks).not.toHaveBeenCalled();
        expect(sendTransaction).not.toHaveBeenCalled();
      },
      { ...OPERATION, condition: L1OperationCondition.messageInOutbox() },
    );
  });

  it('blocks an operation with a listed target before it is priced', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction, simulateBlocks } = buildSubmitter(store, { listed: [TARGET] });

      await expect(submitter.runOnce()).resolves.toMatchObject({ blocked: 1, deferred: 0, submitted: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'blocked' });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      // Only the payout quote, which screening reads: no gas simulation.
      expect(simulateBlocks).toHaveBeenCalledTimes(1);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('blocks an operation whose simulation pays a listed recipient', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction, simulateBlocks } = buildSubmitter(store, {
        listed: [RECIPIENT],
        quote: () => Promise.resolve({ status: 'success', result: PAYOUT, logs: [RECIPIENT_TRANSFER_LOG] }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ blocked: 1, submitted: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'blocked' });
      // Only the payout quote, which screening reads: no gas simulation.
      expect(simulateBlocks).toHaveBeenCalledTimes(1);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers with screening_error when Predicate fails, without burning an attempt', async () => {
    await withStore(async store => {
      const { submitter, sendTransaction } = buildSubmitter(store, {
        predicate: { isCompliant: () => Promise.reject(new Error('predicate down')) },
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        lastReason: 'screening_error',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('re-screens a deferred operation and blocks it once the list gains its recipient', async () => {
    await withStore(async store => {
      const listed: EthAddress[] = [];
      const { submitter, sendTransaction } = buildSubmitter(store, {
        listed,
        // Break-even (100k gas x 10^13 wei) far exceeds the 500k-unit payout, so the first poll defers.
        feeValues: { maxFeePerGas: 10n ** 13n, maxPriorityFeePerGas: 1n },
        quote: () => Promise.resolve({ status: 'success', result: PAYOUT, logs: [RECIPIENT_TRANSFER_LOG] }),
      });

      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        lastReason: 'unprofitable',
      });

      listed.push(RECIPIENT);
      await expect(submitter.runOnce()).resolves.toMatchObject({ blocked: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({ status: 'blocked' });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  it('defers a zero-payout quote even below the retry budget (OX-905: no zero-floor bypass)', async () => {
    await withStore(async store => {
      // A gas cost above zero, from a nonzero gas price, always applies regardless of caller intent —
      // there is no config knob that pins `minPayout` to 0 for this unauthenticated broadcast channel.
      const { submitter, sendTransaction } = buildSubmitter(store, {
        quote: () => Promise.resolve({ status: 'success', result: 0n }),
      });
      await expect(submitter.runOnce()).resolves.toMatchObject({ deferred: 1 });
      await expect(store.getPendingL1Operation(OPERATION_ID)).resolves.toMatchObject({
        status: 'pending',
        lastReason: 'unprofitable',
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });
});

/** Runs batches, as the relayer's poll loop does, until `done` holds. */
async function pollUntil(submitter: L1OperationSubmitter, done: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await done())) {
    await submitter.runOnce();
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function withStore(
  fn: (store: StateStore) => Promise<void>,
  operation: PendingL1Operation = OPERATION,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-l1-op-submit-'));
  const store = await openSqliteStateStore(path.join(dir, 'state.sqlite3'), TEST_RELAYER_DEPLOYMENT);
  try {
    await store.upsertPendingL1Operation(operation);
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
