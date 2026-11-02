import {
  nestedWithdrawal,
  planPayout,
  planWithdrawal,
  type WithdrawalOptions,
} from "../withdrawal/plainWithdrawal.js"
import type { WithdrawOperation } from "../../oxide/withdrawal/plainWithdrawal.js"
// This is an MVP for a service that will be used for all the repeatable
// boilerplate code for all the different paylink types

import { type Account, NO_FROM } from "@aztec-labs/aztec.js/account"
import { computeAuthWitMessageHash } from "@aztec-labs/aztec.js/authorization"
import type { ObsidionWallet, TxHashCallback } from "../../obsidion/ObsidionWallet.js"
import { ObsidionAccount } from "../../obsidion/alpha/account/ObsidionAccount.js"
import {
  buildSponsoredTeeOperation,
  type SponsoredTeeOperationArgs,
} from "../tee/sponsoredTeeOperation.js"
import { MAX_SPONSORED_CALLS } from "../../feePaymentMethod/claimFpc/sponsoredCall.js"
import { sponsoredAccounts } from "../claimFpc/sponsoredAccounts.js"
import { claimFpcPolicySponsorsAnyCall } from "../../feePaymentMethod/claimFpc/claimSponsoredCall.js"
import {
  type ClaimSponsorContext,
  authorizeSponsoredBatch,
  chainInfoFields,
  contractClassWitness,
  registerSponsorFpc,
  giftVoucherInteraction,
  linkChainInfo,
} from "../claimFpc/claimSponsor.js"
import { buildOperationCall } from "./claim/paylinkClaimSubmit.js"
import { buildTokenOperationCall } from "../tee/tokenOperationCall.js"
import type { Operation } from "../../oxide/index.js"
import { paylinkL1ClaimArgs, type PaylinkL1Proof } from "./claim/paylinkL1Claim.js"
import { makePaylinkSpendMetadataResolver } from "./claim/paylinkSpendMetadata.js"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { type MethodOptions, ServiceBase } from "../ServiceBase.js"
import { prepareDepositSubmit } from "./create/paylinkDepositSubmit.js"
import { TokenService } from "../token/TokenService.js"
import type { FieldLike } from "@aztec-labs/aztec.js/abi"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  type ContractService,
  DEFAULT_CONTRACTS,
  type ContractName,
  ensureContractRegisteredInPXE,
} from "@obsidion/contracts"
import { OxideTokenContract, type Transfer as TransferEvent } from "@obsidion/contracts"
import {
  buildTransferMetaForSend,
  decodeTransferMeta,
  fieldLikeToFr,
  type TransferMeta,
} from "../token/transferMeta.js"
import type { ScannedTransferEvent } from "../token/transferEventSource.js"
import {
  type ContractInstanceWithAddress,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/stdlib/contract"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { PublicKey } from "@aztec-labs/stdlib/keys"
import type { EthAddress } from "@aztec-labs/aztec.js/addresses"
import type { TxReceipt } from "@aztec-labs/aztec.js/tx"
import {
  Contract,
  type ContractBase,
  type ContractFunctionInteraction,
} from "@aztec-labs/aztec.js/contracts"
import type { TxEffect, TxHash } from "@aztec-labs/stdlib/tx"
import assert from "assert"
import { poseidon2Hash } from "@zkpassport/poseidon2"
import { computeSiloedPrivateInitializationNullifier, siloNullifier } from "@aztec-labs/stdlib/hash"
import { epochDay } from "../../utils/helper.js"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import { PaylinkProcessorFactory } from "./create/PaylinkProcessorFactory.js"
import type { DepositArg } from "./create/processors/BasePaylinkProcessor.js"
import type {
  CommitmentInput,
  ClaimInput,
  ClaimService,
  ClaimSubmitContext,
  ZkProofClaimInput,
  PaylinkWindow,
} from "./types.js"
import { preparePaylinkClaimSubmit } from "./claim/paylinkClaimSubmit.js"
import {
  assertLinkChain,
  encodePaylinkInline,
  decodePaylinkInline,
  encodePaylinkLocatorPayload,
} from "./link/paylinkInlineCodec.js"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { PaylinkDirectClaimService, PaylinkEmailClaimService } from "../index.js"
import type { SpendMetadataResolver } from "@oxide/oxide-client/token_operations_collector.js"
import type { DepositSpendMetadataResolver } from "../../oxide/index.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import {
  computeEscrowTagSecret,
  registerPaylinkContractWithKeys,
  deriveDeterministicPaylinkKeys,
  findPaylinkKeysForDay,
  MAX_PAYLINK_NONCES_PER_DAY,
  type PaylinkKeyMaterial,
} from "./escrow/paylinkKeys.js"
import {
  assertPaylinkTerms,
  buildPaylinkNoteView,
  claimTermsArgs,
  paylinkTerms,
  type PaylinkNoteView,
} from "./escrow/paylinkNoteData.js"
import {
  escrowInstancesForClasses,
  escrowInstancesForKnownClasses,
  linkEscrow,
  paylinkEscrowInstance,
  paylinkTypeOf,
} from "./escrow/paylinkEscrow.js"
import { escrowDepositTx, registerEscrow, sharedNoteRead } from "./escrow/escrowRegistration.js"
import { LinkKind, linkAnnounceInteraction, shortLinksEnabled } from "./link/linkLocator.js"
import {
  findDepositTxHash,
  PAYLINK_NONCE_EPOCH_DAY,
  scanPaylinkEscrows,
} from "./escrow/paylinkRecovery.js"

export type { PaylinkNoteView } from "./escrow/paylinkNoteData.js"

// Paylink claim-link domain. Prod default; override per environment via the
// PAYLINK_DOMAIN env var (e.g. https://claim.staging.zk.money for staging), mirroring the
// backend's ALLOWED_PAYLINK_DOMAINS env pattern.
const DOMAIN = process.env.PAYLINK_DOMAIN ?? "https://paylink.zk.money"

/** Client-side mirror of the contract's `assert_windows`, so a bad window fails before proving. */
export function assertPaylinkWindow(window: PaylinkWindow): void {
  const { fromClaimable, untilClaimable, refundableUntil } = window
  assert(typeof fromClaimable === "bigint", "fromClaimable must be a bigint")
  assert(fromClaimable >= 0n, "fromClaimable must be non-negative")
  assert(typeof untilClaimable === "bigint", "untilClaimable must be a bigint")
  assert(untilClaimable >= 0n, "untilClaimable must be non-negative")
  assert(untilClaimable > fromClaimable, "untilClaimable must be greater than fromClaimable")
  assert(typeof refundableUntil === "bigint", "refundableUntil must be a bigint")
  assert(refundableUntil >= 0n, "refundableUntil must be non-negative")
  assert(refundableUntil <= untilClaimable, "refundableUntil must not exceed untilClaimable")
}

export type PaylinkInitParams = {
  // the amount of the paylink
  amount: bigint
  // the hash is what data is being committed to, for alpha this will the email/ name/ H(name, DOB, etc)
  hash: FieldLike
  // the token that is being used for the paylink, for alpha this will be constant
  token: AztecAddress
  // Optional zk proof verifying-key hash. Email paylinks require this and bind
  // it into the PaylinkNote; other flavours leave the note field as zero.
  vkey_hash?: FieldLike
  // Claim window plus the end of the creator refund window; see PaylinkWindow.
  window: PaylinkWindow
  // There may be occassions where the is a paylink where there is not an asssoicated registry
  // contract that is needed to verify some of the data in the proof provided by the claimer.
  registry_address?: AztecAddress
  // Bring-your-own key material, bypassing derivation. Wins over `masterSecret`. No production
  // caller sets this; tests use it to exercise claimer-side reconstruction with pre-known keys.
  paylinkKeys?: PaylinkKeyMaterial
  masterSecret?: Fr
  // Sender-asserted lanes of the funding transfer's `Transfer.meta`, read by the link holder off the
  // escrow's event (`readDepositMeta`). Memo ≤ PAYLINK_MEMO_MAX_BYTES UTF-8, truncated.
  memo?: string
  senderTag?: string
  // Plaintext lock email (email flavor): announced in the funding transfer's meta so a resync
  // rebuilds the link's display hint. The contract only ever sees `hash`.
  email?: string
}

// These should match the contract name type

/**
 * What a share link carries. Every escrow key but fallback derives from `secret`; the funding tx,
 * amount, lock email and commitment are read from chain once the escrow is in a PXE
 * (`resolveLink`).
 */
export type PaylinkParams = {
  secret: Fr
  paylinkType: string
  /** `fbpkMHash` of the creator's fallback key: the escrow address depends on it, its secret stays creator-only. */
  fallbackKeyHash: Fr
  /** The escrow's contract class. A build that carries another class derives another address. */
  classId: Fr
  /** L1 chain id of the rollup the escrow was funded on; testnet and mainnet links never mix. */
  chainId: number
  /** Version of that rollup; two deployments on one L1 chain never mix either. */
  rollupVersion: number
  /**
   * Tag secret for an escrow funded before handshake tagging. See `computeEscrowTagSecret`.
   */
  escrowTagSecret?: PublicKey
  /** The short link's seed, which derives `secret`. Absent on a link made before short links. */
  seed?: Uint8Array
  /**
   * `paylink_terms` of the note the create deposited. Every note read refuses another note, and a
   * claim on a class that takes terms asserts them. Absent on a link made before terms.
   */
  terms?: Fr
}

/** What a create hands back: the link plus the creator-side material its row stores. */
export type CreatedPaylinkParams = PaylinkParams & {
  /** The migration factor behind `fallbackKeyHash`; never in the link. */
  fallbackSecret: Fr
  /** The funding tx. Absent on a link minted before its deposit was submitted. */
  txHash?: string
}

