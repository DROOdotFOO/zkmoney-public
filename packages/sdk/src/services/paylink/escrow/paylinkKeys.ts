import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { DomainSeparator } from "@aztec-labs/constants"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { sha512ToGrumpkinScalar } from "@aztec-labs/foundation/crypto/sha512"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { computeSharedTaggingSecret } from "@aztec-labs/stdlib/logs"
import {
  CompleteAddress,
  type ContractInstanceWithAddress,
  computePartialAddress,
} from "@aztec-labs/stdlib/contract"
import { KeyValidationRequest } from "@aztec-labs/stdlib/kernel"
import {
  PublicKeys,
  computeAppSecretKey,
  deriveKeys,
  deriveMasterIncomingViewingSecretKey,
  deriveMasterNullifierHidingSecretKey,
  deriveMasterOutgoingViewingSecretKey,
  derivePublicKeyFromSecretKey,
  hashPublicKey,
  type KeyPrefix,
  type PublicKey,
} from "@aztec-labs/stdlib/keys"
import { DEFAULT_CONTRACTS, registerContractInPXE, type ContractName } from "@obsidion/contracts"
import type { ObsidionWallet } from "../../../obsidion/ObsidionWallet.js"
import {
  type LinkKey,
  LinkKind,
  linkKeyFromSecret,
  linkSecret,
} from "../link/linkLocator.js"

/**
 * An escrow's keys. Every master key but fallback is a function of `secretKey`; the fallback key
 * is the creator's migration factor, so a link holder has only its point (see `derivePaylinkKeys`).
 */
export interface PaylinkKeyMaterial {
  publicKeys: PublicKeys
  secretKey: Fr
  /** `fbpkMHash`: all the escrow address needs of the fallback key, and all the link carries. */
  fallbackKeyHash: Fr
  /** Creator-only: what the escape-door refund signs with. */
  fallbackSecret?: Fr
  /** The `(day, n)` slot under the master secret; absent for keys not derived from one. */
  nonce?: { day: number; n: number }
  /** The short link's signing key when `secretKey` derives from its seed. */
  link?: LinkKey
}

export type PaylinkDerivedKeyMaterial = PaylinkKeyMaterial

type PaylinkKeySet = {
  completeAddress: CompleteAddress
  publicKeys: PublicKeys
  masterNullifierHidingKey: GrumpkinScalar
  masterIncomingViewingSecretKey: GrumpkinScalar
  masterOutgoingViewingSecretKey: GrumpkinScalar
  masterTaggingSecretKey: GrumpkinScalar
  // v5 PublicKeys stores only hashes for n/ov/t (raw point only for ivpk), so
  // the raw master points the keystore serves are derived here and cached.
  masterPublicKeys: Record<KeyPrefix, PublicKey>
}

const PAYLINK_KEY_ACCOUNTS = Symbol.for("obsidion.paylinkKeyAccounts")
const PAYLINK_KEY_ORIGINALS = Symbol.for("obsidion.paylinkKeyOriginals")

type KeyStoreMethods = {
  getAccounts: () => Promise<AztecAddress[]>
  hasAccount: (account: AztecAddress) => Promise<boolean>
  getMasterIncomingViewingSecretKey: (account: AztecAddress) => Promise<GrumpkinScalar>
  getAppOutgoingViewingSecretKey: (account: AztecAddress, app: AztecAddress) => Promise<Fr>
  getMasterNullifierPublicKey: (account: AztecAddress) => Promise<PublicKey>
  getMasterIncomingViewingPublicKey: (account: AztecAddress) => Promise<PublicKey>
  getMasterOutgoingViewingPublicKey: (account: AztecAddress) => Promise<PublicKey>
  getMasterTaggingPublicKey: (account: AztecAddress) => Promise<PublicKey>
  getMasterSecretKey: (pkMHash: Fr) => Promise<GrumpkinScalar>
  getKeyValidationRequest: (
    pkMHash: Fr,
    contractAddress: AztecAddress,
  ) => Promise<KeyValidationRequest>
  accountHasKey: (account: AztecAddress, pkMHash: Fr) => Promise<boolean>
}

