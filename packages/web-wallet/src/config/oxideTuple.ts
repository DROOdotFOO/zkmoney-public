import { createPublicClient, parseAbi, type Address, type Hex, type PublicClient } from "viem"
import { withTimeout } from "../lib/withTimeout"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  bridgeOfTuple,
  feeTokenBridge,
  isAllZeroHex,
  loadOxideDeployment,
  type OxideDeploymentTable,
  type PinnedOxideDeployment,
} from "@obsidion/core/oxide"
import { MULTICALL3_ADDRESS, readDeploymentTable } from "@obsidion/sdk"
import {
  deploymentScanRange,
  fetchSignupResolverRecord,
  loadOxideManifestTuple,
  oxideEnvFromTuple,
  resolveOxideAccountFactory,
} from "@obsidion/front-core"
import {
  isRetiredRollupSource,
  loadRetiredRollupSources,
  oxideManifestDeployments,
  oxideManifestEntries,
  parseDeployment,
  pinnedEntryPolicy,
  type OxideDeployment,
} from "@obsidion/core/oxide"
import { l1Transport, type WebWalletConfig } from "./env"

let cached: { key: string; tuple: Promise<OxideEnvTuple> } | undefined

/** What every per-profile cache of the manifest is keyed by. */
export const oxideProfileKey = (config: WebWalletConfig) =>
  `${config.oxideProfile.manifestUrl}|${config.oxideProfile.portal}`

/** Dev demo seam: satisfy the profile from a fixture so nothing dials the env registry. */
export function primeOxideTuple(config: WebWalletConfig, tuple: OxideEnvTuple): void {
  cached = { key: oxideProfileKey(config), tuple: Promise.resolve(tuple) }
}

/**
 * The pinned bridge's tuple for the active profile, read once per profile off the manifest fetch
 * {@link getOxideDeployment} makes, so the tuple and the table always come from one republish. The SIPA sync loop
 * reads the tuple every tick. A failed fetch is not sticky; the next call retries.
 */
export function getOxideTuple(config: WebWalletConfig): Promise<OxideEnvTuple> {
  const key = oxideProfileKey(config)
  if (cached?.key !== key) {
    const tuple = getOxideDeployment(config).then(({ pinned }) =>
      withRegistryController(config, pinned.tuple),
    )
    cached = { key, tuple }
    tuple.catch(() => {
      if (cached?.tuple === tuple) cached = undefined
    })
  }
  return cached.tuple
}

let deploymentCached: { key: string; deployment: Promise<PinnedOxideDeployment> } | undefined

/** Dev demo seam, as {@link primeOxideTuple}. */
export function primeOxideDeployment(config: WebWalletConfig, pinned: PinnedOxideDeployment): void {
  deploymentCached = { key: oxideProfileKey(config), deployment: Promise.resolve(pinned) }
}

/** A read after an invalidation revalidates with the host, so a host `max-age` cannot delay a feature. */
let revalidate = false

/**
 * Drops the cached deployment, so the next {@link getOxideDeployment} fetches the manifest again: a
 * feature the manifest gained, such as a migration executor, is then read in place. From then on,
 * each fetch revalidates with the host (`cache: "no-cache"`). The pinned tuple stays cached, since
 * the pinned bridge does not change when a feature is added. A repoint to another portal still goes
 * through the Reload prompt.
 */
export function invalidateOxideDeployment(): void {
  deploymentCached = undefined
  revalidate = true
}

/** The pinned deployment with every bridge, fetched once per profile like {@link getOxideTuple}. */
export function getOxideDeployment(config: WebWalletConfig): Promise<PinnedOxideDeployment> {
  const key = oxideProfileKey(config)
  if (deploymentCached?.key !== key) {
    const deployment = loadOxideDeployment({
      ...config.oxideProfile,
      network: config.network,
      ...(revalidate ? { cache: "no-cache" as const } : {}),
    })
    deploymentCached = { key, deployment }
    deployment.catch(() => {
      if (deploymentCached?.deployment === deployment) deploymentCached = undefined
    })
  }
  return deploymentCached.deployment
}

