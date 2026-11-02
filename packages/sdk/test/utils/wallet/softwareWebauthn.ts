/**
 * A P-256 WebAuthn signer with no authenticator: produces the exact witness the production
 * `ObsidionAccountAlpha` reconstructs (`alpha_account/src/webauthn.nr`), so sandbox tests can prove
 * against the production artifact.
 */
import { createHash, randomBytes } from "node:crypto"
import { p256 } from "@noble/curves/p256"
import {
  WebAuthnAlphaAuthProvider,
  type WebAuthnSignResult,
} from "../../../src/obsidion/alpha/auth/WebAuthnAlphaAuthProvider.js"
import type { AlphaPasskeySet } from "../../../src/obsidion/alpha/account/alphaPasskeySet.js"

const RP_ID = "test.zk.money"
const ORIGIN = `https://${RP_ID}`

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(data).digest())

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** The fixed 37-byte header: rpIdHash ‖ flags (UP|UV) ‖ counter. */
function authenticatorData(): Uint8Array {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(RP_ID)), 0)
  out[32] = 0x05
  return out
}

export class SoftwareWebauthnKey {
  readonly privateKey: Uint8Array
  readonly pubkeyX: Buffer
  readonly pubkeyY: Buffer

  constructor(privateKey: Uint8Array = randomBytes(32)) {
    this.privateKey = privateKey
    const uncompressed = p256.getPublicKey(privateKey, false)
    this.pubkeyX = Buffer.from(uncompressed.subarray(1, 33))
    this.pubkeyY = Buffer.from(uncompressed.subarray(33, 65))
  }

  /** The 64-byte x‖y key as hex, the shape the SDK derives addresses from. */
  get pubkeyHex(): string {
    return Buffer.concat([this.pubkeyX, this.pubkeyY]).toString("hex")
  }

  /** Signs like an authenticator: over SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)). */
  async sign(challenge: Buffer): Promise<WebAuthnSignResult> {
    return this.signClientData(
      new TextEncoder().encode(
        `{"type":"webauthn.get","challenge":"${base64url(
          challenge,
        )}","origin":"${ORIGIN}","crossOrigin":false}`,
      ),
    )
  }

  /** Signs over the client data and authenticator bytes as given; a test shapes them. */
  async signClientData(
    clientDataJSON: Uint8Array,
    authData: Uint8Array = authenticatorData(),
  ): Promise<WebAuthnSignResult> {
    const signed = new Uint8Array(authData.length + 32)
    signed.set(authData, 0)
    signed.set(sha256(clientDataJSON), authData.length)
    const signature = p256.sign(sha256(signed), this.privateKey, { lowS: true }).toCompactRawBytes()
    return { signature, authenticatorData: authData, clientDataJSON }
  }

  /** A provider for this key over `passkeys` (default: this key alone). */
  provider(passkeys?: readonly string[]): WebAuthnAlphaAuthProvider {
    return new WebAuthnAlphaAuthProvider(this.pubkeyX, this.pubkeyY, (c) => this.sign(c), passkeys)
  }
}

/**
 * Signs with a key outside an account's set while carrying the account's real slots, so only the
 * contract's membership check can refuse the witness. Test-only: a real provider's
 * `getPasskeySet()` refuses a set its key is not in.
 */
export class ForeignKeyAlphaAuthProvider extends WebAuthnAlphaAuthProvider {
  constructor(key: SoftwareWebauthnKey, private readonly accountSet: AlphaPasskeySet) {
    super(key.pubkeyX, key.pubkeyY, (c) => key.sign(c))
  }

  override getPasskeySet(): Promise<AlphaPasskeySet> {
    return Promise.resolve(this.accountSet)
  }
}