type PatchedKeyStore = KeyStoreMethods & {
  [PAYLINK_KEY_ACCOUNTS]?: Map<string, PaylinkKeySet>
  [PAYLINK_KEY_ORIGINALS]?: KeyStoreMethods
}

const KEY_PREFIXES: KeyPrefix[] = ["n", "iv", "ov", "t"]

// Frozen 4-byte ASCII selectors ("PLNK" / "PLSK" / "PLFB"). Changing one orphans the migration path
// for every paylink already created under it. "PLNK" derives the secret of links made before short
// links; those stay recoverable.
const PAYLINK_SECRET_SEPARATOR = 0x504c4e4b
const PAYLINK_LINK_KEY_SEPARATOR = 0x504c534b
const PAYLINK_FALLBACK_SEPARATOR = 0x504c4642

// Frozen per-flavor domain ids mixed into the hash. 0 is unused so a missing field cannot collide.
function paylinkFlavorId(flavor: ContractName): Fr {
  switch (flavor) {
    case DEFAULT_CONTRACTS.paylinkDirect:
      return new Fr(1)
    case DEFAULT_CONTRACTS.paylinkEmail:
      return new Fr(2)
    default:
      throw new Error(`unsupported paylink flavor: ${flavor}`)
  }
}

// Per-day nonce ceiling shared by creation (first free slot) and recovery (scan width). Raising it
// widens the recovery scan for all history, so bump deliberately.
export const MAX_PAYLINK_NONCES_PER_DAY = 64

function slotFields(masterSecret: Fr, day: number, n: number, flavor: ContractName): Fr[] {
  // Catches a seconds/ms timestamp or a DDMMYYYY-style date passed as `day`; 100_000 is year ~2243.
  if (!Number.isInteger(day) || day < 0 || day > 100_000) {
    throw new Error(`paylink day must be an epoch-day index (see epochDay()), got ${day}`)
  }
  return [masterSecret, new Fr(day), new Fr(n), paylinkFlavorId(flavor)]
}

/** The short link's signing key for a slot. A link holder has its seed, never the key. */
async function slotLinkKey(fields: Fr[]): Promise<LinkKey> {
  return linkKeyFromSecret(
    (await poseidon2HashWithSeparator(fields, PAYLINK_LINK_KEY_SEPARATOR)).toBuffer(),
  )
}

/**
 * The escrow's secrets bound to the creator's master secret and a `(day, n, flavor)` nonce — `day`
 * is days since the unix epoch at creation, `n` the first free slot that day for this flavor. The
 * secret derives from the short link's seed. A link holder knows the seed but not the master
 * secret, so the link key and the fallback secret stay creator-only.
 */
export async function deriveDeterministicPaylinkKeys(
  masterSecret: Fr,
  day: number,
  n: number,
  flavor: ContractName,
): Promise<PaylinkKeyMaterial> {
  const fields = slotFields(masterSecret, day, n, flavor)
  const [link, fallbackSecret] = await Promise.all([
    slotLinkKey(fields),
    poseidon2HashWithSeparator(fields, PAYLINK_FALLBACK_SEPARATOR),
  ])
  const secretKey = await linkSecret(LinkKind.Paylink, link.seed)
  return { ...(await derivePaylinkKeys({ secretKey, fallbackSecret })), nonce: { day, n }, link }
}

/** A slot's keys as links made before short links derived them, straight from the slot. */
export async function deriveLegacyPaylinkKeys(
  masterSecret: Fr,
  day: number,
  n: number,
  flavor: ContractName,
): Promise<PaylinkKeyMaterial> {
  const fields = slotFields(masterSecret, day, n, flavor)
  const [secretKey, fallbackSecret] = await Promise.all([
    poseidon2HashWithSeparator(fields, PAYLINK_SECRET_SEPARATOR),
    poseidon2HashWithSeparator(fields, PAYLINK_FALLBACK_SEPARATOR),
  ])
  return { ...(await derivePaylinkKeys({ secretKey, fallbackSecret })), nonce: { day, n } }
}

/** Both escrows a slot can hold: a short link's, then one made before short links. */
export function deriveSlotPaylinkKeys(
  masterSecret: Fr,
  day: number,
  n: number,
  flavor: ContractName,
): Promise<PaylinkKeyMaterial[]> {
  return Promise.all([
    deriveDeterministicPaylinkKeys(masterSecret, day, n, flavor),
    deriveLegacyPaylinkKeys(masterSecret, day, n, flavor),
  ])
}

