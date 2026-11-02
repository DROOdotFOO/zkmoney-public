#!/usr/bin/env node
/**
 * Sync malformed JWT test data from debug-malformed-jwt-*.json files
 * into contracts/libs/jwt/src/tests/utils.nr as helper functions.
 *
 * Usage:
 * 1. First generate the malformed JWTs:
 *    node -e "require('./test/utils/jwt/malformedJwtGenerator.ts').generateAllMalformedJwtFixtures()"
 * 2. Then run this script:
 *    node scripts/jwt/sync-malformed-jwt-to-noir.mjs
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const debugDir = path.join(root, "test", "email")
const utilsPath = path.join(root, "contracts", "libs", "jwt", "src", "tests", "utils.nr")

// Find all malformed JWT debug files
const debugFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("debug-malformed-jwt-") && f.endsWith(".json"))

if (debugFiles.length === 0) {
  console.error("No malformed JWT debug files found in", debugDir)
  console.error("Run generateAllMalformedJwtFixtures() first to generate test fixtures")
  process.exit(1)
}

console.log(`Found ${debugFiles.length} malformed JWT fixtures:`)
debugFiles.forEach((file) => console.log(`  - ${file}`))

function formatLimb(hex) {
  const s = typeof hex === "string" ? hex : hex.toString(16).replace(/^/, "0x")
  const clean = s.startsWith("0x") ? s.slice(2) : s
  return `0x${clean.toLowerCase()}u128`
}

function formatStorage(arr) {
  return arr.map((n) => `        ${n},`).join("\n")
}

function generateNoirFunction(testName, json) {
  const base64_decode_offset = json.base64_decode_offset
  const signature_limbs = json.signature_limbs.map(formatLimb)
  const public_key_e = String(json.public_key_e)
  const public_key_limbs = json.public_key_limbs.map(formatLimb)
  const public_key_redc_limbs = json.public_key_redc_limbs.map(formatLimb)
  const nonce_preimage = json.nonce_preimage
  const len = json.header_and_payload.len
  const storage = json.header_and_payload.storage

  // Create function name from test name (e.g., missing_email -> setup_jwt_missing_email)
  const functionName = `setup_jwt_${testName}`

  return `
/// JWT input for testing: ${testName.replace(/_/g, " ")}
pub fn ${functionName}() -> JWTInput {
    let header_and_payload_ = [
${formatStorage(storage)}
    ];
    let base64_decode_offset = ${base64_decode_offset};
    let signature_limbs = [
        ${signature_limbs.join(",\n        ")}
    ];
    let public_key_e = ${public_key_e}u128;
    let public_key_limbs = [
        ${public_key_limbs.join(",\n        ")}
    ];
    let public_key_redc_limbs = [
        ${public_key_redc_limbs.join(",\n        ")}
    ];
    let nonce_preimage = ${nonce_preimage};

    let header_and_payload_len: u32 = ${len};
    let header_and_payload = BoundedVec::from_parts(header_and_payload_, header_and_payload_len);

    JWTInput {
        header_and_payload,
        base64_decode_offset,
        signature_limbs,
        public_key_e,
        public_key_limbs,
        public_key_redc_limbs,
        nonce_preimage,
    }
}
`
}

// Generate all functions
let functions = []
for (const debugFile of debugFiles) {
  const debugPath = path.join(debugDir, debugFile)
  const json = JSON.parse(fs.readFileSync(debugPath, "utf8"))
  const testName = debugFile.replace("debug-malformed-jwt-", "").replace(".json", "")
  functions.push(generateNoirFunction(testName, json))
}

// Read current utils.nr file
let utils = fs.readFileSync(utilsPath, "utf8")

// Find the marker comment or end of file to insert functions
const marker = "// === MALFORMED JWT TEST HELPERS (AUTO-GENERATED) ==="
const markerIndex = utils.indexOf(marker)

if (markerIndex !== -1) {
  // Remove old generated functions
  const endMarker = "// === END MALFORMED JWT TEST HELPERS ==="
  const endIndex = utils.indexOf(endMarker)
  if (endIndex !== -1) {
    utils = utils.substring(0, markerIndex) + utils.substring(endIndex + endMarker.length)
  }
}

// Append new functions at the end
const generatedCode = `
${marker}
${functions.join("\n")}
// === END MALFORMED JWT TEST HELPERS ===
`

utils = utils + generatedCode

// Write back to file
fs.writeFileSync(utilsPath, utils)

console.log(`\n✓ Generated ${functions.length} Noir helper functions in ${utilsPath}`)
console.log("\nGenerated functions:")
debugFiles.forEach((file) => {
  const testName = file.replace("debug-malformed-jwt-", "").replace(".json", "")
  console.log(`  - setup_jwt_${testName}()`)
})
