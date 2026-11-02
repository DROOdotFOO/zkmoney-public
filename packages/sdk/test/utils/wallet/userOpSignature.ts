/** A user-op signature from a software passkey, in the shape `OxideAccount` decodes. */
import {
  encodeR1UserOpSignature,
  type R1PublicKeyArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import { toHex, type Hex } from "viem"
import type { SoftwareWebauthnKey } from "./softwareWebauthn.js"

export const r1Key = (key: SoftwareWebauthnKey): R1PublicKeyArg => ({
  qx: toHex(key.pubkeyX),
  qy: toHex(key.pubkeyY),
})

export async function webAuthnAuthArg(
  key: SoftwareWebauthnKey,
  userOpHash: Hex,
): Promise<WebAuthnAuthArg> {
  const { signature, authenticatorData, clientDataJSON } = await key.sign(
    Buffer.from(userOpHash.slice(2), "hex"),
  )
  const json = Buffer.from(clientDataJSON).toString("utf8")
  return {
    r: toHex(signature.subarray(0, 32)),
    s: toHex(signature.subarray(32)),
    challengeIndex: BigInt(json.indexOf('"challenge"')),
    typeIndex: BigInt(json.indexOf('"type"')),
    authenticatorData: toHex(authenticatorData),
    clientDataJSON: json,
  }
}

export async function signUserOpHash(
  key: SoftwareWebauthnKey,
  userOpHash: Hex,
  keyIndex = 0n,
): Promise<Hex> {
  return encodeR1UserOpSignature(keyIndex, await webAuthnAuthArg(key, userOpHash))
}
