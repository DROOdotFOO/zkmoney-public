// A short link carries a 16-byte seed: the hash of the link's public key. Everything else it needs
// sits in a LinkLocator log on chain, found by a tag, encrypted under a key from the seed and signed
// by the link's key. Anyone holding the link can read it and announce under its tag, but only the
// key's holder can sign what it opens.

import { Buffer } from "buffer"
import { ctr } from "@noble/ciphers/aes"
import { ed25519 } from "@noble/curves/ed25519"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha2"
import { Contract, type ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from "@aztec-labs/stdlib/contract"
import { computeSiloedPrivateLogFirstField } from "@aztec-labs/stdlib/hash"
import { SiloedTag } from "@aztec-labs/stdlib/logs"
import {
  type ContractService,
  DEFAULT_CONTRACTS,
  getHardcodedArtifact,
  registerContractInPXE,
} from "@obsidion/contracts"
import type { ObsidionWallet } from "../../../obsidion/ObsidionWallet.js"
import { escrowInstancesForClasses } from "../escrow/paylinkEscrow.js"

export const LINK_SEED_BYTES = 16

/** What a link opens. Mixed into the secret, the cipher key and the signature. */
export enum LinkKind {
  Paylink = 1,
  Request = 2,
}

// Frozen 4-byte ASCII selectors ("LKSE" / "LKTG"). Changing one strands every link minted under it.
const SECRET_SEPARATOR = 0x4c4b5345
const TAG_SEPARATOR = 0x4c4b5447

// Bump to change the envelope; it is in the cipher key and the signed message.
const ENVELOPE_VERSION = 1
const CIPHER_INFO = new TextEncoder().encode("zk.money link cipher")
const SIGNATURE_DOMAIN = new TextEncoder().encode("zk.money link")

// `announce` takes PRIVATE_LOG_CIPHERTEXT_LEN fields, each holding 31 bytes of the envelope:
// nonce ‖ AES-256-CTR(length ‖ public key ‖ signature ‖ data ‖ zero padding).
const LOG_FIELDS = 15
const CHUNK_BYTES = 31
const ENVELOPE_BYTES = LOG_FIELDS * CHUNK_BYTES
const NONCE_BYTES = 12
const LENGTH_BYTES = 2
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const DATA_OFFSET = LENGTH_BYTES + PUBLIC_KEY_BYTES + SIGNATURE_BYTES
export const MAX_LINK_PAYLOAD_BYTES = ENVELOPE_BYTES - NONCE_BYTES - DATA_OFFSET

/** The locator's classes here and their artifacts. */
export type LinkLocatorClasses = Pick<ContractService, "getArtifactForClass" | "getKnownClassIds">

/** Those, plus the class the deployment announces under. */
export type LinkAnnouncer = LinkLocatorClasses & Pick<ContractService, "getConfiguredClassId">

/** A link's Ed25519 signing key, and the seed it gives. */
export interface LinkKey {
  secretKey: Uint8Array
  seed: Uint8Array
}

/** The seed is the hash of the public key, so a payload under another key never opens the link. */
export function linkKeyFromSecret(secretKey: Uint8Array): LinkKey {
  const seed = sha256(ed25519.getPublicKey(secretKey)).subarray(0, LINK_SEED_BYTES)
  return { secretKey, seed: new Uint8Array(seed) }
}

export function randomLinkKey(): LinkKey {
  return linkKeyFromSecret(crypto.getRandomValues(new Uint8Array(32)))
}

/** The link's secret: a field only the seed's holder can compute. */
export function linkSecret(kind: LinkKind, seed: Uint8Array): Promise<Fr> {
  if (seed.length !== LINK_SEED_BYTES) throw new Error(`a link seed is ${LINK_SEED_BYTES} bytes`)
  const value = BigInt(`0x${Buffer.from(seed).toString("hex")}`)
  return poseidon2HashWithSeparator([new Fr(kind), new Fr(value)], SECRET_SEPARATOR)
}

export function linkTag(secret: Fr): Promise<Fr> {
  return poseidon2HashWithSeparator([secret], TAG_SEPARATOR)
}

function cipher(kind: LinkKind, seed: Uint8Array, nonce: Uint8Array) {
  const info = Uint8Array.from([...CIPHER_INFO, ENVELOPE_VERSION, kind])
  const key = hkdf(sha256, seed, undefined, info, 32)
  // A 32-bit block counter after the nonce.
  const counter = new Uint8Array(16)
  counter.set(nonce)
  return ctr(key, counter)
}

function signedMessage(kind: LinkKind, data: Uint8Array): Uint8Array {
  return Uint8Array.from([...SIGNATURE_DOMAIN, ENVELOPE_VERSION, kind, ...data])
}

/** `data` signed by the link's key and encrypted under its seed, as a full-length log payload. */
export function sealLinkPayload(kind: LinkKind, key: LinkKey, data: Uint8Array): Fr[] {
  if (data.length > MAX_LINK_PAYLOAD_BYTES) {
    throw new Error(`a link payload holds at most ${MAX_LINK_PAYLOAD_BYTES} bytes`)
  }
  const plain = new Uint8Array(ENVELOPE_BYTES - NONCE_BYTES)
  new DataView(plain.buffer).setUint16(0, data.length)
  plain.set(ed25519.getPublicKey(key.secretKey), LENGTH_BYTES)
  plain.set(ed25519.sign(signedMessage(kind, data), key.secretKey), LENGTH_BYTES + PUBLIC_KEY_BYTES)
  plain.set(data, DATA_OFFSET)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const envelope = Buffer.concat([nonce, cipher(kind, key.seed, nonce).encrypt(plain)])
  return Array.from({ length: LOG_FIELDS }, (_, i) =>
    Fr.fromBuffer(
      Buffer.concat([Buffer.alloc(1), envelope.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)]),
    ),
  )
}