/** A link whose deposit has landed: what `createPaylinkContract` / `createSponsoredPaylink` return. */
export type SettledPaylinkParams = CreatedPaylinkParams & { txHash: string }

/** A link rebuilt from its funding transfer: settled, plus what the transfer said about it. */
export type RecoveredPaylinkParams = SettledPaylinkParams & {
  paylinkType: ContractName
  amount: bigint
  email?: string
}

/** What chain says about a link's escrow, read with the link's keys. */
export type ResolvedPaylink = {
  note: PaylinkNoteView
  /** The funding tx; undefined until the deposit is mined. */
  txHash?: string
  /** Plaintext lock email (email flavor), off the funding transfer's created lane. */
  email?: string
  /** The claim commitment the note binds (email flavor); zero on a direct link. */
  commitment: Fr
  /** The creator's memo, off the funding transfer. */
  memo?: string
  /** The creator's tag as the funding transfer asserts it: verify it against `from`. */
  senderTag?: string
  /** The funding transfer's sender, the creator. */
  from?: string
}

/** ClaimFPC sponsorship inputs for the `NO_FROM` paylink legs — see {@link ClaimSponsorContext}. */
export type PaylinkSponsorContext = ClaimSponsorContext

/** Same-batch L1 burn of a slice of the note the claim just created. Tips come out of `amount` at release. */
export type PaylinkClaimWithdraw = {
  l1Recipient: EthAddress
  amount: bigint
  proverTip: bigint
  withdrawal: WithdrawalOptions
}

/** Pay a claim with the link's own voucher (see `claimSponsoredPaylink`). */
export type VoucherClaimOptions = {
  /** The rail the creator gifted the voucher on (`createSponsoredPaylink`'s `voucher.railId`). */
  railId: number
  /**
   * Same-batch SIPA burn. Prefer the sibling `withdraw` on `claimSponsoredPaylink` when the claim
   * is not voucher-sponsored; this field remains so a voucher claim can carry the burn too.
   */
  withdraw?: PaylinkClaimWithdraw
}

/**
 * A claim asked to carry calls its batch has no room for: only a voucher `claim_with_withdrawal`
 * leaves slots free, and the FPC dispatches at most `MAX_SPONSORED_CALLS`. Thrown before anything is
 * proven, so the caller can send those calls on their own.
 */
export class ClaimBatchFullError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClaimBatchFullError"
  }
}

/**
 * Where a `claim_to_l1` burns to and what it pays. A swap-on-withdraw passes the counterfactual
 * `SwapEscrow` from `planSwapOnWithdraw` as `l1Recipient` and its args as `withdrawal.swap`.
 */
export type ClaimToL1Args = {
  withdrawal: WithdrawalOptions
  l1Recipient: EthAddress
  /** Deducted from the L1 payout by the portal; the token rejects `prover_tip > amount`. */
  proverTip: bigint
  /** Email flavor only: zkJWT proof whose `caller` slot is `paylinkL1Caller(payout)`. Hex strings accepted. */
  zkProof?: {
    vkey: (FieldLike | string)[]
    proof: (FieldLike | string)[]
    public_inputs: string[]
  }
}
/** What `readDepositMeta` returns: the creator (`from`) and the decoded + raw funding meta. */
export type DepositMeta = TransferMeta & { from: string; meta: Fr[] }

/** A master-secret-recovered escrow: everything `refundPaylink` needs, plus its claim status. */
export type RecoveredPaylink = CreatedPaylinkParams & {
  paylinkType: ContractName
  day: number
  n: number
  address: AztecAddress
  txHash: string
  claimed: boolean
}

export class PaylinkService extends ServiceBase {
  private sender: Account
  private tokenService: TokenService
  private contractService: ContractService // could also just get it from the singleton
  private registryAddress?: AztecAddress // For email and identity verification
  public txEffect?: TxEffect

  constructor(
    wallet: ObsidionWallet,
    sender: Account,
    tokenService: TokenService,
    contractService: ContractService,
    registryAddress?: AztecAddress,
    teeSigner?: RegisteredTeeSigner,
  ) {
    super(wallet, teeSigner)
    this.sender = sender
    this.tokenService = tokenService
    this.contractService = contractService
    this.registryAddress = registryAddress
  }

  /**
   * Single source of truth for `ClaimSubmitContext` shape, used by both
   * `claimPaylink` (claim path) and `refundPaylink` (refund path). Keeps
   * the field set aligned between the two routers and the
   * `preparePaylinkClaimSubmit` consumer.
   */
  private buildClaimSubmitContext(args: {
    paylinkInstance: ContractInstanceWithAddress
    paylinkKeys: PaylinkKeyMaterial
    depositTxHash?: TxHash
    feePaymentMethod?: FeePaymentMethod
    transferMeta?: Fr[]
    claimTerms?: Fr[]
  }): ClaimSubmitContext {
    return {
      tokenService: this.tokenService,
      teeSigner: this.getTeeSigner(),
      paylinkInstance: args.paylinkInstance,
      paylinkKeys: args.paylinkKeys,
      depositTxHash: args.depositTxHash,
      feePaymentMethod: args.feePaymentMethod,
      transferMeta: args.transferMeta,
      claimTerms: args.claimTerms,
    }
  }

  /**
   * Compute commitment hash for a paylink based on its type
   * Delegates to the appropriate processor
   * @param paylinkType - The type of paylink ("email")
   * @param input - Type-specific input (email string)
   * @returns Promise resolving to the commitment hash as Fr
   *
   * @example
   * const emailHash = await service.computeCommitmentHash("email", "user@example.com")
   */
  public async computeCommitmentHash(
    paylinkType: ContractName,
    input?: CommitmentInput,
  ): Promise<FieldLike> {
    const processor = PaylinkProcessorFactory.create(paylinkType)
    return await processor.computeCommitmentHash(input)
  }

  /**
   * Get the contract name for a given paylink type
   * @param paylinkType - The type of paylink
   * @returns The contract name
   */
  public getContractNameForType(paylinkType: ContractName): ContractName {
    const processor = PaylinkProcessorFactory.create(paylinkType)
    return processor.getContractName()
  }

  /**
   * Get deposit arguments for a paylink contract.
   *
   * The method name is retained for SDK compatibility; paylink instances are initializerless and
   * these values are passed as private calldata to `deposit`.
   * @param paylinkType - The type of paylink
   * @param args - The paylink deposit parameters
   * @returns Array of deposit arguments in the correct order
   */
  public getConstructorArgs(
    paylinkType: ContractName,
    args: PaylinkInitParams,
    meta: Fr[] = this.depositMeta(paylinkType, args),
  ): DepositArg[] {
    // TODO: we can probs do the same here for the other paylink types to make it cleaner.
    // with the paylink type as a key
    // Validate input parameters
    assert(typeof args.amount === "bigint", "amount must be a bigint")
    assert(args.amount > 0n, "amount must be greater than 0")
    assert(args.hash !== undefined && args.hash !== null, "hash must be provided")
    assert(args.token !== undefined && args.token !== null, "token must be provided")
    assertPaylinkWindow(args.window)

    const processor = PaylinkProcessorFactory.create(paylinkType)
    // Both flavors assert sender is present (refund rights bind to it); pass it through
    // only when a live account is set so pure arg-shaping fails loudly, not with a crash.
    return processor.getConstructorArgs({
      ...args,
      sender: this.sender?.getAddress(),
      meta,
    })
  }

  /** The terms of the note `deposit` writes for these args, which the link carries. */
  private async depositTerms(
    paylinkType: ContractName,
    args: PaylinkInitParams,
    meta: Fr[],
  ): Promise<Fr> {
    const note = await PaylinkProcessorFactory.create(paylinkType).depositNote({
      ...args,
      sender: this.sender?.getAddress(),
      meta,
    })
    return paylinkTerms(note)
  }

  /**
   * The funding transfer's `Transfer.meta`: the creator's memo and tag for the link holder, and the
   * created lane for the creator's own resync (`recoverPaylinkFromTransfer`). A link holder can read
   * the escrow's copy, so the lane carries only what the link gives them anyway: the escrow secret,
   * the fallback key's hash, the creation day and the lock email. The fallback secret stays with the
   * creator, who re-derives it from the master secret and the day. Keys without a `(day, n)` nonce
   * (bring-your-own) announce no link, since no master secret could re-derive them. The deposit
   * calldata and the sender's pull authwit must hash the same fields, so both derive it from here.
   */
  public depositMeta(
    paylinkType: ContractName,
    args: Pick<PaylinkInitParams, "memo" | "senderTag" | "email" | "paylinkKeys">,
  ): Fr[] {
    const keys = args.paylinkKeys
    return buildTransferMetaForSend({
      memo: args.memo,
      senderTag: args.senderTag,
      ...(keys?.nonce
        ? {
            paylinkCreated: {
              flavor: paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct",
              day: keys.nonce.day,
              secret: keys.secretKey,
              fallbackKeyHash: keys.fallbackKeyHash,
              email: args.email,
            },
          }
        : {}),
    })
  }

  /**
   * The link a funding transfer announces, or null. Creator-side: the sender's own Transfer copy
   * is what a resync reads. The lane's secret and fallback key must derive the escrow the transfer
   * funded, and one of the lane's day's nonce slots under this master secret must derive that same
   * secret and key. So a stray or forged lane never yields a link, and only the creator gets the
   * fallback secret back. The escrow may be of any class the flavor has had; the link carries it.
   */
  public async recoverPaylinkFromTransfer(
    event: ScannedTransferEvent,
    masterSecret: Fr,
  ): Promise<RecoveredPaylinkParams | null> {
    const lane = event.paylinkCreated
    if (!lane) return null
    const paylinkType = paylinkTypeOf(lane.flavor)
    const funded = AztecAddress.fromStringUnsafe(event.to)
    const current = await paylinkEscrowInstance(
      this.contractService,
      lane.flavor,
      lane.secret,
      lane.fallbackKeyHash,
    )
    const instance = current.address.equals(funded)
      ? current
      : (await escrowInstancesForKnownClasses(this.contractService, paylinkType, current)).find(
          (candidate) => candidate.address.equals(funded),
        )
    if (!instance) return null
    const keys = await findPaylinkKeysForDay(masterSecret, lane.day, lane.secret, paylinkType)
    if (!keys?.fallbackKeyHash.equals(lane.fallbackKeyHash)) return null
    return {
      ...(await this.linkParams(paylinkType, instance, keys)),
      paylinkType,
      txHash: event.txHash,
      amount: BigInt(event.amount),
      email: lane.email,
    }
  }

