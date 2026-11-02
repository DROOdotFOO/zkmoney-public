import { describe, it, expect } from "vitest"
import { recoverAddress, hashMessage } from "viem"
import {
  deriveXmtpSigner,
  deriveEvmAddress,
  signEip191,
  XMTP_SIGNING_DOMAIN_SEPARATOR,
} from "../../src/xmtp/xmtpCrypto.js"

const TEST_SECRET = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn
const OTHER_SECRET = 0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321n

describe("deriveXmtpSigner", () => {
  it("derives deterministic key material from the same secret", () => {
    const a = deriveXmtpSigner(TEST_SECRET)
    const b = deriveXmtpSigner(TEST_SECRET)

    expect(a.privateKeyBigInt).toBe(b.privateKeyBigInt)
    expect(a.address).toBe(b.address)
    expect(Buffer.from(a.privateKey).toString("hex")).toBe(
      Buffer.from(b.privateKey).toString("hex"),
    )
    expect(Buffer.from(a.publicKey).toString("hex")).toBe(Buffer.from(b.publicKey).toString("hex"))
  })

  it("derives different addresses from different secrets", () => {
    const a = deriveXmtpSigner(TEST_SECRET)
    const b = deriveXmtpSigner(OTHER_SECRET)
    expect(a.address).not.toBe(b.address)
    expect(a.privateKeyBigInt).not.toBe(b.privateKeyBigInt)
  })

  it("accepts hex string and bigint secret interchangeably", () => {
    const hex = `0x${TEST_SECRET.toString(16).padStart(64, "0")}` as `0x${string}`
    const fromHex = deriveXmtpSigner(hex)
    const fromBig = deriveXmtpSigner(TEST_SECRET)
    expect(fromHex.address).toBe(fromBig.address)
  })

  it("derives the same address from a field's 0x-hex and its bigint (registration↔client parity)", () => {
    // Onboarding publishes the binding from `masterSecret.toString()` (0x-hex); the XMTP
    // client derives its inbox from `secret.toBigInt()`. These MUST agree or a sender resolves an
    // address the recipient never listens on. Guards both the zero-padded and minimal-hex forms.
    for (const secretHex of [`0x${"11".repeat(32)}`, "0x2a", `0x${"0".repeat(60)}dead`] as const) {
      expect(deriveXmtpSigner(secretHex).address).toBe(deriveXmtpSigner(BigInt(secretHex)).address)
    }
  })

  it("uses a domain separator distinct from stealth keys", () => {
    // If the separator were reused, the derived scalar would collide with
    // the stealth spending/viewing keys. We assert the raw separator value
    // so that accidental renames are caught as a regression.
    expect(XMTP_SIGNING_DOMAIN_SEPARATOR).toBe("OBSIDION_XMTP_SIGNING:")
  })

  it("returns an EIP-55 checksummed address (20 bytes, 42-char hex)", () => {
    const { address } = deriveXmtpSigner(TEST_SECRET)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // EIP-55: at least one uppercase char exists for most non-trivial addresses.
    // Since this is derived pseudo-randomly, checksum mixed case is expected.
    expect(/[A-F]/.test(address)).toBe(true)
  })

  it("public key is compressed (33 bytes)", () => {
    const { publicKey } = deriveXmtpSigner(TEST_SECRET)
    expect(publicKey.length).toBe(33)
    // Compressed keys start with 0x02 or 0x03
    expect([0x02, 0x03]).toContain(publicKey[0])
  })
})

describe("deriveEvmAddress", () => {
  it("matches the address produced by deriveXmtpSigner for the same key", () => {
    const { privateKey, address } = deriveXmtpSigner(TEST_SECRET)
    expect(deriveEvmAddress(privateKey)).toBe(address)
  })
})

describe("signEip191", () => {
  it("produces a 65-byte r||s||v hex that recovers to the signer address", async () => {
    const { privateKey, address } = deriveXmtpSigner(TEST_SECRET)
    const message = "hello from obsidion"
    const signature = signEip191(privateKey, message)

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/)

    const recovered = await recoverAddress({
      hash: hashMessage(message),
      signature,
    })
    expect(recovered.toLowerCase()).toBe(address.toLowerCase())
  })

  it("produces different signatures for different messages", () => {
    const { privateKey } = deriveXmtpSigner(TEST_SECRET)
    const s1 = signEip191(privateKey, "one")
    const s2 = signEip191(privateKey, "two")
    expect(s1).not.toBe(s2)
  })

  it("produces a stable signature for the same (key, message) — low-s canonical form", () => {
    const { privateKey } = deriveXmtpSigner(TEST_SECRET)
    const s1 = signEip191(privateKey, "same")
    const s2 = signEip191(privateKey, "same")
    expect(s1).toBe(s2)
  })

  it("encodes v as 27 or 28", () => {
    const { privateKey } = deriveXmtpSigner(TEST_SECRET)
    const signature = signEip191(privateKey, "v-check")
    const v = parseInt(signature.slice(-2), 16)
    expect([27, 28]).toContain(v)
  })

  it("recovers to the correct address across a variety of messages", async () => {
    const { privateKey, address } = deriveXmtpSigner(TEST_SECRET)
    const messages = ["", "short", "a".repeat(100), "unicode-✓-π-🎉", "multi\nline\nmessage"]
    for (const m of messages) {
      const sig = signEip191(privateKey, m)
      const recovered = await recoverAddress({ hash: hashMessage(m), signature: sig })
      expect(recovered.toLowerCase(), `failed for message: ${JSON.stringify(m)}`).toBe(
        address.toLowerCase(),
      )
    }
  })
})
