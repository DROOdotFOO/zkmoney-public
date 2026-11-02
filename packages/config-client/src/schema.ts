import { z } from "zod"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"

/**
 * The store serves one document per published version at `profiles/<generation>/<x.y.z>.json` — this
 * shape, carrying that entry alone — and `current.json` beside them, a copy of the live one. The id
 * names the tier + rollup generation, `network` the chain; a new rollup is a NEW generation prefix,
 * never a new version.
 */

/**
 * Shape marker per `versions` entry: an unknown marker parses opaquely and fails typed at
 * resolution ("app update required"), so a pinned consumer keeps booting.
 */
export const VERSION_ENTRY_SCHEMA_VERSION = "1"

export const PROFILE_NETWORKS = ["sandbox", "testnet", "mainnet"] as const
export type ProfileNetwork = (typeof PROFILE_NETWORKS)[number]

/** l1ChainId is derived state: pinning it to the network keeps the enum authoritative. */
export const NETWORK_L1_CHAIN_IDS: Record<ProfileNetwork, number> = {
  sandbox: 31337,
  testnet: 11155111,
  mainnet: 1,
}

const l1Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 20-byte 0x-hex L1 address")
const field32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte 0x-hex value")
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 value")
const fullGitSha = z.string().regex(/^[0-9a-f]{40}$/, "expected full 40-char lowercase git sha")
const isoInstant = z.iso.datetime({ offset: true })
const httpUrl = z.url({ protocol: /^https?$/ })
const versionProfileUrl = httpUrl.refine(
  (value) => !new URL(value).pathname.endsWith("/current.json"),
  "profile reference must not name mutable current.json",
)

const profileId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "profileId: lowercase alphanumeric + dashes, max 64 chars")
/**
 * Our deployment id, spelled like the `CONTRACT_SERVICE_VERSION` it succeeds; only uniqueness
 * matters — `current`, not ordering, picks the live one.
 */
const versionId = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "version id: x.y.z (no leading zeros)")

export function isConfigVersionId(value: unknown): value is string {
  return versionId.safeParse(value).success
}

const contractName = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/, "contract name: camelCase identifier")

const assetSymbol = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,15}$/, "asset: a token symbol")

/**
 * L2 requires `classId` (`address` optional — a class can exist with no instance); L1 is
 * `{address}` alone, a separate shape so an L2 entry cannot omit its class and validate.
 * `meta` is per-contract config, validated fail-closed by its consumer.
 */
const l1ContractEntry = z.strictObject({
  address: l1Address,
})

const l2ContractEntry = z.strictObject({
  address: field32.optional(),
  classId: field32,
  meta: z.record(z.string(), z.unknown()).optional(),
})

const contractEntry = z.union([l1ContractEntry, l2ContractEntry])

/** Derived from the class (per link, per user, or once) — the document check rejects an address row. */
export const PER_INSTANCE_CONTRACTS = [
  "paylinkDirect",
  "paylinkEmail",
  "obsidionAccountAlpha",
  "obsidionAccountAlphaTest",
  "linkLocator",
] as const

export type ConfigContractEntry = z.infer<typeof contractEntry>
export type ConfigL1ContractEntry = z.infer<typeof l1ContractEntry>
export type ConfigL2ContractEntry = z.infer<typeof l2ContractEntry>

/** Presence of `classId` separates the two: an L1 entry has no class to verify against. */
export function isL2ContractEntry(entry: ConfigContractEntry): entry is ConfigL2ContractEntry {
  return "classId" in entry
}

// Strict objects everywhere; the one loose shape is an unknown-schema version entry.
const sharedSchema = z.strictObject({
  l1ChainId: z.int().positive(),
  xmtpEnv: z.enum(["local", "dev", "production"]),
  /** The rollup every version here runs on. A different rollup is a different document. */
  rollupVersion: z.string().regex(/^\d+$/, "on-chain rollupVersion as a decimal string"),
  /** The final profile of the generation this one replaced. */
  previousGenerationProfile: versionProfileUrl.nullable().optional(),
})

