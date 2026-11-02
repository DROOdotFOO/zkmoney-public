// Self-contained inline codec for paylink URLs. The link carries the escrow secret, the hash of
// the creator's fallback key, the class it was derived against and the rollup it lives on (L1
// chain id and rollup version), as plaintext CBOR in the URL fragment — there is no server and no
// encryption (the link is a bearer secret regardless). Every other escrow key follows from the
// secret; the funding tx, amount, lock email and commitment are read from chain once the escrow is
// in a PXE. Mirrors the connect-packet serverless codec: integer-keyed CBOR map,
// raw-byte field encoding, base64url output, fail-closed decode behind a hard size cap.

import { encode as cborEncode, decode as cborDecode } from "cbor-x"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Buffer } from "buffer"
import type { PaylinkParams } from "../PaylinkService.js"
import { Point } from "@aztec-labs/foundation/curves/grumpkin"
import { base64UrlToBytes, bytesToBase64Url, LINK_SEED_BYTES } from "./linkLocator.js"

// Bump when the packet layout changes. Decode rejects any other value, so a bump bricks
// older links (acceptable under the hard-cut, no-back-compat posture). Adding an optional key
// is not such a change.
const FORMAT = 2

// Integer map keys (CBOR byte savings come from these vs string keys).
const KEY_FORMAT = 1
const KEY_TYPE = 2
const KEY_SECRET = 3
const KEY_CLASS_ID = 4
const KEY_CHAIN_ID = 5
// ECDH point behind the escrow note's `(creator -> escrow)` tag. The pinned oxide token tags the
// creator's own Transfer copy with the tx's tag sender, so the creator must tag the funding tx and
// a claimer needs this point to find the escrow's note. Goes away once the token pins the
// sender's copy to `from` and the escrow can tag its own note again.
const KEY_ESCROW_TAG_SECRET = 6
// `fbpkMHash`: the one slot of the escrow's `PublicKeys` the secret does not yield, since the
// fallback secret is the creator-only migration factor. The hash is all the address needs.
const KEY_FALLBACK_KEY_HASH = 7
// Two rollup deployments on one L1 chain (a generation roll, a testnet reset) share a chain id;
// the version tells them apart, so a link never resolves to an escrow on the wrong one.
const KEY_ROLLUP_VERSION = 8
// The 16 bytes a short link carries, kept so the creator's row can rebuild that link.
const KEY_SEED = 9
// `paylink_terms` of the deposited note, so every read and claim refuses any other note.
const KEY_TERMS = 10

// Pinned paylink-type <-> int map, independent of any TS enum declaration order. The strings
// are the `ContractName` values from `DEFAULT_CONTRACTS`.
const TYPE_TO_INT: Record<string, number> = {
  paylinkDirect: 0,
  paylinkEmail: 1,
}
const INT_TO_TYPE = ["paylinkDirect", "paylinkEmail"]

const MAX_FRAGMENT_BYTES = 256 // DoS guard before decode; a full packet is ~220 bytes.
const FIELD_BYTES = 32
const POINT_BYTES = FIELD_BYTES * 2 // a single Grumpkin point (x, y)

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0
}

/** Everything a link carries but its secret and seed. */
function paylinkMap(params: Omit<PaylinkParams, "secret" | "seed">): Map<number, unknown> {
  const typeInt = TYPE_TO_INT[params.paylinkType]
  if (typeInt === undefined) throw new Error(`Unknown paylink type: ${params.paylinkType}`)
  // Checked on the way in too, so a bad chain fails at creation, not in a recipient's hands.
  if (!isPositiveInt(params.chainId)) throw new Error("invalid chain id")
  if (!isPositiveInt(params.rollupVersion)) throw new Error("invalid rollup version")

  const m = new Map<number, unknown>()
  m.set(KEY_FORMAT, FORMAT)
  m.set(KEY_TYPE, typeInt)
  m.set(KEY_CLASS_ID, params.classId.toBuffer())
  m.set(KEY_CHAIN_ID, params.chainId)
  m.set(KEY_FALLBACK_KEY_HASH, params.fallbackKeyHash.toBuffer())
  m.set(KEY_ROLLUP_VERSION, params.rollupVersion)
  if (params.escrowTagSecret) m.set(KEY_ESCROW_TAG_SECRET, params.escrowTagSecret.toBuffer())
  if (params.terms) m.set(KEY_TERMS, params.terms.toBuffer())
  return m
}

/** Encode paylink params into the URL-fragment payload (base64url CBOR). */
export function encodePaylinkInline(params: PaylinkParams): string {
  const m = paylinkMap(params)
  m.set(KEY_SECRET, params.secret.toBuffer())
  if (params.seed) m.set(KEY_SEED, params.seed)
  return bytesToBase64Url(cborEncode(m))
}

