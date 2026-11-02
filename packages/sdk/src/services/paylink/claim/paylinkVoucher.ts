import { nestedWithdrawal, planPayout, type WithdrawalOptions } from "../../withdrawal/plainWithdrawal.js"
/**
 * A paylink's voucher: the escrow's own single-use subscription on the ClaimFPC voucher rail, gifted
 * by the creator in the create batch and spent by whoever holds the link. These legs take a wallet,
 * the contract service and a TEE signer, never an account: the escrow's keys, derived from the link's
 * secret, are the only identity a sponsored exit needs, so a recipient with no account, passkey or
 * registration can burn the escrow to an Ethereum address.
 */
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import {
  type ContractService,
  DEFAULT_CONTRACTS,
  ensureContractRegisteredInPXE,
} from "@obsidion/contracts"
import type { ObsidionWallet, TxHashCallback } from "../../../obsidion/ObsidionWallet.js"
import {
  contractClassWitness,
  registerSponsorFpc,
  type ClaimSponsorContext,
} from "../../claimFpc/claimSponsor.js"
import type { PaylinkParams } from "../PaylinkService.js"
import { buildSponsoredTeeOperation } from "../../tee/sponsoredTeeOperation.js"
import { TokenService } from "../../token/TokenService.js"
import { buildOperationCall } from "./paylinkClaimSubmit.js"
import { registerEscrow, sharedNoteRead } from "../escrow/escrowRegistration.js"
import { paylinkL1ClaimArgs, type PaylinkL1Proof } from "./paylinkL1Claim.js"
import {
  assertPaylinkTerms,
  buildPaylinkNoteView,
  claimTermsArgs,
  type PaylinkNoteView,
} from "../escrow/paylinkNoteData.js"
import { findEscrowDepositTx } from "../escrow/paylinkRecovery.js"
import { makePaylinkSpendMetadataResolver } from "./paylinkSpendMetadata.js"

export interface PaylinkVoucherDeps {
  wallet: ObsidionWallet
  contractService: ContractService
  /** The voucher rail (`railByName`), where the escrow's note lives. */
  sponsor: ClaimSponsorContext
}

export { registerEscrow }

/**
 * The escrow note behind a link, read with no account: what a bearer cash-out can burn. Refuses a
 * note other than the one the link was made for.
 */
export async function readPaylinkEscrowNote(
  deps: Pick<PaylinkVoucherDeps, "wallet" | "contractService">,
  params: PaylinkParams,
): Promise<PaylinkNoteView> {
  const { instance, artifact } = await registerEscrow(deps, params)
  const note = await sharedNoteRead(deps.wallet, instance.address, async () => {
    const escrow = Contract.at(instance.address, artifact, deps.wallet)
    const sim = await escrow.methods.sync_note!().simulate({
      from: NO_FROM,
      additionalScopes: [instance.address],
    })
    return buildPaylinkNoteView(sim.result)
  })
  await assertPaylinkTerms(params, note)
  return note
}

/** Sponsored txs the link's escrow still holds on the voucher rail: how many exits it can pay for. */
export async function paylinkVoucherUses(
  deps: PaylinkVoucherDeps,
  params: PaylinkParams,
): Promise<number> {
  const { instance } = await registerEscrow(deps, params)
  const fpcArtifact = await registerSponsorFpc(deps.wallet, deps.sponsor)
  const fpc = Contract.at(deps.sponsor.fpcAddress, fpcArtifact, deps.wallet)
  const result = await fpc.methods.get_subscription_uses!(
    instance.address,
    deps.sponsor.railId,
  ).simulate({ from: instance.address, additionalScopes: [instance.address] } as never)
  return Number((result as { result: unknown }).result)
}

export interface PaylinkExitArgs extends PaylinkVoucherDeps {
  params: PaylinkParams
  tokenAddress: AztecAddress
  signer: RegisteredTeeSigner
  l1Recipient: EthAddress
  /** Defaults to zero; the portal pays it out of `amount` on L1. */
  proverTip?: bigint
  withdrawal: WithdrawalOptions
  operationId?: string
  zkProof?: PaylinkL1Proof
  onTxHash?: TxHashCallback
}