/**
 * A self-contained snapshot of one deployment; `shared` holds what no deployment can change. The
 * name is the wallet's own version stream, unrelated to oxide's deployment labels.
 */
const versionSchema = z.strictObject({
  /** The shape of this entry — see VERSION_ENTRY_SCHEMA_VERSION. */
  schemaVersion: z.literal(VERSION_ENTRY_SCHEMA_VERSION),
  /** The obsidion commit this deployment was cut from — ours, distinct from `oxide.expectedGitSha`. */
  gitSha: fullGitSha.optional(),
  /** A reference point (ordering, incident timelines), not an audit record. */
  deployedAt: isoInstant,
  nodeUrl: httpUrl,
  l1RpcUrl: httpUrl,
  /** Obsidion's own account-service. Oxide's manifest has a same-named field for their resolver-side service; these are different deployments. */
  accountServiceUrl: httpUrl,
  zkmoneyApiUrl: httpUrl.optional(),
  /** Origin the wallet composes claim/request links against, e.g. `https://paylink.test.zk.money`. */
  paylinkDomain: httpUrl,
  // Oxide by pointer, never copied. `expectedGitSha` is optional here but required on mainnet by
  // the document check — a missing pin would degrade the same-sha gate to schema-only.
  oxide: z.strictObject({
    manifestUrl: httpUrl,
    /** The pinned deployment's portal in `<env>.v4.json`. */
    portal: l1Address,
    expectedGitSha: fullGitSha.optional(),
  }),
  /**
   * Display metadata for the wallet's assets: a symbol and a place in the list for the deployment found by portal in
   * `oxide`'s manifest. The deposit tokens come from the pinned forwarding table's rows; an asset only names and
   * orders a row, and adds or removes none. Withdrawals and savings find an asset's deployment by its portal. The
   * wallet token (DAI) is `oxide`'s own deployment, where names and registration live, and no other asset is;
   * `oxide` stays for clients that predate this field.
   */
  assets: z
    .array(
      z.strictObject({
        symbol: assetSymbol,
        portal: l1Address,
        expectedGitSha: fullGitSha.optional(),
      }),
    )
    .optional(),
  /**
   * Exact bytes at `artifacts/<generation>/<version>.json`; absent on profiles predating catalogs.
   * Pre-field clients prune this as an additive version key in their served-profile wire parser;
   * they keep booting with their old artifact behavior but do not gain manifest resolution.
   */
  artifactManifestSha256: sha256.optional(),
  /**
   * Both layers, one map. Key sets differ per version by design — a version predating a
   * contract omits it. The OxideAccountFactory is oxide's and lives in their manifest, not here.
   */
  contracts: z.record(contractName, contractEntry),
  /**
   * Hashes, never full vkeys; reported, never bound — consumers compare and warn, never adopt.
   * Omit the block rather than serve a zero hash.
   */
  vkeys: z
    .strictObject({
      zkJwtVkeyHash: field32,
    })
    .optional(),
})

export type ConfigVersion = z.infer<typeof versionSchema>

/** Tolerated at parse; RESOLVING one is the typed failure — "app update required", not "corrupt". */
export type UnknownConfigVersion = { schemaVersion: string } & Record<string, unknown>
export type ConfigVersionEntry = ConfigVersion | UnknownConfigVersion

const ENTRY_SCHEMA_MARKER = /^[1-9]\d*$/

/** Marker grammar alone: a well-formed unknown marker is "app update required", else invalid. */
export function isVersionSchemaMarker(value: unknown): value is string {
  return typeof value === "string" && ENTRY_SCHEMA_MARKER.test(value)
}

/**
 * Full validation, not a marker comparison; takes `unknown` so hand-built junk cannot crash the
 * guard that exists for it.
 */
export function isSupportedVersion(entry: unknown): entry is ConfigVersion {
  return versionSchema.safeParse(entry).success
}

