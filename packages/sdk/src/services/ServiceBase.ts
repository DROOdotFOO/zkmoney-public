import { EventEmitter } from "eventemitter3"
import { ContractService, type ContractName } from "@obsidion/contracts"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  type BatchCall,
  Contract,
  type ContractBase,
  ContractFunctionInteraction,
  type DeployInstantiationOptions,
  type DeployMethod,
  type DeployOptions,
  type OffchainOutput,
  type SendInteractionOptions,
  type SimulateInteractionOptions,
  NO_WAIT,
} from "@aztec-labs/aztec.js/contracts"
import type { Account } from "@aztec-labs/aztec.js/account"
import { type TxReceipt, TxHash, type TxProfileResult } from "@aztec-labs/stdlib/tx"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { TESTNET_TIMEOUT } from "../utils/constants.js"
import { QueueStatus, TransactionProgress } from "@obsidion/core/constants"
import { createAsyncTransaction } from "../utils/helper.js"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import type { OriginalFlowKind } from "@obsidion/proving-progress"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import { type BuildTeeOperationSendOpts, dedupeByAddressString } from "./tee/teeOperation.js"

export interface BaseServiceMethodOptions {
  sendOptions?: SendInteractionOptions
  /** Log gate counts before sending. */
  profile?: boolean
  /** Proving-scope op id, so the UI row and proving events share one id. */
  operationId?: string
  /** Proving-progress flow kind. The wallet defaults it to `"send"`. */
  kind?: OriginalFlowKind
  /** Skip this class's status and proving-progress emits. `wallet.sendTx` still emits its own. */
  silent?: boolean
  /** Holds `wallet.sendTx` until the user confirms. Rejects on dismiss. */
  confirmGate?: Promise<unknown>
}

export type MethodOptions<T extends object = object> = BaseServiceMethodOptions & T

export class ServiceBase extends EventEmitter {
  protected wallet: ObsidionWallet
  protected _lastProfileSteps: { method: string; gateCount: number }[] | undefined = undefined
  /** Fallback source for `lastProfileSteps`. */
  protected _profileDelegate: ServiceBase | undefined = undefined
  /** Signer for oxide TEE flows. Here, not on ServiceContractBase, because PaylinkService needs it. */
  private _teeSigner?: RegisteredTeeSigner

  constructor(wallet: ObsidionWallet, teeSigner?: RegisteredTeeSigner) {
    super()
    this.wallet = wallet
    this._teeSigner = teeSigner
  }

  /** `undefined` clears the signer, e.g. after a network or account switch. */
  public setTeeSigner(teeSigner?: RegisteredTeeSigner): void {
    this._teeSigner = teeSigner
  }

  protected getTeeSigner(): RegisteredTeeSigner {
    if (!this._teeSigner) {
      throw new Error(
        `[${this.constructor.name}] TEE signer not wired. Pass \`teeSigner\` to the constructor / static \`create(...)\` or call \`setTeeSigner(...)\` before invoking a flow that requires oxide's submit().`,
      )
    }
    return this._teeSigner
  }

  public get lastProfileSteps(): { method: string; gateCount: number }[] | undefined {
    return this._lastProfileSteps ?? this._profileDelegate?.lastProfileSteps
  }
  public emitInit() {
    this.emit("status", QueueStatus.INITIALIZING, TransactionProgress.INITIALIZING)
  }

  public emitProveAndSend() {
    this.emit("status", QueueStatus.PROVING_AND_SENDING, TransactionProgress.PROVING_AND_SENDING)
  }

  public emitMining() {
    this.emit("status", QueueStatus.MINING, TransactionProgress.MINING)
  }

  public emitSuccess(txHash: string) {
    this.emit("status", QueueStatus.SUCCESS, TransactionProgress.SUCCESS, txHash)
  }

  public emitFailed(txHash: string | undefined) {
    this.emit("status", QueueStatus.FAILED, TransactionProgress.FAILED, txHash)
  }

  protected async getSendOptions(
    from: AztecAddress,
    options?: BaseServiceMethodOptions,
  ): Promise<SendInteractionOptions> {
    return options?.sendOptions ?? (await this.wallet.getDefaultSendOptions(from))
  }

