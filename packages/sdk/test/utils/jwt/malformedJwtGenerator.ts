import { fileURLToPath } from "node:url"
import { generateKeyPair, type KeyPair } from "./jwt.js"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Bytes } from "ox"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import {
  bnToLimbStrArray,
  computeBarrettReductionParameter,
  JWT_HEADER_MAX_LEN,
  JWT_PAYLOAD_MAX_LEN,
  splitInto120BitLimbs,
  toBoundedVec,
} from "../../../src/index.js"
import { Fr } from "@aztec-labs/aztec.js/fields"

// Use the same static key as Apple JWT generator for consistency
const STATIC_TEST_KEY_PAIR = generateKeyPair()
const STATIC_TEST_KID = crypto
  .createHash("sha256")
  .update(STATIC_TEST_KEY_PAIR.publicKey)
  .digest("hex")
  .slice(0, 16)
const STATIC_TEST_KEY: KeyPair = { ...STATIC_TEST_KEY_PAIR, kid: STATIC_TEST_KID }

interface JwtInputData {
  header_and_payload: {
    storage: number[]
    len: number
  }
  base64_decode_offset: number
  signature_limbs: string[]
  public_key_e: string
  public_key_limbs: string[]
  public_key_redc_limbs: string[]
  nonce_preimage: string
}

/**
 * Extract JWT input data from a JWT token and nonce preimage
 * This mimics the prepareJwtFromProvider function
 */
function extractJwtInputData(jwt: string, nonce_preimage: bigint, keyPair: KeyPair): JwtInputData {
  const [headerBase64Url, payloadBase64Url, signatureBase64Url] = jwt.split(".") as [
    string,
    string,
    string,
  ]

  const headerBytes = Array.from(Bytes.fromString(headerBase64Url))
  const base64_decode_offset = headerBytes.length + 1 // +1 for the '.' separator

  const header_and_payload = toBoundedVec(
    Array.from(Bytes.fromString(`${headerBase64Url}.${payloadBase64Url}`)),
    JWT_HEADER_MAX_LEN + 1 + JWT_PAYLOAD_MAX_LEN,
  )

  // Decode signature and ensure it's exactly 256 bytes (2048 bits for RSA-2048)
  const sigBytes = Buffer.from(signatureBase64Url, "base64url")
  // Pad to 256 bytes if needed (RSA signatures can be 255 bytes if MSB is 0)
  const sigPadded =
    sigBytes.length < 256
      ? Buffer.concat([Buffer.alloc(256 - sigBytes.length, 0), sigBytes])
      : sigBytes
  const sigBigInt = BigInt("0x" + sigPadded.toString("hex"))
  const signature_limbs = bnToLimbStrArray(sigBigInt)

  // Extract public key modulus from PEM using crypto.createPublicKey
  const publicKeyObject = crypto.createPublicKey(keyPair.publicKey)
  const jwk = publicKeyObject.export({ format: "jwk" })

  // Convert base64url modulus to BigInt
  const nBytes = Buffer.from(jwk.n!, "base64url")
  const nBigInt = BigInt("0x" + nBytes.toString("hex"))

  // Use the proper bignum functions to generate limbs (18 limbs for 2048-bit RSA)
  const NUM_BITS = 2048
  const public_key_limbs = bnToLimbStrArray(nBigInt, NUM_BITS)
  // Compute Barrett reduction parameter correctly for 2048-bit RSA (18 limbs)
  const barrettParam = computeBarrettReductionParameter(nBigInt, NUM_BITS)
  const public_key_redc_limbs = splitInto120BitLimbs(barrettParam, NUM_BITS).map(
    (limb) => "0x" + limb.toString(16),
  )

  return {
    header_and_payload,
    base64_decode_offset,
    signature_limbs,
    public_key_e: "65537",
    public_key_limbs,
    public_key_redc_limbs,
    nonce_preimage: nonce_preimage.toString(),
  }
}

/**
 * Write JWT input data to a debug file for syncing to Noir
 */
