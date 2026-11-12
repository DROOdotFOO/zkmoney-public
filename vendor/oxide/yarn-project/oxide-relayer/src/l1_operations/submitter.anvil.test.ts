import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { startAnvil } from '@aztec-labs/ethereum/test';

import {
  MockOncePerBlockOperationAbi,
  MockOncePerBlockOperationBytecode,
  OperationExecutorAbi,
  OperationExecutorBytecode,
  TestERC20Abi,
  TestERC20Bytecode,
} from '@oxide/l1-contracts';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  publicActions,
  toHex,
} from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import type { SendL1Tx } from '../l1/l1_tx_queue.js';
import { fixedPriceOracle } from '../price_oracle/fixed_price_oracle.js';
import { type SqliteStateStore, openSqliteStateStore } from '../state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from '../state/test_fixtures.js';
import type { PendingL1Operation, StateStore } from '../state/types.js';
import { L1OperationScreener } from './l1_operation_screener.js';
import { L1OperationSubmitter } from './submitter.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

/** Anvil's first three dev accounts, funded at genesis. */
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const RELAYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER_USER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

const REWARD = 100n * 10n ** 18n;
/** What the target adds for its first call in a block, as a subsidy adds the gas of the sUSDS drip. */
const FIRST_IN_BLOCK_REWARD = 10n ** 18n;
/** About 350k gas of first-in-block work, so a gas limit priced without it runs out of gas. */
const WORK_ROUNDS = 5_000n;
/** The seconds from one mainnet block to the next. */
const SLOT_SECONDS = 12n;
const USD_PER_ETH = 2_000n;
const OPERATION_ID = `0x${'cd'.repeat(32)}` as Hex;
const MAX_PENDING_AGE_MS = 48 * 60 * 60_000;

/** Every operation here is immediate, so completion is never reached. */
const NO_WITHDRAWALS = {
  resolveCalldata: () => Promise.reject(new Error('unexpected withdrawal completion')),
} as unknown as WithdrawalCompletion;

const FIXED_PRICE_ORACLE = fixedPriceOracle(USD_PER_ETH);

type RequestFn = (args: { method: string; params?: unknown }) => Promise<unknown>;

/**
 * Serves `eth_simulateV1` as geth and the execution-apis spec do: each simulated block is a new block on top of the
 * base block, one number and 12 seconds later. anvil 1.4.1 runs the simulation in the base block itself, which is
 * also the block that `eth_estimateGas` at that block number runs in.
 */
function nextBlockSimulation(rpcUrl: string) {
  const request = http(rpcUrl)({ chain: foundry }).request as RequestFn;
  return custom({
    async request({ method, params }) {
      if (method === 'eth_simulateV1') {
        const [payload, blockTag] = params as [{ blockStateCalls: { blockOverrides?: object }[] }, Hex];
        const base = (await request({ method: 'eth_getBlockByNumber', params: [blockTag, false] })) as {
          number: Hex;
          timestamp: Hex;
        };
        payload.blockStateCalls = payload.blockStateCalls.map((block, index) => ({
          ...block,
          blockOverrides: {
            number: toHex(BigInt(base.number) + BigInt(index + 1)),
            time: toHex(BigInt(base.timestamp) + SLOT_SECONDS * BigInt(index + 1)),
            ...block.blockOverrides,
          },
        }));
      }
      return request({ method, params });
    },
  });
}

