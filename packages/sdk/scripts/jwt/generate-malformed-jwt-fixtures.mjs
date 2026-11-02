#!/usr/bin/env node
/**
 * Generate all malformed JWT test fixtures
 *
 * This script calls the malformedJwtGenerator to create JWT fixtures with:
 * - Missing claims (email, sub, nonce, iss, aud, iat)
 * - Empty claims (email, sub)
 * - Edge case values (iat = 0, iat = max safe integer)
 *
 * The fixtures are written to test/oidcKeyRegistry/debug-malformed-jwt-*.json
 *
 * Usage (from packages/sdk): npm run generate:malformed-jwt
 * Or: npx tsx scripts/jwt/generate-malformed-jwt-fixtures.mjs
 */

import { generateAllMalformedJwtFixtures } from "../../test/utils/jwt/malformedJwtGenerator.ts"

console.log("Generating malformed JWT test fixtures...")
console.log("=" .repeat(60))

try {
  await generateAllMalformedJwtFixtures()
  console.log("\n" + "=".repeat(60))
  console.log("✓ Success! All fixtures generated.")
  console.log("\nNext steps:")
  console.log("1. Run: node scripts/sync-malformed-jwt-to-noir.mjs")
  console.log("2. Uncomment tests in contracts/libs/jwt/src/tests/malformedClaims.nr")
  console.log("3. Run: cd contracts/libs/jwt && aztec test")
} catch (error) {
  console.error("\n✗ Error generating fixtures:", error)
  process.exit(1)
}
