import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';

import { ErrorsAbi, IFPCFunderAbi, OperationExecutorAbi } from '@oxide/l1-contracts';
import {
  LEGACY_OPERATION_EXECUTOR_ABI,
  type OperationExecutorVersion,
  SIMULATED_SENDER_BALANCE,
  UINT256_EXTRA_CALLDATA_GAS,
  encodeOperationExecute,
  gasCostInToken,
} from '@oxide/oxide-client/l1_operation_quote.js';

import { type Hex, type PublicClient, encodeFunctionData, keccak256 } from 'viem';

import { CauseTransitions } from '../cause_transitions.js';
import { type L1TxQueue, type SendL1Tx, type SentL1Tx, isAboveMaxFeePerGas } from '../l1/l1_tx_queue.js';
import { type ExtensiblePriceOracle, readTokenUnitsPerEth } from '../price_oracle/price_oracle.js';

export const DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS = 60_000;

export interface FpcFunderCallerConfig {
  fpcFunder: EthAddress;
  /** OperationExecutor the call is wrapped in, so a raced call reverts on its payout floor. */
  executor: EthAddress;
  /** The `execute` version of `executor`. */
  executorVersion: OperationExecutorVersion;
  client: PublicClient;
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address' | 'maxFeePerGasCap'>;
  priceOracle: ExtensiblePriceOracle;
  /** Call whenever the quote is nonzero, skipping the break-even check. */
  allowUnprofitable: boolean;
  pollIntervalMs?: number;
  logger?: Logger;
}

/**
 * Polls the FPCFunder's bounty quote and calls `swapAndDepositAsFeeJuice()` when the bounty covers the gas cost.
 * The call goes through the OperationExecutor with the break-even floor as `minPayout`.
 */
export class FpcFunderCaller {
  private readonly runningPromise: RunningPromise;
  private inputToken?: EthAddress;
  /** The cause the funder was last deferred with, so an idle funder logs once for each state it enters. */
  private readonly deferrals = new CauseTransitions();
  private retryNextBatch = false;

  private constructor(
    private readonly config: FpcFunderCallerConfig,
    private readonly log: Logger,
    pollIntervalMs: number,
  ) {
    this.runningPromise = new RunningPromise(() => this.runOnce(), this.log, pollIntervalMs);
  }

  static create(config: FpcFunderCallerConfig): FpcFunderCaller {
    const log = config.logger ?? createLogger('oxide-relayer:fpc-funder-caller');
    return new FpcFunderCaller(config, log, config.pollIntervalMs ?? DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS);
  }

  public start(): void {
    if (!this.runningPromise.isRunning()) {
      this.log.info(`Starting FPC funder caller (funder ${this.config.fpcFunder})`);
      this.runningPromise.start();
    }
  }

  public async stop(): Promise<void> {
    await this.runningPromise.stop();
  }

  /** One poll cycle: quote, gate, and submit. Public so tests can drive it without the loop. */
  public async runOnce(): Promise<void> {
    const retry = this.retryNextBatch;
    this.retryNextBatch = false;
    const sent = await this.config.l1TxQueue.enqueue(send => this.prepareAndSubmit(send), { retry });
    if (!sent) {
      return;
    }
    try {
      await sent.settled;
    } catch (error) {
      this.retryNextBatch = true;
      throw error;
    }
  }

