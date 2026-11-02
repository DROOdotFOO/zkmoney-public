import { EncodedAppEntrypointCalls } from "@aztec-labs/entrypoints/encoding"
import {
  Capsule,
  ExecutionPayload,
  HashedValues,
  TxContext,
  TxExecutionRequest,
} from "@aztec-labs/stdlib/tx"
import type { ChainInfo, EntrypointInterface } from "@aztec-labs/entrypoints/interfaces"
import { CAPSULE_SLOT } from "../../../utils/constants.js"
import type { DefaultAccountEntrypointOptions } from "@aztec-labs/entrypoints/account"
import type { GasSettings } from "@aztec-labs/stdlib/gas"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  encodeArguments,
  type FunctionAbi,
  FunctionCall,
  FunctionSelector,
  getFunctionReturnType,
} from "@aztec-labs/stdlib/abi"
import type { AlphaAuthProvider } from "../auth/AlphaAuthProvider.js"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { DomainSeparator } from "@aztec-labs/constants"
import { computeOuterAuthWitHash } from "@aztec-labs/stdlib/auth-witness"

const INTENT_HASHES_LEN = 4

type EntrypointType = "entrypoint" | "entrypoint_with_intent"

export type AlphaEntrypointOptions = DefaultAccountEntrypointOptions

export class ObsidionAccountEntrypoint implements EntrypointInterface {
  constructor(private address: AztecAddress, private authProvider: AlphaAuthProvider) {}

  setAuthProvider(authProvider: AlphaAuthProvider) {
    this.authProvider = authProvider
  }

  async createTxExecutionRequest(
    exec: ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    options: AlphaEntrypointOptions,
  ): Promise<TxExecutionRequest> {
    const { calls, authWitnesses, capsules, extraHashedArgs } = exec
    const { txNonce, feePaymentMethodOptions } = options

    // Build a fresh capsules list for THIS request instead of mutating the
    // caller's `exec.capsules`. `sendTx` reuses the same `ExecutionPayload`
    // across pre-simulation and prove; mutating it here makes the pre-sim's
    // intent capsule leak into the prove request, where PXE's transient
    // capsule lookup (`.find()`, first match wins) returns the stale one
    // while `entrypoint_with_intent`'s ABI param has the up-to-date hashes.
    // `verify_private_authwit` then queries the wrong slot and the note
    // lookup fails.
    let requestCapsules: Capsule[] = [...capsules]

    const appEncodedCalls = await EncodedAppEntrypointCalls.create(calls, txNonce)
    const appEncodedCallsHash = await appEncodedCalls.hash()

    const hasIntents = authWitnesses.length > 0
    const entrypointType = this.getEntrypointType(hasIntents)

    let payloadHash: Fr
    let entrypointHashedArgs: HashedValues
    let abi: FunctionAbi

    if (hasIntents) {
      const rawIntentHashes = authWitnesses?.map((aw) => aw.requestHash) ?? []
      const intentHashes = [
        ...rawIntentHashes,
        ...Array(INTENT_HASHES_LEN - rawIntentHashes.length).fill(Fr.ZERO),
      ]

      abi = this.getEntrypointWithIntentAbi(entrypointType)
      const abiArgs = this.buildArgsWithIntent(
        appEncodedCalls,
        feePaymentMethodOptions,
        intentHashes,
      )

      const encodedArgs = encodeArguments(abi, abiArgs)
      entrypointHashedArgs = await HashedValues.fromArgs(encodedArgs)

      requestCapsules = this.withEntrypointIntentCapsule(
        requestCapsules,
        new Capsule(this.address, new Fr(CAPSULE_SLOT), [appEncodedCallsHash, ...intentHashes]),
      )

      payloadHash = await poseidon2HashWithSeparator(
        [appEncodedCallsHash, ...intentHashes],
        DomainSeparator.SIGNATURE_PAYLOAD,
      )
    } else {
      abi = this.getEntrypointAbi(entrypointType)
      const abiArgs = this.buildArgs(appEncodedCalls, feePaymentMethodOptions)
      const encodedArgs = encodeArguments(abi, abiArgs)
      entrypointHashedArgs = await HashedValues.fromArgs(encodedArgs)
      payloadHash = appEncodedCallsHash
    }

    const signedMessage = await this.signedMessageHash(chainInfo, payloadHash)

    const combinedPayloadAuthWitness = await this.authProvider.createAuthWit(signedMessage)

    const txContext = new TxContext(chainInfo.chainId, chainInfo.version, gasSettings)

    return TxExecutionRequest.from({
      firstCallArgsHash: entrypointHashedArgs.hash,
      origin: this.address,
      functionSelector: await FunctionSelector.fromNameAndParameters(abi.name, abi.parameters),
      txContext,
      argsOfCalls: [...appEncodedCalls.hashedArguments, entrypointHashedArgs, ...extraHashedArgs],
      authWitnesses: [...authWitnesses, combinedPayloadAuthWitness],
      capsules: requestCapsules,
      salt: Fr.random(),
    })
  }

