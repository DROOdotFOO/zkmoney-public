import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';

import type { OperationExecutorVersion } from '@oxide/oxide-client/l1_operation_quote.js';
import type { SanctionsList } from '@oxide/watcher-lib/sanctions';

import type { PublicClient } from 'viem';

import type { L1OperationsSubmissionConfig } from '../cli/config.js';
import type { PriceOracle } from '../price_oracle/price_oracle.js';
import type { RelayerTelemetry } from '../relayer_telemetry.js';
import type { StateStore } from '../state/types.js';
import { BalanceWatcher, OutboxWatcher } from './l1_operation_condition.js';
import type { L1OperationOwnership } from './l1_operation_router.js';
import { L1OperationScreener } from './l1_operation_screener.js';
import { L1OperationSyncer } from './l1_operation_syncer.js';
import type { PayoutTokenFilter } from './payout_token_registry.js';
import { PredicateScreener, type PredicateScreenerConfig } from './predicate_screener.js';
import { L1OperationSubmitter, type L1OperationSubmitterDeps } from './submitter.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

export const DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS = 10_000;

/** Blocks per `eth_getLogs` call of the balance watcher's transfer scan. */
export const DEFAULT_LOG_SCAN_WINDOW = 1_000n;

export interface L1OperationRelayerConfig {
  node: AztecNode;
  publicClient: PublicClient;
  store: StateStore;
  broadcaster: AztecAddress;
  ownership: L1OperationOwnership;
  payoutTokens: PayoutTokenFilter;
  watchedTokens: EthAddress[];
  logScanWindow?: bigint;
  l1OperationsSubmission: L1OperationsSubmissionConfig;
  allowUnprofitable?: boolean;
  /** OperationExecutor that operations submit through; the env registry's published executor for the version. */
  executor: EthAddress;
  /** The `execute` version of `executor`. */
  executorVersion: OperationExecutorVersion;
  l1TxQueue: L1OperationSubmitterDeps['l1TxQueue'];
  /** Exact-operation identities permanently excluded before evaluation or TEE completion. */
  forbiddenOperationIds: ReadonlySet<string>;
  /** The list every address an operation touches is screened against before it is executed. */
  sanctionsList: SanctionsList;
  /** When set, addresses the Predicate policy declines also block the operation. */
  predicate?: PredicateScreenerConfig;
  withdrawalCompletion: WithdrawalCompletion;
  priceOracle: PriceOracle;
  telemetry?: RelayerTelemetry;
  pollIntervalMs?: number;
  logger?: Logger;
}

/**
 * Syncs broadcast L1 operations from L2 public logs and executes the profitable ones through the OperationExecutor.
 */
export class L1OperationRelayer {
  private readonly runningPromise: RunningPromise;

  private constructor(
    private readonly syncer: L1OperationSyncer,
    private readonly submitter: L1OperationSubmitter,
    private readonly telemetry: RelayerTelemetry | undefined,
    private readonly log: Logger,
    pollIntervalMs: number,
  ) {
    this.runningPromise = new RunningPromise(() => this.runOnce(), this.log, pollIntervalMs);
    this.telemetry?.watcherStarted('l1_operation_broadcaster');
    this.telemetry?.watcherStarted('l1_operation_transfer_discovery');
  }

  static create(config: L1OperationRelayerConfig): L1OperationRelayer {
    const log = config.logger ?? createLogger('oxide-relayer:l1-operation-relayer');

    const syncer = new L1OperationSyncer({
      node: config.node,
      store: config.store,
      broadcaster: config.broadcaster,
      ownership: config.ownership,
      payoutTokens: config.payoutTokens,
      watchedTokens: config.watchedTokens,
      balanceWatcher: new BalanceWatcher({
        publicClient: config.publicClient,
        store: config.store,
        tokens: config.watchedTokens,
        logWindow: config.logScanWindow ?? DEFAULT_LOG_SCAN_WINDOW,
        maxAgeMs: config.l1OperationsSubmission.maxPendingAgeMs,
        telemetry: config.telemetry,
        logger: log.createChild('l1-operation-balance-watcher'),
      }),
      outboxWatcher: new OutboxWatcher({
        completion: config.withdrawalCompletion,
        store: config.store,
        telemetry: config.telemetry,
        logger: log.createChild('l1-operation-outbox-watcher'),
      }),
      telemetry: config.telemetry,
      logger: log.createChild('l1-operation-syncer'),
    });

    const submitter = new L1OperationSubmitter({
      executor: config.executor,
      executorVersion: config.executorVersion,
      client: config.publicClient,
      l1TxQueue: config.l1TxQueue,
      store: config.store,
      forbiddenOperationIds: config.forbiddenOperationIds,
      priceOracle: config.priceOracle,
      screener: new L1OperationScreener(
        config.sanctionsList,
        config.predicate ? new PredicateScreener(config.predicate) : undefined,
      ),
      config: config.l1OperationsSubmission,
      withdrawalCompletion: config.withdrawalCompletion,
      ownership: config.ownership,
      allowUnprofitable: config.allowUnprofitable,
      telemetry: config.telemetry,
      logger: log.createChild('l1-operation-submitter'),
    });

    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS;
    return new L1OperationRelayer(syncer, submitter, config.telemetry, log, pollIntervalMs);
  }

  public start(): void {
    if (!this.runningPromise.isRunning()) {
      this.log.info(`Starting L1 operation relayer`);
      this.runningPromise.start();
    }
  }

  public async stop(): Promise<void> {
    if (this.runningPromise.isRunning()) {
      this.log.verbose(`Stopping L1 operation relayer`);
      await this.runningPromise.stop();
    }
    await this.submitter.stop();
    this.log.info(`Stopped L1 operation relayer`);
  }

  public isRunning(): boolean {
    return this.runningPromise.isRunning();
  }

  /** Run one full poll cycle. Exposed for deterministic e2e tests and operator smoke checks. */
  public async runOnce(): Promise<void> {
    const { discovered, markedPending } = await this.syncer.runOnce();
    this.telemetry?.watcherPolled('l1_operation_broadcaster');
    this.telemetry?.watcherPolled('l1_operation_transfer_discovery');
    const summary = await this.submitter.runOnce();
    const activity =
      discovered > 0 ||
      markedPending > 0 ||
      summary.submitted > 0 ||
      summary.confirmed > 0 ||
      summary.deferredChanged > 0 ||
      summary.dropped > 0 ||
      summary.blocked > 0;
    if (activity) {
      this.log.info('L1 operation poll cycle finished', {
        event: 'l1_operation_poll_cycle',
        discovered,
        markedPending,
        submitted: summary.submitted,
        confirmed: summary.confirmed,
        deferred: summary.deferred,
        dropped: summary.dropped,
        blocked: summary.blocked,
      });
    }
  }
}
