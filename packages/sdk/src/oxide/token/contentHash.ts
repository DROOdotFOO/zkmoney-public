import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import type { Hex } from "viem"

function frFromBigInt(value: bigint): Fr {
  if (value < 0n) throw new Error(`non-negative required, got ${value}`)
  return new Fr(value % Fr.MODULUS)
}

function aztecAddressFrom(value: AztecAddress | `0x${string}`): AztecAddress {
  return typeof value === "string" ? AztecAddress.fromStringUnsafe(value) : value
}

/** The deposit message's recipient commitment: blinds the recipient behind the shared-secret salt. */
export async function computeStealthRecipientHash(
  sharedSecret: bigint,
  recipient: AztecAddress | `0x${string}`,
): Promise<Hex> {
  const commitment = await computeRecipientCommitment(
    frFromBigInt(sharedSecret),
    aztecAddressFrom(recipient),
  )
  return commitment.toString() as Hex
}
