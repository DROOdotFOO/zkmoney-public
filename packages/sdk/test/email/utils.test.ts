import { describe, expect, it } from "vitest"
import {
  assertJwtEmailMatchesCommitment,
  EmailMismatchError,
  EMAIL_LEN,
  poseidon2HashPackedString,
} from "../../src/email/utils.js"
import { Fr } from "@aztec-labs/foundation/curves/bn254"

const EMAIL = "alice@example.com"

function fakeGoogleJwt(email: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const header = b64({ kid: "kid1", alg: "RS256" })
  const payload = b64({
    aud: "aud",
    sub: "sub",
    iss: "https://accounts.google.com",
    iat: 1,
    email,
    email_verified: true,
  })
  return `${header}.${payload}.sig`
}

describe("assertJwtEmailMatchesCommitment", () => {
  const commitment = new Fr(poseidon2HashPackedString(EMAIL, EMAIL_LEN))

  it("passes when the token email hashes to the commitment", () => {
    expect(() =>
      assertJwtEmailMatchesCommitment(fakeGoogleJwt(EMAIL), "google", commitment),
    ).not.toThrow()
  })

  it("throws EmailMismatchError naming the locked email and the signed-in account", () => {
    try {
      assertJwtEmailMatchesCommitment(
        fakeGoogleJwt("mallory@example.com"),
        "google",
        commitment,
        EMAIL,
      )
      expect.unreachable("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(EmailMismatchError)
      expect((e as EmailMismatchError).signedInAs).toBe("mallory@example.com")
      expect((e as EmailMismatchError).lockedTo).toBe(EMAIL)
      expect((e as EmailMismatchError).message).toBe(
        `This link is locked to ${EMAIL} — you signed in as mallory@example.com. Sign in with the right account and try again.`,
      )
    }
  })
})
