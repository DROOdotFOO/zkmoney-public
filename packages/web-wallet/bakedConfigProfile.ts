import { createHash } from "node:crypto"
import type { Plugin } from "vite"
import {
  ConfigProfileError,
  fetchConfigProfile,
  resolveWalletProfileDocument,
} from "@obsidion/config-client"
import { assertProfilePolicy, parseNetwork } from "./src/config/profilePolicy.js"

/**
 * Bakes the config profile into the bundle so the wallet can boot when the config service is
 * unreachable. `vite build` fetches `VITE_BAKED_CONFIG_PROFILE_URL` or `VITE_CONFIG_PROFILE_URL`, runs the checks
 * the wallet runs at boot (identity, network, `current`, the oxide-pointer policy), and serves the
 * result as `virtual:baked-config-profile`; the build fails if any of that fails. No URL, a
 * profile id the store does not hold yet, or `vite dev`, bakes nothing. `dist/build-target.json`
 * records what was baked.
 */

export const BAKED_PROFILE_MODULE_ID = "virtual:baked-config-profile"
const RESOLVED_ID = "\0" + BAKED_PROFILE_MODULE_ID

export interface BakedProfileStamp {
  profileId: string
  network: string
  current: string
  publishedAt: string
  /** The document's `expiresAt`; null when it never expires. */
  expiresAt: string | null
  /** `versions[current].gitSha`; null when the document carries none. */
  currentVersionGitSha: string | null
  /** SHA-256 of the exact JSON string the virtual module embeds. */
  sha256: string
}

export interface BakedProfile {
  /** The JSON the virtual module embeds. */
  payload: string
  stamp: BakedProfileStamp
}

type Env = Record<string, string | undefined>

/**
 * Fetch + validate + stamp, apart from the vite hooks so it can be tested without a build.
 * Returns undefined when the build sets no profile URL.
 */
export async function bakeConfigProfile(
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<BakedProfile | undefined> {
  const profileUrl = env.VITE_BAKED_CONFIG_PROFILE_URL || env.VITE_CONFIG_PROFILE_URL
  if (!profileUrl) return undefined
  const expectedProfileId = env.VITE_CONFIG_EXPECTED_PROFILE_ID
  if (!expectedProfileId) {
    throw new Error(
      "VITE_CONFIG_PROFILE_URL is set but VITE_CONFIG_EXPECTED_PROFILE_ID is not — the baked " +
        "profile cannot be checked against an identity",
    )
  }
  const network = parseNetwork(env.VITE_NETWORK)
  let profile
  try {
    profile = await fetchConfigProfile(profileUrl, { fetchImpl })
  } catch (e) {
    // A profile id the store has never held: a MANIFEST_AZTEC_VERSION bump, or a tier's first
    // stand-up. The baked copy only boots the wallet when the config service is unreachable, so
    // refusing to build for a fallback that cannot exist yet deadlocks the deploy that would
    // publish it. Every other failure still fails the build. This is build time only — at boot a
    // 404 stays fatal, because there a missing document means one that was torn down.
    if (e instanceof ConfigProfileError && e.code === "NOT_FOUND" && !env.VITE_BAKED_CONFIG_PROFILE_URL) {
      console.warn(
        `[bakedConfigProfile] ${profileUrl} does not exist yet — building with no baked profile`,
      )
      return undefined
    }
    throw new Error(`${profileUrl}: ${(e as Error).message}`)
  }
  const resolved = resolveWalletProfileDocument(profile, {
    source: `profile at ${profileUrl}`,
    expectedProfileId,
    network,
  })
  assertProfilePolicy(resolved, network)
  const payload = JSON.stringify(profile)
  return {
    payload,
    stamp: {
      profileId: profile.profileId,
      network: profile.network,
      current: profile.current,
      publishedAt: profile.publishedAt,
      expiresAt: profile.expiresAt ?? null,
      currentVersionGitSha: resolved.version.gitSha ?? null,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
  }
}

/**
 * The virtual module's source. `JSON.parse` of a string literal, never an object literal: `meta`
 * accepts arbitrary keys, and an own `__proto__` key in a literal would become the prototype.
 */
export function renderBakedProfileModule(payload: string | undefined): string {
  if (payload === undefined) return "export default undefined\n"
  return `export default JSON.parse(${JSON.stringify(payload)})\n`
}

export interface BakedConfigProfileOptions {
  fetchImpl?: typeof fetch
}

export function bakedConfigProfile(options: BakedConfigProfileOptions = {}): Plugin {
  let env: Env = {}
  let command: "build" | "serve" = "serve"
  let baked: BakedProfile | undefined

  return {
    name: "obsidion-baked-config-profile",
    configResolved(config) {
      env = config.env as Env
      command = config.command
    },
    async buildStart() {
      if (command !== "build") return
      try {
        baked = await bakeConfigProfile(env, options.fetchImpl)
      } catch (e) {
        throw new Error(`cannot bake the config profile: ${(e as Error).message}`)
      }
    },
    resolveId(id) {
      if (id === BAKED_PROFILE_MODULE_ID) return RESOLVED_ID
    },
    load(id) {
      if (id === RESOLVED_ID) return renderBakedProfileModule(baked?.payload)
    },
    // What this build baked, so a deploy or an operator can see what a bundle carries.
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-target.json",
        source: JSON.stringify(
          {
            VITE_NETWORK: env.VITE_NETWORK ?? "",
            VITE_CONFIG_PROFILE_URL: env.VITE_CONFIG_PROFILE_URL ?? "",
            VITE_CONFIG_EXPECTED_PROFILE_ID: env.VITE_CONFIG_EXPECTED_PROFILE_ID ?? "",
            VITE_DESKTOP_BUILD: env.VITE_DESKTOP_BUILD ?? "",
            bakedProfile: baked?.stamp ?? null,
          },
          null,
          2,
        ),
      })
    },
  }
}