/**
 * The fee token's bridge, where registrations and metadata updates settle; the pinned bridge's own entry when it is
 * that bridge, so it carries the overlay {@link getOxideTuple} applies.
 */
export async function getFeeTokenBridgeTuple(config: WebWalletConfig): Promise<OxideEnvTuple> {
  const [pinned, { deployment }] = await Promise.all([
    getOxideTuple(config),
    getOxideDeployment(config),
  ])
  const fee = feeTokenBridge(deployment)
  if (!fee || fee.portal.toLowerCase() === pinned.portal.toLowerCase()) return pinned
  return fee.tuple
}

/** How long a read of the table's rows is reused. The owner can change a row at any time. */
export const DEPLOYMENT_TABLE_TTL_MS = 30_000

let tableCached: { key: string; at: number; table: Promise<OxideDeploymentTable> } | undefined

/**
 * The pinned table's rows, read off L1 and reused for {@link DEPLOYMENT_TABLE_TTL_MS}. `fresh` reads again, for a
 * quote the user is about to act on. A failed read is not sticky.
 */
export function getDeploymentTable(
  config: WebWalletConfig,
  opts: { fresh?: boolean } = {},
): Promise<OxideDeploymentTable> {
  const key = oxideProfileKey(config)
  if (
    opts.fresh ||
    tableCached?.key !== key ||
    Date.now() - tableCached.at > DEPLOYMENT_TABLE_TTL_MS
  ) {
    const table = getOxideDeployment(config).then(({ deployment }) =>
      readDeploymentTable(l1PublicClient(config), deployment),
    )
    tableCached = { key, at: Date.now(), table }
    table.catch(() => {
      if (tableCached?.table === table) tableCached = undefined
    })
  }
  return tableCached.table
}

/**
 * The rows a SIPA committed to `forwardingTable` sweeps through: the pinned table's, or, after a repoint, those of the
 * earlier table. An address handed out before the repoint still commits to it. The earlier table may route a token to
 * a bridge the pinned deployment has since replaced or dropped, so every bridge the manifests list is a candidate.
 */
export async function getSipaDeploymentTable(
  config: WebWalletConfig,
  forwardingTable: string,
): Promise<OxideDeploymentTable> {
  const { deployment } = await getOxideDeployment(config)
  if (deployment.forwardingTable?.toLowerCase() === forwardingTable.toLowerCase()) {
    return getDeploymentTable(config)
  }
  const pinnedPortals = new Set(deployment.bridges.map(({ portal }) => portal.toLowerCase()))
  const others = (await getManifestBridges(config))
    .filter(({ portal }) => !pinnedPortals.has(portal.toLowerCase()))
    .map(bridgeOfTuple)
  return readDeploymentTable(l1PublicClient(config), {
    ...deployment,
    forwardingTable,
    bridges: [...deployment.bridges, ...others],
  })
}

let retiredCached: { key: string; deployments: Promise<OxideEnvTuple[]> } | undefined

const portalTuples = new Map<string, Promise<OxideEnvTuple>>()

/** How long one manifest tuple fetch may take before a later read fetches again. */
export const ASSET_TUPLE_TIMEOUT_MS = 20_000

/**
 * The pinned deployment's retired-rollup siblings — other current deployments sharing its L1
 * chain and name registry, which is what sign-in admission needs to accept a passkey still bound
 * to a rollup this profile has since cut over from. A separate fetch and cache from
 * {@link getOxideTuple}'s (see {@link loadRetiredRollupSources}'s doc comment for why).
 * Bounded by {@link ASSET_TUPLE_TIMEOUT_MS}: a failed read stops sign-in from concluding a passkey
 * has no account, so a slow manifest must not fail it sooner than a portal tuple fetch. The bound
 * also keeps a fetch that never settles out of the cache.
 */