/**
 * The creator's key material for an escrow a funding transfer announced by `(day, secret)`: the
 * slot on that day whose derived secret matches, under either derivation. Undefined when none
 * does, so a lane from another account's master secret, or from bring-your-own keys, recovers
 * nothing.
 */
export async function findPaylinkKeysForDay(
  masterSecret: Fr,
  day: number,
  secret: Fr,
  flavor: ContractName,
): Promise<PaylinkKeyMaterial | undefined> {
  for (let n = 0; n < MAX_PAYLINK_NONCES_PER_DAY; n++) {
    const fields = slotFields(masterSecret, day, n, flavor)
    const [seeded, legacy] = await Promise.all([
      slotLinkKey(fields).then((link) => linkSecret(LinkKind.Paylink, link.seed)),
      poseidon2HashWithSeparator(fields, PAYLINK_SECRET_SEPARATOR),
    ])
    if (seeded.equals(secret)) return deriveDeterministicPaylinkKeys(masterSecret, day, n, flavor)
    if (legacy.equals(secret)) return deriveLegacyPaylinkKeys(masterSecret, day, n, flavor)
  }
  return undefined
}

/**
 * The escrow's key set from its secret plus the fallback key: the creator holds the fallback
 * secret, a link holder only the hash of its public key. Both sides land on the same `PublicKeys`,
 * so the same address.
 */
export async function derivePaylinkKeys(
  input: { secretKey: Fr } & ({ fallbackSecret: Fr } | { fallbackKeyHash: Fr }),
): Promise<PaylinkKeyMaterial> {
  const fallbackSecret = "fallbackSecret" in input ? input.fallbackSecret : undefined
  const fallbackKeyHash = fallbackSecret
    ? await hashPublicKey(
        await derivePublicKeyFromSecretKey(derivePaylinkFallbackSecretKey(fallbackSecret)),
      )
    : (input as { fallbackKeyHash: Fr }).fallbackKeyHash
  const publicKeys = await reconstructPaylinkPublicKeys(input.secretKey, fallbackKeyHash)
  return { publicKeys, secretKey: input.secretKey, fallbackKeyHash, fallbackSecret }
}

/**
 * The full paylink `PublicKeys`: every master key but fallback is what `deriveKeys` makes of
 * `secret`; the fallback slot takes the creator's `fbpkMHash` as is.
 */
export async function reconstructPaylinkPublicKeys(
  secretKey: Fr,
  fallbackKeyHash: Fr,
): Promise<PublicKeys> {
  const { publicKeys } = await deriveKeys(secretKey)
  return new PublicKeys(
    publicKeys.npkMHash,
    publicKeys.ivpkM,
    publicKeys.ovpkMHash,
    publicKeys.tpkMHash,
    publicKeys.mspkMHash,
    fallbackKeyHash,
  )
}

export function derivePaylinkFallbackSecretKey(fallbackSecret: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([fallbackSecret, DomainSeparator.FBSK_M])
}

export async function buildPaylinkCompleteAddress(
  instance: ContractInstanceWithAddress,
  publicKeys: PublicKeys,
): Promise<CompleteAddress> {
  return CompleteAddress.create(instance.address, publicKeys, await computePartialAddress(instance))
}

/**
 * The ECDH point behind the `(creator -> escrow)` tag on the escrow's token note.
 *
 * An escrow funded before handshake tagging has an address-derived tag, discoverable only where the
 * creator is a local account. This point is what a link holder registers instead (see
 * {@link registerEscrowTagSecret}) -- `AppTaggingSecret` silos and directs a registered point
 * exactly as it does a sender-derived one, so the tags coincide. The creator computes it from the
 * escrow's side, which is the side a link rebuilds; ECDH is symmetric, so both agree.
 *
 * Scoped to one ephemeral escrow, and the link it rides already authorizes spending that escrow.
 */
