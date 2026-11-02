import crypto from "crypto"
import jwt from "jsonwebtoken"
import fs from "fs"

// Structure to hold key pairs
export interface KeyPair {
  privateKey: string
  publicKey: string
  kid: string
}

// Generate RSA key pair (2048-bit, e=65537)
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048, // RSA 2048-bit
    publicExponent: 0x10001, // e=65537 (AQAB)
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  return { privateKey, publicKey }
}

// Convert a PEM-formatted public key to a JWKS-compatible JSON format
export function publicKeyToJWK(publicKey: string, kid: string) {
  // Extract the modulus (n) and exponent (e) from the public key
  const keyObject = crypto.createPublicKey(publicKey).export({ format: "jwk" })

  return {
    kty: "RSA",
    kid,
    alg: "RS256",
    use: "sig",
    n: keyObject.n, // Base64Url-encoded modulus
    e: keyObject.e, // Base64Url-encoded exponent ("AQAB" for 65537)
  }
}

// Verify a JWT token using JWKS
export function verifyJwt(token: string, jwks: { keys: crypto.JsonWebKey[] }) {
  try {
    // Extract the header from the JWT token
    const [headerBase64] = token.split(".") as [string]
    const header = JSON.parse(Buffer.from(headerBase64, "base64url").toString())

    // Find the matching key in JWKS using the kid
    const jwk = jwks.keys.find((key) => key.kid === header.kid)
    if (!jwk) {
      throw new Error("No matching key found in JWKS")
    }

    // Convert JWK to PEM format for verification
    const publicKey = crypto
      .createPublicKey({
        key: jwk,
        format: "jwk",
      })
      .export({ type: "spki", format: "pem" })

    // Verify the token
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      ignoreExpiration: true, // Ignore token expiry errors
    })
    console.log("\nJWT Verification: SUCCESS")
    console.log("Decoded JWT payload:", JSON.stringify(decoded, null, 2))
    return decoded
  } catch (error) {
    console.error("\nJWT Verification: FAILED", error)
    throw error
  }
}

// Load key pairs
export function loadKeyPairs(keyFilePath: string): KeyPair[] {
  console.log("Loading existing keys from", keyFilePath)
  const keyData = JSON.parse(fs.readFileSync(keyFilePath, "utf8"))
  return keyData.keyPairs
}

// Generate key pairs
export function generateKeyPairs(keyFilePath: string, numKeyPairs: number = 2): KeyPair[] {
  const keyPairs: KeyPair[] = []
  // Generate new key pairs
  console.log(`Generating ${numKeyPairs} new key pairs and saving to ${keyFilePath}`)

  for (let i = 0; i < numKeyPairs; i++) {
    const keyPair = generateKeyPair()
    const kid = crypto.createHash("sha256").update(keyPair.publicKey).digest("hex").slice(0, 16)
    keyPairs.push({
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      kid,
    })
  }

  // Save key pairs to file
  fs.writeFileSync(keyFilePath, JSON.stringify({ keyPairs }, null, 2), "utf8")
  return keyPairs
}

// Generate JWT token
export function generateJwt(payload: object, keyPair: KeyPair) {
  // Sign JWT with RS256
  const token = jwt.sign(payload, keyPair.privateKey, {
    algorithm: "RS256",
    keyid: keyPair.kid,
  })
  return token
}

// Generate JWKS from key pairs
export function generateJwks(keyPairs: KeyPair[]) {
  return {
    keys: keyPairs.map((keyPair) => publicKeyToJWK(keyPair.publicKey, keyPair.kid)),
  }
}
