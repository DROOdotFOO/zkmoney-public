import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import type { AztecNode } from '@aztec-labs/aztec.js/node';

import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import type { SanctionsList } from '@oxide/watcher-lib/sanctions';

import { describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PublicClient } from 'viem';

import { FpcFunderCaller, type FpcFunderCallerConfig } from './fpc_funding/fpc_funder_caller.js';
import { L1OperationRelayer } from './l1_operations/l1_operation_relayer.js';
import type { L1OperationOwnership } from './l1_operations/l1_operation_router.js';
import type { PayoutTokenFilter } from './l1_operations/payout_token_registry.js';
import type { WithdrawalCompletion } from './l1_operations/withdrawal_completion.js';
import { LogRecorder, OPERATOR_LEVELS } from './log_recorder.js';
import { fixedPriceOracle } from './price_oracle/fixed_price_oracle.js';
import { openSqliteStateStore } from './state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from './state/test_fixtures.js';
import type { StateStore } from './state/types.js';

/** A worker that is alone on its Broadcaster, so it handles every operation. */
const OWNS_ALL: L1OperationOwnership = { owns: () => true, givesWayTo: () => Promise.resolve(undefined) };
/** A payout-token filter that accepts exactly `tokens`. */
function acceptsOnly(...tokens: EthAddress[]): PayoutTokenFilter {
  return { accepts: token => tokens.some(accepted => accepted.equals(token)) };
}

/** Idle poll cycles the measurement drives, after one warm-up cycle settles the start-up work. */
const CYCLES = 10;

/** Operator-visible lines the L1 operation loop writes while one pending operation stays unprofitable. */
const EXPECTED_L1_OPERATION_LINES: Record<string, number> = {};

/** Operator-visible lines the FPC funder writes while its balance stays below the fundable minimum. */
const EXPECTED_FUNDER_LINES: Record<string, number> = {};

const FUNDER = EthAddress.random();
const EXECUTOR = EthAddress.random();
const FUNDER_BALANCE = 5n * 10n ** 17n;
const FUNDER_MINIMUM = 5n * 10n ** 18n;

const BROADCASTER = AztecAddress.fromBigIntUnsafe(7n);
const TOKEN = EthAddress.random();
const SENDER = EthAddress.random();

const HEAD = 10;
const PROVEN = 4;
const L1_TIP = 4_321n;

function fakePublicClient() {
  return {
    getBlockNumber: jest.fn(() => Promise.resolve(L1_TIP)),
    getBlock: jest.fn(() => Promise.resolve({ number: L1_TIP, hash: `0x${'cd'.repeat(32)}` })),
    getContractEvents: jest.fn(() => Promise.resolve([])),
    getLogs: jest.fn(() => Promise.resolve([])),
    getCode: jest.fn(() => Promise.resolve('0x')),
  } as any;
}

/** A funder whose quote reverts below the fundable minimum. Viem exposes the decoded custom error in the cause chain. */
function fakeFunderClient(): PublicClient {
  const revert = Object.assign(new Error('The contract function "execute" reverted.'), {
    cause: {
      data: {
        errorName: 'FPCFunder__BalanceBelowMinimum',
        args: [FUNDER_BALANCE, FUNDER_MINIMUM],
      },
    },
  });
  return {
    readContract: jest.fn(() => Promise.resolve(TOKEN.toString())),
    simulateContract: jest.fn(() => Promise.reject(revert)),
  } as unknown as PublicClient;
}

function passThroughL1TxQueue(): FpcFunderCallerConfig['l1TxQueue'] {
  return {
    address: SENDER.toString(),
    enqueue: submit => submit(() => Promise.reject(new Error('the measurement never submits'))),
    maxFeePerGasCap: undefined,
  };
}

/** A node with no broadcasts, so the L1 operation measurement sees only the pending operation it seeded. */
function emptyNode(): AztecNode {
  return {
    getBlockNumber: jest.fn((status?: string) => Promise.resolve(status === 'proven' ? PROVEN : HEAD)),
    getPublicLogsByTags: jest.fn(() => Promise.resolve([[]])),
    getTxByHash: jest.fn(() => Promise.resolve(undefined)),
  } as unknown as AztecNode;
}