export async function computeEscrowTagSecret(args: {
  instance: ContractInstanceWithAddress
  keyMaterial: PaylinkKeyMaterial
  creator: AztecAddress
}): Promise<PublicKey> {
  const completeAddress = await buildPaylinkCompleteAddress(
    args.instance,
    args.keyMaterial.publicKeys,
  )
  const point = await computeSharedTaggingSecret(
    completeAddress,
    deriveMasterIncomingViewingSecretKey(args.keyMaterial.secretKey),
    args.creator,
  )
  if (!point) {
    throw new Error(`escrow tag secret: ${args.creator.toString()} is not a valid address`)
  }
  return point
}

/**
 * Register a link-borne escrow tag secret so this PXE discovers the escrow's token note. Adding a
 * source clears the contract-sync cache, so every contract re-syncs against it -- each new source
 * costs one extra sweep, which is why only paths that read the escrow's note call this.
 */
export async function registerEscrowTagSecret(args: {
  wallet: ObsidionWallet
  escrow: AztecAddress
  secret: PublicKey
}): Promise<void> {
  const pxe = args.wallet.pxe as unknown as {
    registerTaggingSecretSource?: (source: {
      kind: "arbitrary-secret"
      recipient: AztecAddress
      secret: PublicKey
    }) => Promise<void>
  }
  if (typeof pxe.registerTaggingSecretSource !== "function") {
    throw new Error("PXE.registerTaggingSecretSource() is missing — requires @aztec-labs/pxe >= v5")
  }
  await pxe.registerTaggingSecretSource({
    kind: "arbitrary-secret",
    recipient: args.escrow,
    secret: args.secret,
  })
}

export async function registerPaylinkContractWithKeys(args: {
  wallet: ObsidionWallet
  instance: ContractInstanceWithAddress
  artifact: ContractArtifact
  keyMaterial: PaylinkKeyMaterial
}): Promise<CompleteAddress> {
  const { wallet, instance, artifact, keyMaterial } = args
  const completeAddress = await buildPaylinkCompleteAddress(instance, keyMaterial.publicKeys)
  const keySet = await buildPaylinkKeySet(completeAddress, keyMaterial)

  // Guarded: only the escrow instance is new here; the paylink CLASS is
  // already in the PXE after the first paylink, so skip its recompute.
  await registerContractInPXE(wallet.pxe, instance, artifact)

  const pxe = wallet.pxe as unknown as {
    addressStore?: { addCompleteAddress: (address: CompleteAddress) => Promise<boolean> }
    keyStore?: PatchedKeyStore
  }
  if (!pxe.addressStore || !pxe.keyStore) {
    throw new Error("PXE explicit paylink key registration is unavailable")
  }

  await pxe.addressStore.addCompleteAddress(completeAddress)
  patchKeyStore(pxe.keyStore)
  pxe.keyStore[PAYLINK_KEY_ACCOUNTS]!.set(instance.address.toString(), keySet)

  return completeAddress
}

async function buildPaylinkKeySet(
  completeAddress: CompleteAddress,
  keyMaterial: PaylinkKeyMaterial,
): Promise<PaylinkKeySet> {
  const masterNullifierHidingKey = deriveMasterNullifierHidingSecretKey(keyMaterial.secretKey)
  const masterIncomingViewingSecretKey = deriveMasterIncomingViewingSecretKey(keyMaterial.secretKey)
  const masterOutgoingViewingSecretKey = deriveMasterOutgoingViewingSecretKey(keyMaterial.secretKey)
  // stdlib has no standalone derivation for tsk_m; this mirrors `deriveKeys`.
  const masterTaggingSecretKey = sha512ToGrumpkinScalar([
    keyMaterial.secretKey,
    DomainSeparator.TSK_M,
  ])

  // v5 PublicKeys stores hashes for npk/ovpk/tpk and the raw point only for ivpk.
  const pk = keyMaterial.publicKeys
  const npkPoint = await derivePublicKeyFromSecretKey(masterNullifierHidingKey)
  const ivpkPoint = await derivePublicKeyFromSecretKey(masterIncomingViewingSecretKey)
  const ovpkPoint = await derivePublicKeyFromSecretKey(masterOutgoingViewingSecretKey)
  const tpkPoint = await derivePublicKeyFromSecretKey(masterTaggingSecretKey)

  await assertHashMatches("npk_m", npkPoint, pk.npkMHash)
  assertPointMatches("ivpk_m", ivpkPoint, pk.ivpkM)
  await assertHashMatches("ovpk_m", ovpkPoint, pk.ovpkMHash)
  await assertHashMatches("tpk_m", tpkPoint, pk.tpkMHash)

  return {
    completeAddress,
    publicKeys: keyMaterial.publicKeys,
    masterNullifierHidingKey,
    masterIncomingViewingSecretKey,
    masterOutgoingViewingSecretKey,
    masterTaggingSecretKey,
    masterPublicKeys: { n: npkPoint, iv: ivpkPoint, ov: ovpkPoint, t: tpkPoint },
  }
}

