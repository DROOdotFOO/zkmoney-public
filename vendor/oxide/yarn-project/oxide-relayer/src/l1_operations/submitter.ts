import type { EthAddress } from '@aztec-labs/aztec.js/addresses';
import { maxBigint } from '@aztec-labs/foundation/bigint';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';

import { classifyL1Operation } from '@oxide/l1-contracts';
import {
  type ExecuteGasCostArgs,
  GAS_COST_ARGS_CALLDATA_GAS,
  type L1OperationQuoteBlock,
  NO_EXECUTE_GAS_COST,
  type OperationExecutorVersion,
  type SimulateL1OperationArgs,
  encodeOperationExecute,
  estimateL1OperationFeeValues,
  l1OperationGasLimit,
  minGasToCover,
  nextL1OperationGasLimit,
  relayerGasCost,
  simulateL1Operation,
} from '@oxide/oxide-client/l1_operation_quote.js';
import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { type FeeValuesEIP1559, type Hex, type PublicClient, type TransactionReceipt, erc20Abi } from 'viem';

import { CauseTransitions } from '../cause_transitions.js';
import type { L1OperationsSubmissionConfig } from '../cli/config.js';
import { type L1TxQueue, type SendL1Tx, type SentL1Tx, isAboveMaxFeePerGas } from '../l1/l1_tx_queue.js';
import { type PriceOracle, readTokenUnitsPerEth } from '../price_oracle/price_oracle.js';
import type { RelayerDeferReason, RelayerTelemetry } from '../relayer_telemetry.js';
import type { PendingL1Operation, PendingL1OperationReason, StateStore } from '../state/types.js';
import type { L1OperationOwnership } from './l1_operation_router.js';
import type { L1OperationScreener } from './l1_operation_screener.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

/** The revert backoff doubles from `retryBackoffMs` on each revert, up to this value. */
const MAX_REVERT_BACKOFF_MS = 15 * 60_000;

export interface L1OperationSubmitterDeps {
  /** OperationExecutor deployment the relayer executes through. */
  executor: EthAddress;
  /** The `execute` version of `executor`. A deployment keeps the executor that it was deployed with. */
  executorVersion: OperationExecutorVersion;
  client: PublicClient;
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address' | 'maxFeePerGasCap'>;
  store: StateStore;
  priceOracle: PriceOracle;
  screener: L1OperationScreener;
  config: L1OperationsSubmissionConfig;
  withdrawalCompletion: WithdrawalCompletion;
  ownership: L1OperationOwnership;
  allowUnprofitable?: boolean;
  telemetry?: RelayerTelemetry;
  logger?: Logger;
  /** Injectable clock for deterministic backoff in tests. */
  dateProvider?: DateProvider;
}

/** The transaction that executes an L1 operation through the executor. */
interface L1OperationTx {
  data: Hex;
  /** The payout of the operation in the simulation. */
  payout: bigint;
  gasLimit: bigint;
  feeValues: FeeValuesEIP1559;
}

/** What `#processOperation` does with an operation. `#evaluate` decides it. */
type Evaluation =
  | ({ kind: 'send' } & L1OperationTx)
  | { kind: 'blocked'; listed: EthAddress[] }
  | { kind: 'reverted'; error: unknown }
  | { kind: 'above_max_fee_per_gas'; maxFeePerGas: bigint }
  | { kind: 'unprofitable'; payout: bigint; gasCost: bigint }
  /** A read failed. The operation keeps `reason` as its last reason. */
  | { kind: 'failed'; reason?: 'screening_error' | 'completion_error'; error: unknown };

/** Per-poll outcome counts, mostly for tests and logging. */
export interface L1OperationRunSummary {
  confirmed: number;
  submitted: number;
  dropped: number;
  deferred: number;
  /** Deferrals whose cause differs from the one the operation was last deferred with. The cycle summary reads this. */
  deferredChanged: number;
  blocked: number;
}

/**
 * Polls due L1 operations, simulates each through the executor, and submits the profitable ones. It prices gas in the
 * payout token of each operation. The syncer stores only operations that pay out in an accepted payout token, and the
 * price oracle prices each accepted payout token.
 */
