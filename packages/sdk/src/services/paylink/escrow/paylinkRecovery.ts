import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { BlockNumber } from "@aztec-labs/foundation/branded-types"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from "@aztec-labs/stdlib/contract"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import type { TxHash } from "@aztec-labs/stdlib/tx"
import type { ContractName } from "@obsidion/contracts"
import { escrowInstancesForClasses } from "./paylinkEscrow.js"
import {
  deriveSlotPaylinkKeys,
  MAX_PAYLINK_NONCES_PER_DAY,
  type PaylinkDerivedKeyMaterial,
} from "./paylinkKeys.js"

// 2026-08-06 — the day nonce-derived paylink escrows shipped. No derived escrow can predate it, so
// recovery scans start here when the caller has nothing better (e.g. the account creation day).
export const PAYLINK_NONCE_EPOCH_DAY = 20671

/** The node's cap on leaves per `findLeavesIndexes` call. */
const MAX_LEAVES_PER_QUERY = 100

/** The two node reads recovery needs — a Pick so tests can stub them without a PXE. */
export type PaylinkScanNode = Pick<AztecNode, "findLeavesIndexes" | "getBlock">

export interface RecoveredPaylinkEscrow {
  day: number
  n: number
  keys: PaylinkDerivedKeyMaterial
  instance: ContractInstanceWithAddress
  address: AztecAddress
  initHash: Fr
  l2BlockNumber: BlockNumber
}

/**
 * Enumerate every escrow a creator ever made from the master secret alone: derive the
 * `(day, n, flavor)` key grid under both slot derivations, compute each candidate's counterfactual
 * address under the artifact's class and each of `classIds` (zero `initHash`, keys and class as the
 * only variable inputs) and probe its private initialization nullifier — public tree data, no
 * notes, no logs, no local state.
 */
// ponytail: cost is linear in days scanned (~128 derivations + one RPC per 100 candidates per day, empty or not);
// narrow the window with a per-account start day before this matters.
export async function scanPaylinkEscrows(args: {
  node: PaylinkScanNode
  artifact: ContractArtifact
  /** Other classes the flavor has had; their escrows at the same slots are found too. */
  classIds?: string[]
  flavor: ContractName
  masterSecret: Fr
  fromDay: number
  toDay: number
  noncesPerDay?: number
}): Promise<RecoveredPaylinkEscrow[]> {
  const { node, artifact, flavor, masterSecret, fromDay, toDay } = args
  const noncesPerDay = args.noncesPerDay ?? MAX_PAYLINK_NONCES_PER_DAY
  const hits: RecoveredPaylinkEscrow[] = []

  for (let day = fromDay; day <= toDay; day++) {
    const slots = await Promise.all(
      Array.from({ length: noncesPerDay }, async (_, n) => {
        const slotKeys = await deriveSlotPaylinkKeys(masterSecret, day, n, flavor)
        return Promise.all(
          slotKeys.map(async (keys) => {
            const instance = await getContractInstanceFromInstantiationParams(artifact, {
              salt: new Fr(0n),
              publicKeys: keys.publicKeys,
            })
            const instances = await escrowInstancesForClasses(instance, args.classIds ?? [])
            return instances.map((escrow) => ({ n, keys, instance: escrow }))
          }),
        )
      }),
    )
    const candidates = slots.flat(2)

    const nullifiers = await Promise.all(
      candidates.map(({ instance }) =>
        computeSiloedPrivateInitializationNullifier(instance.address, instance.initializationHash),
      ),
    )
    const leaves = []
    for (let i = 0; i < nullifiers.length; i += MAX_LEAVES_PER_QUERY) {
      const batch = nullifiers.slice(i, i + MAX_LEAVES_PER_QUERY)
      leaves.push(...(await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, batch)))
    }

    for (const [i, leaf] of leaves.entries()) {
      if (leaf?.data === undefined) continue
      const { n, keys, instance } = candidates[i]!
      hits.push({
        day,
        n,
        keys,
        instance,
        address: instance.address,
        initHash: instance.initializationHash,
        l2BlockNumber: leaf.l2BlockNumber,
      })
    }
  }

  return hits
}

/**
 * The deposit tx of a recovered escrow, located from public data: the init nullifier's block is
 * known from the probe, and exactly one tx effect in it carries that nullifier. The tx hash is what
 * the refund pipeline needs to sync the escrow note.
 */
export async function findDepositTxHash(
  node: PaylinkScanNode,
  escrow: Pick<RecoveredPaylinkEscrow, "address" | "initHash" | "l2BlockNumber">,
): Promise<TxHash> {
  const block = await node.getBlock(escrow.l2BlockNumber, { includeTransactions: true })
  if (!block?.body) throw new Error(`recovery: block ${escrow.l2BlockNumber} not found`)
  const initNullifier = await computeSiloedPrivateInitializationNullifier(
    escrow.address,
    escrow.initHash,
  )
  for (const txEffect of block.body.txEffects) {
    if (txEffect.nullifiers.some((nf) => nf.equals(initNullifier))) return txEffect.txHash
  }
  throw new Error(`recovery: no tx in block ${escrow.l2BlockNumber} carries the init nullifier`)
}

/**
 * The tx that funded an escrow, from its init nullifier alone — public tree data, so a link holder
 * finds it with nothing but the secret. Undefined while the escrow is not yet initialized.
 */
export async function findEscrowDepositTx(
  node: PaylinkScanNode,
  instance: Pick<ContractInstanceWithAddress, "address" | "initializationHash">,
): Promise<{ txHash: TxHash; l2BlockNumber: BlockNumber } | undefined> {
  const initNullifier = await computeSiloedPrivateInitializationNullifier(
    instance.address,
    instance.initializationHash,
  )
  const [leaf] = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, [
    initNullifier,
  ])
  if (leaf?.data === undefined) return undefined
  const escrow = {
    address: instance.address,
    initHash: instance.initializationHash,
    l2BlockNumber: leaf.l2BlockNumber,
  }
  return { txHash: await findDepositTxHash(node, escrow), l2BlockNumber: leaf.l2BlockNumber }
}