  /**
   * Prepare claim inputs for a given paylink type
   * @param paylinkType - The type of paylink
   * @param proof - The proof data
   * @returns Promise resolving to prepared claim inputs
   */
  public async prepareClaimInputs(paylinkType: ContractName, proof: ClaimInput): Promise<unknown> {
    const processor = PaylinkProcessorFactory.create(paylinkType)
    return await processor.prepareClaimInputs(proof)
  }

  /**
   * Get the appropriate claim service for a paylink type
   * @param paylinkType - The type of paylink
   * @returns The claim service instance
   */
  private getClaimService(paylinkType: ContractName): ClaimService {
    let service: ClaimService & ServiceBase
    switch (paylinkType) {
      case DEFAULT_CONTRACTS.paylinkEmail:
        if (!this.registryAddress) {
          throw new Error("Registry address is required for email paylinks")
        }
        service = new PaylinkEmailClaimService(this.wallet, this.sender)
        break

      case DEFAULT_CONTRACTS.paylinkDirect:
        service = new PaylinkDirectClaimService(this.wallet, this.sender)
        break

      default:
        throw new Error(`Unsupported paylink type: ${paylinkType}`)
    }
    this._profileDelegate = service
    return service
  }

  /**
   * Claim a paylink by routing to the appropriate service based on type
   * Orchestrates the claim process by delegating to child services
   * @param paylinkType - The type of paylink ("email", "direct")
   * @param claimParams - Common claim parameters (secret, addresses, recipient)
   * @param proof - Type-specific proof data (JWT for email)
   * @returns Promise resolving to transaction result
   *
   * @example
   * // Email claim
   * await paylinkService.claimPaylink("paylinkEmail", parsedLink, emailJwtProof)
   */
  public async claimPaylink(
    paylinkType: ContractName,
    claimParams: PaylinkParams,
    proof: ClaimInput,
    options?: MethodOptions,
  ): Promise<{
    txPromise: Promise<{ txHash: string; receipt: TxReceipt }>
    txHash: Promise<string>
  }> {
    const {
      contract: contractInstance,
      instance,
      keys: paylinkKeys,
      depositTxHash,
    } = await this.reconstructPaylinkContract(claimParams)

    // Prepare the proof data using the processor
    const preparedProof = await this.prepareClaimInputs(paylinkType, proof)

    // Get the appropriate service and call claimPayment
    const service = this.getClaimService(paylinkType)

    // Build the `submitContext` once and thread it through. Leaves do NOT
    // construct any of these themselves — keeping ownership in the router
    // avoids per-flavor drift and lets test fixtures stub the bag in one
    // place. `preparePaylinkClaimSubmit` (called by each leaf) builds the
    // paylink-flavoured spend-metadata resolver internally from the secret /
    // instance / deposit-tx-hash carried here.
    const submitContext = this.buildClaimSubmitContext({
      paylinkInstance: instance,
      paylinkKeys,
      depositTxHash,
      feePaymentMethod: options?.sendOptions?.fee?.paymentMethod,
      transferMeta: await this.payoutMeta(claimParams),
      claimTerms: await this.claimTerms(contractInstance, claimParams),
    })

    const result = await service.claimPayment(
      contractInstance,
      preparedProof,
      this.sender,
      submitContext,
      options,
    )

    return result
  }

  /**
   * Fee-paying `claim_to_l1`: burns the escrow straight to an Ethereum address (or a swap escrow —
   * see {@link ClaimToL1Args}) through the same `outerCall` TEE pipeline as `claimPaylink`. The
   * burn publishes the recipient and amount, so the claim is visible to anyone holding the link.
   */
  public async claimPaylinkToL1(
    claimParams: PaylinkParams,
    args: ClaimToL1Args,
    options?: MethodOptions,
  ): Promise<{
    txPromise: Promise<{ txHash: string; receipt: TxReceipt }>
    txHash: Promise<string>
  }> {
    const paylinkType = claimParams.paylinkType as ContractName
    const {
      contract: escrow,
      instance,
      keys,
      depositTxHash,
    } = await this.reconstructPaylinkContract(claimParams)

    const { amount } = await this.readEscrowNote(escrow, claimParams)
    const token = (await this.tokenService.getTokenContract()).address
    const payout = await planPayout(
      this.wallet,
      this.contractService,
      token,
      { from: escrow.address, recipient: args.l1Recipient, amount, proverTip: args.proverTip },
      args.withdrawal,
    )
    const interaction = escrow.methods.claim_to_l1!(
      ...(await paylinkL1ClaimArgs(
        paylinkType,
        { executor: payout.plainWithdrawal.executor, userPayload: payout.userPayload },
        args.proverTip,
        args.zkProof,
      )),
      ...(await this.claimTerms(escrow, claimParams)),
    )
    const submitContext = this.buildClaimSubmitContext({
      paylinkInstance: instance,
      paylinkKeys: keys,
      depositTxHash,
      feePaymentMethod: options?.sendOptions?.fee?.paymentMethod,
    })
    const { initFn, buildResult, sendOptions } = await preparePaylinkClaimSubmit({
      wallet: this.wallet,
      node: this.wallet.node,
      interaction,
      batchSender: this.sender.getAddress(),
      submitContext,
      options,
      teeUnsignedInteractions: payout.broadcasts,
      withdrawal: {
        declared: nestedWithdrawal(payout, {
          from: escrow.address,
          amount,
          proverTip: args.proverTip,
        }),
        plainWithdrawal: payout.plainWithdrawal,
      },
    })
    return this.sendAndWait(initFn, buildResult, {
      sendOptions,
      profile: options?.profile,
      operationId: options?.operationId,
      kind: options?.kind,
    })
  }

  /**
   * The link's escrow in this PXE: keys derived from the secret, the instance they address under
   * the link's class, its tag source and its funding tx. Refuses a class this deployment never
   * reviewed, or another chain. Idempotent.
   */
  public async reconstructPaylinkContract(params: PaylinkParams): Promise<{
    contract: ContractBase
    instance: ContractInstanceWithAddress
    keys: PaylinkKeyMaterial
    /** Undefined until the deposit is mined; the spend then anchors on the note's creation tx. */
    depositTxHash?: TxHash
  }> {
    const { artifact, keys, instance } = await registerEscrow(
      { wallet: this.wallet, contractService: this.contractService },
      params,
    )
    const contract = Contract.at(instance.address, artifact, this.wallet)
    const deposit = await escrowDepositTx(this.wallet, instance)
    return { contract, instance, keys, depositTxHash: deposit?.txHash }
  }

  /**
   * The link a create or a recovery hands out for this escrow. It carries the short link's seed only
   * when `announced`: the create tx also publishes the locator log the seed resolves through. A
   * recovery (no `created`) adds `escrowTagSecret`: its escrow may predate handshake tagging.
   */
  private async linkParams(
    paylinkType: ContractName,
    instance: ContractInstanceWithAddress,
    keys: PaylinkKeyMaterial,
    created?: { terms?: Fr; announced?: boolean },
  ): Promise<CreatedPaylinkParams> {
    assert(keys.fallbackSecret, "paylink key material lacks the creator's fallback secret")
    return {
      secret: keys.secretKey,
      paylinkType,
      fallbackKeyHash: keys.fallbackKeyHash,
      classId: instance.currentContractClassId,
      ...(await linkChainInfo(this.wallet)),
      ...(created
        ? {}
        : {
            escrowTagSecret: await computeEscrowTagSecret({
              instance,
              keyMaterial: keys,
              creator: this.sender.getAddress(),
            }),
          }),
      fallbackSecret: keys.fallbackSecret,
      ...(created?.announced && keys.link ? { seed: keys.link.seed } : {}),
      ...(created?.terms ? { terms: created.terms } : {}),
    }
  }

  /**
   * Refund a paylink. The contract gates on time from its anchor block: valid
   * until `refundable_until`, and again once the claim window has expired.
   * Both flavours mint a destination note back to the depositor via the oxide-token
   * `transfer(paylink, depositor, amount)` invoked inside
   * `execute_refund`.
   *
   * Dispatch shares the `outerCall` preparation pipeline with claim — the
   * inner-amount asserts run on-chain via the consumed note's amount, so
   * no `amount` parameter is needed at the TS layer.
   */
  public async refundPaylink(params: PaylinkParams, options?: MethodOptions<{ memo?: string }>) {
    const {
      contract: contractInstance,
      instance,
      keys: paylinkKeys,
      depositTxHash,
    } = await this.reconstructPaylinkContract(params)

    // Both flavors take an explicit sender + authwit nonce (sponsorable treatment);
    // a self-refund on the fee-paying path authorizes itself, so the nonce is 0.
    // The refund pays the creator back; its meta is their own memo, off the local row.
    const meta = buildTransferMetaForSend({ memo: options?.memo })
    const interaction = contractInstance.methods.refund!(this.sender.getAddress(), 0, meta)

    const submitContext = this.buildClaimSubmitContext({
      paylinkInstance: instance,
      paylinkKeys,
      depositTxHash,
      feePaymentMethod: options?.sendOptions?.fee?.paymentMethod,
      transferMeta: meta,
    })

    const { initFn, buildResult, sendOptions } = await preparePaylinkClaimSubmit({
      wallet: this.wallet,
      node: this.wallet.node,
      interaction,
      batchSender: this.sender.getAddress(),
      submitContext,
      options,
    })

    return this.sendAndWait(initFn, buildResult, {
      sendOptions,
      profile: options?.profile,
      operationId: options?.operationId,
      kind: options?.kind,
    })
  }