export async function getRetiredRollupSources(config: WebWalletConfig): Promise<OxideEnvTuple[]> {
  const key = oxideProfileKey(config)
  if (retiredCached?.key !== key) {
    const deployments = withTimeout(
      Promise.all([
        loadRetiredRollupSources({ ...config.oxideProfile, network: config.network }),
        getOtherManifestSources(config),
      ]).then(async ([listed, others]) => {
        if (!others.length) return listed
        const pinned = await getOxideTuple(config)
        return [...listed, ...others.filter((tuple) => isRetiredRollupSource(tuple, pinned))]
      }),
      ASSET_TUPLE_TIMEOUT_MS,
    )
    retiredCached = { key, deployments }
    deployments.catch(() => {
      if (retiredCached?.deployments === deployments) retiredCached = undefined
    })
  }
  return retiredCached.deployments
}

let othersCached: { key: string; deployments: Promise<OxideEnvTuple[]> } | undefined

/**
 * The deployments of retired rollups that another manifest than the profile's publishes: an
 * earlier Aztec generation's. Each is that manifest's pinned entry for the version's portal.
 */
export function getOtherManifestSources(config: WebWalletConfig): Promise<OxideEnvTuple[]> {
  const key = oxideProfileKey(config)
  if (othersCached?.key !== key) {
    const pins = (config.sourceRollups ?? []).flatMap((rollup) =>
      rollup.manifestUrl === config.oxideProfile.manifestUrl
        ? []
        : rollup.pins.map((pin) => ({ ...pin, manifestUrl: rollup.manifestUrl })),
    )
    const deployments = withTimeout(
      Promise.all(pins.map((pin) => loadOxideManifestTuple({ ...pin, network: config.network }))),
      ASSET_TUPLE_TIMEOUT_MS,
    )
    othersCached = { key, deployments }
    deployments.catch(() => {
      if (othersCached?.deployments === deployments) othersCached = undefined
    })
  }
  return othersCached.deployments
}

let bridgesCached: { key: string; bridges: Promise<OxideEnvTuple[]> } | undefined

/**
 * Every bridge the profile's manifest lists, then the other manifests' pinned bridges: the tokens the wallet knows
 * exist. A malformed entry is skipped. Fetched once per profile; `fresh` fetches again. A list missing another
 * manifest's bridges, or a failed or stalled fetch, is not kept.
 */
export function getManifestBridges(
  config: WebWalletConfig,
  opts: { fresh?: boolean } = {},
): Promise<OxideEnvTuple[]> {
  const key = oxideProfileKey(config)
  if (opts.fresh || bridgesCached?.key !== key) {
    let complete = true
    const bridges = withTimeout(
      Promise.all([
        loadManifestBridges(config.oxideProfile.manifestUrl),
        getOtherManifestSources(config).catch(() => {
          complete = false
          return []
        }),
      ]).then(([listed, others]) => [...listed, ...others]),
      ASSET_TUPLE_TIMEOUT_MS,
    )
    bridgesCached = { key, bridges }
    const drop = () => {
      if (bridgesCached?.bridges === bridges) bridgesCached = undefined
    }
    bridges.then(() => complete || drop(), drop)
  }
  return bridgesCached!.bridges
}

async function fetchManifest(manifestUrl: string): Promise<unknown> {
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error(`oxide manifest HTTP ${response.status} (${manifestUrl})`)
  return response.json()
}

async function loadManifestBridges(manifestUrl: string): Promise<OxideEnvTuple[]> {
  return oxideManifestEntries(await fetchManifest(manifestUrl)).flatMap((entry) => {
    try {
      return [parseDeployment(entry).tuple]
    } catch {
      return []
    }
  })
}

let deploymentsCached: { key: string; deployments: Promise<OxideDeployment[]> } | undefined

/**
 * Every deployment the profile's manifest lists, with its features: where a contract a record names, such as an older
 * Sky escrow factory, is looked up. On mainnet a deployment that fails the mainnet gate is left out. Fetched once per
 * profile; a failed or stalled fetch is not sticky.
 */
