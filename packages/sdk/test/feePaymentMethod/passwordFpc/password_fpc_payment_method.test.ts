/**
 * Unit guard for PasswordFPCPaymentMethod — pure, no PXE/sandbox.
 *
 * The password is the entire drain-protection boundary, so it must never leak into logs or
 * serialized output. This test makes that an enforced CI guard (not a manual log grep): the
 * password is held in a module WeakMap (off the instance) and toString/toJSON are redacted.
 */

import { describe, it, expect } from "vitest"
import { inspect } from "node:util"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { GasSettings } from "@aztec-labs/stdlib/gas"
import { PasswordFPCPaymentMethod } from "../../../src/feePaymentMethod/passwordFpc/password_fpc_payment_method.js"

const SECRET = "s3cr3t-Passw0rd-never-leak-x12y" // 31 printable-ASCII chars
const FPC = AztecAddress.fromBigIntUnsafe(0x1234n)

describe("PasswordFPCPaymentMethod — no password leakage (R3a)", () => {
  const method = new PasswordFPCPaymentMethod(SECRET, FPC, GasSettings.empty())

  it("JSON.stringify does not contain the password (standalone or nested in sendOptions)", () => {
    expect(JSON.stringify(method)).not.toContain(SECRET)
    expect(JSON.stringify({ from: FPC.toString(), fee: { paymentMethod: method } })).not.toContain(
      SECRET,
    )
  })

  it("util.inspect (what console.log uses) does not contain the password", () => {
    // inspect ignores toJSON and dumps the real object structure; the password lives in a
    // module WeakMap (off the instance), so it must not appear here either.
    expect(inspect(method, { depth: 6 })).not.toContain(SECRET)
  })

  it("encodes the password as 31 char-code fields, never the raw string", async () => {
    const payload = await method.getExecutionPayload()
    const args = payload.calls[0]!.args
    // [feeLimit, nonce] + 31 str<31> fields = 33
    expect(args).toHaveLength(33)
    expect(args.map((a) => a.toString()).join(",")).not.toContain(SECRET)
  })
})