  // TODO: this is going to take alot of work to clean up and not just be happy path
  public async createPaylinkContract(
    args: PaylinkInitParams,
    paylinkType: ContractName,
    options?: MethodOptions<{
      resolveSpendMetadata?: SpendMetadataResolver
      resolveDepositSpendMetadata?: DepositSpendMetadataResolver
    }>,
  ) {
    // `args.token` has two consumers that MUST agree
    assert(
      args.token.equals(this.tokenService.tokenAddress),
      `paylink token ${args.token.toString()} does not match the wallet's token ${this.tokenService.tokenAddress.toString()}`,
    )

    assert(args.paylinkKeys || args.masterSecret, "masterSecret or paylinkKeys is required")
    const paylinkKeys =
      args.paylinkKeys ?? (await this.deriveDepositKeys(paylinkType, args.masterSecret!))

    const { instance, artifact } = await this.getContractInstance(
      paylinkType,
      [],
      undefined,
      paylinkKeys,
    )

    // Paylink instances are initializerless, so initHash is always zero and only their key material
    // varies the deterministic address. The deposit values are ordinary private calldata.
    const meta = this.depositMeta(paylinkType, { ...args, paylinkKeys })
    const depositArgs = this.getConstructorArgs(paylinkType, args, meta)

    await registerPaylinkContractWithKeys({
      wallet: this.wallet,
      instance,
      artifact,
      keyMaterial: paylinkKeys,
    })

    // create the auth witness for the token transfer inside deposit. Paylink's
    // `deposit` entrypoint calls `OxideToken::transfer(
    // sender, paylink, amount, meta)`. Inside the token, `_validate_from_private`
    // sees `from = sender ≠ msg_sender = paylink`, so it falls through to the
    // authwit branch — this witness is what satisfies it.
    const authwit = await this.tokenService.constructTransferCallAuthwit(
      args.amount,
      this.sender.getAddress(),
      instance.address,
      meta,
    )

    const contract = Contract.at(instance.address, artifact, this.wallet)

    // Paylink deposit nullifies sender notes via the inner
    // `transfer(sender, paylink, amount)` call inside the
    // oxide token. `prepareDepositSubmit` wraps `buildTeeOperation` with a
    // `kind: 'outerCall'` op so the seed / TEE notes / TEE metadata /
    // strict-mode capsules are populated for the inner call — without this,
    // the token contract's `capsules::load(...).unwrap()` reverts on
    // `AssertedNote::create`. The outer call is the paylink's manual initializer;
    // the token's `_validate_from_private` authwit branch is satisfied by `authwit`.
    const depositInteraction = contract.methods.deposit!(...depositArgs)
    // The announce shares the deposit's tx: a short link resolves only when the announcing tx
    // also initializes the escrow.
    const prepared = await this.linkParams(paylinkType, instance, paylinkKeys, {
      terms: await this.depositTerms(paylinkType, args, meta),
      announced: !!paylinkKeys.link && (await shortLinksEnabled(this.contractService)),
    })
    const announce =
      prepared.seed && paylinkKeys.link
        ? await linkAnnounceInteraction(
            this.wallet,
            this.contractService,
            LinkKind.Paylink,
            paylinkKeys.link,
            encodePaylinkLocatorPayload(prepared),
          )
        : undefined
    const { batchCall, sendOpts } = await prepareDepositSubmit({
      wallet: this.wallet,
      node: this.wallet.node,
      sender: this.sender.getAddress(),
      teeSigner: this.getTeeSigner(),
      tokenContract: await this.tokenService.getTokenContract(),
      depositInteraction,
      paylinkInstance: instance,
      authwit,
      teeUnsignedInteractions: announce ? [announce] : [],
      // Pin `kind` so the benchmark TEE-leg flow tag matches the prove-leg
      // (the dispatch below hardcodes `kind: "paylink-create"`); otherwise a
      // TEE-only orphan sample would fall back to the "send" default.
      options: {
        ...options,
        kind: "paylink-create",
        // The funding pull may lazily consume the sender's unclaimed deposits.
        resolveDepositSpendMetadata:
          options?.resolveDepositSpendMetadata ??
          (this.sender instanceof ObsidionAccount
            ? await this.sender.makeDepositSpendMetadataResolver()
            : undefined),
      },
    })

    // Route the staged deposit (sim-shape batch + `sendOpts.finalize`, which
    // carries the TEE pipeline) through the shared `sendAndWait` seam
    // (NO_WAIT under the hood — exactly like the legacy direct
    // `wallet.sendTx` path), unifying paylink-create onto the same send
    // abstraction every other Oxide flow uses. `silent: true` suppresses all
    // of `sendAndWait`'s own progress/status emissions so this stays
    // behavior-neutral vs. the old direct path (which emitted none): no
    // service-emitted status row, no Mining stage-complete, no reset-on-error.
    //
    // KNOWN DELTA vs. the old direct path (accepted): the old path passed no
    // `fee` to `wallet.sendTx`, so gas limits were the simulation-derived
    // exact estimate + the finalizer's declared delta. Through `sendAndWait`,
    // the payment method's own `getGasSettings()` (fallback maximums) reaches
    // `sendTx` as caller-supplied gasSettings and wins the override branch —
    // exactly as it already does for send/withdraw/claim/refund. Create now
    // converges with every other staged flow instead of being the one path
    // on exact limits.
    // `operationId` / `kind` still thread through to `wallet.sendTx` for
    // proving-scope registration (identical to the old path). See
    // `ServiceBase.sendAndWait`.
    const result = this.sendAndWait(
      async () => ({ interaction: batchCall, sendOpts }),
      ({ txHash, receipt }) => ({ txHash, receipt }),
      {
        sendOptions: {
          from: this.sender.getAddress(),
          additionalScopes: [instance.address],
          // The creator tags every note in this tx (the default sender), so their own change note
          // and Transfer copy stay discoverable on a fresh device. The escrow's note goes through a
          // handshake.
        },
        operationId: options?.operationId,
        kind: "paylink-create",
        silent: true,
        // Lazy-start: forward the confirm gate so `wallet.sendTx` blocks
        // sign/prove/submit until the UI resolves it. Already on
        // `BaseServiceMethodOptions`; behavior-neutral when absent.
        confirmGate: options?.confirmGate,
      },
    )

    // `sendAndWait` eagerly starts the receipt-wait (`txPromise`) — a
    // detached `waitForTx` poll that the legacy direct `wallet.sendTx(NO_WAIT)`
    // path did NOT start. It self-terminates once the deposit mines (seconds
    // in practice) and is bounded by `TESTNET_TIMEOUT`; we accept this benign
    // background poll as the cost of unifying onto `sendAndWait`. We return
    // off `sentTx` and never await `txPromise`, so attach a no-op catch to
    // swallow a late mining-failure rejection — otherwise it would surface as
    // an unhandled promise rejection after this method has already returned.
    result.txPromise.catch(() => {})

    // `sentTx` resolves only AFTER `aztecNode.sendTx` returns (post-submit,
    // pre-mining), preserving the invariant that the shareable URL is never
    // produced before the deposit tx is actually submitted.
    const sent = await result.sentTx

    const paylinkParams: SettledPaylinkParams = { ...prepared, txHash: sent.txHash }
    return paylinkParams
  }

  /**
   * Keys from `(masterSecret, day, n, flavor)` with `n` the first free slot today for this flavor,
   * so a wiped wallet re-derives them — and every escrow address — by scanning the nonce space.
   */
  private async deriveDepositKeys(
    paylinkType: ContractName,
    masterSecret: Fr,
  ): Promise<PaylinkKeyMaterial> {
    const artifact = await this.contractService.getArtifactForContract(paylinkType)
    const classIds = await this.contractService.getKnownClassIds(paylinkType)
    const day = epochDay(Math.floor(Date.now() / 1000))
    for (let n = 0; n < MAX_PAYLINK_NONCES_PER_DAY; n++) {
      const keys = await deriveDeterministicPaylinkKeys(masterSecret, day, n, paylinkType)
      const instance = await getContractInstanceFromInstantiationParams(artifact, {
        salt: new Fr(0n),
        publicKeys: keys.publicKeys,
      })
      if (await this.escrowSlotTaken(await escrowInstancesForClasses(instance, classIds))) continue
      return keys
    }
    throw new Error(`no free paylink nonce for day ${day} — daily creation cap reached`)
  }

  /**
   * Whether a slot is already used under any class: one of its escrows is registered in this PXE (a
   * create pending or mined from this device) or initialized on chain (any device). Keys ignore the
   * class, so an escrow of another class at the same slot shares the new link's secret, and its
   * holder could claim both. Two devices allocating one slot at the same moment is not covered.
   */
  private async escrowSlotTaken(escrows: ContractInstanceWithAddress[]): Promise<boolean> {
    for (const escrow of escrows) {
      if (await this.wallet.pxe.getContractInstance(escrow.address)) return true
    }
    const initNullifiers = await Promise.all(
      escrows.map((escrow) =>
        computeSiloedPrivateInitializationNullifier(escrow.address, escrow.initializationHash),
      ),
    )
    const leaves = await this.wallet.node.findLeavesIndexes(
      "latest",
      MerkleTreeId.NULLIFIER_TREE,
      initNullifiers,
    )
    return leaves.some((leaf) => leaf?.data !== undefined)
  }

