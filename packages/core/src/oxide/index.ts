// Dependency-free validation, extraction and acquisition for oxide's hosted deployment-env
// manifest (schema v4 and v5, read as one self-contained entry per portal, or as the pinned deployment's bridges in
// `./deployment.ts`). Lives in the leaf
// package so every consumer shares one canonical path with zero `@aztec/*` runtime weight:
//   - `@obsidion/contracts` OxideEnvRegistryClient (the runtime tuple client)
//   - front-core's compatibility export (wallet-side fetch seam)
//   - account-service's loader (backend-side; cannot take front-core's weight)
//
// The pinned entry carries the ATOMIC attestation triple `enclaveUrl` ↔ `portal` ↔ `pcr0`
// (the enclave is verified against the on-chain portal binding), so consumers never mix that
// triple across entries. Migration sources are selected by supported profile history; the caller
// checks their underlying asset and uses each source's own enclave.

import { MAINNET_ENS_DOMAIN, MAINNET_ENTRY_POINT, Network } from "../constants/index.js"
import type {
  FetchFunction,
  OxideEnvProfile,
  OxideEnvTuple,
  OxideFeature,
  OxideTokenImmutablesData,
} from "../types/index.js"
import {
  bridgeByToken,
  deploymentOfTuples,
  type OxideBridge,
  type OxideDeployment,
} from "./deployment.js"

export { L1RpcSimulationUnsupportedError, assertL1RpcSimulates } from "./l1RpcSimulation.js"
export * from "./deployment.js"

// L1 (EVM) addresses are 20 bytes; L2 (Aztec field) addresses are 32 bytes.
const L1_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const L2_ADDRESS = /^0x[0-9a-fA-F]{64}$/

