import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { MSK_PRF_SALT, MSK_PRF_SALT_LABEL } from "../../dist/constants/index.js"

// The bytes every wallet master key derives from. A change here derives a different wallet for the
// same passkey, so the literal and its relationship to the label are both pinned.
const SALT_HEX = "a8e51261f6a147fd70b4506ac31275c61255aa4054b8fb72c169a180242fbbc6"

test("the salt is the pinned 32 bytes", () => {
  assert.equal(MSK_PRF_SALT.length, 32)
  assert.equal(Buffer.from(MSK_PRF_SALT).toString("hex"), SALT_HEX)
})

test("the salt is SHA-256 of the label", () => {
  const digest = createHash("sha256").update(MSK_PRF_SALT_LABEL, "utf8").digest("hex")
  assert.equal(digest, Buffer.from(MSK_PRF_SALT).toString("hex"))
})
