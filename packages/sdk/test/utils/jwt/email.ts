/**
 * Shared utilities for email/JWT-related tests
 * Used by both payToEmail and email registry tests
 */
import path from "path"
import { loadKeyPairs, generateJwks, generateJwt, type KeyPair } from "./jwt.js"
import { setupFetchInterceptor } from "./customizableFetchInterceptor.js"
import type { AztecNode } from "@aztec-labs/aztec.js/node"

// ============ Constants ============

export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "obsidion-wallet.apps.googleusercontent.com"
export const APPLE_AUD = process.env.APPLE_AUD || "signin.obsidion.xyz"

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
export const APPLE_CERTS_URL = "https://appleid.apple.com/auth/keys"

export const LONG_TIMEOUT = 300_000 // 5 minutes for cross-PXE operations

export const DEFAULT_MINT_AMOUNT = 1000000000000000000000000000n

// ============ JWT Payload Types ============

export interface JwtPayload {
  iat: number
  exp: number
  azp: string
  picture: string
  jti: string
  iss: string
  email_verified: boolean
  sub: string
  aud: string
  email: string
  name: string
  family_name: string
  given_name: string
  nonce: string
}

// ============ Chain Time Helpers ============

/**
 * Read the latest block's header timestamp (chain clock, not wall clock).
 *
 * Needed because the Aztec sandbox's slot-based block timestamps advance
 * faster than wall-clock: block time can drift hours ahead of `Date.now()`.
 * Contracts that assert `iat < context.timestamp() <= iat + ALLOWED_DELAY`
 * reject test JWTs whose `iat` was set from `Date.now()`. Derive `iat` from
 * this helper instead to keep JWT timestamps inside the chain's window.
 */
export const getChainTimestamp = async (node: AztecNode): Promise<number> => {
  // v5 removed node.getBlockHeader(); getBlockData carries the header.
  const header = (await node.getBlockData("latest"))?.header
  if (!header) {
    throw new Error("getChainTimestamp: getBlockData('latest') returned undefined")
  }
  return Number(header.globalVariables.timestamp)
}

// ============ JWT Helpers ============

/**
 * Creates a JWT payload with default test values
 */
export const createJwtPayload = (
  email: string = "johnny@obsidion.xyz",
  nonce: string = "42",
  overrides: Partial<JwtPayload> = {},
): JwtPayload => {
  const now = Math.floor(Date.now() / 1000)
  return {
    iat: now,
    exp: now + 86400,
    azp: "123456789-abc123.apps.googleusercontent.com",
    picture: "https://obsidion.xyz/obsidion-logo.png",
    jti: "abcdef123456789abcdef123456789abcdef1234",
    iss: "https://accounts.google.com",
    email_verified: true,
    sub: "123456789",
    aud: GOOGLE_CLIENT_ID,
    email,
    name: "Johnny Silverhand",
    family_name: "Silverhand",
    given_name: "Johnny",
    nonce,
    ...overrides,
  }
}

/**
 * Creates a second JWT payload for testing wrong-person claims
 */
export const createSecondJwtPayload = (basePayload: JwtPayload): JwtPayload => ({
  ...basePayload,
  nonce: "69",
  email: "goober@gmail.com",
  name: "Goober",
  family_name: "Goober",
  given_name: "Goober",
  sub: "123457890",
})

/**
 * Creates a third JWT payload (same sub as first, different email)
 * Useful for testing email change scenarios
 */
export const createThirdJwtPayload = (basePayload: JwtPayload, nonce?: string): JwtPayload => ({
  ...basePayload,
  nonce: nonce ?? "69",
  email: "goober@gmail.com",
})

// ============ JWT Mocking Setup ============

export interface JwtMockingResult {
  jwt: string
  keyPairs: KeyPair[]
  jwks: ReturnType<typeof generateJwks>
  restoreFetch: () => void
}

/**
 * Sets up JWT mocking for tests - loads keypairs, generates JWKS, and intercepts Google certs requests
 * @param jwtPayload - The JWT payload to sign
 * @param fixturesDir - Optional custom fixtures directory (defaults to test/fixtures)
 * @param appleJwks - Optional Apple JWKS to return for Apple certs endpoint
 * @returns The generated JWT string, keypairs, JWKS, and restore function
 */
export const setupJwtMocking = (
  jwtPayload: JwtPayload,
  fixturesDir?: string,
  appleJwks?: { keys: unknown[] },
): JwtMockingResult => {
  const keyFilePath = fixturesDir
    ? path.join(fixturesDir, "jwks.json")
    : path.join(__dirname, "../../fixtures/jwks.json")

  const keyPairs = loadKeyPairs(keyFilePath)
  const jwks = generateJwks(keyPairs)
  const signingKeyPair = keyPairs[0]!
  const jwt = generateJwt(jwtPayload, signingKeyPair)

  const { restoreFetch } = setupFetchInterceptor({
    shouldIntercept: (url) => url === GOOGLE_CERTS_URL || url === APPLE_CERTS_URL,
    mockResponse: (url: string) => {
      // Return Apple keys if URL is Apple and appleJwks is provided, otherwise return Google keys
      if (url === APPLE_CERTS_URL && appleJwks) {
        return appleJwks
      }
      return jwks
    },
    statusCode: 200,
  })

  return { jwt, keyPairs, jwks, restoreFetch }
}

/**
 * Generates multiple JWT tokens from payloads using the same signing key
 * Useful when tests need multiple JWTs with different payloads
 */
export const generateMultipleJwts = (payloads: JwtPayload[], keyPairs: KeyPair[]): string[] => {
  const signingKeyPair = keyPairs[0]!
  return payloads.map((payload) => generateJwt(payload, signingKeyPair))
}
