// The self-finalize exit for an L2->L1 withdrawal the relayer has not released: given the burn tx
// hash and its owner, assemble the `OxidePortal.withdraw` call anyone may submit. The owner recovers
// the withdrawal's finalization data from the burn's recovery events. The portal pays the executor
// the burn named, which takes its fee, pays the burn's relayer tip to `tipRecipient` and the rest to
// the recipient the burn named.
//
// A relayer that wins the race makes this call revert (`OxidePortal__WithdrawalAlreadyClaimed`);
// the already-finalized read below is the cheap refusal before the enclave signs.
//
// This module stops at the calldata; who signs and broadcasts it is the caller's business.
//
// Narrow subpath imports only — the `@oxide/*` barrels re-export node-only modules that break
// browser bundles.
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { TxHash } from "@aztec-labs/stdlib/tx"

import { OxidePortalAbi } from "@oxide/l1-contracts/artifacts.js"
import { resolveTxCheckpointArchive } from "@oxide/oxide-client/archive_ref.js"
import { buildWithdrawalFinalizationCalldata } from "@oxide/oxide-client/atlatl/withdrawal_finalization.js"
import { EnclaveUnavailable } from "@oxide/oxide-client/errors.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import { encodeExecutorRelayerPayload } from "@oxide/oxide-lib/executor.js"
import type { PortalDomain } from "@oxide/oxide-lib/types.js"

import { decodeFunctionData, type Address, type Hex, type PublicClient } from "viem"

import { computeWithdrawalId, recoverBurnWithdrawals } from "./burnWithdrawals.js"
import { isWithdrawalSpent } from "./withdrawalFinalization.js"

/**
 * The failures a caller can say something honest about. Everything else — an unreachable node, a
 * malformed burn, an enclave that answered and refused — propagates raw.
 */
export type WithdrawFinalizationFailure =
  /** `$isWithdrawalSpent` is already true: someone else released this withdrawal. */
  | "already-finalized"
  /** No outbox membership witness yet — the burn's epoch is not proven on L1. */
  | "not-yet-finalizable"
  /** The request never reached a working enclave. */
  | "enclave-unavailable"

export class WithdrawFinalizationError extends Error {
  constructor(
    readonly reason: WithdrawFinalizationFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "WithdrawFinalizationError"
  }
}

export interface WithdrawFinalizationDeps {
  node: AztecNode
  /** The owner's wallet, which reads the burn's recovery events. */
  wallet: Pick<Wallet, "getPrivateEvents">
  /** Enclave RPC. Unauthenticated — it checks the request against chain data, not against a caller. */
  signer: RegisteredTeeSigner
  portal: PortalDomain
  /** The executor the burn's record names; a burn through any other executor is refused. */
  executor: Hex
  /** L1 client for the already-finalized pre-flight. */
  l1: PublicClient
}

export interface WithdrawFinalizationArgs {
  /** L2 burn tx hash. Everything else re-derives from it and the owner's recovery events. */
  burnTxHash: Hex
  /** The account the burn spent from. */
  owner: AztecAddress
  /** Which of the owner's withdrawals in the burn. A wallet burn makes one. */
  withdrawalIndex?: number
  /** Who the executor pays the burn's relayer tip and the subsidy to. */
  tipRecipient: Hex
}

export interface WithdrawFinalizationCall {
  /** The portal. */
  to: Address
  data: Hex
  withdrawalId: Hex
}

/**
 * Build the finalization call for `burnTxHash`.
 *
 * Ordered cheapest-first: the recovery read and the already-finalized read cost a few round trips, the
 * outbox witness one more, and only then does the enclave signature run — it replays the burn
 * checkpoint's blocks with bodies, which is a large fetch and must never be speculative.
 */
export async function buildWithdrawFinalizationCall(
  deps: WithdrawFinalizationDeps,
  args: WithdrawFinalizationArgs,
): Promise<WithdrawFinalizationCall> {
  const { node, portal } = deps
  const txHash = TxHash.fromString(args.burnTxHash)
  const index = args.withdrawalIndex ?? 0

  const withdrawals = await recoverBurnWithdrawals({
    wallet: deps.wallet,
    node,
    portal,
    owner: args.owner,
    txHash,
  })
  const withdrawal = withdrawals[index]
  if (!withdrawal) {
    throw new Error(
      `Burn tx ${args.burnTxHash} recovered ${withdrawals.length} withdrawals; no index ${index}.`,
    )
  }
  if (!withdrawal.finalizationData.executor.equals(EthAddress.fromString(deps.executor))) {
    throw new Error(
      `Burn tx ${args.burnTxHash} does not withdraw through executor ${deps.executor}.`,
    )
  }

  const withdrawalId = computeWithdrawalId(txHash, withdrawal.messageHash).toString() as Hex
  const l1Portal = portal.l1Portal.toString() as Address
  if (await isWithdrawalSpent(deps.l1, l1Portal, withdrawalId)) {
    throw new WithdrawFinalizationError(
      "already-finalized",
      `Withdrawal ${withdrawalId} has already been released on L1.`,
    )
  }

  // Built server-side from the node's own Outbox; absent until a proven root covers the burn's
  // checkpoint, which is exactly the "not finalizable yet" signal.
  if (!(await node.getL2ToL1MembershipWitness(txHash, withdrawal.messageHash))) {
    throw new WithdrawFinalizationError(
      "not-yet-finalizable",
      `Burn tx ${args.burnTxHash} has no L2->L1 membership witness yet — its epoch is not proven.`,
    )
  }

  const relayerPayload = encodeExecutorRelayerPayload({
    tipRecipient: EthAddress.fromString(args.tipRecipient),
  })

  let data: Hex
  try {
    data = await buildWithdrawalFinalizationCalldata(
      {
        chain: node,
        signer: deps.signer,
        l2Token: portal.l2Token,
        portal: {
          address: portal.l1Portal,
          getRollupVersion: () => Promise.resolve(portal.rollupVersion),
          getChainId: () => portal.l1ChainId,
        },
      },
      {
        withdrawal,
        archiveRoot: await resolveTxCheckpointArchive(node, txHash),
        relayerPayload,
      },
    )
  } catch (err) {
    if (err instanceof EnclaveUnavailable) {
      throw new WithdrawFinalizationError(
        "enclave-unavailable",
        "The signing enclave could not be reached.",
        { cause: err },
      )
    }
    throw err
  }

  const signed = decodeFunctionData({ abi: OxidePortalAbi, data })
  if (
    signed.functionName !== "withdraw" ||
    signed.args[0].withdrawalId.toLowerCase() !== withdrawalId.toLowerCase()
  ) {
    throw new Error("Enclave finalization withdrawal ID does not match the burn's withdrawal.")
  }
  return { to: l1Portal, data, withdrawalId }
}
