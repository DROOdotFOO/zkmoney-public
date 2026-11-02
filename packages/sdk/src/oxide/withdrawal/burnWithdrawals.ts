// Read-side primitives for oxide L2->L1 withdrawals. A burn tx attests the message hash of each withdrawal it makes
// in its DA, so anyone with the tx hash derives the `withdrawalId` an L1 finalizer (and the client's finalization
// watcher) key on. The withdrawal's own values are private: its owner recovers them from the tx's recovery events.
//
// Narrow subpath imports only — the `@oxide/oxide-client` and `@oxide/oxide-lib` barrels re-export
// node/backend-only modules that break browser bundles.
import type { Buffer32 } from "@aztec-labs/foundation/buffer"
import type { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { TxHash } from "@aztec-labs/stdlib/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"

import { extractWithdrawalMessageHashes } from "@oxide/oxide-lib/da_extractors.js"
import { computeWithdrawalId } from "@oxide/oxide-lib/hash.js"
import type { PortalDomain } from "@oxide/oxide-lib/types.js"
import { recoverWithdrawals } from "@oxide/oxide-client/withdrawal_recovery.js"
import type { VerifiedWithdrawalInTx } from "@oxide/oxide-client/withdrawal_in_tx.js"
import { OxideTokenContract } from "@obsidion/contracts"

export { computeWithdrawalId }

/** A withdrawal of a burn tx, in the order the tx attests them. */
export interface BurnWithdrawalId {
  messageHash: Fr
  withdrawalId: Buffer32
}

/**
 * The withdrawals a burn tx attests, with their ids. Throws while the burn's tx effect is not indexed yet; the watcher
 * treats that as retryable.
 */
export async function fetchWithdrawalIds(
  node: Pick<AztecNode, "getTxEffect">,
  txHash: TxHash,
  l2Token: AztecAddress,
): Promise<BurnWithdrawalId[]> {
  const effect = await node.getTxEffect(txHash)
  if (!effect) throw new Error(`Tx effect not found for hash ${txHash}`)
  const messageHashes = await extractWithdrawalMessageHashes(effect.data, l2Token)
  return messageHashes.map((messageHash) => ({
    messageHash,
    withdrawalId: computeWithdrawalId(txHash, messageHash),
  }))
}

/**
 * `owner`'s withdrawals in the burn tx, from the tx's recovery events, each verified against the tx. The token must be
 * registered with its immutables, and the wallet synced past the burn.
 */
export async function recoverBurnWithdrawals(args: {
  wallet: Pick<Wallet, "getPrivateEvents">
  node: Pick<AztecNode, "getTxEffect">
  portal: PortalDomain
  owner: AztecAddress
  txHash: TxHash
}): Promise<VerifiedWithdrawalInTx[]> {
  const { withdrawals, failures } = await recoverWithdrawals({
    wallet: args.wallet,
    chain: args.node,
    portal: args.portal,
    owner: args.owner,
    recoveryEventMetadata: OxideTokenContract.events.WithdrawalRecoveryChunk,
    filter: { txHash: args.txHash },
  })
  if (failures.length > 0) throw new Error(`Burn ${args.txHash}: ${failures[0]!.reason}`)
  return withdrawals
}