describe('L1OperationSubmitter against anvil', () => {
  let rpcUrl: string;
  let stopAnvil: (() => Promise<void>) | undefined;
  let chain: ReturnType<typeof testClientFor>;
  let token: Address;
  let executor: Address;
  let operation: Address;
  let dir: string | undefined;
  let store: SqliteStateStore | undefined;

  function testClientFor(url: string) {
    return createTestClient({ chain: foundry, mode: 'anvil', transport: http(url) }).extend(publicActions);
  }

  function walletFor(account: PrivateKeyAccount) {
    return createWalletClient({ chain: foundry, account, transport: http(rpcUrl) }).extend(publicActions);
  }

  async function deploy(abi: Abi, bytecode: Hex, args: readonly unknown[]): Promise<Address> {
    const deployer = walletFor(DEPLOYER);
    const hash = await deployer.deployContract({ abi, bytecode, args } as Parameters<
      typeof deployer.deployContract
    >[0]);
    const { contractAddress } = await deployer.waitForTransactionReceipt({ hash });
    return contractAddress!;
  }

  /** Sends each transaction from the relayer and returns once it is mined, like a queue whose relay mines at once. */
  function sendFromRelayer(): SendL1Tx {
    const relayer = walletFor(RELAYER);
    return async request => {
      const txHash = await relayer.sendTransaction({ ...request, account: RELAYER, chain: foundry });
      const receipt = await relayer.waitForTransactionReceipt({ hash: txHash });
      const { nonce } = await relayer.getTransaction({ hash: txHash });
      return { txHash, nonce, settled: Promise.resolve(receipt) };
    };
  }

  function buildSubmitter(client: PublicClient, pendingStore: StateStore): L1OperationSubmitter {
    const send = sendFromRelayer();
    return new L1OperationSubmitter({
      executor: EthAddress.fromString(executor),
      executorVersion: 'gas-to-cover',
      client,
      l1TxQueue: { address: RELAYER.address, enqueue: submit => submit(send), maxFeePerGasCap: undefined },
      store: pendingStore,
      forbiddenOperationIds: new Set(),
      priceOracle: FIXED_PRICE_ORACLE,
      screener: new L1OperationScreener({ isListed: () => false }),
      config: { retryBackoffMs: 0, maxPendingAgeMs: MAX_PENDING_AGE_MS },
      withdrawalCompletion: NO_WITHDRAWALS,
      ownership: { owns: () => true, givesWayTo: () => Promise.resolve(undefined) },
      allowUnprofitable: false,
    });
  }

  function balanceOf(account: Address): Promise<bigint> {
    return chain.readContract({ address: token, abi: TestERC20Abi, functionName: 'balanceOf', args: [account] });
  }

  beforeAll(async () => {
    ({ rpcUrl, stop: stopAnvil } = await startAnvil({ port: 0 }));
    chain = testClientFor(rpcUrl);
    token = await deploy(TestERC20Abi, TestERC20Bytecode, ['Oxide Test USD', 'oUSD', DEPLOYER.address]);
    executor = await deploy(OperationExecutorAbi, OperationExecutorBytecode, []);
    operation = await deploy(MockOncePerBlockOperationAbi, MockOncePerBlockOperationBytecode, [
      token,
      REWARD,
      FIRST_IN_BLOCK_REWARD,
      WORK_ROUNDS,
    ]);
    const deployer = walletFor(DEPLOYER);
    await deployer.waitForTransactionReceipt({
      hash: await deployer.writeContract({
        address: token,
        abi: TestERC20Abi,
        functionName: 'mint',
        args: [operation, REWARD + FIRST_IN_BLOCK_REWARD],
      }),
    });

    dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-l1-op-anvil-'));
    store = await openSqliteStateStore(path.join(dir, 'state.sqlite3'), TEST_RELAYER_DEPLOYMENT);
    const pending: PendingL1Operation = {
      operationId: OPERATION_ID,
      broadcaster: AztecAddress.fromBigIntUnsafe(7n),
      l2TxHash: '0xl2tx',
      l2BlockNumber: 5n,
      target: EthAddress.fromString(operation),
      payoutToken: EthAddress.fromString(token),
      calldata: Buffer.from(
        encodeFunctionData({ abi: MockOncePerBlockOperationAbi, functionName: 'run' }).slice(2),
        'hex',
      ),
      condition: L1OperationCondition.immediate(),
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    };
    await store.upsertPendingL1Operation(pending);
  }, 30_000);

  afterAll(async () => {
    await store?.close();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
    await stopAnvil?.();
  });

  it('sends an operation whose first call in a block pays more, after the latest block made that call', async () => {
    const otherUser = walletFor(OTHER_USER);
    await otherUser.waitForTransactionReceipt({
      hash: await otherUser.writeContract({
        address: operation,
        abi: MockOncePerBlockOperationAbi,
        functionName: 'poke',
      }),
    });
    const latest = await chain.getBlock({ blockTag: 'latest' });
    await chain.setNextBlockTimestamp({ timestamp: latest.timestamp + SLOT_SECONDS });
    const client = createPublicClient({ chain: foundry, transport: nextBlockSimulation(rpcUrl) });

    const summary = await buildSubmitter(client, store!).runOnce();

    expect(summary).toMatchObject({ submitted: 1, confirmed: 1, deferred: 0 });
    // The relayer's transaction is the first call in its block, so it does the work and gets the larger payout.
    await expect(balanceOf(RELAYER.address)).resolves.toBe(REWARD + FIRST_IN_BLOCK_REWARD);
  }, 30_000);
});
