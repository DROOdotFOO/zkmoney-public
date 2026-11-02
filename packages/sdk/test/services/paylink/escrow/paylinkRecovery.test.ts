import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/contracts"
import {
  deriveDeterministicPaylinkKeys,
  deriveLegacyPaylinkKeys,
} from "../../../../src/services/paylink/escrow/paylinkKeys.js"
import {
  scanPaylinkEscrows,
  type PaylinkScanNode,
} from "../../../../src/services/paylink/escrow/paylinkRecovery.js"

const DIRECT = DEFAULT_CONTRACTS.paylinkDirect
const DAY = 20_700

/** A node holding `initialized` nullifiers that refuses a query over its 100-leaf cap. */
function nodeWith(initialized: Fr[]): PaylinkScanNode {
  return {
    findLeavesIndexes: async (_block: unknown, _tree: unknown, leaves: Fr[]) => {
      if (leaves.length > 100) throw new Error("Too big: expected array to have <=100 items")
      return leaves.map((leaf) =>
        initialized.some((nf) => nf.equals(leaf)) ? { data: 1n, l2BlockNumber: 7 } : undefined,
      )
    },
    getBlock: async () => undefined,
  } as never
}

describe("scanPaylinkEscrows", () => {
  it("finds escrows under either slot derivation within the node's query cap", async () => {
    const masterSecret = Fr.random()
    const artifact = await getHardcodedArtifact(DIRECT)
    const initOf = async (keys: { publicKeys: never }) => {
      const instance = await getContractInstanceFromInstantiationParams(artifact, {
        salt: new Fr(0n),
        publicKeys: keys.publicKeys,
      })
      return computeSiloedPrivateInitializationNullifier(
        instance.address,
        instance.initializationHash,
      )
    }
    const seeded = await deriveDeterministicPaylinkKeys(masterSecret, DAY, 3, DIRECT)
    const legacy = await deriveLegacyPaylinkKeys(masterSecret, DAY, 9, DIRECT)
    const node = nodeWith([await initOf(seeded as never), await initOf(legacy as never)])

    const hits = await scanPaylinkEscrows({
      node,
      artifact,
      flavor: DIRECT,
      masterSecret,
      fromDay: DAY,
      toDay: DAY,
    })
    expect(hits.map((h) => h.n).sort((a, b) => a - b)).toEqual([3, 9])
    expect(hits.find((h) => h.n === 3)?.keys.link?.seed).toEqual(seeded.link!.seed)
  })
})
