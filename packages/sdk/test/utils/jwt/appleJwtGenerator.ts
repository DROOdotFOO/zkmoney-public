import { sha256 } from "@aztec-labs/foundation/crypto/sha256"
import { generateKeyPair, generateJwt, publicKeyToJWK, type KeyPair } from "./jwt.js"
import crypto from "crypto"

/**
 * Calculate c_hash from authorization code
 * c_hash = BASE64URL(leftmost_128_bits(SHA256(authorization_code)))
 */
function calculateCHash(authorizationCode: string): string {
  const buffer = Buffer.from(authorizationCode)
  const hash = sha256(buffer)
  // Take leftmost 128 bits (16 bytes)
  const leftmost128bits = hash.subarray(0, 16)
  return leftmost128bits.toString("base64url")
}

// Generate a single static Apple key pair for testing (like Google does)
const STATIC_APPLE_KEY_PAIR = generateKeyPair()
const STATIC_APPLE_KID = crypto
  .createHash("sha256")
  .update(STATIC_APPLE_KEY_PAIR.publicKey)
  .digest("hex")
  .slice(0, 16)
const STATIC_APPLE_KEY: KeyPair = { ...STATIC_APPLE_KEY_PAIR, kid: STATIC_APPLE_KID }

// Generate static JWKS for Apple
export const STATIC_APPLE_JWK = publicKeyToJWK(STATIC_APPLE_KEY.publicKey, STATIC_APPLE_KID)
export const STATIC_APPLE_JWKS = {
  keys: [STATIC_APPLE_JWK],
}

// const STATIC_APPLE_NONCE = "69"

/**
 * Generate a complete Apple Sign-In response fixture.
 *
 * `iat` defaults to wall-clock time, but callers running against the Aztec
 * sandbox should pass the chain's current block timestamp instead — sandbox
 * block time can drift hours ahead of `Date.now()` and the OidcKeyRegistry
 * contract rejects JWTs whose `iat` is outside a 10000s window around the
 * chain clock.
 */
export function generateAppleSignInFixture(email: string, nonce: string, iat?: number) {
  // Generate authorization code first
  const authorizationCode = crypto.randomBytes(32).toString("hex")

  // Calculate c_hash from authorization code
  const c_hash = calculateCHash(authorizationCode)

  // Use the static key pair (same every time, like Google)
  const keyPair = STATIC_APPLE_KEY

  // Create Apple JWT payload structure with correct c_hash
  const now = iat ?? Math.floor(Date.now() / 1000)
  const sub = `001157.${crypto.randomBytes(16).toString("hex")}.1137`
  const payload = {
    iss: "https://appleid.apple.com",
    aud: "signin.obsidion.xyz",
    exp: now + 86400, // 24 hours from now
    iat: now,
    sub: sub,
    nonce: nonce,
    c_hash: c_hash,
    email: email,
    email_verified: true,
    auth_time: now,
    nonce_supported: true,
    real_user_status: 2,
  }

  // Generate JWT
  const jwt = generateJwt(payload, keyPair)

  return {
    fixture: {
      authorizationCode: authorizationCode,
      email: email,
      fullName: {
        familyName: "Test",
        givenName: "User",
        middleName: null,
        namePrefix: null,
        nameSuffix: null,
        nickname: null,
      },
      identityToken: jwt,
      realUserStatus: 2,
      state: null,
      user: sub,
    },
    aud: "signin.obsidion.xyz",
    keyPair,
    jwk: STATIC_APPLE_JWK,
    jwks: STATIC_APPLE_JWKS,
  }
}

// Generate the test@apple.com fixture
export function generateAppleSignInFixtureWithNonce(email: string, nonce: string) {
  return generateAppleSignInFixture(email, nonce)
}
