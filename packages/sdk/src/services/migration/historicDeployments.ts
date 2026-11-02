import { OxidePortalAbi } from "@oxide/l1-contracts"
import type { Network } from "@obsidion/core/constants"
import {
  extractPinnedOxideEnvTuple,
  migrationSources,
  pinnedEntryPolicy,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, PublicClient } from "viem"

/** The pinned entry's pointer plus the network, so the canonical entry passes the boot-time mainnet gate. */
export interface PinnedManifestArgs {
  manifestUrl: string
  portal: string
  network: Network
  expectedGitSha?: string
  fetchImpl?: typeof fetch
}

/**
 * Finds the retired oxide deployments an account's funds may still sit on: explicitly selected profile history whose
 * underlying matches Main or another product. Products on the pinned rollup are destinations, not history. No
 * selected sources means no historical L1 reads.
 */
export async function detectHistoricDeployments(
  args: PinnedManifestArgs & {
    publicClient: PublicClient
    /** Lowercase source portals selected by supported profile history. */
    sourcePortals?: ReadonlySet<string>
    /** Sources another generation's manifest publishes; kept only when explicitly selected. */
    otherSources?: readonly OxideEnvTuple[]
    /** Other live entries on the pinned rollup, such as the Sky sUSDS one. */
    products?: readonly OxideEnvTuple[]
  },
): Promise<{
  current: OxideEnvTuple
  historic: OxideEnvTuple[]
  /** Each historic deployment's destination by lowercase portal: `current` or a product. */
  destinations: ReadonlyMap<string, OxideEnvTuple>
}> {
  const fetchImpl = args.fetchImpl ?? fetch
  const res = await fetchImpl(args.manifestUrl)
  if (!res.ok) {
    throw new Error(
      `detectHistoricDeployments: manifest fetch failed (${res.status}) at ${args.manifestUrl}`,
    )
  }
  const manifest = await res.json()
  const current = extractPinnedOxideEnvTuple(manifest, args, pinnedEntryPolicy(args)).tuple
  const products = (args.products ?? []).filter(
    (p) =>
      p.rollupVersion === current.rollupVersion &&
      p.portal.toLowerCase() !== current.portal.toLowerCase(),
  )
  const byPortal = new Map(
    migrationSources(manifest, current, args.sourcePortals).map((t) => [t.portal.toLowerCase(), t]),
  )
  for (const tuple of args.otherSources ?? []) {
    const portal = tuple.portal.toLowerCase()
    if (tuple.plainWithdrawalExecutor && args.sourcePortals?.has(portal) && !byPortal.has(portal))
      byPortal.set(portal, tuple)
  }
  for (const product of products) byPortal.delete(product.portal.toLowerCase())
  const candidates = [...byPortal.values()]
  if (candidates.length === 0) return { current, historic: [], destinations: new Map() }
  const underlyings = (
    await Promise.all(
      [current, ...products, ...candidates].map((tuple) =>
        args.publicClient.readContract({
          address: tuple.portal as Address,
          abi: OxidePortalAbi,
          functionName: "UNDERLYING",
        }),
      ),
    )
  ).map((u) => u.toLowerCase())
  const [pinned, ...rest] = underlyings
  const productUnderlyings = rest.slice(0, products.length)
  const historic: OxideEnvTuple[] = []
  const destinations = new Map<string, OxideEnvTuple>()
  candidates.forEach((tuple, i) => {
    const underlying = rest[products.length + i]
    const destination =
      underlying === pinned
        ? current
        : tuple.rollupVersion !== current.rollupVersion
        ? products[productUnderlyings.indexOf(underlying!)]
        : undefined
    if (!destination) return
    historic.push(tuple)
    destinations.set(tuple.portal.toLowerCase(), destination)
  })
  return { current, historic, destinations }
}