  private logProfileResult(
    executionSteps: { functionName: string; gateCount?: number }[],
    label: string | string[],
  ): void {
    let totalGateCount = 0
    const steps: { id: number; method: string; gateCount: number }[] = []

    for (const step of executionSteps) {
      steps.push({
        id: steps.length + 1,
        method: step.functionName,
        gateCount: step.gateCount ?? 0,
      })
      totalGateCount += step.gateCount ?? 0
    }

    console.log("\n" + "=".repeat(80))
    console.log("EXECUTION PROFILE: ", label)
    console.log("=".repeat(80))

    console.log("┌─────┬──────────────────────────────────────┬─────────────┐")
    console.log("│ ID  │ Method                               │ Gate Count  │")
    console.log("├─────┼──────────────────────────────────────┼─────────────┤")

    for (const step of steps) {
      const id = step.id.toString().padStart(3)
      const method = step.method.padEnd(36)
      const gateCount = step.gateCount.toString().padStart(11)
      console.log(`│ ${id} │ ${method} │ ${gateCount} │`)
    }

    console.log("├─────┼──────────────────────────────────────┼─────────────┤")
    const totalStr = totalGateCount.toString().padStart(11)
    console.log(`│     │ TOTAL                                │ ${totalStr} │`)
    console.log("└─────┴──────────────────────────────────────┴─────────────┘")
    console.log("=".repeat(80) + "\n")
  }

  /** Logs gate counts without sending. */
  protected async profileInteraction(
    interaction: ContractFunctionInteraction | DeployMethod,
    options: SimulateInteractionOptions,
  ): Promise<{ method: string; gateCount: number }[]> {
    const result: TxProfileResult = await interaction.profile({
      ...options,
      profileMode: "gates",
      skipProofGeneration: true,
    })

    const executionNames = (await interaction.request()).calls.map((call) => call.name)
    this.logProfileResult(result.executionSteps, executionNames)

    const steps = result.executionSteps.map((step) => ({
      method: step.functionName,
      gateCount: step.gateCount ?? 0,
    }))
    this._lastProfileSteps = steps
    return steps
  }

  /**
   * Sends a tx, waits for it, and emits status events. `wallet.sendTx` emits the Mining stage
   * start, so this method must not.
   */
  protected sendAndWait<
    TInit extends {
      interaction: ContractFunctionInteraction | BatchCall
      sendOpts?: BuildTeeOperationSendOpts
    },
    TResult,
  >(
    initFn: () => Promise<TInit>,
    buildResult: (
      data: Omit<TInit, "interaction" | "sendOpts"> & {
        txHash: string
        receipt: TxReceipt
      } & OffchainOutput,
    ) => TResult | Promise<TResult>,
    options?: BaseServiceMethodOptions,
  ): {
    txPromise: Promise<TResult>
    txHash: Promise<string>
    /** Carries the offchain output. */
    sentTx: Promise<TInit & { txHash: string } & OffchainOutput>
  } {
    return createAsyncTransaction(
      async () => {
        try {
          if (!options?.silent) this.emitProveAndSend()
          const init = await initFn()

          // ponytail: BatchCall has no `.with()`, so TEE flows skip profiling.
          if (
            options?.profile &&
            options.sendOptions?.from &&
            init.interaction instanceof ContractFunctionInteraction
          ) {
            const capsules = options.sendOptions?.capsules
            const interactionToProfile = capsules?.length
              ? init.interaction.with({ capsules })
              : init.interaction
            this._lastProfileSteps = await this.profileInteraction(interactionToProfile, {
              from: options.sendOptions.from,
              additionalScopes: options.sendOptions.additionalScopes,
            })
          }

          if (!options?.sendOptions) {
            throw new Error("sendOptions must be provided to sendAndWait")
          }

          const mergedSendOptions = {
            ...options.sendOptions,
            additionalScopes: dedupeByAddressString([
              ...(options.sendOptions?.additionalScopes ?? []),
              ...(init.sendOpts?.additionalScopes ?? []),
            ]),
            // ponytail: shallow merge. Safe while `sendOpts.fee` never sets `gasSettings`.
            fee: { ...options.sendOptions?.fee, ...init.sendOpts?.fee },
            operationId: options.operationId,
            kind: options.kind,
            finalize: init.sendOpts?.finalize,
            confirmGate: options.confirmGate,
          }

          const { txHash, offchainMessages, offchainEffects } = await init.interaction.send({
            ...mergedSendOptions,
            wait: NO_WAIT,
          })

          return {
            ...init,
            txHash: txHash.toString(),
            offchainMessages: offchainMessages,
            offchainEffects: offchainEffects,
          }
        } catch (error) {
          if (!options?.silent) {
            provingProgress.emitReset()
            this.emitFailed(undefined)
          }
          throw error
        }
      },
      async (init) => {
        try {
          if (!options?.silent) this.emitMining()
          const receipt = await waitForTx(this.wallet.node, TxHash.fromString(init.txHash), {
            ...this.wallet.defaultWaitOpts,
            timeout: TESTNET_TIMEOUT,
          })
          if (!options?.silent) {
            provingProgress.emitStageComplete(ProvingStage.Mining, options?.operationId)
            this.emitSuccess(init.txHash)
          }
          const { interaction, sendOpts, ...rest } = init
          return await buildResult({ ...rest, receipt } as Omit<
            TInit,
            "interaction" | "sendOpts"
          > & {
            txHash: string
            receipt: TxReceipt
          } & OffchainOutput)
        } catch (error) {
          if (!options?.silent) {
            provingProgress.emitReset()
            this.emitFailed(init.txHash)
          }
          throw error
        }
      },
    )
  }
}