export class L1OperationSubmitter {
  private readonly log: Logger;
  private readonly dateProvider: DateProvider;
  private readonly backgroundSummary: L1OperationRunSummary = {
    confirmed: 0,
    submitted: 0,
    dropped: 0,
    deferred: 0,
    deferredChanged: 0,
    blocked: 0,
  };
  /** The cause each operation was last deferred with, so a held cause logs once. */
  private readonly deferrals = new CauseTransitions();
  /** The operations whose sent tx has no outcome yet. A batch skips them. */
  private readonly inFlight = new Set<Hex>();
  /** Settlement monitors that must finish before a clean generic-runtime handoff. */
  private readonly settlementMonitors = new Set<Promise<void>>();

  private retryNextBatch = false;

  constructor(private readonly deps: L1OperationSubmitterDeps) {
    this.log = deps.logger ?? createLogger('oxide-relayer:l1-operation-submitter');
    this.dateProvider = deps.dateProvider ?? new DateProvider();
  }

  async runOnce(): Promise<L1OperationRunSummary> {
    const retry = this.retryNextBatch;
    this.retryNextBatch = false;
    return await this.deps.l1TxQueue.enqueue(send => this.#runBatch(send), { retry });
  }

  /** A clean shutdown waits until every signed submission has a terminal chain outcome. */
  async stop(): Promise<void> {
    await Promise.all(this.settlementMonitors);
  }

  async #runBatch(send: SendL1Tx): Promise<L1OperationRunSummary> {
    const summary = this.#drainBackgroundSummary();
    // A batch can start before the monitor of an earlier batch's tx records its outcome.
    const due = (await this.deps.store.listPendingL1Operations({ dueAt: this.#now() })).filter(
      operation => !this.inFlight.has(operation.operationId),
    );
    if (due.length === 0) {
      return summary;
    }

    this.log.debug('Processing due L1 operations', { event: 'l1_operation_poll', dueCount: due.length });
    for (const operation of due) {
      await this.#processOperation(send, operation, summary);
    }
    return summary;
  }

  /** Evaluates the operation, then applies the result. Each result ends the processing of the operation. */
  async #processOperation(
    send: SendL1Tx,
    operation: PendingL1Operation,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    const owner = await this.deps.ownership.givesWayTo(operation).catch(() => undefined);
    if (owner !== undefined) {
      await this.#giveWay(operation, owner);
      return;
    }
    const evaluation = await this.#evaluate(operation).catch((error): Evaluation => ({ kind: 'failed', error }));
    switch (evaluation.kind) {
      case 'send':
        await this.#broadcast(send, operation, evaluation, summary);
        break;
      case 'blocked':
        await this.#block(operation, evaluation.listed, summary);
        break;
      case 'reverted':
        await this.#handleSimulationFailure(operation, evaluation.error, summary);
        break;
      case 'above_max_fee_per_gas':
        await this.#deferAboveMaxFeePerGas(operation, evaluation.maxFeePerGas, summary);
        break;
      case 'unprofitable':
        await this.#deferUnprofitable(operation, evaluation.payout, evaluation.gasCost, summary);
        break;
      case 'failed':
        await this.#deferFailure(operation, evaluation.reason, evaluation.error, summary);
        break;
    }
  }

  /**
   * Decides what to do with the operation now. It reads L1 and the screening lists and changes no state. The checks
   * run in sequence, and the first check that does not pass decides the result. A completion or screening read that
   * fails returns `failed` with its reason. Another read that fails throws.
   */
  async #evaluate(operation: PendingL1Operation): Promise<Evaluation> {
    let calldata: Hex;
    try {
      calldata = await this.#resolveCalldata(operation);
    } catch (error) {
      return { kind: 'failed', reason: 'completion_error', error };
    }

    // One block prices the whole quote: the fee values and the three simulations.
    const quoteBlock = await this.deps.client.getBlock({ blockTag: 'latest' });
    const feeValues = await estimateL1OperationFeeValues(this.deps.client, quoteBlock);
    // The relayer does not send above the cap, so it does not simulate either. A revert at this fee must not charge
    // an attempt.
    if (isAboveMaxFeePerGas(this.deps.l1TxQueue, feeValues.maxFeePerGas)) {
      return { kind: 'above_max_fee_per_gas', maxFeePerGas: feeValues.maxFeePerGas };
    }

    const quote: SimulateL1OperationArgs = {
      executor: this.deps.executor.toString(),
      executorVersion: this.deps.executorVersion,
      sender: this.deps.l1TxQueue.address,
      operation: {
        target: operation.target.toString(),
        calldata,
        payoutToken: operation.payoutToken.toString(),
      },
      feeValues,
      quoteBlock,
    };
    const simulation = await simulateL1Operation(this.deps.client, quote);
    if (simulation.status === 'failure') {
      return { kind: 'reverted', error: simulation.error };
    }
    const { result: payout, logs = [] } = simulation;

    let listed: EthAddress[];
    try {
      listed = await this.deps.screener.screen(operation, logs);
    } catch (error) {
      return { kind: 'failed', reason: 'screening_error', error };
    }
    if (listed.length > 0) {
      return { kind: 'blocked', listed };
    }

    const { gasLimit, minPayout, gasCostArgs, quotedGasCost } = await this.#price(
      quote,
      operation.payoutToken,
      payout,
      quoteBlock,
    );
    if (payout < quotedGasCost) {
      return { kind: 'unprofitable', payout, gasCost: quotedGasCost };
    }

