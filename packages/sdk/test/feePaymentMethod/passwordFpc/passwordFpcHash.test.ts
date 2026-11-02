/**
 * Divergence guard between `computeFpcPasswordHash` and PasswordFPC's `get_password_hash`. The
 * pinned value below was read out of a PasswordFPC's public storage after a real deploy, so a
 * change to either packing — the TS side here or `FieldCompressedString` in the contract — breaks
 * this test rather than silently producing an FPC nobody can pay through.
 */
import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { GasSettings } from "@aztec-labs/stdlib/gas"
import {
  computeFpcPasswordHash,
  FPC_PASSWORD_MAX_LENGTH,
} from "../../../src/feePaymentMethod/passwordFpc/password_fpc_hash.js"
import { PasswordFPCBootstrapPaymentMethod } from "../../../src/feePaymentMethod/passwordFpc/password_fpc_bootstrap_payment_method.js"

const PINNED_PASSWORD = "spike-password-do-not-ship"
const PINNED_HASH = "0x175f163047d921f09550e454fb6c604b232bab71fd827240e5962292ed6f624a"

describe("computeFpcPasswordHash", () => {
  it("matches the hash the contract stores for the same password", async () => {
    expect((await computeFpcPasswordHash(PINNED_PASSWORD)).toString()).toBe(PINNED_HASH)
  })

  it("accepts a password at exactly the declared width", async () => {
    const hash = await computeFpcPasswordHash("b".repeat(FPC_PASSWORD_MAX_LENGTH))
    expect(hash.toString()).toBe(
      "0x209d5192fa85412d5c75368e020b4559c8103de5a29c919dffa458cf3d470ee5",
    )
  })

  it("rejects a password past the declared width rather than truncating", async () => {
    await expect(computeFpcPasswordHash("b".repeat(FPC_PASSWORD_MAX_LENGTH + 1))).rejects.toThrow(
      /at most 31 characters/,
    )
  })

  it("rejects multi-byte characters that would overflow the declared width", async () => {
    await expect(computeFpcPasswordHash("é".repeat(FPC_PASSWORD_MAX_LENGTH))).rejects.toThrow(
      /ASCII/,
    )
  })
})

describe("PasswordFPCBootstrapPaymentMethod", () => {
  it("names the FPC as payer and asset while contributing no call", async () => {
    const fpc = await AztecAddress.random()
    const gasSettings = GasSettings.empty()
    const method = new PasswordFPCBootstrapPaymentMethod(fpc, gasSettings)

    expect((await method.getFeePayer()).toString()).toBe(fpc.toString())
    expect((await method.getAsset()).toString()).toBe(fpc.toString())
    expect(method.getGasSettings()).toBe(gasSettings)

    // A call here would land ahead of the deployment and close setup before the claim could run.
    const payload = await method.getExecutionPayload()
    expect(payload.calls).toEqual([])
    expect(payload.feePayer?.toString()).toBe(fpc.toString())
  })
})