export abstract class ServiceContractBase extends ServiceBase {
  private static registrationPromises: Map<ContractName, Promise<void>> = new Map()

  protected contractService: ContractService
  private deploymentInProgress: Promise<ContractBase | undefined> | null = null
  protected contractAddress: AztecAddress | undefined
  protected contractName: ContractName
  protected contract: ContractBase | undefined
  protected deployer?: Account

  constructor(
    contractName: ContractName,
    wallet: ObsidionWallet,
    contractAddress?: AztecAddress,
    deployer?: Account,
    contractService?: ContractService,
    teeSigner?: RegisteredTeeSigner,
  ) {
    super(wallet, teeSigner)
    this.contractService = contractService ?? ContractService.getInstance()
    this.contractName = contractName
    this.contractAddress = contractAddress
    this.deployer = deployer

    this.registerContract()
  }

  protected getDeployer(): AztecAddress {
    if (!this.deployer) {
      throw new Error("Deployer not initialized")
    }
    return this.deployer.getAddress()
  }

  private registerContract(): void {
    if (ServiceContractBase.registrationPromises.has(this.contractName)) {
      return
    }

    const promise = this.contractService
      .registerContractWithName(this.contractName)
      .catch((error) => {
        console.error(`Error registering contract ${this.contractName}:`, error)
        ServiceContractBase.registrationPromises.delete(this.contractName)
      })

    ServiceContractBase.registrationPromises.set(this.contractName, promise)
  }

  protected async ensureContractsRegistered(): Promise<void> {
    const promise = ServiceContractBase.registrationPromises.get(this.contractName)
    if (promise) {
      await promise
    }
  }

  public async getContractAddress(): Promise<AztecAddress> {
    if (this.contractAddress) {
      return this.contractAddress
    }

    if (!this.contractAddress) {
      this.contractAddress = await this.contractService.getContractAddress(this.contractName)
      if (!this.contractAddress) {
        throw new Error(`Contract address not found for contract ${this.contractName}`)
      }
    }
    return this.contractAddress
  }

  protected async getContract(address?: AztecAddress): Promise<ContractBase> {
    if (this.contract) {
      await this.ensureContractsRegistered()
      return this.contract
    }

    let contract: ContractBase
    // A service constructed with an explicit address anchors on it even when the caller passes
    // none — operations must run against the address the service exposes.
    const anchor = address ?? this.contractAddress
    if (anchor) {
      contract = await this.contractService.getContractWithArtifactAndAddress(
        anchor,
        this.wallet,
        await this.contractService.getArtifactForContract(this.contractName, anchor, this.wallet),
      )
    } else {
      contract = await this.contractService.getContract(this.contractName, this.wallet)
    }

    if (!contract) {
      throw new Error(`Failed to get contract ${this.contractName}`)
    }

    this.contract = contract

    await this.ensureContractsRegistered()
    return contract
  }

  protected async deployContract(
    args: any[],
    options?: DeployOptions,
    instantiation?: DeployInstantiationOptions,
  ): Promise<ContractBase | undefined> {
    if (this.deploymentInProgress) {
      console.log(`Deployment for contract ${this.contractName} already in progress, waiting...`)
      return this.deploymentInProgress
    }

    this.deploymentInProgress = this.deployContractInternal(args, options, instantiation)

    return await this.deploymentInProgress
  }

  private async deployContractInternal(
    args: any[],
    options?: DeployOptions,
    instantiation?: DeployInstantiationOptions,
  ): Promise<ContractBase | undefined> {
    console.debug(`deploying contract ${this.contractName}...`)

    try {
      const artifact = await this.contractService.getArtifactForContract(this.contractName)

      const defaultOptions = options
        ? options
        : await this.wallet.getDefaultSendOptions(this.getDeployer())

      const deployed = await Contract.deploy(
        this.wallet,
        artifact,
        args,
        undefined,
        instantiation,
      ).send(defaultOptions)
      this.contract = deployed.contract
      this.contractAddress = this.contract.address

      await this.contractService.setContractAddress(this.contractName, this.contract.address)

      return this.contract
    } catch (error) {
      console.error(`Error deploying contract ${this.contractName}:`, error)
      throw error
    } finally {
      this.deploymentInProgress = null
    }
  }
}