/**
 * The data a log payload holds, or undefined unless it was sealed under `seed` and signed by the
 * key that seed is the hash of. Nothing of `data` is read before the signature checks.
 */
export function openLinkPayload(
  kind: LinkKind,
  seed: Uint8Array,
  fields: Fr[],
): Uint8Array | undefined {
  if (fields.length < LOG_FIELDS) return undefined
  const chunks = fields.slice(0, LOG_FIELDS).map((field) => field.toBuffer())
  if (chunks.some((chunk) => chunk[0] !== 0)) return undefined
  const envelope = Buffer.concat(chunks.map((chunk) => chunk.subarray(1)))
  const nonce = envelope.subarray(0, NONCE_BYTES)
  const plain = cipher(kind, seed, nonce).decrypt(envelope.subarray(NONCE_BYTES))
  const length = new DataView(plain.buffer, plain.byteOffset).getUint16(0)
  if (length > MAX_LINK_PAYLOAD_BYTES) return undefined
  if (plain.subarray(DATA_OFFSET + length).some((b) => b !== 0)) return undefined
  const publicKey = plain.subarray(LENGTH_BYTES, LENGTH_BYTES + PUBLIC_KEY_BYTES)
  if (!Buffer.from(sha256(publicKey).subarray(0, LINK_SEED_BYTES)).equals(Buffer.from(seed))) {
    return undefined
  }
  const signature = plain.subarray(LENGTH_BYTES + PUBLIC_KEY_BYTES, DATA_OFFSET)
  const data = plain.subarray(DATA_OFFSET, DATA_OFFSET + length)
  try {
    if (!ed25519.verify(signature, signedMessage(kind, data), publicKey)) return undefined
  } catch {
    return undefined
  }
  return new Uint8Array(data)
}

// Spelled out: the browser Buffer polyfill has no "base64url" encoding.
export function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

export function base64UrlToBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"))
}

/** The fragment a short link carries: its kind, then its seed. */
export function encodeLinkFragment(kind: LinkKind, seed: Uint8Array): string {
  if (seed.length !== LINK_SEED_BYTES) throw new Error(`a link seed is ${LINK_SEED_BYTES} bytes`)
  return bytesToBase64Url(Uint8Array.from([kind, ...seed]))
}

/** A short link's kind and seed, or undefined for any other fragment. */
export function decodeLinkFragment(
  fragment: string,
): { kind: LinkKind; seed: Uint8Array } | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(fragment)) return undefined
  const bytes = base64UrlToBytes(fragment)
  if (bytes.length !== LINK_SEED_BYTES + 1) return undefined
  const kind = bytes[0]
  if (kind !== LinkKind.Paylink && kind !== LinkKind.Request) return undefined
  return { kind, seed: new Uint8Array(bytes.subarray(1)) }
}

