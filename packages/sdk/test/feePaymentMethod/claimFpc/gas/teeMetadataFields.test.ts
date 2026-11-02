import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { BlockHash } from "@aztec-labs/stdlib/block"
import { TEEMetadata } from "@oxide/oxide-lib/types.js"
import { TEE_METADATA_FIELDS } from "../../../../src/feePaymentMethod/claimFpc/gas/claimFpcGasModel.js"

describe("ClaimFPC gas model", () => {
  it("prices publish_da's metadata log at the pinned token's TEEMetadata length", () => {
    const zero = new TEEMetadata(Fr.ZERO, Fr.ZERO, Fr.ZERO, Fr.ZERO, BlockHash.random(), Fr.ZERO)
    expect(TEE_METADATA_FIELDS).toBe(zero.toFields().length)
  })
})
