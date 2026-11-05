import { AztecAddress } from '@aztec-labs/aztec.js/addresses';

import {
  GAS_COST_ARGS_CALLDATA_GAS,
  encodeOperationExecute,
  estimateL1OperationFeeValues,
  l1OperationGasLimit,
  simulateL1Operation,
  type OperationExecutorVersion,
} from '@oxide/oxide-client/l1_operation_quote.js';

import {
  type Hash,
  type Hex,
  type PublicClient,
  hexToBytes,
  keccak256,
  toHex,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

import type { PendingL1Operation } from '../state/types.js';
import type { WithdrawalCompletion } from '../l1_operations/withdrawal_completion.js';
import type { ExactOperationApproval, ExactOperationObservation } from './contract.js';
import type { ExactOperationObserver } from './observer.js';
import type { ExactOperationExecution, SignedExactOperation } from './runner.js';

export class ExactExecutionLimits {
  private teeRequests = 0;
  private l1Signings = 0;
  private sendCalls = 0;

  async requestTeeSignature<T>(action: () => Promise<T>): Promise<T> {
    if (++this.teeRequests > 1) throw new Error('TEE finalization signature request limit is one');
    return await action();
  }

  async signL1Transaction<T>(action: () => Promise<T>): Promise<T> {
    if (++this.l1Signings > 1) throw new Error('L1 transaction signing limit is one');
    return await action();
  }

  async sendRawTransaction<T>(action: () => Promise<T>): Promise<T> {
    if (++this.sendCalls > 1) throw new Error('eth_sendRawTransaction call limit is one');
    return await action();
  }
}

export class ExactL1Execution implements ExactOperationExecution {
  constructor(
    private readonly observer: ExactOperationObserver,
    private readonly loadCompletion: () => Promise<WithdrawalCompletion>,
    private readonly client: PublicClient,
    private readonly loadAccount: () => Promise<PrivateKeyAccount>,
    private readonly chainId: number,
    private readonly executorVersion: OperationExecutorVersion,
  ) {}
  private readonly limits = new ExactExecutionLimits();

  async observe(approval: ExactOperationApproval): Promise<ExactOperationObservation> {
    return await this.observer.observe(approval);
  }

  async signOnce(approval: ExactOperationApproval): Promise<SignedExactOperation> {
    if (this.executorVersion !== approval.economics.executorVersion) {
      throw new Error('Exact-operation executor version differs from the approved economics');
    }
    const account = await this.loadAccount();
    const source = this.observer.exactOperation();
    const operation: PendingL1Operation = {
      operationId: approval.operation.id as Hex,
      broadcaster: AztecAddress.fromStringUnsafe(approval.deployment.broadcaster),
      l2TxHash: approval.operation.sourceTxHash,
      l2BlockNumber: BigInt(approval.operation.sourceBlockNumber),
      l2BlockHash: approval.operation.sourceBlockHash,
      target: source.target,
      payoutToken: source.payoutToken,
      calldata: source.calldata,
      condition: source.condition,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(0),
    };
    const finalizationCalldata = await this.limits.requestTeeSignature(async () =>
      (await this.loadCompletion()).resolveCalldata(operation),
    );
    const quoteBlock = await this.client.getBlock({ blockTag: 'latest' });
    const feeValues = await estimateL1OperationFeeValues(this.client, quoteBlock);
    enforceFeeCeilings(approval, feeValues);

    const executable = {
      target: source.target.toString() as Hex,
      calldata: finalizationCalldata,
      payoutToken: source.payoutToken.toString() as Hex,
    };
    const minimumPayout = BigInt(approval.economics.minimumPayout);
    const simulation = await simulateL1Operation(this.client, {
      executor: approval.deployment.operationExecutor as Hex,
      executorVersion: this.executorVersion,
      sender: account.address,
      operation: executable,
      feeValues,
      minPayout: minimumPayout,
      quoteBlock,
    });
    if (simulation.status === 'failure') {
      throw new Error(`Exact-operation simulation failed: ${simulation.error.message}`);
    }
    if (simulation.result < minimumPayout) {
      throw new Error('Exact-operation payout is below the approved minimum');
    }

    const maximumGasToCover = BigInt(approval.economics.maximumGasToCover);
    if (simulation.gasToCover > maximumGasToCover) {
      throw new Error(
        `Exact-operation gas-to-cover ${simulation.gasToCover} exceeds approved maximum ${maximumGasToCover}`,
      );
    }
    const gas = l1OperationGasLimit(simulation.gasUsed, quoteBlock) + GAS_COST_ARGS_CALLDATA_GAS;
    if (gas > BigInt(approval.economics.maximumGas)) {
      throw new Error('Exact-operation gas limit exceeds the approved maximum');
    }
    if (gas * feeValues.maxFeePerGas > BigInt(approval.economics.maximumTotalFee)) {
      throw new Error('Exact-operation maximum transaction fee exceeds the approved total');
    }

    const confirmedSimulation = await simulateL1Operation(this.client, {
      executor: approval.deployment.operationExecutor as Hex,
      executorVersion: this.executorVersion,
      sender: account.address,
      operation: executable,
      feeValues,
      minPayout: minimumPayout,
      quoteBlock,
      gas,
    });
    if (confirmedSimulation.status === 'failure') {
      throw new Error(`Exact-operation bounded-gas simulation failed: ${confirmedSimulation.error.message}`);
    }
    const data = encodeOperationExecute(this.executorVersion, executable, minimumPayout, {
      gasToCover: simulation.gasToCover,
      tokenWeiPerEth: BigInt(approval.economics.tokenWeiPerEth),
    });
    const nonce = await this.client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const chainId = approvedSigningChainId(approval, this.chainId);
    const serialized = await this.limits.signL1Transaction(() =>
      account.signTransaction({
        type: 'eip1559',
        chainId,
        nonce,
        to: approval.deployment.operationExecutor as Hex,
        data,
        value: 0n,
        gas,
        ...feeValues,
      }),
    );
    return { hash: keccak256(serialized), bytes: Buffer.from(hexToBytes(serialized)) };
  }

  async sendOnce(signedTransaction: Buffer): Promise<string> {
    return await this.limits.sendRawTransaction(() =>
      this.client.sendRawTransaction({ serializedTransaction: toHex(signedTransaction) }),
    );
  }

  async waitForReceipt(txHash: string): Promise<{ status: 'success' | 'reverted' }> {
    const receipt = await this.client.waitForTransactionReceipt({ hash: txHash as Hash });
    return { status: receipt.status };
  }
}
export function approvedSigningChainId(approval: ExactOperationApproval, verifiedChainId: number): number {
  if (BigInt(verifiedChainId) !== BigInt(approval.deployment.chainId)) {
    throw new Error('Exact-operation signing chain differs from the approved chain');
  }
  return verifiedChainId;
}


function enforceFeeCeilings(
  approval: ExactOperationApproval,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): void {
  if (fees.maxFeePerGas > BigInt(approval.economics.maximumFeePerGas)) {
    throw new Error('Exact-operation max fee per gas exceeds the approved maximum');
  }
  if (fees.maxPriorityFeePerGas > BigInt(approval.economics.maximumPriorityFeePerGas)) {
    throw new Error('Exact-operation priority fee exceeds the approved maximum');
  }
}