/** Salt 0, no initializer, no keys: the locator's address is a function of its class. */
function locatorInstance(artifact: ContractArtifact): Promise<ContractInstanceWithAddress> {
  return getContractInstanceFromInstantiationParams(artifact, { salt: new Fr(0n) })
}

/** The bundled class alone, for a reader with no contract service, such as a browser with no account. */
export const bundledLinkLocator: LinkLocatorClasses = {
  getArtifactForClass: () => getHardcodedArtifact(DEFAULT_CONTRACTS.linkLocator),
  getKnownClassIds: async () => {
    const instance = await locatorInstance(
      await getHardcodedArtifact(DEFAULT_CONTRACTS.linkLocator),
    )
    return [instance.currentContractClassId.toString().toLowerCase()]
  },
}

/**
 * The class new links announce under: the deployment's, or the bundled one outside profile mode.
 * Undefined when the profile states no locator, and the wallet hands out full links instead.
 */
async function announceClassId(contractService: LinkAnnouncer): Promise<string | undefined> {
  let served: string | undefined
  try {
    served = contractService.getConfiguredClassId(DEFAULT_CONTRACTS.linkLocator)
  } catch {
    return undefined
  }
  return served ?? (await contractService.getKnownClassIds(DEFAULT_CONTRACTS.linkLocator))[0]
}

/** Whether this deployment announces short links. */
export async function shortLinksEnabled(contractService: LinkAnnouncer): Promise<boolean> {
  return (await announceClassId(contractService)) !== undefined
}

/** The locator's address under every class it has had here, the bundled one first. */
export async function linkLocatorAddresses(
  contractService: LinkLocatorClasses,
): Promise<AztecAddress[]> {
  const classIds = await contractService.getKnownClassIds(DEFAULT_CONTRACTS.linkLocator)
  const bundled = await contractService.getArtifactForClass(
    classIds[0]!,
    DEFAULT_CONTRACTS.linkLocator,
  )
  const instances = await escrowInstancesForClasses(await locatorInstance(bundled), classIds)
  return instances.map((instance) => instance.address)
}

export interface LocatedLink {
  bytes: Uint8Array
  txHash: string
  blockNumber: number
  /** The announcing tx's nullifiers. */
  nullifiers: Fr[]
}

/**
 * Every payload the link's key signed under its tag, oldest first. Anyone holding the link can
 * announce under the tag, so a payload under any other key is dropped.
 */
export async function findLinkPayloads(
  node: Pick<AztecNode, "getPrivateLogsByTags">,
  contractService: LinkLocatorClasses,
  kind: LinkKind,
  seed: Uint8Array,
): Promise<LocatedLink[]> {
  const tag = await linkTag(await linkSecret(kind, seed))
  const tags = await Promise.all(
    (
      await linkLocatorAddresses(contractService)
    ).map(async (address) => new SiloedTag(await computeSiloedPrivateLogFirstField(address, tag))),
  )
  const results = await node.getPrivateLogsByTags({ tags, includeEffects: true })
  const found: LocatedLink[] = []
  for (const log of results.flat()) {
    const bytes = openLinkPayload(kind, seed, log.logData.slice(1))
    if (!bytes) continue
    found.push({
      bytes,
      txHash: log.txHash.toString(),
      blockNumber: Number(log.blockNumber),
      nullifiers: log.nullifiers ?? [],
    })
  }
  return found.sort((a, b) => a.blockNumber - b.blockNumber)
}

/** The `announce` call publishing `bytes` signed by `key`, with the locator registered in the PXE. */
export async function linkAnnounceInteraction(
  wallet: ObsidionWallet,
  contractService: LinkAnnouncer,
  kind: LinkKind,
  key: LinkKey,
  bytes: Uint8Array,
): Promise<ContractFunctionInteraction> {
  const classId = await announceClassId(contractService)
  if (!classId) throw new Error("This deployment states no link locator")
  const artifact = await contractService.getArtifactForClass(classId, DEFAULT_CONTRACTS.linkLocator)
  const instance = await locatorInstance(artifact)
  await registerContractInPXE(wallet.pxe, instance, artifact)
  return Contract.at(instance.address, artifact, wallet).methods.announce!(
    await linkTag(await linkSecret(kind, key.seed)),
    sealLinkPayload(kind, key, bytes),
  )
}
