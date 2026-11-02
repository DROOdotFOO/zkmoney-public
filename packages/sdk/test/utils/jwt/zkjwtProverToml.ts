import { writeFileSync } from "fs"
import type { JwtInput } from "../../../src/email/utils.js"

/**
 * Serialize a JwtInput + caller address to the zkJWT circuit's Prover.toml layout.
 *
 * Matches `fn main(jwt: JWTInput, caller: Field)` in
 * packages/contracts/circuits/zkJWT/src/main.nr — structure mirrors the existing
 * hand-written Prover.toml in that directory.
 */
export function renderZkJwtProverToml(input: JwtInput, callerHex: string): string {
  const quoted = (items: Array<string | bigint | number>) =>
    "[" + items.map((x) => `"${BigInt(x).toString(10)}"`).join(", ") + "]"

  // Render storage as 32-byte chunks per line to match the existing file's style.
  const storage = input.header_and_payload.storage
  const chunks: string[] = []
  const perLine = 32
  for (let i = 0; i < storage.length; i += perLine) {
    chunks.push("  " + storage.slice(i, i + perLine).join(", "))
  }
  const storageToml = "[\n" + chunks.join(",\n") + ",\n]"

  const noncePreimageHex = "0x" + input.nonce_preimage.toString(16).padStart(64, "0")

  return [
    `caller = "${callerHex}"`,
    ``,
    `[jwt]`,
    `base64_decode_offset = ${input.base64_decode_offset}`,
    `signature_limbs = ${quoted(input.signature_limbs)}`,
    `public_key_e = "${BigInt(input.public_key_e).toString(10)}"`,
    `public_key_limbs = ${quoted(input.public_key_limbs)}`,
    `public_key_redc_limbs = ${quoted(input.public_key_redc_limbs)}`,
    `nonce_preimage = "${noncePreimageHex}"`,
    ``,
    `[jwt.header_and_payload]`,
    `len = ${input.header_and_payload.len}`,
    `storage = ${storageToml}`,
    ``,
  ].join("\n")
}

export function writeZkJwtProverToml(destPath: string, input: JwtInput, callerHex: string): void {
  writeFileSync(destPath, renderZkJwtProverToml(input, callerHex))
}