  private async prepareAndSubmit(send: SendL1Tx): Promise<SentL1Tx | undefined> {
    const { client, l1TxQueue } = this.config;
    const to = this.config.executor.toString();
    const inputToken = await this.getInputToken();

    let bounty: bigint;
    try {
      bounty = await this.quotePayout(inputToken);
    } catch (err) {
      // Below the fundable minimum the call reverts. That is the funder's idle state, not a fault, so it logs once
      // for each balance it holds. Any other revert is unexpected and keeps its level on every occurrence.
      const belowMinimum = balanceBelowMinimum(err);
      if (!belowMinimum) {
        // Record the state even though the line is unconditional, so a return to the same balance logs again.
        this.deferrals.changed(this.deferralKey(), 'simulation_reverted');
        this.log.info('FPC funding simulation reverted; deferring', {
          event: 'fpc_funding_deferred',
          cause: 'simulation_reverted',
          error: errMessage(err),
        });
        return;
      }
      const { balance, minimum } = belowMinimum;
      const changed = this.deferrals.changed(this.deferralKey(), `balance_below_minimum:${balance}:${minimum}`);
      const write = changed ? this.log.info : this.log.debug;
      write.call(this.log, 'FPC funder balance is below the fundable minimum; deferring', {
        event: 'fpc_funding_deferred',
        cause: 'balance_below_minimum',
        balance: balance.toString(),
        minimum: minimum.toString(),
      });
      return;
    }

    // Estimate against a zero floor: the execution path is identical, and estimation cannot be raced into
    // a revert by a bounty change between the quote and here.
    const account = l1TxQueue.address;
    const estimatedGas = await client.estimateGas({
      account,
      to,
      data: this.executeCalldata(inputToken, 0n),
      blockTag: 'latest',
      // A random key, used when submission is disabled, holds no ETH.
      stateOverride: [{ address: account, balance: SIMULATED_SENDER_BALANCE }],
    });
    // Non-zero `minPayout` costs extra calldata gas, so add it here.
    const gasLimit = estimatedGas + UINT256_EXTRA_CALLDATA_GAS;
    const price = await client.estimateFeesPerGas();
    if (isAboveMaxFeePerGas(l1TxQueue, price.maxFeePerGas)) {
      const changed = this.deferrals.changed(this.deferralKey(), 'gas_price_above_max');
      const write = changed ? this.log.info : this.log.debug;
      write.call(this.log, 'FPC funding deferred by the max fee per gas', {
        event: 'fpc_funding_deferred',
        cause: 'gas_price_above_max',
        maxFeePerGas: price.maxFeePerGas.toString(),
        maxFeePerGasCap: l1TxQueue.maxFeePerGasCap?.toString(),
      });
      return;
    }

    let floor = 0n;
    if (!this.config.allowUnprofitable) {
      // Break-even for the exact tx being sent, in payout-token units. The bounty ramp is the margin: an
      // unprofitable call becomes profitable by waiting.
      const tokenUnitsPerEth = await readTokenUnitsPerEth(this.config.priceOracle, inputToken);
      floor = gasCostInToken(gasLimit, price.maxFeePerGas, tokenUnitsPerEth);
    }
    if (bounty < floor) {
      // The bounty ramps every block, so the amounts change while the state does not. Only the state opens the gate.
      const changed = this.deferrals.changed(this.deferralKey(), 'unprofitable');
      const write = changed ? this.log.info : this.log.debug;
      write.call(this.log, 'FPC funding deferred by bounty floor', {
        event: 'fpc_funding_deferred',
        cause: 'unprofitable',
        bounty: bounty.toString(),
        floor: floor.toString(),
      });
      return;
    }

    const data = this.executeCalldata(inputToken, floor);
    const sent = await send(
      { to, data, gas: gasLimit, ...price },
      { kind: 'fpc-funding', id: `${this.config.fpcFunder.toString().toLowerCase()}/${keccak256(data)}` },
    );
    const { txHash, nonce } = sent;
    this.deferrals.forget(this.deferralKey());
    this.log.info('Submitted FPC funding call', {
      event: 'fpc_funding_submitted',
      txHash,
      nonce,
      bounty: bounty.toString(),
      minPayout: floor.toString(),
      gasLimit: gasLimit.toString(),
    });
    return sent;
  }

  private deferralKey(): string {
    return this.config.fpcFunder.toString().toLowerCase();
  }

  /** `executor.execute(funder, swapAndDepositAsFeeJuice, inputToken, minPayout)` calldata: no gas cost. */
  private executeCalldata(inputToken: EthAddress, minPayout: bigint): Hex {
    return encodeOperationExecute(this.config.executorVersion, this.operation(inputToken), minPayout);
  }

  private operation(inputToken: EthAddress) {
    return {
      target: this.config.fpcFunder.toString(),
      calldata: encodeFunctionData({ abi: IFPCFunderAbi, functionName: 'swapAndDepositAsFeeJuice' }),
      payoutToken: inputToken.toString(),
    };
  }

  private async quotePayout(inputToken: EthAddress): Promise<bigint> {
    const sender = this.config.l1TxQueue.address;
    const { target, calldata, payoutToken } = this.operation(inputToken);
    const call = {
      address: this.config.executor.toString(),
      account: sender,
      // A random key, used when submission is disabled, holds no ETH.
      stateOverride: [{ address: sender, balance: SIMULATED_SENDER_BALANCE }],
    };
    if (this.config.executorVersion === 'legacy') {
      const { result } = await this.config.client.simulateContract({
        ...call,
        abi: [...LEGACY_OPERATION_EXECUTOR_ABI, ...ErrorsAbi],
        functionName: 'execute',
        args: [target, calldata, payoutToken, 0n],
      });
      return result;
    }
    const { result } = await this.config.client.simulateContract({
      ...call,
      abi: [...OperationExecutorAbi, ...ErrorsAbi],
      functionName: 'execute',
      args: [target, calldata, payoutToken, 0n, 0n, 0n],
    });
    return result;
  }

  private async getInputToken(): Promise<EthAddress> {
    if (!this.inputToken) {
      const raw = await this.config.client.readContract({
        address: this.config.fpcFunder.toString(),
        abi: IFPCFunderAbi,
        functionName: 'inputToken',
      });
      const inputToken = EthAddress.fromString(raw);
      await this.config.priceOracle.addToken(inputToken);
      this.inputToken = inputToken;
    }
    return this.inputToken;
  }
}

/**
 * The funder's balance and its fundable minimum, when the revert is `FPCFunder__BalanceBelowMinimum`. Viem exposes
 * the decoded custom error in the cause chain, and `ErrorsAbi` is already part of the simulation.
 */
function balanceBelowMinimum(error: unknown): { balance: bigint; minimum: bigint } | undefined {
  for (let current: any = error; current && typeof current === 'object'; current = current.cause) {
    if (current.data?.errorName !== 'FPCFunder__BalanceBelowMinimum') {
      continue;
    }
    const [balance, minimum] = (current.data.args ?? []) as [bigint?, bigint?];
    if (typeof balance === 'bigint' && typeof minimum === 'bigint') {
      return { balance, minimum };
    }
  }
  return undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