  // For a paylink escrow contract, if we dont want to deploy the contract,
  // we are going to need to create the contract instance that we are going to register in
  // the pxe before sending the initialization transaction
  public async getContractInstance(
    escrowtype: ContractName,
    constructorArgs: unknown[],
    initializerName: string | undefined,
    paylinkKeys: PaylinkKeyMaterial,
  ) {
    // Retain the published SDK signature for callers migrating from initializer-backed paylinks.
    // The legacy shape only ever accepted an empty constructor argument list and `deposit` as the
    // initializer; both are now intentionally excluded from instance derivation.
    assert(constructorArgs.length === 0, "paylink instances do not accept constructor arguments")
    assert(
      initializerName === undefined || initializerName === "deposit",
      `unsupported legacy paylink initializer: ${initializerName}`,
    )
    const secret = paylinkKeys.secretKey

    const artifact = await this.contractService.getArtifactForContract(escrowtype)

    const instance = await getContractInstanceFromInstantiationParams(artifact, {
      salt: new Fr(0n),
      publicKeys: paylinkKeys.publicKeys,
    })

    this.assertEscrowClass(escrowtype, instance)

    return { instance, secret, artifact }
  }

  /**
   * Hold a derived escrow instance to the class the deployment states. The instance class comes
   * from the bundled artifact, so this compares what the served config states against what this
   * binary compiles. `getConfiguredClassId` throws when the document omits the entry — a profile
   * cannot skip the check by leaving it out; only a local-ledger service (the deploy tooling,
   * which states no class ids) skips.
   * Every path that derives an escrow instance to fund must call this, so a new link never uses a
   * class the deployment has moved off.
   */
  private assertEscrowClass(escrowtype: ContractName, instance: { currentContractClassId: Fr }) {
    const servedClassId = this.contractService.getConfiguredClassId(escrowtype)
    if (!servedClassId) return
    const actualClassId = instance.currentContractClassId.toString()
    assert(
      actualClassId.toLowerCase() === servedClassId.toLowerCase(),
      `Unexpected class ID for ${escrowtype}: got ${actualClassId}, expected ${servedClassId}`,
    )
  }

  /** The escrow a link addresses under the link's class. Nothing touches the PXE. */
  public async getContractAddress(params: PaylinkParams): Promise<AztecAddress> {
    return (await linkEscrow(this.contractService, params)).instance.address
  }

  /**
   * Compute the OAuth nonce for a paylink claim.
   * This nonce is passed to the identity provider (Google/Apple) during sign-in
   * and must match what the Noir contract verifies.
   *
   * @param noncePreimage - Random bigint generated by the claimer
   * @param address - Claimer's Aztec address as bigint
   * @returns Decimal string of poseidon2Hash([noncePreimage, address])
   */
  public static computeNonce(noncePreimage: bigint, address: bigint): string {
    return poseidon2Hash([noncePreimage, address]).toString(10)
  }

  /**
   * Check if a paylink has been claimed by looking for its nullifier in the tree.
   *
   * The paylink contract's `_get_note` pushes a custom nullifier:
   *   Poseidon2::hash([contract_address, storage_slot], 2)
   * using noir stdlib's Poseidon2 (IV = message_size * 2^64).
   *
   * The kernel then siloes it: siloNullifier(contract_address, inner_nullifier).
   *
   * IMPORTANT: noir stdlib's Poseidon2::hash differs from aztec's poseidon2HashWithSeparator.
   * Must use @zkpassport/poseidon2 (matches noir stdlib) for the inner nullifier.
   *
   * The storage_slot for `paylink_email_note` (first field in Storage) is 1.
   */
  private static readonly PAYLINK_NOTE_STORAGE_SLOT = 1n

  public async isPaylinkClaimed(params: PaylinkParams): Promise<boolean> {
    return (await this.paylinkClaimBlock(params)) !== undefined
  }

  /** The L2 block whose transaction spent the link's escrow; undefined while it is unspent. */
  public async paylinkClaimBlock(params: PaylinkParams): Promise<number | undefined> {
    assertLinkChain(params, await linkChainInfo(this.wallet))
    const contractAddress = await this.getContractAddress(params)

    // Replicate the contract's custom nullifier: Poseidon2::hash([contract_address, storage_slot], 2)
    // Uses @zkpassport/poseidon2 which matches noir stdlib's Poseidon2::hash
    const innerNullifier = new Fr(
      poseidon2Hash([contractAddress.toBigInt(), PaylinkService.PAYLINK_NOTE_STORAGE_SLOT]),
    )
    const siloedNullifier = await siloNullifier(contractAddress, innerNullifier)

    const [leafIndex] = await this.wallet.node.findLeavesIndexes(
      "latest",
      MerkleTreeId.NULLIFIER_TREE,
      [siloedNullifier],
    )

    return leafIndex?.data === undefined ? undefined : Number(leafIndex.l2BlockNumber)
  }

  /**
   * Enumerate every escrow this creator made, from the master secret alone — no share link, no
   * local state. Each hit carries everything `refundPaylink` needs.
   * This is only planned to be called by recovery kit.
   */
  public async recoverPaylinks(
    masterSecret: Fr,
    opts?: {
      fromDay?: number
      toDay?: number
      paylinkTypes?: ContractName[]
      /** Keep only escrows with this claim status. Omit for both. */
      claimed?: boolean
    },
  ): Promise<RecoveredPaylink[]> {
    const fromDay = opts?.fromDay ?? PAYLINK_NONCE_EPOCH_DAY
    // +1: creation stamps the day from wall clock, so a fast clock can put an escrow a day ahead.
    const toDay = opts?.toDay ?? epochDay(Math.floor(Date.now() / 1000)) + 1
    const paylinkTypes = opts?.paylinkTypes ?? [
      DEFAULT_CONTRACTS.paylinkDirect,
      DEFAULT_CONTRACTS.paylinkEmail,
    ]

    const recovered: RecoveredPaylink[] = []
    for (const paylinkType of paylinkTypes) {
      const artifact = await this.contractService.getArtifactForContract(paylinkType)
      const hits = await scanPaylinkEscrows({
        node: this.wallet.node,
        artifact,
        classIds: await this.contractService.getKnownClassIds(paylinkType),
        flavor: paylinkType,
        masterSecret,
        fromDay,
        toDay,
      })
      for (const hit of hits) {
        const params = await this.linkParams(paylinkType, hit.instance, hit.keys)
        // Claim status first — it decides whether the deposit-tx block read is worth doing.
        const claimed = await this.isPaylinkClaimed(params)
        if (opts?.claimed !== undefined && claimed !== opts.claimed) continue
        recovered.push({
          ...params,
          paylinkType,
          day: hit.day,
          n: hit.n,
          address: hit.address,
          txHash: (await findDepositTxHash(this.wallet.node, hit)).toString(),
          claimed,
        })
      }
    }
    return recovered
  }

  /**
   * Discover the paylink escrow note in the PXE via the contract's `sync_note()` utility.
   */
  public async sync_note(
    params: PaylinkParams,
    account: Account = this.sender,
  ): Promise<PaylinkNoteView> {
    const { contract } = await this.reconstructPaylinkContract(params)
    return this.readEscrowNote(contract, params, account)
  }

  /** The escrow's note, refused when it is not the one the link was made for. */
  private async readEscrowNote(
    contract: ContractBase,
    link: Pick<PaylinkParams, "terms">,
    account: Account = this.sender,
  ): Promise<PaylinkNoteView> {
    if (!contract.methods.sync_note) {
      throw new Error(`Contract ${contract.address.toString()} does not expose sync_note()`)
    }
    // Visitors have no account. ZERO is only a placeholder, not a valid note-discovery scope.
    const from = account.getAddress()
    const note = await sharedNoteRead(this.wallet, contract.address, async () => {
      const sim = await contract.methods.sync_note!().simulate({
        from: from.equals(AztecAddress.ZERO) ? NO_FROM : from,
        additionalScopes: [contract.address],
      })
      return buildPaylinkNoteView(sim.result)
    })
    await assertPaylinkTerms(link, note)
    return note
  }

  /** The trailing `terms` a claim on this escrow takes. */
  private claimTerms(
    escrow: ContractBase,
    link: PaylinkParams,
    account: Account = this.sender,
  ): Promise<Fr[]> {
    return claimTermsArgs(escrow.artifact, link, () => this.readEscrowNote(escrow, link, account))
  }

  /**
   * Everything chain says about a link: the escrow note (amount, windows, commitment) and the
   * funding transfer's lane (email, memo, sender tag). The transfer is read off the token the note names, so a
   * browser with no account and no token service still sees the memo. The transfer read is
   * fail-open: a note without its transfer still resolves, email-less.
   */
  public async resolveLink(
    params: PaylinkParams,
    account: Account = this.sender,
  ): Promise<ResolvedPaylink> {
    const { contract, instance, depositTxHash } = await this.reconstructPaylinkContract(params)
    const note = await this.readEscrowNote(contract, params, account)
    const deposit = await this.readDepositMetaOf(instance, depositTxHash, note.tokenAddress).catch(
      () => undefined,
    )
    return {
      note,
      txHash: depositTxHash?.toString(),
      email: deposit?.paylinkCreated?.email,
      commitment: note.hash,
      memo: deposit?.memo,
      senderTag: deposit?.senderTag,
      from: deposit?.from,
    }
  }

  /**
   * The funding transfer's `Transfer` event, addressed to the escrow and decrypted with the link's
   * keys. Its `meta` is the creator's memo / tag and the created lane; `from` is the creator, so a
   * reader can verify the tag the way the transfer scanner does. The deposit tx, when already
   * known, narrows the read; otherwise the escrow's first incoming transfer is it. Undefined until
   * the event is visible.
   */
  public async readDepositMeta(params: PaylinkParams): Promise<DepositMeta | undefined> {
    const { instance, depositTxHash } = await this.reconstructPaylinkContract(params)
    return this.readDepositMetaOf(instance, depositTxHash)
  }

