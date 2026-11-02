/**
 * Forward tag resolution against the oxide registries — the replacement for the
 * legacy ens-gateway `/resolve-l2`. Normalizes + validates the bare tag,
 * composes the wire nameHash, and reads the recipient's metadata record through
 * the sdk primitive. front-core owns the tag→nameHash composition and the result
 * shaping; the contract reads originate in sdk (`readUserByNameHash`, which pairs
 * the NameRegistry's owner lookup with the AccountMetadataRegistry's record).
 *
 * The discriminated result preserves the two load-bearing semantics of the
 * legacy resolver:
 *   - Rollup scoping — a record on a different `rollupVersion` points at a
 *     dead-rollup address, so a mismatch surfaces as `staleRollup` (the legacy
 *     server-side 404), never a live `resolved`. Sign-in alone admits a
 *     retired rollup the profile names.
 *   - Transport vs absence — a confirmed zero-address read is `notFound`
 *     (permanent); an RPC/transport failure throws (retryable). Callers
 *     narrowing to the `ITagForwardResolver` `{ l2Address } | null` contract
 *     collapse both `notFound` and `staleRollup` to null.
 */

import type { Address, PublicClient } from "viem"
import { readUserByNameHash, readUserL2AddressAt } from "@obsidion/sdk"
import { normalizeTag } from "../../utils/normalizeTag"
import { composeWireNameHash } from "./wireDomain"

export interface RegistryTagResolverConfig {
  /** viem read client for the registries' chain (passed opaquely to the sdk read). */
  client: PublicClient
  /** NameRegistry — resolves `nameHash → account`. */
  registry: Address
  /** AccountMetadataRegistry — holds the account's l2Address, stealth key and rollup version. */
  accountMetadataRegistry: Address
  /** Wire domain (`tuple.ensDomain`): `oxidestaging.eth` on testnet, `zk.money` on mainnet. */
  ensDomain: string
}

export type RegistryTagResolution =
  | {
      status: "resolved"
      /** The tag's L1 OxideAccount. */
      account: string
      l2Address: string
      rollupId: string
      /** secp256k1 SIPA deposit key (K1Point x‖y) — NOT the Aztec tagging key. */
      sipaStealthPublicKey: { x: bigint; y: bigint }
      /**
       * The recipient's messaging address: their account's bootstrap EOA, which their wallet
       * associates with its XMTP inbox. `canMessage` is false until that wallet has started once.
       */
      xmtpAddress: string
    }
  | { status: "notFound" }
  | { status: "staleRollup" }

/**
 * Thrown for invalid / non-ASCII tags, rejected before any nameHash or RPC. A
 * validation throw is a permanent rejection, distinct from a transport throw —
 * callers that map throws to deferred-retry must catch this separately.
 */
export class TagValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TagValidationError"
  }
}

export class RegistryTagResolver {
  constructor(private readonly config: RegistryTagResolverConfig) {}

  /**
   * `retiredRollupVersions` admits a record still bound to a rollup the profile has cut over from
   * (sign-in only). It is read only for a record off the current rollup.
   */
  async resolveTag(
    tag: string,
    currentRollupVersion: bigint,
    retiredRollupVersions?: () => Promise<readonly string[]>,
  ): Promise<RegistryTagResolution> {
    const normalized = normalizeTag(tag)
    if (normalized === null) throw new TagValidationError(`Invalid tag: ${tag}`)

    const nameHash = composeWireNameHash(normalized, this.config.ensDomain)
    const record = await readUserByNameHash(
      this.config.client,
      this.config.registry,
      this.config.accountMetadataRegistry,
      nameHash,
    )
    if (record === null) return { status: "notFound" }
    if (
      record.rollupVersion !== currentRollupVersion &&
      !(await retiredRollupVersions?.())?.includes(record.rollupVersion.toString())
    ) {
      return { status: "staleRollup" }
    }

    return {
      status: "resolved",
      account: record.account,
      l2Address: record.l2Address,
      rollupId: record.rollupVersion.toString(),
      sipaStealthPublicKey: record.sipaStealthPublicKey,
      xmtpAddress: record.bootstrapOwner,
    }
  }

  /**
   * The L2 address the tag's account held on `rollupVersion` at L1 block `blockNumber`, for a
   * transfer read on a rollup it has since left. Null for an invalid tag or no address there then.
   */
  async resolveTagAt(
    tag: string,
    rollupVersion: bigint,
    blockNumber: bigint,
  ): Promise<string | null> {
    const normalized = normalizeTag(tag)
    if (normalized === null) return null
    return readUserL2AddressAt(
      this.config.client,
      this.config.registry,
      this.config.accountMetadataRegistry,
      composeWireNameHash(normalized, this.config.ensDomain),
      rollupVersion,
      blockNumber,
    )
  }
}
