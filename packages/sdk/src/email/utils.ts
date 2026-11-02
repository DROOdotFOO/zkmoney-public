import { utils } from "@shield-labs/utils"
import { Base64, Bytes, Hex } from "ox"
import { assert } from "ts-essentials"
import { z } from "zod"
import type { PublicKeyRegistry } from "./PublicKeyRegistry.js"
import { poseidon2Hash } from "@zkpassport/poseidon2"
import type { FieldLike } from "@aztec-labs/aztec.js/abi"
import { bnToLimbStrArray } from "./BigNumParamGen.js"

// JWT structure constants - keep in sync with Noir JWTInput struct
export const JWT_HEADER_MAX_LEN = 256
export const JWT_PAYLOAD_JSON_MAX_LEN = 768
export const JWT_PAYLOAD_MAX_LEN = Math.ceil(JWT_PAYLOAD_JSON_MAX_LEN / 3) * 4
const JWT_SUB_MAX_LEN = 64
const JWT_AUD_MAX_LEN = 128
const JWT_ISS_MAX_LEN = 32
export const EMAIL_LEN = 64

export interface JwtInput {
  header_and_payload: { storage: number[]; len: number }
  /** Byte offset into header_and_payload where the payload base64url starts (index after the '.') */
  base64_decode_offset: number
  signature_limbs: string[]
  public_key_e: string
  public_key_limbs: string[]
  public_key_redc_limbs: string[]
  /** Random field element r such that poseidon2(r, address) equals the JWT nonce claim. */
  nonce_preimage: bigint
}

/**
 * Compute the OAuth nonce string to pass to the provider before the auth redirect.
 * nonce = poseidon2(nonce_preimage, address).toString(10)
 *
 * @param nonce_preimage - Random field element r (generate once, store until JWT comes back)
 * @param address - The Aztec address that will call the contract
 */
export function computeNonce(nonce_preimage: bigint, address: bigint): string {
  return poseidon2Hash([nonce_preimage, address]).toString(10)
}

function fieldToHex(field: bigint): `0x${string}` {
  return ("0x" + field.toString(16).padStart(64, "0")) as `0x${string}`
}

function stringToBoundedBytes(value: string, maxLen: number): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  assert(encoded.length <= maxLen, `String exceeds ${maxLen} byte limit`)
  return encoded
}

export function packLeBytesIntoFields(bytes: Uint8Array | number[], maxLen: number): bigint[] {
  assert(bytes.length <= maxLen, `Byte array exceeds ${maxLen} byte limit`)

  const fieldsNeeded = Math.ceil(maxLen / 31)
  const fields: bigint[] = []

  for (let i = 0; i < fieldsNeeded; i++) {
    let fieldValue = 0n
    let offset = 1n

    for (let j = 0; j < 31; j++) {
      const byteIdx = i * 31 + j
      if (byteIdx < bytes.length) {
        const byte = bytes[byteIdx]!
        assert(byte >= 0 && byte <= 255, `Invalid byte at index ${byteIdx}: ${byte}`)
        fieldValue += BigInt(byte) * offset
      }
      offset *= 256n
    }

    fields.push(fieldValue)
  }

  return fields
}

export function poseidon2HashPackedBytes(bytes: Uint8Array | number[], maxLen: number): bigint {
  return poseidon2Hash(packLeBytesIntoFields(bytes, maxLen))
}

export function poseidon2HashPackedString(value: string, maxLen: number): bigint {
  return poseidon2HashPackedBytes(stringToBoundedBytes(value, maxLen), maxLen)
}

export function processIssuer(iss: string): `0x${string}` {
  return fieldToHex(poseidon2HashPackedString(iss, JWT_ISS_MAX_LEN))
}

export type JwtProvider = "google" | "apple"

export async function prepareJwtFromProvider(
  jwt: string,
  nonce_preimage: bigint,
  publicKeyRegistry: PublicKeyRegistry,
  provider: JwtProvider,
): Promise<{
  input: JwtInput
  subHash: bigint
  emailHash: bigint
  email: string
  jwk_id: `0x${string}`
}> {
  const [headerBase64Url, payloadBase64Url, signatureBase64Url] = splitJwt(jwt)

  const headerBytes = Array.from(Bytes.fromString(headerBase64Url))
  const base64_decode_offset = headerBytes.length + 1 // +1 for the '.' separator

  const header_and_payload = toBoundedVec(
    Array.from(Bytes.fromString(`${headerBase64Url}.${payloadBase64Url}`)),
    JWT_HEADER_MAX_LEN + 1 + JWT_PAYLOAD_MAX_LEN,
  )

  const sigHex = Base64.toHex(signatureBase64Url)
  const signature_limbs = bnToLimbStrArray(sigHex, Hex.size(sigHex) * 8)

  const jwtDecoded = provider === "google" ? decodeJwt(jwt) : decodeAppleJwt(jwt)

  // Fail fast before proof work; the circuit re-enforces this authoritatively.
  // Apple may send the string "true"; Google sends a boolean (schema-enforced).
  const emailVerified = jwtDecoded.payload.email_verified
  if (emailVerified !== true && emailVerified !== "true") {
    throw new Error("Provider did not mark the email as verified (email_verified is not true)")
  }

  const publicKey =
    provider === "google"
      ? await publicKeyRegistry.getPublicKeyByJwt(jwt)
      : await publicKeyRegistry.getPublicKeyByAppleJwt(jwt)

  const jwk_id = publicKey.jwk_id!

  const sub = jwtDecoded.payload.sub
  const subHash = poseidon2HashPackedString(sub, JWT_SUB_MAX_LEN)

  const email = jwtDecoded.payload.email
  const emailHash = poseidon2HashPackedString(email, EMAIL_LEN)

  // Convert Base64 exponent to bigint
  const eBytes = Base64.toBytes(publicKey.e)
  const eBigInt = Bytes.toBigInt(eBytes)

  const input = {
    header_and_payload,
    base64_decode_offset,
    signature_limbs,
    public_key_e: eBigInt.toString(),
    public_key_limbs: publicKey.limbs.public_key_limbs,
    public_key_redc_limbs: publicKey.limbs.public_key_redc_limbs,
    nonce_preimage,
  }

  return { input, subHash, emailHash, email, jwk_id }
}