function writeDebugFile(testName: string, data: JwtInputData) {
  const debugDir = path.join(__dirname, "../..", "oidcKeyRegistry")
  const debugPath = path.join(debugDir, `debug-malformed-jwt-${testName}.json`)
  fs.writeFileSync(debugPath, JSON.stringify(data, null, 2))
  console.log(`Wrote malformed JWT '${testName}' to ${debugPath}`)
}

/**
 * Generate a JWT missing a specific claim
 */
export async function generateJwtMissingClaim(
  omitField: string,
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)

  const now = Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(16).toString("hex")}.1137`

  const payload: Record<string, unknown> = {
    iss: "https://appleid.apple.com",
    aud: "signin.obsidion.xyz",
    exp: now + 86400,
    iat: now,
    sub: sub,
    nonce: nonce,
    email: "test@missing.com",
  }

  // Remove the specified field
  delete payload[omitField]

  // Create and sign the JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)

  // Pad signature to exactly 256 bytes
  const sigBytes = Buffer.from(signature)
  const sigPadded =
    sigBytes.length < 256
      ? Buffer.concat([Buffer.alloc(256 - sigBytes.length, 0), sigBytes])
      : sigBytes
  const signatureB64 = sigPadded.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    writeDebugFile(`missing_${omitField}`, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate a JWT with an empty string value for a specific claim
 */
export async function generateJwtEmptyClaim(
  field: string,
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)

  const now = Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(16).toString("hex")}.1137`

  const payload: Record<string, unknown> = {
    iss: "https://appleid.apple.com",
    aud: "signin.obsidion.xyz",
    exp: now + 86400,
    iat: now,
    sub: sub,
    nonce: nonce,
    email: "test@example.com",
  }

  // Set the specified field to empty string
  payload[field] = ""

  // Create and sign the JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)

  // Pad signature to exactly 256 bytes
  const sigBytes = Buffer.from(signature)
  const sigPadded =
    sigBytes.length < 256
      ? Buffer.concat([Buffer.alloc(256 - sigBytes.length, 0), sigBytes])
      : sigBytes
  const signatureB64 = sigPadded.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    writeDebugFile(`empty_${field}`, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate a JWT with an edge case iat value
 */
export async function generateJwtEdgeIat(
  iatValue: number,
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)

  const now = Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(16).toString("hex")}.1137`

  const payload: Record<string, unknown> = {
    iss: "https://appleid.apple.com",
    aud: "signin.obsidion.xyz",
    exp: now + 86400,
    iat: iatValue,
    sub: sub,
    nonce: nonce,
    email: "test@example.com",
  }

  // Create and sign the JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)

  // Pad signature to exactly 256 bytes
  const sigBytes = Buffer.from(signature)
  const sigPadded =
    sigBytes.length < 256
      ? Buffer.concat([Buffer.alloc(256 - sigBytes.length, 0), sigBytes])
      : sigBytes
  const signatureB64 = sigPadded.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    const testName = iatValue === 0 ? "iat_zero" : `iat_${iatValue}`
    writeDebugFile(testName, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate a JWT with duplicate keys (manually constructed payload)
 * This tests whether the circuit handles JSON with duplicate keys correctly
 */
export async function generateJwtDuplicateKey(
  duplicateField: string,
  firstValue: string,
  secondValue: string,
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)
  const now = Math.floor(Date.now() / 1000)
  const sub1 = `001157.${crypto.randomBytes(8).toString("hex")}.1137`

  // Manually construct JSON with duplicate keys
  // Different values depending on which field is duplicated
  let payloadJson: string

  if (duplicateField === "email") {
    payloadJson = JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "signin.obsidion.xyz",
      exp: now + 86400,
      iat: now,
      sub: sub1,
      nonce: nonce,
      email: firstValue,
    })
    // Inject duplicate email by string manipulation (hacky but works)
    payloadJson = payloadJson.slice(0, -1) + `,"email":"${secondValue}"}`
  } else if (duplicateField === "sub") {
    payloadJson = JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "signin.obsidion.xyz",
      exp: now + 86400,
      iat: now,
      sub: firstValue,
      nonce: nonce,
      email: "test@duplicate.com",
    })
    payloadJson = payloadJson.slice(0, -1) + `,"sub":"${secondValue}"}`
  } else if (duplicateField === "nonce") {
    payloadJson = JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "signin.obsidion.xyz",
      exp: now + 86400,
      iat: now,
      sub: sub1,
      nonce: firstValue,
      email: "test@duplicate.com",
    })
    payloadJson = payloadJson.slice(0, -1) + `,"nonce":"${secondValue}"}`
  } else {
    throw new Error(`Unsupported duplicate field: ${duplicateField}`)
  }

  // Manually create the JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(payloadJson).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  // Sign with private key
  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)

  // Pad signature to exactly 256 bytes (same as signJwtWithAppleKey)
  const sigBytes = Buffer.from(signature)
  const sigPadded =
    sigBytes.length < 256
      ? Buffer.concat([Buffer.alloc(256 - sigBytes.length, 0), sigBytes])
      : sigBytes
  const signatureB64 = sigPadded.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    const testName = `duplicate_${duplicateField}_${firstValue.slice(0, 10)}_vs_${secondValue.slice(
      0,
      10,
    )}`.replace(/[^a-zA-Z0-9_]/g, "_")
    writeDebugFile(testName, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate a JWT with prefix injection attack
 * Places a fake field containing the target substring BEFORE the real field
 *
 * Example: {"prefix_iss":"https://accounts.google.com","iss":"https://evil.com"}
 *
 * The circuit searches for "iss" and might find it inside "prefix_iss",
 * potentially extracting the wrong value.
 */
export async function generateJwtPrefixInjection(
  targetField: string,
  fakeValue: string,
  realValue: string,
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const now = Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(8).toString("hex")}.1137`

  // Compute valid nonce: poseidon2(noncePreimage, address)
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)

  // Manually construct JSON with prefix field BEFORE the real field
  let payloadJson: string

  if (targetField === "iss") {
    // Attack: "prefix_iss" comes before "iss"
    const payload = {
      prefix_iss: fakeValue,
      aud: "signin.obsidion.xyz",
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: "test@prefix.com",
      iss: realValue, // Real issuer (the one that's actually signed)
    }
    payloadJson = JSON.stringify(payload)
  } else if (targetField === "aud") {
    // Attack: "fake_aud" comes before "aud"
    const payload = {
      iss: "https://appleid.apple.com",
      fake_aud: fakeValue,
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: "test@prefix.com",
      aud: realValue, // Real audience (the one that's actually signed)
    }
    payloadJson = JSON.stringify(payload)
  } else {
    throw new Error(`Unsupported prefix injection field: ${targetField}`)
  }

  // Create and sign the JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(payloadJson).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)
  const signatureB64 = signature.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    const testName = `prefix_injection_${targetField}_${fakeValue.slice(
      0,
      15,
    )}_before_${realValue.slice(0, 15)}`.replace(/[^a-zA-Z0-9_]/g, "_")
    writeDebugFile(testName, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate a JWT with JSON escaping attack
 * Uses escaped forward slash in field name: "\/iss" instead of "iss"
 * Tests if decoder normalizes \/ to / before circuit validation
 */
export async function generateJwtJsonEscaping(
  targetField: string,
  escapedValue: string,
  realValue: string,
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const now = Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(8).toString("hex")}.1137`

  // Compute valid nonce
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)

  // Manually construct JSON with escaped field name
  let payloadJson: string

  if (targetField === "iss") {
    // Attack: "\\/iss" might be normalized to "iss" by decoder
    // Note: We use \\/ to represent \/ in the string
    const payload: Record<string, unknown> = {
      aud: "signin.obsidion.xyz",
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: "test@escape.com",
      iss: realValue,
    }
    payloadJson = JSON.stringify(payload)
    // Inject escaped version before real iss
    payloadJson = payloadJson.replace('"iss":', '"\\/iss":"' + escapedValue + '","iss":')
  } else if (targetField === "aud") {
    const payload: Record<string, unknown> = {
      iss: "https://appleid.apple.com",
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: "test@escape.com",
      aud: realValue,
    }
    payloadJson = JSON.stringify(payload)
    payloadJson = payloadJson.replace('"aud":', '"\\/aud":"' + escapedValue + '","aud":')
  } else {
    throw new Error(`Unsupported escape field: ${targetField}`)
  }

  // Create and sign JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(payloadJson).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)
  const signatureB64 = signature.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    const testName = `json_escape_${targetField}_${escapedValue.slice(0, 15)}`.replace(
      /[^a-zA-Z0-9_]/g,
      "_",
    )
    writeDebugFile(testName, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate a JWT with Unicode escaping attack
 * Uses unicode escape in field name: "\u0069ss" instead of "iss" (where \u0069 = 'i')
 */
export async function generateJwtUnicodeEscaping(
  targetField: string,
  fakeValue: string,
  realValue: string,
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const now = Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(8).toString("hex")}.1137`

  // Compute valid nonce
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)

  let payloadJson: string

  if (targetField === "iss") {
    // Attack: "\u0069ss" where \u0069 = 'i', so it could be normalized to "iss"
    const payload: Record<string, unknown> = {
      aud: "signin.obsidion.xyz",
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: "test@unicode.com",
      iss: realValue,
    }
    payloadJson = JSON.stringify(payload)
    // Inject unicode escaped version
    payloadJson = payloadJson.replace('"iss":', '"\\u0069ss":"' + fakeValue + '","iss":')
  } else if (targetField === "aud") {
    const payload: Record<string, unknown> = {
      iss: "https://appleid.apple.com",
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: "test@unicode.com",
      aud: realValue,
    }
    payloadJson = JSON.stringify(payload)
    payloadJson = payloadJson.replace('"aud":', '"\\u0061ud":"' + fakeValue + '","aud":')
  } else {
    throw new Error(`Unsupported unicode escape field: ${targetField}`)
  }

  // Create and sign JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(payloadJson).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)
  const signatureB64 = signature.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    const testName = `unicode_escape_${targetField}_${fakeValue.slice(0, 15)}`.replace(
      /[^a-zA-Z0-9_]/g,
      "_",
    )
    writeDebugFile(testName, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate a JWT with array value instead of string
 * Tests if circuit properly rejects array values for string fields
 */
export async function generateJwtArrayValue(
  targetField: string,
  arrayValues: string[],
  noncePreimage: bigint,
  address: bigint,
  writeDebug = true,
): Promise<{ jwt: string; inputData: JwtInputData }> {
  const now = Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(8).toString("hex")}.1137`

  // Compute valid nonce
  const { poseidon2Hash } = await import("@zkpassport/poseidon2")
  const nonce = poseidon2Hash([noncePreimage, address]).toString(10)

  let payload: Record<string, unknown>

  if (targetField === "aud") {
    payload = {
      iss: "https://appleid.apple.com",
      aud: arrayValues, // Array instead of string!
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: "test@array.com",
    }
  } else if (targetField === "email") {
    payload = {
      iss: "https://appleid.apple.com",
      aud: "signin.obsidion.xyz",
      exp: now + 86400,
      iat: now,
      sub: sub,
      nonce: nonce,
      email: arrayValues, // Array instead of string!
    }
  } else {
    throw new Error(`Unsupported array field: ${targetField}`)
  }

  const payloadJson = JSON.stringify(payload)

  // Create and sign JWT
  const header = { alg: "RS256", typ: "JWT", kid: STATIC_TEST_KEY.kid }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(payloadJson).toString("base64url")
  const signatureInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signatureInput)
  const signature = sign.sign(STATIC_TEST_KEY.privateKey)
  const signatureB64 = signature.toString("base64url")

  const jwt = `${signatureInput}.${signatureB64}`
  const inputData = extractJwtInputData(jwt, noncePreimage, STATIC_TEST_KEY)

  if (writeDebug) {
    const testName = `array_value_${targetField}`.replace(/[^a-zA-Z0-9_]/g, "_")
    writeDebugFile(testName, inputData)
  }

  return { jwt, inputData }
}

/**
 * Generate all malformed JWT test fixtures
 * Call this to generate all debug files at once
 */
export async function generateAllMalformedJwtFixtures() {
  // Address from VALID_SENDER in malformedClaims.nr
  const VALID_SENDER = BigInt("0x08cad1e03676948f661bc00df74eadac619fc961aa8bf9ee7ca9e9b64291485c")

  // Use proper nonce preimage and address for all tests
  const testNoncePreimage = 1234567890n

  console.log("\n=== Generating Malformed JWT Fixtures ===\n")

  // Missing claims - now use proper nonce computation
  await generateJwtMissingClaim("email", testNoncePreimage, VALID_SENDER)
  await generateJwtMissingClaim("sub", testNoncePreimage, VALID_SENDER)
  await generateJwtMissingClaim("nonce", testNoncePreimage, VALID_SENDER)
  await generateJwtMissingClaim("iss", testNoncePreimage, VALID_SENDER)
  await generateJwtMissingClaim("aud", testNoncePreimage, VALID_SENDER)
  await generateJwtMissingClaim("iat", testNoncePreimage, VALID_SENDER)

  // Empty claims - now use proper nonce computation
  await generateJwtEmptyClaim("email", testNoncePreimage, VALID_SENDER)
  await generateJwtEmptyClaim("sub", testNoncePreimage, VALID_SENDER)

  // Edge case iat values - now use proper nonce computation
  await generateJwtEdgeIat(0, testNoncePreimage, VALID_SENDER)
  // Max u64 would be 18446744073709551615, but that's too large for JS number
  // Use a large but safe value instead
  await generateJwtEdgeIat(9007199254740991, testNoncePreimage, VALID_SENDER) // Number.MAX_SAFE_INTEGER

  // Duplicate key attacks
  console.log("\n--- Duplicate Key Attack Tests ---")
  await generateJwtDuplicateKey(
    "email",
    "attacker@evil.com",
    "victim@real.com",
    testNoncePreimage,
    VALID_SENDER,
  )
  await generateJwtDuplicateKey(
    "sub",
    "attacker-sub-99999",
    "victim-sub-12345",
    testNoncePreimage,
    VALID_SENDER,
  )
  await generateJwtDuplicateKey(
    "nonce",
    "1234567890",
    "9999999999",
    testNoncePreimage,
    VALID_SENDER,
  )

  // Prefix injection attacks
  console.log("\n--- Prefix Injection Attack Tests ---")
  // Generate random nonce preimage for these tests
  const prefixNoncePreimage = Fr.random().toBigInt()

  await generateJwtPrefixInjection(
    "iss",
    "https://accounts.google.com",
    "https://evil.com",
    prefixNoncePreimage,
    VALID_SENDER,
  )
  await generateJwtPrefixInjection(
    "aud",
    "signin.obsidion.xyz",
    "evil-app.com",
    prefixNoncePreimage,
    VALID_SENDER,
  )

  // JSON escaping attacks
  console.log("\n--- JSON Escaping Attack Tests ---")
  const escapeNoncePreimage = Fr.random().toBigInt()

  await generateJwtJsonEscaping(
    "iss",
    "https://accounts.google.com",
    "https://evil.com",
    escapeNoncePreimage,
    VALID_SENDER,
  )
  await generateJwtJsonEscaping(
    "aud",
    "signin.obsidion.xyz",
    "evil-app.com",
    escapeNoncePreimage,
    VALID_SENDER,
  )

  // Unicode escaping attacks
  console.log("\n--- Unicode Escaping Attack Tests ---")
  const unicodeNoncePreimage = Fr.random().toBigInt()

  await generateJwtUnicodeEscaping(
    "iss",
    "https://accounts.google.com",
    "https://evil.com",
    unicodeNoncePreimage,
    VALID_SENDER,
  )
  await generateJwtUnicodeEscaping(
    "aud",
    "signin.obsidion.xyz",
    "evil-app.com",
    unicodeNoncePreimage,
    VALID_SENDER,
  )

  // Array value attacks
  console.log("\n--- Array Value Attack Tests ---")
  const arrayNoncePreimage = Fr.random().toBigInt()

  await generateJwtArrayValue(
    "aud",
    ["signin.obsidion.xyz", "other-aud"],
    arrayNoncePreimage,
    VALID_SENDER,
  )
  await generateJwtArrayValue(
    "email",
    ["test@array.com", "other@email.com"],
    arrayNoncePreimage,
    VALID_SENDER,
  )

  console.log("\n=== Done! Run sync script to copy to Noir ===\n")
}

// Export the static key for testing
export { STATIC_TEST_KEY }