function assertPointMatches(label: string, derived: PublicKey, expected: PublicKey) {
  if (!derived.equals(expected)) {
    throw new Error(`Paylink ${label} does not match the supplied secret material`)
  }
}

async function assertHashMatches(label: string, derived: PublicKey, expectedHash: Fr) {
  if (!(await hashPublicKey(derived)).equals(expectedHash)) {
    throw new Error(`Paylink ${label} does not match the supplied secret material`)
  }
}

function patchKeyStore(keyStore: PatchedKeyStore) {
  if (keyStore[PAYLINK_KEY_ACCOUNTS]) return

  keyStore[PAYLINK_KEY_ACCOUNTS] = new Map()
  keyStore[PAYLINK_KEY_ORIGINALS] = {
    getAccounts: keyStore.getAccounts,
    hasAccount: keyStore.hasAccount,
    getMasterIncomingViewingSecretKey: keyStore.getMasterIncomingViewingSecretKey,
    getAppOutgoingViewingSecretKey: keyStore.getAppOutgoingViewingSecretKey,
    getMasterNullifierPublicKey: keyStore.getMasterNullifierPublicKey,
    getMasterIncomingViewingPublicKey: keyStore.getMasterIncomingViewingPublicKey,
    getMasterOutgoingViewingPublicKey: keyStore.getMasterOutgoingViewingPublicKey,
    getMasterTaggingPublicKey: keyStore.getMasterTaggingPublicKey,
    getMasterSecretKey: keyStore.getMasterSecretKey,
    getKeyValidationRequest: keyStore.getKeyValidationRequest,
    accountHasKey: keyStore.accountHasKey,
  }

  keyStore.getAccounts = async function (this: PatchedKeyStore) {
    const originals = this[PAYLINK_KEY_ORIGINALS]!
    const accounts = await originals.getAccounts.call(this)
    for (const keySet of this[PAYLINK_KEY_ACCOUNTS]!.values()) {
      if (!accounts.some((account) => account.equals(keySet.completeAddress.address))) {
        accounts.push(keySet.completeAddress.address)
      }
    }
    return accounts
  }

  keyStore.hasAccount = async function (this: PatchedKeyStore, account: AztecAddress) {
    if (findByAddress(this, account)) return true
    return this[PAYLINK_KEY_ORIGINALS]!.hasAccount.call(this, account)
  }

  keyStore.getMasterIncomingViewingSecretKey = async function (
    this: PatchedKeyStore,
    account: AztecAddress,
  ) {
    return (
      findByAddress(this, account)?.masterIncomingViewingSecretKey ??
      (await this[PAYLINK_KEY_ORIGINALS]!.getMasterIncomingViewingSecretKey.call(this, account))
    )
  }

  keyStore.getAppOutgoingViewingSecretKey = async function (
    this: PatchedKeyStore,
    account: AztecAddress,
    app: AztecAddress,
  ) {
    const keySet = findByAddress(this, account)
    if (keySet) return computeAppSecretKey(keySet.masterOutgoingViewingSecretKey, app, "ov")
    return this[PAYLINK_KEY_ORIGINALS]!.getAppOutgoingViewingSecretKey.call(this, account, app)
  }

  keyStore.getMasterNullifierPublicKey = async function (
    this: PatchedKeyStore,
    account: AztecAddress,
  ) {
    return (
      findByAddress(this, account)?.masterPublicKeys.n ??
      (await this[PAYLINK_KEY_ORIGINALS]!.getMasterNullifierPublicKey.call(this, account))
    )
  }

  keyStore.getMasterIncomingViewingPublicKey = async function (
    this: PatchedKeyStore,
    account: AztecAddress,
  ) {
    return (
      findByAddress(this, account)?.masterPublicKeys.iv ??
      (await this[PAYLINK_KEY_ORIGINALS]!.getMasterIncomingViewingPublicKey.call(this, account))
    )
  }

  keyStore.getMasterOutgoingViewingPublicKey = async function (
    this: PatchedKeyStore,
    account: AztecAddress,
  ) {
    return (
      findByAddress(this, account)?.masterPublicKeys.ov ??
      (await this[PAYLINK_KEY_ORIGINALS]!.getMasterOutgoingViewingPublicKey.call(this, account))
    )
  }

  keyStore.getMasterTaggingPublicKey = async function (
    this: PatchedKeyStore,
    account: AztecAddress,
  ) {
    return (
      findByAddress(this, account)?.masterPublicKeys.t ??
      (await this[PAYLINK_KEY_ORIGINALS]!.getMasterTaggingPublicKey.call(this, account))
    )
  }

  keyStore.getMasterSecretKey = async function (this: PatchedKeyStore, pkMHash: Fr) {
    const match = await findByPublicKeyHash(this, pkMHash)
    if (match) return secretKeyForPrefix(match.keySet, match.prefix)
    return this[PAYLINK_KEY_ORIGINALS]!.getMasterSecretKey.call(this, pkMHash)
  }

  keyStore.getKeyValidationRequest = async function (
    this: PatchedKeyStore,
    pkMHash: Fr,
    contractAddress: AztecAddress,
  ) {
    const match = await findByPublicKeyHash(this, pkMHash)
    if (match) {
      const skM = secretKeyForPrefix(match.keySet, match.prefix)
      // v5 KeyValidationRequest takes the master-key HASH, not the point — and
      // the incoming `pkMHash` (which findByPublicKeyHash matched on) IS it.
      return new KeyValidationRequest(
        pkMHash,
        await computeAppSecretKey(skM, contractAddress, match.prefix),
      )
    }
    return this[PAYLINK_KEY_ORIGINALS]!.getKeyValidationRequest.call(this, pkMHash, contractAddress)
  }

  keyStore.accountHasKey = async function (
    this: PatchedKeyStore,
    account: AztecAddress,
    pkMHash: Fr,
  ) {
    const keySet = findByAddress(this, account)
    if (keySet) {
      for (const prefix of KEY_PREFIXES) {
        if ((await hashPublicKey(publicKeyForPrefix(keySet, prefix))).equals(pkMHash)) return true
      }
      return false
    }
    return this[PAYLINK_KEY_ORIGINALS]!.accountHasKey.call(this, account, pkMHash)
  }
}