/**
 * Dispatch on the entry's own marker: a supported entry's issues are re-raised with precise paths
 * (kept prunable for the wire path); an unknown marker leaves the entry opaque.
 */
const versionEntrySchema = z
  .looseObject({
    schemaVersion: z
      .string()
      .regex(ENTRY_SCHEMA_MARKER, "version entry schemaVersion: a positive decimal string"),
  })
  .check((ctx) => {
    if (ctx.value.schemaVersion !== VERSION_ENTRY_SCHEMA_VERSION) return
    const parsed = versionSchema.safeParse(ctx.value)
    if (parsed.success) return
    // A finalized issue is a valid raw issue at runtime; the types differ only in optionality.
    for (const issue of parsed.error.issues) ctx.issues.push(issue as z.core.$ZodRawIssue)
  })
  // Sound: supported entries validated against versionSchema; unknown ones are the loose envelope.
  .transform((entry) => entry as ConfigVersionEntry)

const baseSchema = z.strictObject({
  profileId,
  network: z.enum(PROFILE_NETWORKS),
  publishedAt: isoInstant,
  expiresAt: isoInstant.optional(),
  /** Commit the DOCUMENT was published from (the publish CLI stamps it); versions carry their own. */
  gitSha: fullGitSha.optional(),
  shared: sharedSchema,
  /**
   * The live version — named, not inferred, so rollback and prepublication stay expressible.
   * Append-only is operator POLICY, not enforcement. Must name a key of
   * `versions` (checked below).
   */
  current: versionId,
  versions: z.record(versionId, versionEntrySchema),
})