/** What a short link's locator log holds: the link without its secret, which the seed gives. */
export function encodePaylinkLocatorPayload(
  params: Omit<PaylinkParams, "secret" | "seed">,
): Uint8Array {
  return new Uint8Array(cborEncode(paylinkMap(params)))
}

/**
 * Decode a URL-fragment payload back into paylink params. Fail-closed: any malformed,
 * oversized, or out-of-range input throws a single opaque error and never yields a partial
 * packet. The size cap is enforced before the CBOR decoder runs.
 */
export function decodePaylinkInline(fragment: string): PaylinkParams {
  try {
    const raw = Buffer.from(base64UrlToBytes(fragment))
    if (raw.length === 0 || raw.length > MAX_FRAGMENT_BYTES) throw new Error("size")
    const m = decodeMap(raw)
    const seed = m.has(KEY_SEED) ? readSeed(m) : undefined
    return { ...readPaylinkMap(m), secret: readField(m, KEY_SECRET), ...(seed ? { seed } : {}) }
  } catch {
    throw new Error("Invalid paylink link")
  }
}

/**
 * A locator payload back into the link it stands for, given the secret and seed it was found by. A
 * short link is always made with terms, so a payload without them is refused.
 */
export function decodePaylinkLocatorPayload(
  bytes: Uint8Array,
  secret: Fr,
  seed: Uint8Array,
): PaylinkParams {
  try {
    if (bytes.length === 0 || bytes.length > MAX_FRAGMENT_BYTES) throw new Error("size")
    const m = decodeMap(bytes)
    if (m.has(KEY_SECRET) || m.has(KEY_SEED)) throw new Error("secret")
    if (!m.has(KEY_TERMS)) throw new Error("terms")
    return { ...readPaylinkMap(m), secret, seed }
  } catch {
    throw new Error("Invalid paylink link")
  }
}

function decodeMap(raw: Uint8Array): Map<number, unknown> {
  const m = cborDecode(raw)
  if (!(m instanceof Map)) throw new Error("shape")
  if (m.get(KEY_FORMAT) !== FORMAT) throw new Error("format")
  return m
}

function readPaylinkMap(m: Map<number, unknown>): Omit<PaylinkParams, "secret" | "seed"> {
  const typeInt = m.get(KEY_TYPE)
  const paylinkType = typeof typeInt === "number" ? INT_TO_TYPE[typeInt] : undefined
  if (!paylinkType) throw new Error("type")

  const chainId = m.get(KEY_CHAIN_ID)
  if (!isPositiveInt(chainId)) throw new Error("chainId")
  const rollupVersion = m.get(KEY_ROLLUP_VERSION)
  if (!isPositiveInt(rollupVersion)) throw new Error("rollupVersion")

  const escrowTagSecret = m.has(KEY_ESCROW_TAG_SECRET)
    ? readPoint(m, KEY_ESCROW_TAG_SECRET)
    : undefined

  return {
    paylinkType,
    classId: readField(m, KEY_CLASS_ID),
    chainId,
    fallbackKeyHash: readField(m, KEY_FALLBACK_KEY_HASH),
    rollupVersion,
    escrowTagSecret,
    ...(m.has(KEY_TERMS) ? { terms: readField(m, KEY_TERMS) } : {}),
  }
}

function readSeed(m: Map<number, unknown>): Uint8Array {
  const v = m.get(KEY_SEED)
  if (!(v instanceof Uint8Array) || v.length !== LINK_SEED_BYTES) throw new Error("seed")
  return new Uint8Array(v)
}

function readField(m: Map<number, unknown>, key: number): Fr {
  const v = m.get(key)
  if (!(v instanceof Uint8Array) || v.length !== FIELD_BYTES) throw new Error("field")
  return Fr.fromBuffer(Buffer.from(v))
}

function readPoint(m: Map<number, unknown>, key: number): Point {
  const v = m.get(key)
  if (!(v instanceof Uint8Array) || v.length !== POINT_BYTES) throw new Error("point")
  return Point.fromBuffer(Buffer.from(v))
}

export const LINK_CLASS_REFUSAL = "This link was made with another version of the app"

/** Refuse a link whose escrow was derived against a class other than the instance's. */
export function assertLinkClass(
  params: Pick<PaylinkParams, "classId">,
  instance: { currentContractClassId: Fr },
): void {
  if (!instance.currentContractClassId.equals(params.classId)) {
    throw new Error(LINK_CLASS_REFUSAL)
  }
}

/** The rollup a link is stamped with and checked against: L1 chain id plus rollup version. */
export type LinkChain = Pick<PaylinkParams, "chainId" | "rollupVersion">

/**
 * Refuse a link made on another chain or another rollup deployment of the same chain; the escrow
 * only exists where it was funded.
 */
export function assertLinkChain(params: LinkChain, chain: LinkChain): void {
  if (params.chainId !== chain.chainId) {
    throw new Error("This link is for a different network")
  }
  if (params.rollupVersion !== chain.rollupVersion) {
    throw new Error("This link is for another deployment of this network")
  }
}