export function decodeJwt(jwt: string) {
  const [headerBase64Url, payloadBase64Url] = splitJwt(jwt)
  const header = JSON.parse(Base64.toString(headerBase64Url))
  const payload = JSON.parse(Base64.toString(payloadBase64Url))
  const HeaderSchema = z.object({
    kid: z.string(),
  })
  const PayloadSchema = z.object({
    aud: z.string(),
    sub: z.string(),
    iss: z.string(),
    iat: z.number(),
    email: z.string(),
    email_verified: z.boolean(),
  })
  return {
    header: HeaderSchema.parse(header),
    payload: PayloadSchema.parse(payload),
  }
}

export function decodeAppleJwt(jwt: string) {
  const [headerBase64Url, payloadBase64Url] = splitJwt(jwt)
  const header = JSON.parse(Base64.toString(headerBase64Url))
  const payload = JSON.parse(Base64.toString(payloadBase64Url))
  const HeaderSchema = z.object({
    kid: z.string(),
  })
  const PayloadSchema = z.object({
    iss: z.string(),
    aud: z.string(),
    exp: z.number(),
    iat: z.number(),
    sub: z.string(),
    email: z.string(),
    // Apple deviates from OIDC and may send email_verified as the string "true".
    email_verified: z.union([z.boolean(), z.enum(["true", "false"])]),
    auth_time: z.number(),
  })
  return {
    header: HeaderSchema.parse(header),
    payload: PayloadSchema.parse(payload),
  }
}

/** Wrong Google/Apple account for an email-locked paylink — notify the user, don't report. */
export class EmailMismatchError extends Error {
  readonly signedInAs?: string
  /** Plaintext claim email from the link (display hint; commitment is what the contract checks). */
  readonly lockedTo?: string

  constructor(opts?: { signedInAs?: string; lockedTo?: string }) {
    const signedInAs = opts?.signedInAs
    const lockedTo = opts?.lockedTo
    let message =
      "The account you signed in with does not match the email this link is locked to. Sign in with the right account and try again."
    if (lockedTo && signedInAs) {
      message = `This link is locked to ${lockedTo} — you signed in as ${signedInAs}. Sign in with the right account and try again.`
    } else if (lockedTo) {
      message = `This link is locked to ${lockedTo}. Sign in with that account and try again.`
    } else if (signedInAs) {
      message = `This link is locked to a different email — you signed in as ${signedInAs}. Sign in with the right account and try again.`
    }
    super(message)
    this.name = "EmailMismatchError"
    this.signedInAs = signedInAs
    this.lockedTo = lockedTo
    Object.setPrototypeOf(this, EmailMismatchError.prototype)
  }
}

/**
 * Fail fast when the id_token's email can't claim this link: hash(email) must equal the link's
 * commitment. The circuit re-enforces this; the guard only spares a wasted prove.
 * `lockedTo` is the link's plaintext email hint — included in the error so the UI can name it.
 */
export function assertJwtEmailMatchesCommitment(
  jwt: string,
  provider: JwtProvider,
  commitment: FieldLike,
  lockedTo?: string,
): void {
  const { payload } = provider === "google" ? decodeJwt(jwt) : decodeAppleJwt(jwt)
  if (poseidon2HashPackedString(payload.email, EMAIL_LEN) !== BigInt(commitment.toString())) {
    throw new EmailMismatchError({ signedInAs: payload.email, lockedTo })
  }
}

export function splitJwt(jwt: string) {
  const [headerBase64Url, payloadBase64Url, signatureBase64Url] = jwt.split(".")
  assert(headerBase64Url && payloadBase64Url && signatureBase64Url, "invalid jwt")
  return [headerBase64Url, payloadBase64Url, signatureBase64Url] as const
}

export function toBoundedVec(arr: number[], maxLen: number) {
  const storage = utils.arrayPadEnd(arr, maxLen, 0)
  return { storage, len: arr.length }
}

export function processAud(aud: string): `0x${string}` {
  return fieldToHex(poseidon2HashPackedString(aud, JWT_AUD_MAX_LEN))
}