export function getManifestDeployments(config: WebWalletConfig): Promise<OxideDeployment[]> {
  const key = oxideProfileKey(config)
  if (deploymentsCached?.key !== key) {
    const deployments = withTimeout(
      fetchManifest(config.oxideProfile.manifestUrl).then((manifest) =>
        oxideManifestDeployments(manifest, pinnedEntryPolicy({ network: config.network })),
      ),
      ASSET_TUPLE_TIMEOUT_MS,
    )
    deploymentsCached = { key, deployments }
    deployments.catch(() => {
      if (deploymentsCached?.deployments === deployments) deploymentsCached = undefined
    })
  }
  return deploymentsCached.deployments
}

/**
 * The first L1 block of the earliest deployment the manifest lists on `rollupVersion`: nothing a deployment on that
 * rollup sent is older, so a log scan about the rollup starts here. Undefined when the manifest cannot be read.
 */
export async function rollupScanFloor(
  config: WebWalletConfig,
  publicClient: PublicClient,
  rollupVersion: string,
): Promise<bigint | undefined> {
  try {
    const [deployments, head] = await Promise.all([
      getManifestDeployments(config),
      publicClient.getBlockNumber({ cacheTime: 0 }),
    ])
    const tuples = deployments
      .flatMap((deployment) => deployment.bridges.map((bridge) => bridge.tuple))
      .filter((tuple) => tuple.rollupVersion === rollupVersion)
    if (!tuples.length) return undefined
    const starts = await Promise.all(
      tuples.map(async (tuple) => (await deploymentScanRange(publicClient, tuple, head)).fromBlock),
    )
    return starts.reduce((low, start) => (start < low ? start : low))
  } catch (error) {
    console.warn("[oxide] the rollup's first deployment block could not be read:", error)
    return undefined
  }
}

/** The fleet a deployment's requests go to: the configured enclave override, else the manifest's router URL. */
export function fleetUrl(
  config: WebWalletConfig,
  tuple: Pick<OxideEnvTuple, "enclaveUrl">,
): string {
  return config.enclaveUrl ? `${config.enclaveUrl}/rpc` : tuple.enclaveUrl
}

/**
 * The manifest tuple of `portal` in the profile's manifest, fetched once per manifest and portal.
 * A failed or stalled fetch is not sticky: it rejects after {@link ASSET_TUPLE_TIMEOUT_MS} and the
 * next read fetches again.
 */
export function getPortalTuple(
  config: WebWalletConfig,
  portal: string,
  expectedGitSha?: string,
): Promise<OxideEnvTuple> {
  const key = `${config.oxideProfile.manifestUrl}|${portal.toLowerCase()}`
  let tuple = portalTuples.get(key)
  if (!tuple) {
    const made = withTimeout(
      loadOxideManifestTuple({
        manifestUrl: config.oxideProfile.manifestUrl,
        portal,
        ...(expectedGitSha ? { expectedGitSha } : {}),
        network: config.network,
      }),
      ASSET_TUPLE_TIMEOUT_MS,
    )
    portalTuples.set(key, made)
    made.catch(() => {
      if (portalTuples.get(key) === made) portalTuples.delete(key)
    })
    tuple = made
  }
  return tuple
}

// TEMPORARY — remove once oxide's manifest carries registrationController. It is the one contract
// the NameRegistry points at that the manifest schema does not publish, so the registration
// schedule has nowhere else to look. The manifest value wins when present; a zero or failed read
// leaves the tuple as loaded.
const REGISTRY_CONTROLLER_ABI = parseAbi([
  "function registrationController() view returns (address)",
])

async function withRegistryController(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
): Promise<OxideEnvTuple> {
  if (
    (tuple.registrationController && !isAllZeroHex(tuple.registrationController)) ||
    !tuple.registry
  ) {
    return tuple
  }
  try {
    const controller = await l1PublicClient(config).readContract({
      address: tuple.registry as Address,
      abi: REGISTRY_CONTROLLER_ABI,
      functionName: "registrationController",
    })
    return isAllZeroHex(controller) ? tuple : { ...tuple, registrationController: controller }
  } catch (err) {
    console.warn(
      "registrationController read from the name registry failed; manifest tuple used as is",
      err,
    )
    return tuple
  }
}

