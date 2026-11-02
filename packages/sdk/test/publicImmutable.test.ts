import { describe, expect, it, vi } from "vitest"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { readPublicImmutable } from "../src/utils/publicImmutable.js"

const SLOT = new Fr(7n)

/** A contract whose `config` is `{ owner: Field, cap: u128, flags: [bool; 2] }`. */
const artifact = {
  name: "Probe",
  storageLayout: { config: { slot: SLOT } },
  functions: [
    {
      name: "get_config",
      parameters: [],
      returnType: {
        kind: "struct",
        path: "probe::Config",
        fields: [
          { name: "owner", type: { kind: "field" } },
          { name: "cap", type: { kind: "integer", sign: "unsigned", width: 128 } },
          { name: "flags", type: { kind: "array", length: 2, type: { kind: "boolean" } } },
        ],
      },
    },
  ],
} as unknown as ContractArtifact

const CONTRACT = AztecAddress.fromStringUnsafe(`0x${"0a".repeat(32)}`)

async function nodeHolding(packed: Fr[], hash?: Fr) {
  const stored = [...packed, hash ?? (await poseidon2Hash(packed))]
  return {
    getPublicStorageAt: vi.fn(async (_block: "latest", _contract: AztecAddress, slot: Fr) => {
      const at = Number(slot.toBigInt() - SLOT.toBigInt())
      return stored[at] ?? Fr.ZERO
    }),
  }
}

describe("readPublicImmutable", () => {
  it("decodes the packed value at the storage slot, as the reader's return type", async () => {
    const node = await nodeHolding([new Fr(5n), new Fr(300n), new Fr(1n), new Fr(0n)])

    const config = await readPublicImmutable(node, CONTRACT, artifact, "config", "get_config")

    expect(config).toEqual({ owner: 5n, cap: 300n, flags: [true, false] })
    expect(node.getPublicStorageAt).toHaveBeenCalledTimes(5)
  })

  it("refuses a value that was never set", async () => {
    const node = await nodeHolding([Fr.ZERO, Fr.ZERO, Fr.ZERO, Fr.ZERO], Fr.ZERO)
    await expect(
      readPublicImmutable(node, CONTRACT, artifact, "config", "get_config"),
    ).rejects.toThrow("is not set")
  })

  it("refuses a value that does not match its stored hash", async () => {
    const node = await nodeHolding([new Fr(5n), new Fr(300n), new Fr(1n), new Fr(0n)], new Fr(9n))
    await expect(
      readPublicImmutable(node, CONTRACT, artifact, "config", "get_config"),
    ).rejects.toThrow("does not match its hash")
  })

  it("names a missing storage variable or reader", async () => {
    const node = await nodeHolding([])
    await expect(
      readPublicImmutable(node, CONTRACT, artifact, "nope", "get_config"),
    ).rejects.toThrow("no storage named nope")
    await expect(readPublicImmutable(node, CONTRACT, artifact, "config", "nope")).rejects.toThrow(
      "no function named nope",
    )
  })
})
