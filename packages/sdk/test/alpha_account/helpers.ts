import type { BatchCall } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod, SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Gas, GasSettings } from "@aztec-labs/stdlib/gas"
import type { TxExecutionRequest } from "@aztec-labs/stdlib/tx"
import type { PXE } from "@aztec-labs/pxe/server"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"

import type { OxideTokenContract } from "../../src/index.js"
import { buildTeeOperation } from "../../src/index.js"
import { proveTxWithProgress } from "../../src/obsidion/proving-progress-helpers.js"
import type { ObsidionAccount } from "../../src/obsidion/alpha/account/ObsidionAccount.js"
import type { ObsidionWalletTest } from "../../src/obsidion/ObsidionWalletTest.js"
import type {
  DepositSpendMetadataResolver,
  Operation,
  SpendMetadataResolver,
} from "../../src/oxide/index.js"
import type { OxideTokenSandbox } from "../utils/oxide/oxideTokenSandbox.js"
import { profileExecutionPayload } from "../utils/bench/profiler.js"
import { emptyTransferMeta } from "@obsidion/core/constants"

export type OxideTokenTeeTestContext = {
  wallet: ObsidionWalletTest
  tokenContract: OxideTokenContract
  teeSigner: RegisteredTeeSigner
  paymentMethod: SponsoredFeePaymentMethod
}

export function teeContextFromSandbox(sandbox: OxideTokenSandbox): OxideTokenTeeTestContext {
  return {
    wallet: sandbox.wallet,
    tokenContract: sandbox.tokenContract,
    teeSigner: sandbox.teeSigner,
    paymentMethod: sandbox.sponsoredFeePaymentMethod,
  }
}

export async function getSandboxGasSettings(node: AztecNode): Promise<GasSettings> {
  const [fees, { txsLimits }] = await Promise.all([node.getCurrentMinFees(), node.getNodeInfo()])
  return GasSettings.fallback({ gasLimits: Gas.from(txsLimits.gas), maxFeesPerGas: fees })
}

/** Prove + submit a hand-built `TxExecutionRequest` outside `wallet.sendTx`. */
export async function proveAndSendTxRequest(
  pxe: PXE,
  node: AztecNode,
  txRequest: TxExecutionRequest,
) {
  const provenTx = await proveTxWithProgress(
    pxe,
    txRequest,
    {
      scopes: [txRequest.origin],
      senderForTags: txRequest.origin,
    },
    { sync: true },
  )
  const tx = await provenTx.toTx()
  const txHash = tx.getTxHash()
  await node.sendTx(tx)
  return waitForTx(node, txHash)
}

export type TeeCallResult = {
  batchCall: BatchCall
  sendOptions: {
    from: AztecAddress
    fee: { paymentMethod: FeePaymentMethod } | undefined
    additionalScopes: AztecAddress[] | undefined
    finalize: Awaited<ReturnType<typeof buildTeeOperation>>["sendOpts"]["finalize"]
  }
}

/** OxideToken needs TEE capsules; bare `.send()` fails in brillig note preprocessing. */
export async function buildOxideTokenTeeCall(
  ctx: OxideTokenTeeTestContext,
  from: AztecAddress,
  op: Operation,
  resolveSpendMetadata: SpendMetadataResolver,
  resolveDepositSpendMetadata?: DepositSpendMetadataResolver,
): Promise<TeeCallResult> {
  const { batchCall, sendOpts } = await buildTeeOperation(
    { wallet: ctx.wallet, node: ctx.wallet.node, paymentMethod: ctx.paymentMethod },
    from,
    {
      tokenContract: ctx.tokenContract,
      signer: ctx.teeSigner,
      operations: [op],
      buildOperationCall: (o, capsules) => {
        switch (o.kind) {
          case "transfer":
            return ctx.tokenContract.methods.transfer!(
              o.from,
              o.to,
              o.amount,
              emptyTransferMeta(),
              0,
            ).with({ capsules })
          case "outerCall":
            return o.interaction.with({ capsules, authWitnesses: o.authwits ?? [] })
          default:
            throw new Error(`unsupported op kind in alpha account tests: ${o.kind}`)
        }
      },
      resolveSpendMetadata,
      resolveDepositSpendMetadata,
    },
  )
  return {
    batchCall,
    sendOptions: {
      from,
      fee: sendOpts.fee,
      additionalScopes: sendOpts.additionalScopes,
      finalize: sendOpts.finalize,
    },
  }
}

export async function buildAlphaTeeCall(
  ctx: OxideTokenTeeTestContext,
  account: ObsidionAccount,
  op: Operation,
): Promise<TeeCallResult> {
  return buildOxideTokenTeeCall(
    ctx,
    account.getAddress(),
    op,
    await account.makeSpendMetadataResolver(),
    await account.makeDepositSpendMetadataResolver(),
  )
}

export async function sendOxideTokenTransferViaTee(
  ctx: OxideTokenTeeTestContext,
  from: AztecAddress,
  to: AztecAddress,
  amount: bigint,
  resolveSpendMetadata: SpendMetadataResolver,
  resolveDepositSpendMetadata?: DepositSpendMetadataResolver,
) {
  const { batchCall, sendOptions } = await buildOxideTokenTeeCall(
    ctx,
    from,
    { kind: "transfer", from, to, amount },
    resolveSpendMetadata,
    resolveDepositSpendMetadata,
  )
  return batchCall.send(sendOptions)
}

export async function sendAlphaTransferViaTee(
  ctx: OxideTokenTeeTestContext,
  account: ObsidionAccount,
  to: AztecAddress,
  amount: bigint,
) {
  const { batchCall, sendOptions } = await buildAlphaTeeCall(ctx, account, {
    kind: "transfer",
    from: account.getAddress(),
    to,
    amount,
  })
  return batchCall.send(sendOptions)
}

export async function profileTeeBatch(
  ctx: OxideTokenTeeTestContext,
  batchCall: BatchCall,
  from: AztecAddress,
  label: string,
) {
  await profileExecutionPayload(ctx.wallet, await batchCall.request(), { from, label })
}

/** Alpha-account tests: spend metadata comes from the account's own keys. */
export function createAlphaTeeHelpers(ctx: OxideTokenTeeTestContext) {
  return {
    buildTeeCall: (account: ObsidionAccount, op: Operation) => buildAlphaTeeCall(ctx, account, op),
    sendTransferViaTee: (account: ObsidionAccount, to: AztecAddress, amount: bigint) =>
      sendAlphaTransferViaTee(ctx, account, to, amount),
    profileTeeBatch: (batchCall: BatchCall, from: AztecAddress, label: string) =>
      profileTeeBatch(ctx, batchCall, from, label),
  }
}

/** Schnorr-fixture callers: use the sandbox metadata resolvers. */
export function createOxideTokenTeeHelpers(
  ctx: OxideTokenTeeTestContext,
  resolveSpendMetadata: SpendMetadataResolver,
  resolveDepositSpendMetadata?: DepositSpendMetadataResolver,
) {
  return {
    buildTeeCall: (from: AztecAddress, op: Operation) =>
      buildOxideTokenTeeCall(ctx, from, op, resolveSpendMetadata, resolveDepositSpendMetadata),
    sendTransferViaTee: (from: AztecAddress, to: AztecAddress, amount: bigint) =>
      sendOxideTokenTransferViaTee(
        ctx,
        from,
        to,
        amount,
        resolveSpendMetadata,
        resolveDepositSpendMetadata,
      ),
  }
}