  private buildArgs(
    appEncodedCalls: EncodedAppEntrypointCalls,
    feePaymentMethodOptions: any,
  ): any[] {
    return [appEncodedCalls, feePaymentMethodOptions]
  }

  private buildArgsWithIntent(
    appEncodedCalls: EncodedAppEntrypointCalls,
    feePaymentMethodOptions: any,
    intentHashes: Fr[],
  ): any[] {
    return [appEncodedCalls, feePaymentMethodOptions, intentHashes]
  }

  /** What the contract verifies: the payload hash bound to this account, chain and version. */
  private signedMessageHash(chainInfo: ChainInfo, payloadHash: Fr): Promise<Fr> {
    return computeOuterAuthWitHash(this.address, chainInfo.chainId, chainInfo.version, payloadHash)
  }

  async wrapExecutionPayload(
    exec: ExecutionPayload,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<ExecutionPayload> {
    const { authWitnesses, capsules, extraHashedArgs, feePayer } = exec
    const callData = await this.buildEntrypointCallData(exec, chainInfo, options)
    const wrappedCapsules = this.withEntrypointIntentCapsule(capsules, callData.intentCapsule)

    const entrypointCall = FunctionCall.from({
      name: callData.abi.name,
      to: this.address,
      selector: callData.functionSelector,
      type: callData.abi.functionType,
      hideMsgSender: false,
      isStatic: callData.abi.isStatic,
      args: callData.encodedArgs,
      returnType: getFunctionReturnType(callData.abi),
    })

    return new ExecutionPayload(
      [entrypointCall],
      [callData.payloadAuthWitness, ...authWitnesses],
      wrappedCapsules,
      [...callData.encodedCalls.hashedArguments, ...extraHashedArgs],
      feePayer ?? this.address,
    )
  }

  private async buildEntrypointCallData(
    exec: ExecutionPayload,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ) {
    const { calls, authWitnesses } = exec
    const { txNonce, feePaymentMethodOptions } = options

    const encodedCalls = await EncodedAppEntrypointCalls.create(calls, txNonce)
    const appEncodedCallsHash = await encodedCalls.hash()

    const hasIntents = authWitnesses.length > 0
    const entrypointType = this.getEntrypointType(hasIntents)

    let abi: FunctionAbi
    let args: any[]
    let payloadHash: Fr
    let intentCapsule: Capsule | undefined

    if (hasIntents) {
      const rawIntentHashes = authWitnesses?.map((aw) => aw.requestHash) ?? []
      const intentHashes = [
        ...rawIntentHashes,
        ...Array(INTENT_HASHES_LEN - rawIntentHashes.length).fill(Fr.ZERO),
      ]

      abi = this.getEntrypointWithIntentAbi(entrypointType)
      args = this.buildArgsWithIntent(encodedCalls, feePaymentMethodOptions, intentHashes)

      payloadHash = await poseidon2HashWithSeparator(
        [appEncodedCallsHash, ...intentHashes],
        DomainSeparator.SIGNATURE_PAYLOAD,
      )
      intentCapsule = new Capsule(this.address, new Fr(CAPSULE_SLOT), [
        appEncodedCallsHash,
        ...intentHashes,
      ])
    } else {
      abi = this.getEntrypointAbi(entrypointType)
      args = this.buildArgs(encodedCalls, feePaymentMethodOptions)
      payloadHash = appEncodedCallsHash
    }

    const encodedArgs = encodeArguments(abi, args)
    const functionSelector = await FunctionSelector.fromNameAndParameters(abi.name, abi.parameters)
    const payloadAuthWitness = await this.authProvider.createAuthWit(
      await this.signedMessageHash(chainInfo, payloadHash),
    )

    return { encodedCalls, abi, encodedArgs, functionSelector, payloadAuthWitness, intentCapsule }
  }

  /**
   * Append the alpha account's intent capsule to the request's capsule list,
   * displacing any prior capsule at `(this.address, CAPSULE_SLOT, ZERO scope)`.
   *
   * Why displace, not append: PXE's transient capsule lookup uses `.find(...)`
   * over the request's capsule list (see `pxe/src/storage/capsule_store/
   * capsule_service.ts` — transient capsules `overshadow` persisted data with
   * first-match-wins semantics). Two capsules at the same `(address, slot,
   * scope)` triple means the older one wins and the newer ABI `intent_hashes`
   * parameter no longer agrees with what `verify_private_authwit` loads from
   * the capsule, producing a slot mismatch on `intents_hashes.at(...).get_note()`.
   *
   * Filtering by `(address, slot, scope)` is intentional — capsules pushed by
   * unrelated contracts (e.g. a sponsor FPC) or by the same contract at a
   * different slot must pass through untouched.
   */
  private withEntrypointIntentCapsule(capsules: Capsule[], intentCapsule?: Capsule): Capsule[] {
    if (!intentCapsule) {
      return [...capsules]
    }

    const slot = new Fr(CAPSULE_SLOT)
    const filtered = capsules.filter(
      (capsule) =>
        !(
          capsule.contractAddress.equals(this.address) &&
          capsule.storageSlot.equals(slot) &&
          (capsule.scope ?? AztecAddress.ZERO).equals(AztecAddress.ZERO)
        ),
    )
    return [...filtered, intentCapsule]
  }

  private getEntrypointType(hasIntents: boolean): EntrypointType {
    return hasIntents ? "entrypoint_with_intent" : "entrypoint"
  }

  private getEntrypointAbi(entrypointType: EntrypointType): FunctionAbi {
    const parameters = [APP_PAYLOAD_PARAM, FEE_PAYMENT_METHOD_PARAM]
    return { name: entrypointType, ...BASE_ABI_PROPS, parameters } as unknown as FunctionAbi
  }

  private getEntrypointWithIntentAbi(entrypointType: EntrypointType): FunctionAbi {
    const parameters = [APP_PAYLOAD_PARAM, FEE_PAYMENT_METHOD_PARAM, INTENT_HASHES_PARAM]
    return { name: entrypointType, ...BASE_ABI_PROPS, parameters } as unknown as FunctionAbi
  }
}

const FUNCTION_CALL_TYPE = {
  kind: "struct",
  path: "authwit::entrypoint::function_call::FunctionCall",
  fields: [
    { name: "args_hash", type: { kind: "field" } },
    {
      name: "function_selector",
      type: {
        kind: "struct",
        path: "authwit::aztec::protocol_types::abis::function_selector::FunctionSelector",
        fields: [{ name: "inner", type: { kind: "integer", sign: "unsigned", width: 32 } }],
      },
    },
    {
      name: "target_address",
      type: {
        kind: "struct",
        path: "authwit::aztec::protocol_types::address::AztecAddress",
        fields: [{ name: "inner", type: { kind: "field" } }],
      },
    },
    { name: "is_public", type: { kind: "boolean" } },
    { name: "hide_msg_sender", type: { kind: "boolean" } },
    { name: "is_static", type: { kind: "boolean" } },
  ],
} as const

const APP_PAYLOAD_PARAM = {
  name: "app_payload",
  type: {
    kind: "struct",
    path: "authwit::entrypoint::app::AppPayload",
    fields: [
      { name: "function_calls", type: { kind: "array", length: 5, type: FUNCTION_CALL_TYPE } },
      { name: "tx_nonce", type: { kind: "field" } },
    ],
  },
  visibility: "public",
} as const

const FEE_PAYMENT_METHOD_PARAM = {
  name: "fee_payment_method",
  type: { kind: "integer", sign: "unsigned", width: 8 },
} as const

const INTENT_HASHES_PARAM = {
  name: "intent_hashes",
  type: { kind: "array", length: 4, type: { kind: "field" } },
} as const

const BASE_ABI_PROPS = {
  isInitializer: false,
  functionType: "private" as const,
  isInternal: false,
  isStatic: false,
  returnTypes: [] as never[],
  errorTypes: {} as Record<string, never>,
}
