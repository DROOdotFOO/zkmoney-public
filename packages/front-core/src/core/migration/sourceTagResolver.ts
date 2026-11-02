/**
 * Checks a tag a source rollup's transfer claims for its counterparty. The account's record now names
 * the rollup it moved to, so the address it held on the source is read as of the source portal's freeze.
 */
import type { OxideEnvTuple } from "@obsidion/core/types"
import { readPortalFreezeBlock } from "@obsidion/sdk"
import type { Address, PublicClient } from "viem"
import { deploymentScanRange } from "../../oxide/deploymentScanRange"
import { RegistryTagResolver } from "../services/RegistryTagResolver"

/**
 * The L2 address each tag's account held on `tuple`'s rollup when its portal froze, or at `head`
 * while it runs, once per tag. A failed read gives null, so the transfer keeps its address: the
 * source read fails on a throw and runs again in full. Undefined when the deployment names no
 * registry or wire domain.
 */
export function sourceTagResolver(
  client: PublicClient,
  tuple: OxideEnvTuple,
  head: bigint,
): ((tag: string) => Promise<string | null>) | undefined {
  const { registry, accountMetadataRegistry, ensDomain } = tuple
  if (!registry || !accountMetadataRegistry || !ensDomain) return undefined
  const resolver = new RegistryTagResolver({
    client,
    registry: registry as Address,
    accountMetadataRegistry: accountMetadataRegistry as Address,
    ensDomain,
  })
  const rollupVersion = BigInt(tuple.rollupVersion)
  let snapshot: Promise<bigint> | undefined
  const resolved = new Map<string, Promise<string | null>>()
  return (tag) => {
    let run = resolved.get(tag)
    if (!run) {
      snapshot ??= deploymentScanRange(client, tuple, head)
        .then((range) => readPortalFreezeBlock(client, tuple.portal as Address, range))
        .then((frozenAt) => frozenAt ?? head)
      run = snapshot
        .then((block) => resolver.resolveTagAt(tag, rollupVersion, block))
        .catch((error) => {
          console.warn(`[migration] tag check failed for ${tag}; keeping the address:`, error)
          return null
        })
      resolved.set(tag, run)
    }
    return run
  }
}