/** An executor whose quote always pays less than the gas it costs, so the operation defers on every due cycle. */
function unprofitableOperationClient(): PublicClient {
  return {
    ...fakePublicClient(),
    getBlock: jest.fn(() => Promise.resolve({ number: L1_TIP, baseFeePerGas: 9n })),
    estimateMaxPriorityFeePerGas: jest.fn(() => Promise.resolve(1n)),
    simulateBlocks: jest.fn(() => Promise.resolve([{ calls: [{ status: 'success', result: 1n, gasUsed: 100_000n }] }])),
    estimateGas: jest.fn(() => Promise.resolve(100_000n)),
  } as unknown as PublicClient;
}

const CLEAN_LIST: SanctionsList = { isListed: () => false };
/** The cycled operation is unconditioned, so no withdrawal is ever polled or completed. */
const NO_WITHDRAWALS = {
  outboxStatus: () => Promise.resolve({ status: 'waiting' }),
  resolveCalldata: () => Promise.reject(new Error('unexpected withdrawal completion')),
} as unknown as WithdrawalCompletion;
const IDENTITY_ORACLE = fixedPriceOracle();

async function withStore(run: (store: StateStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-idle-logs-'));
  const store = await openSqliteStateStore(path.join(dir, 'relayer.db'), TEST_RELAYER_DEPLOYMENT);
  try {
    await run(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeArtifact(name: string, body: unknown): Promise<void> {
  const dir = path.join(process.cwd(), 'test-artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
}

describe('idle-cycle logging', () => {
  it('counts the operator-visible lines an idle L1 operation cycle writes', async () => {
    await withStore(async store => {
      await store.upsertPendingL1Operation({
        operationId: `0x${'ee'.repeat(32)}`,
        broadcaster: BROADCASTER,
        l2TxHash: '0xoperation',
        l2BlockNumber: 1n,
        target: EthAddress.random(),
        payoutToken: TOKEN,
        calldata: Buffer.from('00', 'hex'),
        condition: L1OperationCondition.immediate(),
        status: 'pending',
        attempts: 0,
        createdAt: new Date(),
      });

      const recorder = new LogRecorder();
      const relayer = L1OperationRelayer.create({
        node: emptyNode(),
        publicClient: unprofitableOperationClient(),
        store,
        broadcaster: BROADCASTER,
        ownership: OWNS_ALL,
        payoutTokens: acceptsOnly(TOKEN),
        watchedTokens: [TOKEN],
        l1OperationsSubmission: { retryBackoffMs: 0, maxPendingAgeMs: 48 * 60 * 60_000 },
        executor: EXECUTOR,
        executorVersion: 'gas-to-cover',
        l1TxQueue: passThroughL1TxQueue(),
        forbiddenOperationIds: new Set(),
        sanctionsList: CLEAN_LIST,
        withdrawalCompletion: NO_WITHDRAWALS,
        priceOracle: IDENTITY_ORACLE,
        logger: recorder.logger('oxide-relayer:l1-operation-relayer'),
      });

      await relayer.runOnce();
      recorder.clear();
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        await relayer.runOnce();
      }

      const byEvent = recorder.countByEvent(OPERATOR_LEVELS);
      await writeArtifact('idle-cycle-logging-l1-operations.json', {
        cycles: CYCLES,
        pendingOperations: 1,
        operatorLines: recorder.count(OPERATOR_LEVELS),
        byEvent,
      });

      expect(byEvent).toEqual(EXPECTED_L1_OPERATION_LINES);
    });
  });

  it('counts the operator-visible lines an idle FPC funder cycle writes', async () => {
    const recorder = new LogRecorder();
    const caller = FpcFunderCaller.create({
      fpcFunder: FUNDER,
      executor: EXECUTOR,
      executorVersion: 'gas-to-cover',
      client: fakeFunderClient(),
      l1TxQueue: passThroughL1TxQueue(),
      priceOracle: IDENTITY_ORACLE,
      allowUnprofitable: false,
      logger: recorder.logger('oxide-relayer:fpc-funder-caller'),
    });

    await caller.runOnce();
    recorder.clear();
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      await caller.runOnce();
    }

    const byEvent = recorder.countByEvent(OPERATOR_LEVELS);
    await writeArtifact('idle-cycle-logging-funder.json', {
      cycles: CYCLES,
      balance: FUNDER_BALANCE.toString(),
      minimum: FUNDER_MINIMUM.toString(),
      operatorLines: recorder.count(OPERATOR_LEVELS),
      byEvent,
    });

    expect(byEvent).toEqual(EXPECTED_FUNDER_LINES);
  });
});