    const data = encodeOperationExecute(this.deps.executorVersion, quote.operation, minPayout, gasCostArgs);
    return { kind: 'send', data, payout, gasLimit, feeValues };
  }

  /**
   * Returns the gas limit, the sent `minPayout` and gas cost arguments, and the gas cost that decides whether to send.
   * All simulations run in the block of the payout quote, because a payout can depend on the block, and all require
   * the quoted `payout`, so an inner failure cannot produce a cheaper run. The later ones run at the gas limit.
   *
   * The gas to cover is at least {@link minGasToCover} of the gas limit, because the target can use all of the gas
   * limit in the sent transaction. This matters only when the gas limit is more than its first value.
   *
   * - A `gas-to-cover` executor prices `gasToCover`, the gas used after refunds, at the gas price the tx pays, so the
   *   sent `minPayout` is 0. The relayer decides at the price the tx pays if the base fee holds: the base fee of the
   *   quote block plus the tip.
   * - A `legacy` executor checks only `minPayout`, so the relayer sends the gas at `maxFeePerGas` as `minPayout` and
   *   decides at that cost.
   */
  async #price(
    quote: SimulateL1OperationArgs,
    payoutToken: EthAddress,
    payout: bigint,
    quoteBlock: L1OperationQuoteBlock,
  ): Promise<{ gasLimit: bigint; minPayout: bigint; gasCostArgs: ExecuteGasCostArgs; quotedGasCost: bigint }> {
    const { executorVersion } = this.deps;
    const gasSimulation = await simulateL1Operation(this.deps.client, { ...quote, minPayout: payout });
    if (gasSimulation.status === 'failure') {
      throw new Error(`gas simulation failed: ${errMessage(gasSimulation.error)}`);
    }
    const simulatedGasLimit = await this.#confirmGasLimit(quote, payout, gasSimulation.gasUsed, quoteBlock);
    const gasLimit = simulatedGasLimit + GAS_COST_ARGS_CALLDATA_GAS;
    if (this.deps.allowUnprofitable) {
      return { gasLimit, minPayout: 0n, gasCostArgs: NO_EXECUTE_GAS_COST, quotedGasCost: 0n };
    }
    const gasToCover = maxBigint(gasSimulation.gasToCover, minGasToCover(gasLimit));
    const tokenWeiPerEth = await readTokenUnitsPerEth(this.deps.priceOracle, payoutToken);
    const quotedGasCost = relayerGasCost(executorVersion, gasToCover, quoteBlock, quote.feeValues, tokenWeiPerEth);
    if (executorVersion === 'legacy') {
      return { gasLimit, minPayout: quotedGasCost, gasCostArgs: NO_EXECUTE_GAS_COST, quotedGasCost };
    }
    return { gasLimit, minPayout: 0n, gasCostArgs: { gasToCover, tokenWeiPerEth }, quotedGasCost };
  }

  /**
   * Returns the gas limit at which a simulation of the operation pays the quoted `payout`. It starts at
   * {@link l1OperationGasLimit} of `gasUsed`. While the simulation fails, it tries {@link nextL1OperationGasLimit}.
   * Throws when the simulation fails at the cap.
   */
  async #confirmGasLimit(
    quote: SimulateL1OperationArgs,
    payout: bigint,
    gasUsed: bigint,
    quoteBlock: L1OperationQuoteBlock,
  ): Promise<bigint> {
    let gasLimit = l1OperationGasLimit(gasUsed, quoteBlock);
    for (;;) {
      const simulation = await simulateL1Operation(this.deps.client, { ...quote, minPayout: payout, gas: gasLimit });
      if (simulation.status === 'success') {
        return gasLimit;
      }
      const next = nextL1OperationGasLimit(gasLimit, quoteBlock);
      if (next === undefined) {
        throw new Error(`gas limit simulation failed at ${gasLimit} gas: ${errMessage(simulation.error)}`);
      }
      gasLimit = next;
    }
  }

  /**
   * An error, not a revert: no attempt is charged. A screening or completion error keeps its reason on the operation;
   * the screening reason drives an alarm.
   */
  async #deferFailure(
    operation: PendingL1Operation,
    reason: PendingL1OperationReason | undefined,
    error: unknown,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    const cause = reason ?? 'evaluation_error';
    this.log.warn('L1 operation evaluation failed; deferring', {
      event: 'l1_operation_deferred',
      cause,
      error: errMessage(error),
      ...operationLogFields(operation),
    });
    await this.#defer(operation, reason, summary, { cause });
  }

  async #deferAboveMaxFeePerGas(
    operation: PendingL1Operation,
    maxFeePerGas: bigint,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    const changed = await this.#defer(operation, undefined, summary, {
      cause: 'gas_price_above_max',
      deferReason: 'gas_price_above_max',
    });
    this.#logDeferral(changed, 'L1 operation deferred by the max fee per gas', {
      event: 'l1_operation_deferred',
      cause: 'gas_price_above_max',
      maxFeePerGas: maxFeePerGas.toString(),
      maxFeePerGasCap: this.deps.l1TxQueue.maxFeePerGasCap?.toString(),
      ...operationLogFields(operation),
    });
  }

  async #deferUnprofitable(
    operation: PendingL1Operation,
    payout: bigint,
    gasCost: bigint,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    const changed = await this.#defer(operation, 'unprofitable', summary, { cause: 'unprofitable' });
    this.#logDeferral(changed, 'L1 operation deferred: payout below gas cost', {
      event: 'l1_operation_deferred',
      cause: 'unprofitable',
      payout: payout.toString(),
      gasCost: gasCost.toString(),
      ...operationLogFields(operation),
    });
  }

  /** Logs at info when the cause is new for the operation, else at debug, so a held cause logs once. */
  #logDeferral(changed: boolean, message: string, fields: Record<string, unknown>): void {
    (changed ? this.log.info : this.log.debug).call(this.log, message, fields);
  }

  /** Settles the operation with the terminal status `blocked`; `listed` is why. */
  async #block(operation: PendingL1Operation, listed: EthAddress[], summary: L1OperationRunSummary): Promise<void> {
    await this.deps.store.setL1OperationStatus(operation.operationId, 'blocked');
    this.deferrals.forget(operation.operationId);
    summary.blocked++;
    this.deps.telemetry?.l1OperationOutcome('blocked', classifyL1Operation(operation));
    this.log.warn('L1 operation blocked by sanctions screening', {
      event: 'l1_operation_blocked',
      listed: listed.map(address => address.toString().toLowerCase()),
      ...operationLogFields(operation),
    });
  }

  async #broadcast(
    send: SendL1Tx,
    operation: PendingL1Operation,
    { data, payout, gasLimit, feeValues }: L1OperationTx,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    let sent: SentL1Tx;
    try {
      sent = await send({ to: this.deps.executor.toString(), data, gas: gasLimit, ...feeValues });
    } catch (err) {
      this.log.warn('L1 operation broadcast failed; deferring', {
        event: 'l1_operation_deferred',
        cause: 'broadcast_failed',
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      await this.#defer(operation, undefined, summary, {
        cause: 'broadcast_failed',
        deferReason: 'broadcast_failed',
      });
      return;
    }
    const { txHash, nonce, settled } = sent;
    this.log.info('Submitted L1 operation', {
      event: 'l1_operation_submitted',
      txHash,
      nonce,
      payout: payout.toString(),
      gasLimit: gasLimit.toString(),
      ...(sent.simulated ? { simulated: true } : {}),
      ...operationLogFields(operation),
    });
    summary.submitted++;
    // A simulated tx was not sent, so no outcome or gas metric counts it.
    if (!sent.simulated) {
      this.deps.telemetry?.l1OperationOutcome('submitted', classifyL1Operation(operation));
    }

    const pendingMarker = Symbol('pending');
    let pending = false;
    try {
      pending = (await Promise.race([settled, Promise.resolve(pendingMarker)])) === pendingMarker;
    } catch {
      // An already rejected monitor is terminal and must be processed before this run returns.
    }
    this.inFlight.add(operation.operationId);
    let monitor: Promise<void>;
    monitor = this.#monitorBroadcast(sent, operation, pending ? this.backgroundSummary : summary).finally(() => {
      this.inFlight.delete(operation.operationId);
      this.settlementMonitors.delete(monitor);
    });
    this.settlementMonitors.add(monitor);
    if (!pending) {
      await monitor;
    }
  }

  async #monitorBroadcast(
    sent: SentL1Tx,
    operation: PendingL1Operation,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    const { txHash, nonce, settled } = sent;
    let receipt: TransactionReceipt;
    try {
      receipt = await settled;
    } catch (err) {
      // A dropped tx (private mempools drop reverting txs silently) or a monitor error: defer without charging
      // an attempt. If someone else executed the operation, the next simulation reverts
      this.log.warn('L1 operation tx finished without success; will re-evaluate', {
        event: 'l1_operation_tx_failed',
        txHash,
        nonce,
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      // No receipt, so there is no gas to record here.
      this.deps.telemetry?.l1OperationOutcome('failed', classifyL1Operation(operation));
      this.retryNextBatch = true;
      await this.#defer(operation, undefined, summary, { cause: 'tx_unsuccessful', countDeferred: false });
      return;
    }
    if (receipt.status !== 'success') {
      // A revert-protected relay drops a reverting tx; a public mempool (Sepolia, dev) mines it and charges the gas.
      this.log.warn('L1 operation tx reverted; will re-evaluate', {
        event: 'l1_operation_tx_failed',
        txHash,
        nonce,
        receiptStatus: receipt.status,
        ...operationLogFields(operation),
      });
      this.deps.telemetry?.gasSpentWei('l1_operation', receipt.gasUsed * receipt.effectiveGasPrice);
      this.deps.telemetry?.l1OperationOutcome('failed', classifyL1Operation(operation));
      await this.#defer(operation, undefined, summary, { cause: 'tx_reverted', countDeferred: false });
      return;
    }

    await this.deps.store.setL1OperationStatus(operation.operationId, 'executed');
    this.deferrals.forget(operation.operationId);
    summary.confirmed++;
    if (!sent.simulated) {
      this.deps.telemetry?.l1OperationOutcome('confirmed', classifyL1Operation(operation));
      this.deps.telemetry?.gasSpentWei('l1_operation', receipt.gasUsed * receipt.effectiveGasPrice);
    }
    this.log.info('L1 operation executed on L1', {
      event: 'l1_operation_executed',
      txHash,
      nonce,
      ...(sent.simulated ? { simulated: true } : {}),
      ...operationLogFields(operation),
    });
  }

  #drainBackgroundSummary(): L1OperationRunSummary {
    const summary = { ...this.backgroundSummary };
    this.backgroundSummary.confirmed = 0;
    this.backgroundSummary.submitted = 0;
    this.backgroundSummary.dropped = 0;
    this.backgroundSummary.deferred = 0;
    this.backgroundSummary.deferredChanged = 0;
    this.backgroundSummary.blocked = 0;
    return summary;
  }

  /**
   * A reverting simulation can succeed later, for example once the portal refills its global deposit limit. It can
   * also mean that someone else executed the operation, or that it was never valid. A `Balance` operation whose
   * recipient no longer holds the token is dropped, because the funds it waited for are gone. Otherwise the backoff
   * doubles on each revert up to `MAX_REVERT_BACKOFF_MS`, and the max pending age drops the operation.
   */
  async #handleSimulationFailure(
    operation: PendingL1Operation,
    err: unknown,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    if (await this.#isBalanceConditionCleared(operation)) {
      await this.#drop(operation, summary, 'L1 operation dropped because its balance condition no longer holds', {
        cause: 'condition_cleared',
        token: operation.condition.token.toString().toLowerCase(),
        recipient: operation.condition.recipient.toString().toLowerCase(),
        error: errMessage(err),
      });
      return;
    }
    const attempts = operation.attempts + 1;
    const backoffMs = Math.min(this.deps.config.retryBackoffMs * 2 ** (attempts - 1), MAX_REVERT_BACKOFF_MS);
    this.log.info('L1 operation simulation reverted; deferring', {
      event: 'l1_operation_deferred',
      cause: 'simulation_reverted',
      attempts,
      backoffMs,
      error: errMessage(err),
      ...operationLogFields(operation),
    });
    await this.#defer(operation, 'simulation_reverted', summary, {
      cause: 'simulation_reverted',
      incrementAttempts: true,
      backoffMs,
    });
  }

  async #isBalanceConditionCleared(operation: PendingL1Operation): Promise<boolean> {
    if (operation.condition.kind !== L1OperationConditionKind.Balance) {
      return false;
    }
    try {
      const balance = await this.deps.client.readContract({
        address: operation.condition.token.toString(),
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [operation.condition.recipient.toString()],
      });
      return balance === 0n;
    } catch (err) {
      // A failed read returns false, so the operation keeps its revert backoff.
      this.log.warn('L1 operation balance condition read failed', {
        event: 'l1_operation_condition_read_failed',
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      return false;
    }
  }

  /**
   * A `MessageInOutbox` broadcast carries a finalization request, which the completion turns into
   * `OxidePortal.withdraw` calldata; every other condition broadcasts calldata that is already complete. Rebuilt on
   * every attempt, never persisted.
   */
  async #resolveCalldata(operation: PendingL1Operation): Promise<Hex> {
    if (operation.condition.kind !== L1OperationConditionKind.MessageInOutbox) {
      return `0x${operation.calldata.toString('hex')}`;
    }
    return await this.deps.withdrawalCompletion.resolveCalldata(operation);
  }

  /** Records the deferral and returns whether its cause is new for this operation. */
  async #defer(
    operation: PendingL1Operation,
    reason: PendingL1OperationReason | undefined,
    summary: L1OperationRunSummary,
    opts: {
      cause: string;
      countDeferred?: boolean;
      incrementAttempts?: boolean;
      deferReason?: RelayerDeferReason;
      backoffMs?: number;
    },
  ): Promise<boolean> {
    const now = this.#now();
    if (this.#isStale(operation, now)) {
      await this.#drop(operation, summary, 'L1 operation dropped after exceeding the max pending age', {
        cause: opts.cause,
        attempts: operation.attempts,
        createdAt: operation.createdAt.toISOString(),
      });
      return false;
    }
    const updated = await this.deps.store.updatePendingL1OperationRetry(operation.operationId, {
      lastCheckedAt: now,
      nextCheckAt: new Date(now.getTime() + (opts.backoffMs ?? this.deps.config.retryBackoffMs)),
      lastReason: reason,
      incrementAttempts: opts.incrementAttempts,
    });
    // The operation reached a terminal status while this one ran. Nothing was deferred, so nothing is counted.
    if (!updated) {
      this.deferrals.forget(operation.operationId);
      return false;
    }
    summary.deferred++;
    // A terminal-failure retry (countDeferred: false) is already counted as 'failed'; only count genuine defers.
    if (opts.countDeferred !== false) {
      this.deps.telemetry?.l1OperationOutcome(
        'deferred',
        classifyL1Operation(operation),
        opts.deferReason ?? reason ?? 'other',
      );
    }
    const changed = this.deferrals.changed(operation.operationId, opts.cause);
    if (changed) {
      summary.deferredChanged++;
    }
    return changed;
  }

  /**
   * The age counts from when the operation was recorded, so it includes time spent `waiting` for its condition. Only
   * a deferral checks it: an operation that executes on its first pending check is never dropped for its age.
   */
  #isStale(operation: PendingL1Operation, now: Date): boolean {
    return now.getTime() - operation.createdAt.getTime() >= this.deps.config.maxPendingAgeMs;
  }

  /**
   * Settles this worker's copy of an operation that another worker owns and holds. The owner submits it, so this is
   * not a failure: it records no outcome and is not counted as dropped.
   */
  async #giveWay(operation: PendingL1Operation, owner: string): Promise<void> {
    await this.deps.store.setL1OperationStatus(operation.operationId, 'dropped');
    this.deferrals.forget(operation.operationId);
    this.log.info('L1 operation left to the worker that owns it', {
      event: 'l1_operation_given_way',
      owner,
      ...operationLogFields(operation),
    });
  }

  async #drop(
    operation: PendingL1Operation,
    summary: L1OperationRunSummary,
    message: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.setL1OperationStatus(operation.operationId, 'dropped');
    this.deferrals.forget(operation.operationId);
    summary.dropped++;
    this.deps.telemetry?.l1OperationOutcome('dropped', classifyL1Operation(operation));
    this.log.warn(message, { event: 'l1_operation_dropped', ...fields, ...operationLogFields(operation) });
  }

  #now(): Date {
    return this.dateProvider.nowAsDate();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function operationLogFields(operation: PendingL1Operation): { operationId: string; target: string } {
  return {
    operationId: operation.operationId,
    target: operation.target.toString().toLowerCase(),
  };
}
