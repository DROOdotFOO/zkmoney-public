import path from "path"
import {
  generateJwt,
  generateJwks,
  verifyJwt,
  type KeyPair,
  loadKeyPairs,
  generateKeyPairs,
} from "../utils/jwt/jwt.js"
import fs from "fs"

// JWT to sign
const jwt = {
  iat: 1740588000,
  nbf: 1740587700,
  exp: 2056677414,
  azp: "123456789-abc123.apps.googleusercontent.com",
  nonce: "42",
  picture: "https://obsidion.xyz/obsidion-logo.png",
  jti: "abcdef123456789abcdef123456789abcdef1234",
  iss: "https://accounts.google.com",
  email_verified: true,
  sub: "123456789",
  aud: "1034085538051-hlu3dd6l0gguos52pjjkns2h0rjothqi.apps.googleusercontent.com",
  email: "johnny@obsidion.xyz",
  name: "Johnny Silverhand",
  family_name: "Silverhand",
  given_name: "Johnny",
}

// File path for storing keys
const keyFilePath = path.join(__dirname, "jwks.json")

// Number of key pairs to generate/use
const NUM_KEY_PAIRS = 2 // Can be changed to any number

// Load or generate key pairs
let keyPairs: KeyPair[] = []
if (fs.existsSync(keyFilePath)) {
  keyPairs = loadKeyPairs(keyFilePath)
} else {
  keyPairs = generateKeyPairs(keyFilePath, NUM_KEY_PAIRS)
}

// Use the first key pair for signing
const signingKeyPair = keyPairs[0]!

// Generate JWT token
const token = generateJwt(jwt, signingKeyPair)

// Generate JWKS
const jwks = generateJwks(keyPairs)

// Output JWT, JWKS, and all key pairs
console.log("JWT Token:\n", token)
console.log("\nJWKS:\n", JSON.stringify(jwks, null, 2))

// Output all key pairs
keyPairs.forEach((keyPair: KeyPair, index: number) => {
  console.log(`\nKey Pair ${index + 1}:`)
  console.log(`  Kid: ${keyPair.kid}`)
  console.log(`  Public Key (PEM):\n${keyPair.publicKey}`)
  console.log(`  Private Key (PEM):\n${keyPair.privateKey}`)
})

// Verify the JWT token using the JWKS
verifyJwt(token, jwks)