  /**
   * The PXE decrypts a token's Transfer events only once it holds that token contract and its
   * immutables, which the token's `sync_state` reads.
   */
  private async registerToken(token: AztecAddress): Promise<void> {
    const artifact = await this.contractService.getArtifactForContract(
      DEFAULT_CONTRACTS.oxideToken,
      token,
    )
    await ensureContractRegisteredInPXE(this.wallet.pxe, this.wallet.node, token, () =>
      Promise.resolve(artifact),
    )
    await TokenService.ensureImmutablesStored(this.wallet, this.contractService, token)
  }

  private async readDepositMetaOf(
    instance: ContractInstanceWithAddress,
    txHash: TxHash | undefined,
    token: AztecAddress = this.tokenService.tokenAddress,
  ): Promise<DepositMeta | undefined> {
    await this.registerToken(token)
    const events = await this.wallet.getPrivateEvents<TransferEvent>(
      OxideTokenContract.events.Transfer,
      {
        ...(txHash ? { txHash } : {}),
        contractAddress: token,
        scopes: [instance.address],
      },
    )
    const hit = events.find(({ event }) => event.to.toString() === instance.address.toString())
    if (!hit) return undefined
    const meta = hit.event.meta.map(fieldLikeToFr)
    return { from: hit.event.from.toString(), meta, ...decodeTransferMeta(meta) }
  }

  /**
   * The claim payout meta: the deposit event's memo and tag, when readable, plus the payout lane
   * that lets the claimer rebuild this claim on a fresh device. A refund carries no lane.
   */
  private async payoutMeta(params: PaylinkParams): Promise<Fr[]> {
    let read: TransferMeta | undefined
    try {
      read = await this.readDepositMeta(params)
    } catch {
      read = undefined
    }
    return buildTransferMetaForSend({
      memo: read?.memo,
      senderTag: read?.senderTag,
      paylinkPayout: {
        flavor: params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct",
        secret: params.secret,
        fallbackKeyHash: params.fallbackKeyHash,
      },
    })
  }

  /**
   * Generate a self-contained payment link. The whole reconstruction payload rides inline in
   * the URL fragment as plaintext CBOR — no server, no encryption (the link is a bearer secret).
   * @param params - Paylink parameters to encode
   * @returns the payment link URL
   */
  public async generatePaymentLink(params: PaylinkParams): Promise<string> {
    // URL: <PAYLINK_DOMAIN>/claim#<base64url-cbor> (default paylink.zk.money). The payload rides in
    // the fragment so it never reaches a static host's request logs or Referer headers.
    return `${DOMAIN}/claim#${encodePaylinkInline(params)}`
  }

  /**
   * Parse a payment link URL back into paylink params by decoding its fragment. No network call.
   * Fails closed on malformed/oversized input (see the codec).
   * @param url - The payment link URL
   */
  public static async parsePaylinkUrl(url: string): Promise<PaylinkParams> {
    const fragment = new URL(url).hash.substring(1) // strip '#'
    if (!fragment) throw new Error("Invalid paylink URL format")
    return decodePaylinkInline(fragment)
  }

  // ─── ClaimFPC-sponsored (NO_FROM) legs ──────────────────────────────────────

  /**
   * The sender as its concrete alpha account — the sponsored legs need the
   * `authProvider` (intents-only signing) and spend-metadata resolver that the
   * base `Account` type doesn't surface.
   */
  private asObsidionAccount(): ObsidionAccount {
    if (!(this.sender instanceof ObsidionAccount)) {
      throw new Error("sponsored paylinks require an ObsidionAccount sender")
    }
    return this.sender
  }

  /**
   * ClaimFPC-sponsored, TEE-attested paylink creation (direct, or email-locked
   * when `email` is set). Mirrors `createPaylinkContract`'s key/instance setup,
   * but instead of paying through the sender's account it wraps the escrow
   * `deposit` in a ClaimFPC batch and submits NO_FROM; the escrow pulls funding
   * from the sender via the collapsed authwit. Returns the reconstruction
   * params for the share link.
   */
  public async createSponsoredPaylink(
    args: {
      amount: bigint
      token: AztecAddress
      window: PaylinkWindow
      /** Lock the claim to this email (zkJWT-gated at claim). Absent = direct flavor. */
      email?: { address: string; registryAddress: AztecAddress; vkeyHash: FieldLike }
      masterSecret: Fr
      /** See `PaylinkInitParams.memo` / `senderTag`. */
      memo?: string
      senderTag?: string
      /**
       * Hand one use of the creator's allowance to the escrow as a single-use note on the named
       * rail, so a link holder with no account can exit to Ethereum (`exitPaylinkWithVoucher`).
       * Rides the create batch as `gift_voucher`, filling it to `MAX_SPONSORED_CALLS`.
       */
      voucher?: { railId: number }
    },
    sponsor: PaylinkSponsorContext,
    options?: {
      operationId?: string
      /**
       * Receives the complete link before the passkey ceremony — the share URL can exist while the
       * deposit is still proving. Awaited, so a caller can persist it before the tx moves on.
       */
      onPrepared?: (params: CreatedPaylinkParams) => void | Promise<void>
      onTxHash?: TxHashCallback
    },
  ): Promise<SettledPaylinkParams> {
    assert(
      args.token.equals(this.tokenService.tokenAddress),
      `paylink token ${args.token.toString()} does not match the wallet's token ${this.tokenService.tokenAddress.toString()}`,
    )
    const account = this.asObsidionAccount()
    const user = account.getAddress()
    const { chainId, version } = await chainInfoFields(this.wallet)

    const paylinkType = args.email
      ? DEFAULT_CONTRACTS.paylinkEmail
      : DEFAULT_CONTRACTS.paylinkDirect
    const commitment = args.email
      ? await this.computeCommitmentHash(paylinkType, args.email.address)
      : undefined

    const artifact = await this.contractService.getArtifactForContract(paylinkType)
    const paylinkKeys = await this.deriveDepositKeys(paylinkType, args.masterSecret)
    // Counterfactual initializerless escrow — fixed salt/deployer and zero initHash, so the link
    // fragment alone reconstructs the address. Deposit params are private calldata.
    const meta = this.depositMeta(paylinkType, {
      memo: args.memo,
      senderTag: args.senderTag,
      email: args.email?.address,
      paylinkKeys,
    })
    const initArgs: PaylinkInitParams = {
      amount: args.amount,
      hash: commitment ?? 0n,
      token: args.token,
      window: args.window,
      memo: args.memo,
      ...(args.email
        ? { registry_address: args.email.registryAddress, vkey_hash: args.email.vkeyHash }
        : {}),
    }
    const depositArgs = this.getConstructorArgs(paylinkType, initArgs, meta)
    const instance = await getContractInstanceFromInstantiationParams(artifact, {
      salt: new Fr(0n),
      publicKeys: paylinkKeys.publicKeys,
    })
    this.assertEscrowClass(paylinkType, instance)
    await registerPaylinkContractWithKeys({
      wallet: this.wallet,
      instance,
      artifact,
      keyMaterial: paylinkKeys,
    })
    // The escrow tags its own PaylinkNote (`with_sender(self.address)` in `deposit`); this is what
    // makes that tag scannable here. PXE skips it when the escrow is already a local account.
    await this.wallet.registerSender(instance.address)
    const escrow = Contract.at(instance.address, artifact, this.wallet)

    const token = await this.tokenService.getTokenContract()
    const fpcArtifact = await registerSponsorFpc(this.wallet, sponsor)

    const prepared = await this.linkParams(paylinkType, instance, paylinkKeys, {
      terms: await this.depositTerms(paylinkType, initArgs, meta),
      announced: !!paylinkKeys.link && (await shortLinksEnabled(this.contractService)),
    })
    await options?.onPrepared?.(prepared)
    const announce =
      prepared.seed && paylinkKeys.link
        ? await linkAnnounceInteraction(
            this.wallet,
            this.contractService,
            LinkKind.Paylink,
            paylinkKeys.link,
            encodePaylinkLocatorPayload(prepared),
          )
        : undefined

    // One passkey signature covers the funding-pull intent AND unlocks the session.
    const pull = token.methods.transfer!(user, instance.address, args.amount, meta, 0)
    const intentHash = await computeAuthWitMessageHash(
      { caller: instance.address, action: pull },
      { chainId, version },
    )
    const authorized = await authorizeSponsoredBatch(
      this.wallet,
      this.contractService,
      sponsor,
      user,
      account.getAuthProvider(),
      [intentHash],
      { chainId, version },
    )
    const paying = sponsoredAccounts(sponsor, user)
    const op = await buildSponsoredTeeOperation(
      {
        wallet: this.wallet,
        node: this.wallet.node as never,
        operationId: options?.operationId,
        benchmarkFlow: "paylink-create",
      },
      {
        fpcAddress: sponsor.fpcAddress,
        fpcArtifact,
        railId: sponsor.railId,
        policy: sponsor.policy,
        ...paying.args,
        tokenContract: token,
        signer: this.getTeeSigner(),
        operations: [
          {
            kind: "outerCall",
            interaction: escrow.methods.deposit!(...depositArgs),
            additionalScopes: [instance.address],
          },
        ],
        buildOperationCall,
        resolveSpendMetadata: await account.makeSpendMetadataResolver(),
        // The funding pull may lazily consume the sender's unclaimed deposits.
        resolveDepositSpendMetadata: await account.makeDepositSpendMetadataResolver(),
        operationClassWitnesses: [await contractClassWitness(instance)],
        ...authorized,
        // The escrow is already in scope for its own notes, which the gift's tag also needs.
        teeUnsignedInteractions: [
          ...(announce ? [announce] : []),
          ...(args.voucher
            ? [
                // The gift spends a use of the payer's subscription.
                giftVoucherInteraction(
                  this.wallet,
                  sponsor,
                  paying.args.user,
                  instance.address,
                  args.voucher.railId,
                ),
              ]
            : []),
        ],
        gate: sponsor.subscribe?.gate,
      },
    )

    // The creator tags every note in this tx, including their own funding change note and the
    // refreshed ClaimFPC SubscriptionNote -- both of which their PXE must still find after a
    // reload, when the escrow is no longer one of its accounts. The escrow's note goes through a
    // handshake.
    const sent = await this.wallet.sendTx(op.payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [...paying.scopes, ...op.sendOpts.additionalScopes],
      finalize: op.sendOpts.finalize,
      fee: op.sendOpts.fee,
      operationId: options?.operationId,
      kind: "paylink-create",
      onTxHash: options?.onTxHash,
    })
    const txHash = (
      sent as { receipt?: { txHash?: { toString(): string } } }
    ).receipt?.txHash?.toString()
    if (!txHash) throw new Error("sponsored paylink create returned no tx hash")