/** Validation failure ⇒ `manifest-incompatible` (vs network `fetch-failed`). */
export class OxideManifestValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new OxideManifestValidationError(
      `oxide env registry: ${field} is missing or malformed (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

/** True for `0x0`, `0x00…0` — any all-zero hex string. */
export function isAllZeroHex(value: string): boolean {
  return /^0x0+$/i.test(value)
}

/** L1 address that is well-formed AND not the zero address (a zero address is truthy). */
export function requireNonZeroL1Address(value: unknown, field: string): string {
  const v = requirePattern(value, L1_ADDRESS, field)
  if (isAllZeroHex(v))
    throw new OxideManifestValidationError(`oxide env registry: ${field} is the zero address`)
  return v
}

/** Non-throwing form of {@link requireNonZeroL1Address}, for a field a caller skips rather than rejects. */
function isWellFormedNonZeroL1Address(value: unknown): value is string {
  return typeof value === "string" && L1_ADDRESS.test(value) && !isAllZeroHex(value)
}

/** L2 address that is well-formed AND not the zero address. */
export function requireNonZeroL2Address(value: unknown, field: string): string {
  const v = requirePattern(value, L2_ADDRESS, field)
  if (isAllZeroHex(v))
    throw new OxideManifestValidationError(`oxide env registry: ${field} is the zero address`)
  return v
}

function requireHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new OxideManifestValidationError(`oxide env registry: ${field} is not a string`)
  }
  try {
    const { protocol } = new URL(value)
    if (protocol !== "https:" && protocol !== "http:") throw new Error()
  } catch {
    throw new OxideManifestValidationError(
      `oxide env registry: ${field} is not a well-formed http(s) URL (got ${JSON.stringify(
        value,
      )})`,
    )
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** An ISO-8601 instant, kept verbatim alongside its epoch ms. Both callers bound something by it. */
function requireIsoTimestamp(value: unknown, field: string): { iso: string; ms: number } {
  const iso = requirePattern(value, /^\d{4}-\d{2}-\d{2}T/, field)
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new OxideManifestValidationError(
      `oxide env registry: ${field} is not parseable (got ${JSON.stringify(iso)})`,
    )
  }
  return { iso, ms }
}

/** A non-negative integer as a decimal string; anything else reads as absent. */
function optionalDecimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value)
  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined
}

export interface ExtractOxideEnvTupleOptions {
  /**
   * Enforce the strict mainnet (`prod.v4.json`) schema: the a1/SIPA/fee address
   * surface present as well-formed NON-ZERO addresses and a numeric
   * `rollupVersion`. `accountFactory`/`entryPoint`/`ensDomain` are NOT required
   * here — the app hardcodes entryPoint/ensDomain, and the factory (oxide's on
   * every network) is demanded non-zero by its consumers, not by the parser.
   * Off for testnet/staging/dev/sandbox, which tolerate the leaner tuple.
   */
  requireProdSchema?: boolean
  /**
   * Explicit SHA expectations reject mismatches. The network policy leaves this unset;
   * OxideEnvRegistryClient reports SHA drift as a non-blocking warning.
   */
  expectedGitSha?: string
}

/**
 * Mainnet requires the full prod schema; other networks use a bare extract. Git SHA drift is advisory.
 */
export function pinnedEntryPolicy(pin: {
  network: Network
  expectedGitSha?: string
}): ExtractOxideEnvTupleOptions | undefined {
  return pin.network === Network.MAINNET ? { requireProdSchema: true } : undefined
}

/**
 * Apply the strict mainnet gate to an already-extracted tuple. Split out from
 * extractPinnedOxideEnvTuple so a caller holding a tuple it did not parse itself runs
 * the exact same checks, and no unvetted tuple can go live on mainnet.
 */
export function assertProdOxideTuple(
  tuple: OxideEnvTuple,
  opts: ExtractOxideEnvTupleOptions,
): void {
  if (opts.requireProdSchema) {
    if (!/^\d+$/.test(tuple.rollupVersion ?? "")) {
      throw new OxideManifestValidationError(
        `oxide env registry: mainnet manifest has a missing or non-numeric rollupVersion ` +
          `(got ${JSON.stringify(tuple.rollupVersion)})`,
      )
    }
    // a1 / tag resolution reads registry; SIPA wiring reads resolverGatewayUrl / l2Broadcaster;
    // withdrawals settle into plainWithdrawalExecutor; token/portal/l2Token are the base tuple. All
    // must be well-formed and non-zero on mainnet.
    //
    // The deposit fee is NOT gated here. It is an immutable on the intent implementation the
    // `sipaFactory` serves, and the live mainnet document publishes no `sipaFactory` — gating it
    // would reject prod.json rather than describe it. A mainnet manifest without one has no
    // priceable SIPA rail at all, which the deposit reads report where they run.
    requireNonZeroL1Address(tuple.registry, "registry")
    requireNonZeroL1Address(tuple.plainWithdrawalExecutor, "plainWithdrawalExecutor")
    requireNonZeroL2Address(tuple.l2Broadcaster, "l2Broadcaster")
    requireHttpUrl(tuple.resolverGatewayUrl, "resolverGatewayUrl")
    requireNonZeroL1Address(tuple.token, "token")
    requireNonZeroL1Address(tuple.portal, "portal")
    requireNonZeroL2Address(tuple.l2Token, "l2Token")
    // Optional — a manifest without the swap stack simply offers no swap routes. A PUBLISHED
    // placeholder is the dangerous case: the burn pays a CREATE2 escrow derived from this factory,
    // and nothing can ever deploy at an address derived from zero.
    if (tuple.swapEscrowFactoryV2 !== undefined) {
      requireNonZeroL1Address(tuple.swapEscrowFactoryV2, "swapEscrowFactoryV2")
    }
    if (tuple.skyEscrowFactory !== undefined) {
      requireNonZeroL1Address(tuple.skyEscrowFactory, "skyEscrowFactory")
    }
  }
  if (opts.expectedGitSha && tuple.gitSha !== opts.expectedGitSha) {
    throw new OxideManifestValidationError(
      `oxide env registry: mainnet manifest gitSha ${JSON.stringify(tuple.gitSha)} != expected ` +
        `${JSON.stringify(opts.expectedGitSha)} — same-sha parity is enforced on mainnet.`,
    )
  }
}

/**
 * The manifest's entries, one per portal, in document order. Schema v4 entries are already per portal. A schema v5
 * deployment lists its bridges, and each bridge reads as the deployment's fields plus its own.
 */
export function oxideManifestEntries(manifest: unknown): Record<string, unknown>[] {
  return oxideManifestGroups(manifest).flat()
}

/**
 * The manifest's deployments, each as its bridges' per-portal entries, in document order. A schema v4 entry is a
 * deployment of one bridge.
 */
export function oxideManifestGroups(manifest: unknown): Record<string, unknown>[][] {
  if (!isRecord(manifest)) {
    throw new OxideManifestValidationError("oxide env registry: manifest is not an object")
  }
  if (manifest.schemaVersion !== "4" && manifest.schemaVersion !== "5") {
    throw new OxideManifestValidationError(
      `oxide env registry: unsupported schemaVersion ${JSON.stringify(
        manifest.schemaVersion,
      )} (expected "4" or "5")`,
    )
  }
  if (!Array.isArray(manifest.deployments)) {
    throw new OxideManifestValidationError("oxide env registry: missing deployments array")
  }
  const deployments = manifest.deployments.map((entry, i) => {
    if (!isRecord(entry)) {
      throw new OxideManifestValidationError(
        `oxide env registry: deployments[${i}] is not an object`,
      )
    }
    return entry
  })
  requireUnique(deployments, "label")
  const groups =
    manifest.schemaVersion === "4"
      ? deployments.map((entry) => [entry])
      : deployments.map(bridgeEntries)
  requireUnique(groups.flat(), "portal")
  return groups
}

function bridgeEntries(deployment: Record<string, unknown>, i: number): Record<string, unknown>[] {
  const { bridges, ...shared } = deployment
  if (!Array.isArray(bridges) || bridges.length === 0) {
    throw new OxideManifestValidationError(`oxide env registry: deployments[${i}] lists no bridges`)
  }
  return bridges.map((bridge, j) => {
    if (!isRecord(bridge)) {
      throw new OxideManifestValidationError(
        `oxide env registry: deployments[${i}].bridges[${j}] is not an object`,
      )
    }
    return { ...shared, ...bridge }
  })
}

function requireUnique(entries: Record<string, unknown>[], key: "portal" | "label"): void {
  const seen = new Map<string, number>()
  entries.forEach((entry, i) => {
    const value = entry[key]
    if (typeof value !== "string") return
    const id = key === "portal" ? value.toLowerCase() : value
    const first = seen.get(id)
    if (first !== undefined) {
      throw new OxideManifestValidationError(
        `oxide env registry: deployments[${first}] and deployments[${i}] share ${key} ${value}`,
      )
    }
    seen.set(id, i)
  })
}

function samePortal(entry: Record<string, unknown>, portal: string): boolean {
  return typeof entry.portal === "string" && entry.portal.toLowerCase() === portal.toLowerCase()
}

/** The entry pinned by portal. Absent ⇒ throws naming the pin and every available portal. */
export function selectDeployment(
  manifest: unknown,
  pin: { portal: string },
): Record<string, unknown> {
  const deployments = oxideManifestEntries(manifest)
  const hit = deployments.find((entry) => samePortal(entry, pin.portal))
  if (!hit) throw missingPin(deployments, pin.portal)
  return hit
}

function missingPin(
  entries: Record<string, unknown>[],
  portal: string,
): OxideManifestValidationError {
  const available = entries.map((entry) => String(entry.portal)).join(", ") || "none"
  return new OxideManifestValidationError(
    `oxide env registry: no deployment for pinned portal ${portal} (available: ${available}) ` +
      "— profile fix or app update may be required",
  )
}

/**
 * One per-portal entry → OxideEnvTuple, field for field. `timestamp` is the entry's `updatedAt` and moves
 * on every republish; `deployedAt` is when the deployment came into existence and does not.
 */
export function parseDeployment(entry: Record<string, unknown>): {
  tuple: OxideEnvTuple
  timestampMs: number
} {
  const { iso: updatedAt, ms: timestampMs } = requireIsoTimestamp(entry.updatedAt, "updatedAt")
  const tuple: OxideEnvTuple = {
    version: requirePattern(entry.label, /\S/, "label"),
    gitSha: optionalString(entry.gitSha) ?? "",
    timestamp: updatedAt,
    deployedAt: requireIsoTimestamp(entry.deployedAt, "deployedAt").iso,
    deployedAtBlock: optionalDecimal(entry.deployedAtBlock),
    portal: requirePattern(entry.portal, L1_ADDRESS, "portal"),
    token: requirePattern(entry.token, L1_ADDRESS, "token"),
    underlying: requirePattern(entry.underlying ?? entry.token, L1_ADDRESS, "underlying"),
    bridgeKey: optionalString(entry.key),
    bridgeId: optionalString(entry.bridgeId),
    l2Token: requirePattern(entry.l2Token, L2_ADDRESS, "l2Token"),
    l2TokenImmutables: parseTokenImmutables(entry.l2TokenImmutables, entry.portal),
    enclaveUrl: requireHttpUrl(entry.enclaveUrl, "enclaveUrl"),
    pcr0: optionalString(entry.pcr0) ?? "",
    rollupVersion: requirePattern(entry.rollupVersion, /^\d+$/, "rollupVersion"),
    chainId: requirePattern(entry.chainId, /^[1-9]\d*$/, "chainId"),
    certManager: optionalString(entry.certManager),
    nitroValidator: optionalString(entry.nitroValidator),
    registry: optionalString(entry.nameRegistry),
    accountMetadataRegistry: optionalString(entry.accountMetadataRegistry),
    accountFactory: optionalString(entry.accountFactory),
    registrationController: optionalString(entry.registrationController),
    namePortal: optionalString(entry.namePortal),
    paymaster: optionalString(entry.paymaster),
    entryPoint: optionalString(entry.entryPoint),
    ensDomain: optionalString(entry.ensDomain),
    sipaFactory: optionalString(entry.sipaFactory),
    sipaRecoveryProtocol: sipaRecoveryProtocol(entry.sipaRecoveryProtocol),
    sipaResolver: optionalString(entry.sipaResolver),
    resolverProofVerifier: optionalString(entry.resolverProofVerifier),
    resolverGatewayUrl: optionalString(entry.resolverGatewayUrl),
    depositSIPAImplementation: optionalString(entry.depositSIPAImplementation),
    registrationSIPAImplementation: optionalString(entry.registrationSIPAImplementation),
    forwardingTable: optionalString(entry.forwardingTable),
    feeToken: optionalString(entry.feeToken),
    depositSubsidy: optionalString(entry.depositSubsidy),
    withdrawalSubsidy: optionalString(entry.withdrawalSubsidy),
    proverSubsidy: optionalString(entry.proverSubsidy),
    plainWithdrawalExecutor: optionalString(entry.plainWithdrawalExecutor),
    l2Broadcaster: optionalString(entry.l2Broadcaster),
    frozenNotesRefundVerifier: optionalString(entry.frozenNotesRefundVerifier),
    // Oxide manifests name it `frozenDeposits…` from the batched circuit on.
    frozenDepositRefundVerifier: optionalString(
      entry.frozenDepositsRefundVerifier ?? entry.frozenDepositRefundVerifier,
    ),
    unprocessedDepositRefundVerifier: optionalString(entry.unprocessedDepositRefundVerifier),
    frozenNotesRefundVkSha256: optionalString(entry.frozenNotesRefundVkSha256),
    frozenDepositRefundVkSha256: optionalString(
      entry.frozenDepositsRefundVkSha256 ?? entry.frozenDepositRefundVkSha256,
    ),
    swapEscrowFactoryV2:
      optionalString(entry.swapEscrowFactoryV2) ??
      swapFeatureFactory(entry.features, entry.bridgeId),
    skyEscrowFactory: optionalString(entry.skyEscrowFactory),
    features: parseFeatures(entry.features),
    operationExecutor: optionalString(entry.operationExecutor),
    fpcFunder: optionalString(entry.fpcFunder),
    fpcBeneficiary: optionalString(entry.fpcBeneficiary),
    fpcBeneficiarySalt: optionalString(entry.fpcBeneficiarySalt),
  }
  return { tuple: Object.freeze(tuple), timestampMs }
}

function parseTokenImmutables(
  value: unknown,
  portal: unknown,
): Readonly<OxideTokenImmutablesData> | undefined {
  if (value === undefined) return undefined
  const field = "l2TokenImmutables"
  if (!isRecord(value)) {
    throw new OxideManifestValidationError(`oxide env registry: ${field} is not an object`)
  }
  const tokenPortal = requireNonZeroL1Address(value.portal, `${field}.portal`)
  if (typeof portal !== "string" || tokenPortal.toLowerCase() !== portal.toLowerCase()) {
    throw new OxideManifestValidationError(`oxide env registry: ${field}.portal differs from portal`)
  }
  const teeRegistry = requireNonZeroL1Address(value.teeRegistry, `${field}.teeRegistry`)
  const text = (key: "name" | "symbol"): string => {
    const text = value[key]
    if (typeof text !== "string" || new TextEncoder().encode(text).length > 31) {
      throw new OxideManifestValidationError(
        `oxide env registry: ${field}.${key} must be a string of at most 31 UTF-8 bytes`,
      )
    }
    return text
  }
  const decimals = value.decimals
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new OxideManifestValidationError(`oxide env registry: ${field}.decimals must fit in a u8`)
  }
  const maxNoteAmount = requirePattern(value.maxNoteAmount, /^(0|[1-9]\d*)$/, `${field}.maxNoteAmount`)
  if (BigInt(maxNoteAmount) >= (1n << 128n)) {
    throw new OxideManifestValidationError(`oxide env registry: ${field}.maxNoteAmount must fit in a u128`)
  }
  return Object.freeze({
    portal: tokenPortal,
    teeRegistry,
    name: text("name"),
    symbol: text("symbol"),
    decimals,
    maxNoteAmount,
  })
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((v) => typeof v === "string")

type FeatureVariable = string | number | boolean

const isFeatureVariable = (value: unknown): value is FeatureVariable =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"

/** A feature's `variables`: absent on older manifests, so read as none. A value of another type is left out. */
function featureVariables(value: unknown): Readonly<Record<string, FeatureVariable>> | undefined {
  if (value === undefined) return Object.freeze({})
  if (!isRecord(value)) return undefined
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).filter((e): e is [string, FeatureVariable] => isFeatureVariable(e[1])),
    ),
  )
}

/**
 * The deployment's `features`, by ID. A feature serves only its own bridges, so a malformed one is left out rather
 * than failing the deployment; its contracts and roles are checked where they are used.
 */
function parseFeatures(value: unknown): readonly OxideFeature[] | undefined {
  if (!isRecord(value)) return undefined
  return Object.freeze(
    Object.entries(value).flatMap(([id, feature]) =>
      isRecord(feature) &&
      typeof feature.project === "string" &&
      /\S/.test(feature.project) &&
      isStringRecord(feature.bridges) &&
      isStringRecord(feature.contracts) &&
      featureVariables(feature.variables)
        ? [
            Object.freeze({
              id,
              project: feature.project,
              bridges: Object.freeze({ ...feature.bridges }),
              contracts: Object.freeze({ ...feature.contracts }),
              variables: featureVariables(feature.variables)!,
            }),
          ]
        : [],
    ),
  )
}

/**
 * The SwapEscrowFactory of the deployment's `swap` feature that binds this bridge. A deployment without features names
 * the factory in the bridge's own `swapEscrowFactoryV2`. Two swap features for one bridge fail the entry: the escrow
 * address derives from the factory, so a guess could send a withdrawal to an escrow that no factory deploys.
 */
function swapFeatureFactory(features: unknown, bridgeId: unknown): string | undefined {
  if (typeof bridgeId !== "string") return undefined
  const factories = (parseFeatures(features) ?? []).filter(
    (feature) => feature.project === "swap" && Object.values(feature.bridges).includes(bridgeId),
  )
  if (factories.length > 1) {
    const ids = factories.map((feature) => feature.id).join(", ")
    throw new OxideManifestValidationError(
      `oxide env registry: bridge ${bridgeId} has more than one swap feature (${ids})`,
    )
  }
  return optionalString(factories[0]?.contracts.swapEscrowFactory)
}

function sipaRecoveryProtocol(value: unknown): "legacy-eoa" | "account" {
  if (value === undefined || value === "legacy-eoa") return "legacy-eoa"
  if (value === "account") return "account"
  throw new Error("Unknown SIPA recovery protocol")
}

/**
 * Whether an entry speaks the withdraw-and-execute protocol this wallet builds against. Entries published before it
 * carry no `plainWithdrawalExecutor`; the wallet cannot burn on their tokens.
 */
function isCurrentProtocol(entry: Record<string, unknown>): boolean {
  return entry.plainWithdrawalExecutor !== undefined
}

/**
 * Current-protocol sources explicitly selected by supported profile history. The caller compares underlying assets.
 * An unselected deployment is not migration history and is never parsed.
 */
export function migrationSources(
  manifest: unknown,
  pinned: OxideEnvTuple,
  sourcePortals: ReadonlySet<string> = new Set(),
): OxideEnvTuple[] {
  return oxideManifestEntries(manifest)
    .filter(
      (entry) =>
        typeof entry.portal === "string" &&
        sourcePortals.has(entry.portal.toLowerCase()) &&
        !samePortal(entry, pinned.portal) &&
        isCurrentProtocol(entry),
    )
    .map((entry) => parseDeployment(entry).tuple)
}

/**
 * Every other rollup's entry sharing the pinned deployment's L1 chain and name registry — an
 * earlier rollup generation of the same identity lineage (what a rollup cutover leaves behind),
 * not an unrelated deployment that merely differs in rollupVersion. The lineage is matched on raw
 * fields before parsing, so an entry outside it never has to be schema-valid. Skips an entry whose
 * `accountFactory`/`namePortal` aren't well-formed, non-zero addresses, rather than returning an
 * incomplete entry as if it were a complete deployment.
 */
export function retiredRollupSources(manifest: unknown, pinned: OxideEnvTuple): OxideEnvTuple[] {
  return oxideManifestEntries(manifest)
    .filter((entry) => sameLineage(entry, pinned))
    .map((entry) => parseDeployment(entry).tuple)
    .filter((tuple) => isRetiredRollupSource(tuple, pinned))
}

/** Whether `tuple`, from this or another generation's manifest, is a retired rollup of the pinned lineage. */
export function isRetiredRollupSource(tuple: OxideEnvTuple, pinned: OxideEnvTuple): boolean {
  return (
    sameLineage({ chainId: tuple.chainId, nameRegistry: tuple.registry }, pinned) &&
    tuple.rollupVersion !== pinned.rollupVersion &&
    isWellFormedNonZeroL1Address(tuple.accountFactory) &&
    isWellFormedNonZeroL1Address(tuple.namePortal)
  )
}

function sameLineage(entry: Record<string, unknown>, pinned: OxideEnvTuple): boolean {
  return (
    entry.chainId === pinned.chainId &&
    typeof pinned.registry === "string" &&
    typeof entry.nameRegistry === "string" &&
    entry.nameRegistry.toLowerCase() === pinned.registry.toLowerCase()
  )
}

/** The pinned entry as a tuple. With `opts`, the mainnet gate holds its whole deployment, every bridge and the table. */
export function extractPinnedOxideEnvTuple(
  manifest: unknown,
  profile: Pick<OxideEnvProfile, "portal">,
  opts?: ExtractOxideEnvTupleOptions,
): { tuple: OxideEnvTuple; timestampMs: number } {
  if (!opts) return parseDeployment(selectDeployment(manifest, { portal: profile.portal }))
  const { pinned, timestampMs } = pinnedOxideDeployment(manifest, profile, opts)
  return { tuple: pinned.tuple, timestampMs }
}

/** The pinned deployment, its pinned bridge, and the pinned entry's `updatedAt`. */
export interface PinnedOxideDeployment {
  deployment: OxideDeployment
  pinned: OxideBridge
  timestampMs: number
}

/**
 * The deployment that lists the pinned portal, every bridge parsed. With `opts`, each bridge passes the mainnet gate
 * and the deployment passes {@link assertProdOxideDeployment}.
 */
export function pinnedOxideDeployment(
  manifest: unknown,
  profile: Pick<OxideEnvProfile, "portal">,
  opts?: ExtractOxideEnvTupleOptions,
): PinnedOxideDeployment {
  const groups = oxideManifestGroups(manifest)
  const group = groups.find((entries) => entries.some((entry) => samePortal(entry, profile.portal)))
  if (!group) throw missingPin(groups.flat(), profile.portal)
  const parsed = group.map(parseDeployment)
  const tuples = parsed.map(({ tuple }) => tuple) as [OxideEnvTuple, ...OxideEnvTuple[]]
  const deployment = deploymentOfTuples(tuples)
  if (opts) {
    for (const tuple of tuples) assertProdOxideTuple(tuple, opts)
    assertProdOxideDeployment(deployment, opts)
  }
  const index = group.findIndex((entry) => samePortal(entry, profile.portal))
  return { deployment, pinned: deployment.bridges[index]!, timestampMs: parsed[index]!.timestampMs }
}

/**
 * The table checks a deployment needs before its rows go live on mainnet: one bridge per token, a non-zero table and
 * fee token where published, and a bridge for the fee token. Each bridge's own fields are
 * {@link assertProdOxideTuple}'s.
 */
export function assertProdOxideDeployment(
  deployment: OxideDeployment,
  opts: ExtractOxideEnvTupleOptions,
): void {
  if (!opts.requireProdSchema) return
  const tokens = new Set<string>()
  for (const bridge of deployment.bridges) {
    const underlying = requireNonZeroL1Address(bridge.underlying, "underlying").toLowerCase()
    if (tokens.has(underlying)) {
      throw new OxideManifestValidationError(
        `oxide env registry: deployment ${deployment.label} lists two bridges for token ${bridge.underlying}`,
      )
    }
    tokens.add(underlying)
  }
  if (deployment.forwardingTable !== undefined) {
    requireNonZeroL1Address(deployment.forwardingTable, "forwardingTable")
  }
  if (deployment.feeToken !== undefined) {
    requireNonZeroL1Address(deployment.feeToken, "feeToken")
    if (!bridgeByToken(deployment, deployment.feeToken)) {
      throw new OxideManifestValidationError(
        `oxide env registry: deployment ${deployment.label} has no bridge for its fee token ${deployment.feeToken}`,
      )
    }
  }
}

/**
 * Every deployment of the manifest, each bridge parsed, in document order. With `opts`, each must pass the mainnet
 * gate as {@link pinnedOxideDeployment} applies it. A deployment with a malformed bridge or one failing the gate is
 * skipped; a manifest {@link oxideManifestGroups} rejects throws, as it does for the pinned read.
 */
export function oxideManifestDeployments(
  manifest: unknown,
  opts?: ExtractOxideEnvTupleOptions,
): OxideDeployment[] {
  return oxideManifestGroups(manifest).flatMap((group) => {
    try {
      const tuples = group.map((entry) => parseDeployment(entry).tuple) as [
        OxideEnvTuple,
        ...OxideEnvTuple[],
      ]
      const deployment = deploymentOfTuples(tuples)
      if (opts) {
        for (const tuple of tuples) assertProdOxideTuple(tuple, opts)
        assertProdOxideDeployment(deployment, opts)
      }
      return [deployment]
    } catch {
      return []
    }
  })
}

export interface LoadOxideManifestOpts {
  /** The pinned manifest URL to fetch. */
  manifestUrl: string
  portal: string
  /** MAINNET applies the prod-schema gate + entryPoint/ensDomain overlay; other networks bare-extract. */
  network: Network
  /** Deployment provenance; a different manifest gitSha does not block a read. */
  expectedGitSha?: string
  /** Injectable fetch implementation; defaults to global fetch. */
  fetchImpl?: FetchFunction
  /** `no-cache` makes a deployment read revalidate with the host, so a host `max-age` cannot delay a change. */
  cache?: "no-cache"
}

/** Fetch and validate a pinned Oxide manifest into the tuple every direct consumer shares. */
export async function loadOxideManifestTuple(opts: LoadOxideManifestOpts): Promise<OxideEnvTuple> {
  const response = await (opts.fetchImpl ?? fetch)(opts.manifestUrl)
  if (!response.ok) {
    throw new Error(`oxide manifest HTTP ${response.status} (${opts.manifestUrl})`)
  }
  const { tuple } = extractPinnedOxideEnvTuple(await response.json(), opts, pinnedEntryPolicy(opts))
  if (opts.network === Network.MAINNET) {
    return Object.freeze({
      ...tuple,
      entryPoint: MAINNET_ENTRY_POINT,
      ensDomain: MAINNET_ENS_DOMAIN,
    })
  }
  return tuple
}

/** Fetch and validate a pinned Oxide manifest into the pinned deployment, with the same overlay and gate. */
export async function loadOxideDeployment(
  opts: LoadOxideManifestOpts,
): Promise<PinnedOxideDeployment> {
  const load = opts.fetchImpl ?? fetch
  const response = await (opts.cache
    ? load(opts.manifestUrl, { cache: opts.cache })
    : load(opts.manifestUrl))
  if (!response.ok) {
    throw new Error(`oxide manifest HTTP ${response.status} (${opts.manifestUrl})`)
  }
  const pinned = pinnedOxideDeployment(await response.json(), opts, pinnedEntryPolicy(opts))
  if (opts.network !== Network.MAINNET) return pinned
  const tuples = pinned.deployment.bridges.map(({ tuple }) =>
    Object.freeze({ ...tuple, entryPoint: MAINNET_ENTRY_POINT, ensDomain: MAINNET_ENS_DOMAIN }),
  ) as [OxideEnvTuple, ...OxideEnvTuple[]]
  const deployment = deploymentOfTuples(tuples)
  const index = pinned.deployment.bridges.indexOf(pinned.pinned)
  return { ...pinned, deployment, pinned: deployment.bridges[index]! }
}

/**
 * Fetch and validate the oxide manifest's retired-rollup siblings of the pinned entry. A separate
 * fetch from {@link loadOxideManifestTuple} (not its cached result): callers that need both pay
 * two small requests rather than entangle this with the pinned-tuple cache every other consumer
 * shares.
 */
export async function loadRetiredRollupSources(
  opts: LoadOxideManifestOpts,
): Promise<OxideEnvTuple[]> {
  const response = await (opts.fetchImpl ?? fetch)(opts.manifestUrl)
  if (!response.ok) {
    throw new Error(`oxide manifest HTTP ${response.status} (${opts.manifestUrl})`)
  }
  const manifest = await response.json()
  const { tuple: pinned } = extractPinnedOxideEnvTuple(manifest, opts, pinnedEntryPolicy(opts))
  return retiredRollupSources(manifest, pinned)
}