/**
 * Burn a vouchered link's escrow to `l1Recipient` through the ClaimFPC voucher rail. The escrow is
 * the batch's `user` and its own note pays, so no account call rides the batch and no account is
 * needed to build it. Email exits carry a zkJWT proof bound to the payout.
 */
export async function exitPaylinkWithVoucher(
  args: PaylinkExitArgs,
): Promise<{ txHash: string; blockNumber: number; amount: bigint; l1Recipient: string }> {
  const { params } = args
  const proverTip = args.proverTip ?? 0n
  const { instance, keys, artifact } = await registerEscrow(args, params)
  const note = await readPaylinkEscrowNote(args, params)
  const { amount, tokenAddress } = note
  if (!tokenAddress.equals(args.tokenAddress)) {
    throw new Error("The paylink note token differs from its withdrawal source")
  }
  const payout = await planPayout(
    args.wallet,
    args.contractService,
    args.tokenAddress,
    { from: instance.address, recipient: args.l1Recipient, amount, proverTip },
    args.withdrawal,
  )
  const claimArgs = [
    ...(await paylinkL1ClaimArgs(
      params.paylinkType,
      { executor: payout.plainWithdrawal.executor, userPayload: payout.userPayload },
      proverTip,
      args.zkProof,
    )),
    ...(await claimTermsArgs(artifact, params, async () => note)),
  ]
  const fpcArtifact = await registerSponsorFpc(args.wallet, args.sponsor)
  const tokenArtifact = await args.contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.oxideToken,
    args.tokenAddress,
  )
  await ensureContractRegisteredInPXE(args.wallet.pxe, args.wallet.node, args.tokenAddress, () =>
    Promise.resolve(tokenArtifact),
  )
  await TokenService.ensureImmutablesStored(args.wallet, args.contractService, args.tokenAddress)
  const token = Contract.at(args.tokenAddress, tokenArtifact, args.wallet)
  const escrow = Contract.at(instance.address, artifact, args.wallet)

  const op = await buildSponsoredTeeOperation(
    {
      wallet: args.wallet,
      node: args.wallet.node as never,
      operationId: args.operationId,
      benchmarkFlow: "paylink-claim",
    },
    {
      fpcAddress: args.sponsor.fpcAddress,
      fpcArtifact,
      railId: args.sponsor.railId,
      policy: args.sponsor.policy,
      user: instance.address,
      tokenContract: token,
      signer: args.signer,
      operations: [
        {
          kind: "outerCall",
          interaction: escrow.methods.claim_to_l1!(...claimArgs),
          additionalScopes: [instance.address],
          withdrawals: [nestedWithdrawal(payout, { from: instance.address, amount, proverTip })],
        },
      ],
      buildOperationCall,
      resolveSpendMetadata: makePaylinkSpendMetadataResolver(
        instance,
        (
          await findEscrowDepositTx(args.wallet.node, instance)
        )?.txHash,
        keys,
      ),
      operationClassWitnesses: [await contractClassWitness(instance)],
      teeUnsignedInteractions: payout.broadcasts,
      plainWithdrawal: payout.plainWithdrawal,
      // The escrow note sizes any swap escrow the caller planned; a burn of anything else would
      // strand it in an escrow that never executes.
      expectedWithdrawalAmount: amount,
    },
  )

  // The escrow is the only identity in the tx: it is the batch's user, the tag sender and the scope.
  const sent = await args.wallet.sendTx(op.payload, {
    from: NO_FROM,
    sendMessagesAs: instance.address,
    additionalScopes: [instance.address, ...op.sendOpts.additionalScopes],
    finalize: op.sendOpts.finalize,
    fee: op.sendOpts.fee,
    operationId: args.operationId,
    kind: "paylink-claim",
    onTxHash: args.onTxHash,
  })
  const receipt = (sent as { receipt?: { txHash?: { toString(): string }; blockNumber?: number } })
    .receipt
  if (!receipt?.txHash) throw new Error("sponsored paylink exit returned no tx hash")
  return {
    txHash: receipt.txHash.toString(),
    blockNumber: receipt.blockNumber ?? 0,
    amount,
    l1Recipient: args.l1Recipient.toString(),
  }
}