function findByAddress(
  keyStore: PatchedKeyStore,
  account: AztecAddress,
): PaylinkKeySet | undefined {
  return keyStore[PAYLINK_KEY_ACCOUNTS]?.get(account.toString())
}

async function findByPublicKeyHash(
  keyStore: PatchedKeyStore,
  pkMHash: Fr,
): Promise<{ keySet: PaylinkKeySet; prefix: KeyPrefix } | undefined> {
  for (const keySet of keyStore[PAYLINK_KEY_ACCOUNTS]?.values() ?? []) {
    for (const prefix of KEY_PREFIXES) {
      if ((await hashPublicKey(publicKeyForPrefix(keySet, prefix))).equals(pkMHash)) {
        return { keySet, prefix }
      }
    }
  }
  return undefined
}

function publicKeyForPrefix(keySet: PaylinkKeySet, prefix: KeyPrefix): PublicKey {
  return keySet.masterPublicKeys[prefix]
}

function secretKeyForPrefix(keySet: PaylinkKeySet, prefix: KeyPrefix): GrumpkinScalar {
  switch (prefix) {
    case "n":
      return keySet.masterNullifierHidingKey
    case "iv":
      return keySet.masterIncomingViewingSecretKey
    case "ov":
      return keySet.masterOutgoingViewingSecretKey
    case "t":
      return keySet.masterTaggingSecretKey
  }
}
