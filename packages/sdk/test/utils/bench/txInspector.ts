/**
 * Transaction inspection utility for benchmarking.
 * Extracts on-chain and off-chain effects from a sent transaction.
 */

import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { TxHash } from "@aztec-labs/stdlib/tx"

export interface TxInspection {
  txHash: string
  transactionFee: bigint
  /** Metered L2 gas used by the tx (from the proven kernel tail). */
  l2Gas?: number
  /** Metered DA gas used by the tx. */
  daGas?: number
  nullifierCount: number
  noteHashCount: number
  l2ToL1MsgCount: number
  publicDataWriteCount: number
  privateLogCount: number
  publicLogCount: number
  contractClassLogCount: number
}

/**
 * The mined tx effect carries only the fee, not the L2/DA gas split — pass
 * `gasUsed` when available (e.g. from proven kernel tail public inputs).
 */
export async function inspectTransaction(
  txHash: TxHash,
  node: Pick<AztecNode, "getTxEffect">,
  gasUsed?: { l2Gas: number; daGas: number },
): Promise<TxInspection> {
  const txEffect = await node.getTxEffect(txHash)
  if (!txEffect) {
    throw new Error(`No tx effect found for ${txHash.toString()}`)
  }

  const data = txEffect.data

  return {
    txHash: txHash.toString(),
    transactionFee: data.transactionFee.toBigInt(),
    l2Gas: gasUsed?.l2Gas,
    daGas: gasUsed?.daGas,
    nullifierCount: data.nullifiers.filter((n: Fr) => !n.isZero()).length,
    noteHashCount: data.noteHashes.filter((n: Fr) => !n.isZero()).length,
    l2ToL1MsgCount: data.l2ToL1Msgs.filter((n: Fr) => !n.isZero()).length,
    publicDataWriteCount: data.publicDataWrites.length,
    privateLogCount: data.privateLogs.length,
    publicLogCount: data.publicLogs.length,
    contractClassLogCount: data.contractClassLogs.length,
  }
}
