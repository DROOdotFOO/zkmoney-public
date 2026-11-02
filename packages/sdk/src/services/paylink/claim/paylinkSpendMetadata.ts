import { TxHash } from "@aztec-labs/stdlib/tx"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import { deriveMasterNullifierHidingSecretKey } from "@aztec-labs/stdlib/keys"
import { buildPaylinkCompleteAddress, type PaylinkKeyMaterial } from "../escrow/paylinkKeys.js"
import type {
  SpendMetadata,
  SpendMetadataResolver,
} from "@oxide/oxide-client/token_operations_collector.js"

/**
 * Build a `SpendMetadataResolver` for a paylink-contract-owned note.
 *
 * The paylink contract holds the locked funds between deposit and claim/refund.
 * To nullify that note, oxide's TEE needs the paylink contract's `CompleteAddress`
 * (rebuilt from the link's public keys) and its master-nullifier-hiding key
 * (derived from the link's `secret`). The resolver fails loudly if the simulated
 * call nullifies anything other than the paylink contract's own note.
 *
 * @param paylinkInstance - The reconstructed contract instance whose address must
 *                          match `nullified.owner` for the asserted note.
 * @param depositTxHash - The link's funding tx, when it carries one. Otherwise the note's own
 *                        `creationTxHash` serves — the token contract emits it for every settled
 *                        note, and the escrow note is always settled by the time it is spent.
 * @param paylinkKeys - Reconstructed key material. The nullifier-hiding key comes from `secret`;
 *                      the escape door's fallback key only from the creator's material.
 */
export function makePaylinkSpendMetadataResolver(
  paylinkInstance: ContractInstanceWithAddress,
  depositTxHash: TxHash | undefined,
  paylinkKeys: PaylinkKeyMaterial,
): SpendMetadataResolver {
  return async (nullified) => {
    // The only nullified note during claim/refund is the paylink-contract-owned
    // balance note. If the simulation surfaces anything else, the caller's
    // assumptions are wrong — fail loudly rather than handing back stale keys.
    if (!nullified.owner.equals(paylinkInstance.address)) {
      throw new Error(
        `[paylinkSpendMetadataResolver] Unexpected nullification owner ${nullified.owner.toString()}; only paylink contract ${paylinkInstance.address.toString()} is supported. ` +
          `If a paylink flow now spends notes from another owner, compose this resolver with one for that owner.`,
      )
    }
    const creationTxHash = depositTxHash ?? nullified.creationTxHash
    if (creationTxHash.equals(TxHash.zero())) {
      throw new Error(
        "[paylinkSpendMetadataResolver] escrow note has no creation tx: the deposit is not found on chain and the note is not settled",
      )
    }
    return buildPaylinkSpendMetadata({ paylinkInstance, creationTxHash, paylinkKeys })
  }
}

/**
 * Mirror of `buildSpendMetadata` from `@oxide/oxide-client` but for a
 * paylink-contract-owned note instead of a Schnorr account. The address comes
 * from the link's public keys; the live TEE spend authorizes through the
 * nullifier-hiding key derived from the link's `secret`.
 */
async function buildPaylinkSpendMetadata(input: {
  paylinkInstance: ContractInstanceWithAddress
  creationTxHash: TxHash
  paylinkKeys: PaylinkKeyMaterial
}): Promise<SpendMetadata> {
  const ownerAddressPreimage = await buildPaylinkCompleteAddress(
    input.paylinkInstance,
    input.paylinkKeys.publicKeys,
  )

  return {
    creationTxHash: input.creationTxHash,
    ownerAddressPreimage,
    masterNullifierHidingKey: deriveMasterNullifierHidingSecretKey(input.paylinkKeys.secretKey),
  }
}