    return { ...prepared, txHash }
  }

  /**
   * ClaimFPC-sponsored, TEE-attested paylink claim (direct, or email when
   * `options.zkProof` carries the claimer-bound zkJWT proof). The claim is
   * authorized BY the recipient (msg_sender is the FPC), so the escrow consumes
   * the recipient's authwit over the fresh-nonce'd claim intent. Returns the
   * claim tx hash.
   *
   * With `options.voucher` the link pays for itself: `sponsor` is the voucher rail, the escrow is
   * the batch's user and its gifted note pays, so the recipient needs no subscription — an account
   * fresh from signup claims for free. The option names the rail the voucher was gifted on, and a
   * sponsor on any other rail is refused before the escrow is read: the escrow holds no note there,
   * and the batch would only fail in proving. `options.withdraw` (or `voucher.withdraw`) is a second
   * operation in that same tx, not a follow-up: it burns a slice of the claimed note to L1 (the registration SIPA).
   * `options.broadcasts` ride the same batch unsigned by the enclave (the registration SIPA's own
   * broadcast); a batch with no room for them throws {@link ClaimBatchFullError} first.
   */
  public async claimSponsoredPaylink(
    claimParams: PaylinkParams,
    sponsor: PaylinkSponsorContext,
    options?: {
      operationId?: string
      /** Claimer-bound zkJWT proof (email flavor). Hex strings accepted — proof caches store hex. */
      zkProof?: {
        vkey: (FieldLike | string)[]
        proof: (FieldLike | string)[]
        public_inputs: string[]
      }
      voucher?: VoucherClaimOptions
      /** Same-batch burn; set even when the claim pays on the registered rail rather than a voucher. */
      withdraw?: PaylinkClaimWithdraw
      /** Calls the enclave does not sign that ride the claim batch, e.g. a SIPA broadcast. */
      broadcasts?: ContractFunctionInteraction[]
      onTxHash?: TxHashCallback
    },
  ): Promise<string> {
    const isEmail = claimParams.paylinkType === DEFAULT_CONTRACTS.paylinkEmail
    assert(
      claimParams.paylinkType === DEFAULT_CONTRACTS.paylinkDirect || isEmail,
      `sponsored claim supports direct and email paylinks, got ${claimParams.paylinkType}`,
    )
    if (options?.voucher && options.voucher.railId !== sponsor.railId) {
      throw new Error(
        `a voucher claim rides the rail its voucher was gifted on (rail ${options.voucher.railId}), ` +
          `not the sponsor's rail ${sponsor.railId}`,
      )
    }
    const prepared = await this.prepareSponsoredEscrow(claimParams, sponsor)
    const { escrow, user, meta, terms } = prepared
    const voucherBurn = options?.voucher?.withdraw
    const broadcasts = options?.broadcasts ?? []
    if (!isEmail && voucherBurn && "claim_with_withdrawal" in escrow.methods) {
      return (await this.claimWithWithdrawal(prepared, voucherBurn, sponsor, options, broadcasts))
        .txHash
    }
    if (broadcasts.length > 0) {
      throw new ClaimBatchFullError(
        "only a voucher claim that burns through claim_with_withdrawal has room for extra calls",
      )
    }

    let claimInteraction
    if (isEmail) {
      // Validated shape (field counts) via the flavor processor; the recipient slot
      // of the proof's public inputs must be the claiming account — the contract
      // verifies exactly that, so catch a mismatched proof here with a clear error.
      const { zkProof } = (await this.prepareClaimInputs(DEFAULT_CONTRACTS.paylinkEmail, {
        zkProof: options?.zkProof,
      } as ClaimInput)) as ZkProofClaimInput
      const [caller, emailHash, preEmailHash, audHash, iat, jwkId, hIss] =
        zkProof.public_inputs.map((hex: string) => Fr.fromHexString(hex))
      assert(
        caller!.equals(user.toField()),
        `zkJWT proof is bound to ${caller!.toString()}, not the claiming account`,
      )
      const toFr = (v: FieldLike | string) => (typeof v === "string" ? Fr.fromHexString(v) : v)
      claimInteraction = escrow.methods.claim!(
        zkProof.vkey.map(toFr),
        zkProof.proof.map(toFr),
        emailHash,
        preEmailHash,
        audHash,
        iat,
        jwkId,
        hIss,
        user,
        Fr.random(),
        meta,
        ...terms,
      )
    } else {
      claimInteraction = escrow.methods.claim!(user, Fr.random(), meta, ...terms)
    }
    const sent = await this.sendSponsoredEscrowCall(prepared, claimInteraction, sponsor, options)
    return sent.txHash
  }

  /**
   * ClaimFPC-sponsored, TEE-attested `claim_to_l1` (both flavors): the escrow burns its whole
   * balance to `l1Recipient` through the plain withdrawal executor instead of paying the claimer's
   * account. The prover tip and the relayer tip come out of the escrow amount. A swap-on-withdraw
   * passes the planned `SwapEscrow` as the recipient and its args as `withdrawal.swap`. Returns the
   * burn tx hash and block so the caller can track the withdrawal.
   */
  public async claimSponsoredPaylinkToL1(
    claimParams: PaylinkParams,
    l1Recipient: EthAddress,
    args: Omit<ClaimToL1Args, "l1Recipient">,
    sponsor: PaylinkSponsorContext,
    options?: { operationId?: string; zkProof?: PaylinkL1Proof; onTxHash?: TxHashCallback },
  ): Promise<{ txHash: string; blockNumber: number }> {
    const prepared = await this.prepareSponsoredEscrow(claimParams, sponsor)
    const { amount } = await this.readEscrowNote(prepared.escrow, claimParams, prepared.account)
    const payout = await planPayout(
      this.wallet,
      this.contractService,
      (
        await this.tokenService.getTokenContract()
      ).address,
      { from: prepared.escrow.address, recipient: l1Recipient, amount, proverTip: args.proverTip },
      args.withdrawal,
    )
    const claimArgs = await paylinkL1ClaimArgs(
      claimParams.paylinkType,
      { executor: payout.plainWithdrawal.executor, userPayload: payout.userPayload },
      args.proverTip,
      options?.zkProof ?? args.zkProof,
    )
    const interaction = prepared.escrow.methods.claim_to_l1!(...claimArgs, ...prepared.terms)
    return this.sendSponsoredEscrowCall(prepared, interaction, sponsor, options, {
      teeUnsignedInteractions: payout.broadcasts,
      plainWithdrawal: payout.plainWithdrawal,
      withdrawals: [
        nestedWithdrawal(payout, {
          from: prepared.escrow.address,
          amount,
          proverTip: args.proverTip,
        }),
      ],
      // The escrow note sizes any swap escrow the caller planned; a burn of anything else would
      // strand it in an escrow that never executes.
      expectedWithdrawalAmount: amount,
    })
  }

  /**
   * A voucher claim whose escrow burns the registration slice itself: `claim_with_withdrawal` pays
   * `withdraw` to L1 and the rest to this account, so the batch has no account call and no passkey
   * assertion. Only escrow classes carrying that function take this path.
   */
  private async claimWithWithdrawal(
    prepared: Awaited<ReturnType<PaylinkService["prepareSponsoredEscrow"]>>,
    withdraw: PaylinkClaimWithdraw,
    sponsor: PaylinkSponsorContext,
    options: { operationId?: string; onTxHash?: TxHashCallback } | undefined,
    broadcasts: ContractFunctionInteraction[] = [],
  ): Promise<{ txHash: string; blockNumber: number }> {
    const { escrow, user, meta, terms } = prepared
    const payout = await planPayout(
      this.wallet,
      this.contractService,
      (
        await this.tokenService.getTokenContract()
      ).address,
      {
        from: escrow.address,
        recipient: withdraw.l1Recipient,
        amount: withdraw.amount,
        proverTip: withdraw.proverTip,
      },
      withdraw.withdrawal,
    )
    // The claim, the payout's and the extra broadcasts, the finalization request the TEE batch
    // appends, and `publish_da`.
    const calls = 3 + payout.broadcasts.length + broadcasts.length
    if (calls > MAX_SPONSORED_CALLS) {
      throw new ClaimBatchFullError(
        `the claim batch would need ${calls} calls; the FPC dispatches at most ${MAX_SPONSORED_CALLS}`,
      )
    }
    // A per-call policy budgets each call at its worst case, which for this batch with a broadcast
    // riding it sums above the flat caps the deployment prices; only an open policy declares those.
    if (broadcasts.length > 0 && !claimFpcPolicySponsorsAnyCall(sponsor.policy)) {
      throw new ClaimBatchFullError(
        "a per-call policy cannot sponsor a claim with a withdrawal and a broadcast in one batch",
      )
    }
    const interaction = escrow.methods.claim_with_withdrawal!(
      user,
      withdraw.amount,
      payout.plainWithdrawal.executor,
      getUserPayloadHash(payout.userPayload),
      withdraw.proverTip,
      meta,
      ...terms,
    )
    return this.sendSponsoredEscrowCall(
      prepared,
      interaction,
      sponsor,
      {
        operationId: options?.operationId,
        onTxHash: options?.onTxHash,
        voucher: { railId: sponsor.railId },
      },
      {
        accountFree: true,
        teeUnsignedInteractions: [...payout.broadcasts, ...broadcasts],
        plainWithdrawal: payout.plainWithdrawal,
        withdrawals: [
          nestedWithdrawal(payout, {
            from: escrow.address,
            amount: withdraw.amount,
            proverTip: withdraw.proverTip,
          }),
        ],
        expectedWithdrawalAmount: withdraw.amount,
      },
    )
  }

  /** Rebuild the escrow in this PXE and register what a sponsored call on it needs. */
  private async prepareSponsoredEscrow(claimParams: PaylinkParams, sponsor: PaylinkSponsorContext) {
    const account = this.asObsidionAccount()
    const user = account.getAddress()
    const paylinkType = claimParams.paylinkType as ContractName
    const { instance, keys, depositTxHash } = await this.reconstructPaylinkContract(claimParams)
    const artifact = await this.contractService.getArtifactForContract(
      paylinkType,
      instance.address,
    )
    const escrow = Contract.at(instance.address, artifact, this.wallet)
    const fpcArtifact = await registerSponsorFpc(this.wallet, sponsor)
    const meta = await this.payoutMeta(claimParams)
    const terms = await this.claimTerms(escrow, claimParams, account)
    return {
      account,
      user,
      instance,
      keys,
      depositTxHash,
      escrow,
      fpcArtifact,
      claimParams,
      meta,
      terms,
    }
  }

  /**
   * Send one escrow interaction as an FPC-sponsored `outerCall` TEE operation, authorized by the
   * user's authwit over the call intent. Resolves once the tx is mined.
   */
  private async sendSponsoredEscrowCall(
    prepared: Awaited<ReturnType<PaylinkService["prepareSponsoredEscrow"]>>,
    interaction: ContractFunctionInteraction,
    sponsor: PaylinkSponsorContext,
    options?: {
      operationId?: string
      voucher?: VoucherClaimOptions
      withdraw?: PaylinkClaimWithdraw
      onTxHash?: TxHashCallback
    },
    extra?: Pick<
      SponsoredTeeOperationArgs,
      "teeUnsignedInteractions" | "expectedWithdrawalAmount" | "plainWithdrawal"
    > & {
      withdrawals?: WithdrawOperation[]
      /** The escrow pays and its call needs no authwit, so the account authorizes nothing. */
      accountFree?: boolean
    },
  ): Promise<{ txHash: string; blockNumber: number }> {
    const { account, user, instance, keys, depositTxHash, fpcArtifact } = prepared
    const { chainId, version } = await chainInfoFields(this.wallet)
    const token = await this.tokenService.getTokenContract()
    const intentHash = await computeAuthWitMessageHash(
      { caller: sponsor.fpcAddress, action: interaction },
      { chainId, version },
    )
    const withdraw = options?.withdraw ?? options?.voucher?.withdraw
    const planned =
      withdraw &&
      (await planWithdrawal(
        this.wallet,
        this.contractService,
        token.address,
        {
          from: user,
          recipient: withdraw.l1Recipient,
          amount: withdraw.amount,
          proverTip: withdraw.proverTip,
          authwitNonce: Fr.random(),
        },
        withdraw.withdrawal,
      ))
    const withdrawOp: Operation | undefined = planned?.operation
    const intentHashes = [intentHash]
    if (withdrawOp) {
      intentHashes.push(
        await computeAuthWitMessageHash(
          { caller: sponsor.fpcAddress, action: buildTokenOperationCall(token, withdrawOp, []) },
          { chainId, version },
        ),
      )
    }
    const authorized = extra?.accountFree
      ? undefined
      : await authorizeSponsoredBatch(
          this.wallet,
          this.contractService,
          sponsor,
          user,
          account.getAuthProvider(),
          intentHashes,
          { chainId, version },
        )
    const paying = sponsoredAccounts(sponsor, user)
    // The voucher is the escrow's note, so the escrow pays; the account still authorizes its calls.
    const payer = options?.voucher ? instance.address : paying.args.user
    const op = await buildSponsoredTeeOperation(
      {
        wallet: this.wallet,
        node: this.wallet.node as never,
        operationId: options?.operationId,
        benchmarkFlow: "paylink-claim",
      },
      {
        fpcAddress: sponsor.fpcAddress,
        fpcArtifact,
        railId: sponsor.railId,
        policy: sponsor.policy,
        user: payer,
        ...(authorized && { intentsAccount: user, ...authorized }),
        tokenContract: token,
        signer: this.getTeeSigner(),
        operations: [
          {
            kind: "outerCall",
            interaction,
            additionalScopes: [instance.address],
            withdrawals: extra?.withdrawals,
          },
          ...(withdrawOp ? [withdrawOp] : []),
        ],
        buildOperationCall: (op, capsules) =>
          op.kind === "outerCall"
            ? buildOperationCall(op, capsules)
            : buildTokenOperationCall(token, op, capsules),
        resolveSpendMetadata: makePaylinkSpendMetadataResolver(instance, depositTxHash, keys),
        operationClassWitnesses: [
          await contractClassWitness(instance),
          ...(withdrawOp ? [undefined] : []),
        ],
        gate: sponsor.subscribe?.gate,
        teeUnsignedInteractions: [
          ...(extra?.teeUnsignedInteractions ?? []),
          ...(planned?.broadcasts ?? []),
        ],
        plainWithdrawal: extra?.plainWithdrawal ?? planned?.plainWithdrawal,
        expectedWithdrawalAmount: extra?.expectedWithdrawalAmount,
      },
    )

    const sent = await this.wallet.sendTx(op.payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [
        ...(options?.voucher ? [user] : paying.scopes),
        ...op.sendOpts.additionalScopes,
      ],
      finalize: op.sendOpts.finalize,
      fee: op.sendOpts.fee,
      operationId: options?.operationId,
      kind: "paylink-claim",
      onTxHash: options?.onTxHash,
    })
    const receipt = (sent as { receipt?: TxReceipt }).receipt
    const txHash = receipt?.txHash?.toString()
    if (!txHash) throw new Error("sponsored paylink claim returned no tx hash")
    return { txHash, blockNumber: Number(receipt!.blockNumber) }
  }

  /**
   * ClaimFPC-sponsored, TEE-attested paylink refund (both flavors). The refund is
   * authorized BY the original sender (msg_sender is the FPC), so the escrow
   * consumes the sender's authwit over the fresh-nonce'd refund intent;
   * `execute_refund` still binds the payout to the note's sender_hash and
   * gates on time from the anchor block. Returns the refund tx hash.
   */
  public async refundSponsoredPaylink(
    claimParams: PaylinkParams,
    sponsor: PaylinkSponsorContext,
    options?: { operationId?: string; memo?: string; onTxHash?: TxHashCallback },
  ): Promise<string> {
    const account = this.asObsidionAccount()
    const user = account.getAddress()
    const { chainId, version } = await chainInfoFields(this.wallet)

    const paylinkType = claimParams.paylinkType as ContractName
    const { instance, keys, depositTxHash } = await this.reconstructPaylinkContract(claimParams)
    const artifact = await this.contractService.getArtifactForContract(
      paylinkType,
      instance.address,
    )
    const escrow = Contract.at(instance.address, artifact, this.wallet)

    const token = await this.tokenService.getTokenContract()
    const fpcArtifact = await registerSponsorFpc(this.wallet, sponsor)

    const meta = buildTransferMetaForSend({ memo: options?.memo })
    const refundInteraction = escrow.methods.refund!(user, Fr.random(), meta)
    const refundIntentHash = await computeAuthWitMessageHash(
      { caller: sponsor.fpcAddress, action: refundInteraction },
      { chainId, version },
    )
    const authorized = await authorizeSponsoredBatch(
      this.wallet,
      this.contractService,
      sponsor,
      user,
      account.getAuthProvider(),
      [refundIntentHash],
      { chainId, version },
    )
    const paying = sponsoredAccounts(sponsor, user)
    const op = await buildSponsoredTeeOperation(
      {
        wallet: this.wallet,
        node: this.wallet.node as never,
        operationId: options?.operationId,
        benchmarkFlow: "paylink-refund",
      },
      {
        fpcAddress: sponsor.fpcAddress,
        fpcArtifact,
        railId: sponsor.railId,
        policy: sponsor.policy,
        ...paying.args,
        tokenContract: token,
        signer: this.getTeeSigner(),
        operations: [
          {
            kind: "outerCall",
            interaction: refundInteraction,
            additionalScopes: [instance.address],
          },
        ],
        buildOperationCall,
        resolveSpendMetadata: makePaylinkSpendMetadataResolver(instance, depositTxHash, keys),
        operationClassWitnesses: [await contractClassWitness(instance)],
        ...authorized,
        gate: sponsor.subscribe?.gate,
      },
    )

    const sent = await this.wallet.sendTx(op.payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [...paying.scopes, ...op.sendOpts.additionalScopes],
      finalize: op.sendOpts.finalize,
      fee: op.sendOpts.fee,
      operationId: options?.operationId,
      kind: "paylink-refund",
      onTxHash: options?.onTxHash,
    })
    const txHash = (
      sent as { receipt?: { txHash?: { toString(): string } } }
    ).receipt?.txHash?.toString()
    if (!txHash) throw new Error("sponsored paylink refund returned no tx hash")
    return txHash
  }
}
