import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { paylinkTerms } from "../../../src/services/paylink/escrow/paylinkNoteData.js"

/** The terms a claim on a hand-built escrow asserts, off the note its deposit wrote. */
export async function escrowTerms(escrow: ContractBase, from: AztecAddress): Promise<Fr> {
  const { result } = await escrow.methods.sync_note!().simulate({
    from,
    additionalScopes: [escrow.address],
  })
  return paylinkTerms(result)
}