export const configProfileSchema = baseSchema.check((ctx) => {
  const p = ctx.value

  if (Object.keys(p.versions).length === 0) {
    ctx.issues.push({
      code: "custom",
      message: "versions must not be empty",
      input: p.versions,
      path: ["versions"],
    })
  }
  // Object.hasOwn, not `in`: a `current` of "constructor" must not resolve through the prototype.
  if (!Object.hasOwn(p.versions, p.current)) {
    ctx.issues.push({
      code: "custom",
      message: `current "${p.current}" is not a version in this document (${Object.keys(
        p.versions,
      ).join(", ")})`,
      input: p.current,
      path: ["current"],
    })
  }
  const expectedChainId = NETWORK_L1_CHAIN_IDS[p.network]
  if (p.shared.l1ChainId !== expectedChainId) {
    ctx.issues.push({
      code: "custom",
      message: `l1ChainId ${p.shared.l1ChainId} does not match network "${p.network}" (expected ${expectedChainId})`,
      input: p.shared.l1ChainId,
      path: ["shared", "l1ChainId"],
    })
  }
  if (p.expiresAt && Date.parse(p.expiresAt) <= Date.parse(p.publishedAt)) {
    ctx.issues.push({
      code: "custom",
      message: "expiresAt must be after publishedAt",
      input: p.expiresAt,
      path: ["expiresAt"],
    })
  }

  for (const [id, version] of Object.entries(p.versions)) {
    // Shape rules apply to shapes this build knows; an unknown-schema entry is opaque here.
    if (!isSupportedVersion(version)) continue
    if (Object.keys(version.contracts).length === 0) {
      ctx.issues.push({
        code: "custom",
        message: `version "${id}" has no contracts`,
        input: version.contracts,
        path: ["versions", id, "contracts"],
      })
    }
    // Either union branch can smuggle an address in — read the parsed entry, not the branch.
    for (const name of PER_INSTANCE_CONTRACTS) {
      const entry = version.contracts[name]
      if (entry && "address" in entry && entry.address !== undefined) {
        ctx.issues.push({
          code: "custom",
          message:
            `version "${id}" states an address for "${name}" — a per-instance contract is ` +
            `derived from its class and carries no fleet-wide address`,
          input: entry,
          path: ["versions", id, "contracts", name, "address"],
        })
      }
    }
    // Omitting the pin would degrade the mainnet same-sha gate to schema-only; the 40-zero sha
    // stays the sentinel and fails closed at the manifest gate, not here.
    if (p.network === "mainnet" && !version.oxide.expectedGitSha) {
      ctx.issues.push({
        code: "custom",
        message: `version "${id}" has no oxide.expectedGitSha — a mainnet document must pin the oxide cut`,
        input: version.oxide,
        path: ["versions", id, "oxide", "expectedGitSha"],
      })
    }
    const assets = version.assets ?? []
    const isOxides = (portal: string) => portal.toLowerCase() === version.oxide.portal.toLowerCase()
    const walletToken = assets.find((asset) => asset.symbol === WALLET_TOKEN_SYMBOL)
    if (version.assets && !(walletToken && isOxides(walletToken.portal))) {
      ctx.issues.push({
        code: "custom",
        message: `version "${id}" lists no ${WALLET_TOKEN_SYMBOL} asset at oxide's own deployment (${version.oxide.portal})`,
        input: version.assets,
        path: ["versions", id, "assets"],
      })
    }
    const symbols = new Set<string>()
    const portals = new Set<string>()
    assets.forEach((asset, index) => {
      const at = (field: string) => ["versions", id, "assets", index, field]
      const issue = (message: string, field: string) =>
        ctx.issues.push({
          code: "custom",
          message: `version "${id}" ${message}`,
          input: asset,
          path: at(field),
        })
      if (symbols.has(asset.symbol)) issue(`lists the ${asset.symbol} asset twice`, "symbol")
      if (portals.has(asset.portal.toLowerCase()))
        issue(`lists the portal ${asset.portal} for two assets`, "portal")
      symbols.add(asset.symbol)
      portals.add(asset.portal.toLowerCase())
      if (asset.symbol !== WALLET_TOKEN_SYMBOL && isOxides(asset.portal))
        issue(
          `puts ${asset.symbol} at oxide's own deployment, which is ${WALLET_TOKEN_SYMBOL}'s`,
          "portal",
        )
      if (p.network === "mainnet" && !asset.expectedGitSha)
        issue(
          `has no expectedGitSha for ${asset.symbol} — a mainnet document must pin the oxide cut`,
          "expectedGitSha",
        )
      if (isOxides(asset.portal) && asset.expectedGitSha !== version.oxide.expectedGitSha)
        issue(`pins ${asset.symbol} to oxide's deployment at another oxide cut`, "expectedGitSha")
    })
  }

  // Every network but sandbox serves real users, so every endpoint must be https — keyed on
  // `network` so a document cannot opt itself out via a self-declared tier.
  if (p.network !== "sandbox") {
    const urls: [string, string][] = []
    if (p.shared.previousGenerationProfile) {
      urls.push(["shared.previousGenerationProfile", p.shared.previousGenerationProfile])
    }
    for (const [id, version] of Object.entries(p.versions)) {
      if (!isSupportedVersion(version)) continue
      urls.push([`versions.${id}.nodeUrl`, version.nodeUrl])
      urls.push([`versions.${id}.l1RpcUrl`, version.l1RpcUrl])
      urls.push([`versions.${id}.accountServiceUrl`, version.accountServiceUrl])
      if (version.zkmoneyApiUrl) urls.push([`versions.${id}.zkmoneyApiUrl`, version.zkmoneyApiUrl])
      urls.push([`versions.${id}.paylinkDomain`, version.paylinkDomain])
      urls.push([`versions.${id}.oxide.manifestUrl`, version.oxide.manifestUrl])
    }
    for (const [path, url] of urls) {
      if (!url.startsWith("https://")) {
        ctx.issues.push({
          code: "custom",
          message: `${path} must be https on a ${p.network} profile`,
          input: url,
          path: path.split("."),
        })
      }
    }
  }
})

export type ConfigProfile = z.infer<typeof configProfileSchema>

export function parseConfigProfile(data: unknown): ConfigProfile {
  return configProfileSchema.parse(data)
}

export function formatProfileIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
}