/**
 * Read a manifest field a rail cannot run without — a thin manifest fails
 * here, naming the field, instead of as a TypeError deep in the flow.
 */
export function requireTupleField<K extends keyof OxideEnvTuple>(
  tuple: OxideEnvTuple,
  field: K,
): NonNullable<OxideEnvTuple[K]> {
  const value = tuple[field]
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    throw new Error(`oxide manifest lacks ${String(field)}`)
  }
  return value
}

/** One L1 public client over the configured chain + RPC. */
export function l1PublicClient(config: WebWalletConfig): PublicClient {
  return createPublicClient({
    chain: config.l1Chain,
    transport: l1Transport(config),
  }) as PublicClient
}

/** An L1 client that folds the contract reads it is handed within 50 ms into one Multicall3 call. */
export function l1MulticallClient(config: WebWalletConfig): PublicClient {
  const chain = {
    ...config.l1Chain,
    contracts: { ...config.l1Chain.contracts, multicall3: { address: MULTICALL3_ADDRESS } },
  }
  return createPublicClient({
    chain,
    transport: l1Transport(config),
    // viem's default 1 KiB of calldata per batch holds six predictSIPA reads.
    batch: { multicall: { wait: 50, batchSize: 16_384 } },
  }) as PublicClient
}

/**
 * The L2 address a registration asks oxide's NamePortal to report the claimed name to: this
 * deployment's ClaimFPC, whose registration rail consumes that message. It is committed into the
 * registration intent, so it is also part of the derived SIPA address — every path that re-derives
 * one (claim, sweep, seed, resume) reads it from here so they all reproduce the same address.
 *
 * A registration that named nobody would succeed and emit no message, leaving the rail permanently
 * closed to the account with nothing to show why, so an absent address fails the claim instead.
 */
function namePortalRecipient(config: WebWalletConfig): Hex {
  if (!config.claimFpcAddress) {
    throw new Error(
      "the config profile carries no claimFpc address — a registration would name no recipient " +
        "for the name message, and the sponsored rail would never admit this account",
    )
  }
  return config.claimFpcAddress as Hex
}

/** How long a resolver-operator selection is reused. Selecting one scans the deployment's whole
 *  operator log history, and the tag step starts it ahead of the claim. */
export const RESOLVER_OPERATOR_REUSE_MS = 5 * 60_000

type ResolverRecord = Awaited<ReturnType<typeof fetchSignupResolverRecord>>

let operatorCached:
  | { tuple: OxideEnvTuple; at: number; record: Promise<ResolverRecord> }
  | undefined

function signupResolverRecord(
  config: WebWalletConfig,
  tuple: OxideEnvTuple,
  publicClient: PublicClient,
): Promise<ResolverRecord> {
  if (
    operatorCached?.tuple !== tuple ||
    Date.now() - operatorCached.at > RESOLVER_OPERATOR_REUSE_MS
  ) {
    const record = fetchSignupResolverRecord(publicClient, tuple, config.network)
    operatorCached = { tuple, at: Date.now(), record }
    record.catch(() => {
      if (operatorCached?.record === record) operatorCached = undefined
    })
  }
  return operatorCached.record
}

/**
 * The resolved oxide env plus the L1 client it was read through — the preamble
 * every onboarding rail (claim, detection, recovery) builds.
 */
export async function oxideEnvFor(config: WebWalletConfig): Promise<{
  tuple: OxideEnvTuple
  env: ReturnType<typeof oxideEnvFromTuple>
  publicClient: PublicClient
  resolver: ResolverRecord
}> {
  const tuple = await getOxideTuple(config)
  const publicClient = l1PublicClient(config)
  const resolver = await signupResolverRecord(config, tuple, publicClient)
  const resolverOperator = resolver.owner as Address
  const accountFactory = resolveOxideAccountFactory({ tuple })
  const env = oxideEnvFromTuple(tuple, {
    resolverOperator,
    l1ChainId: config.l1ChainId,
    accountFactory,
    namePortalRecipient: namePortalRecipient(config),
  })
  return { tuple, env, publicClient, resolver }
}
