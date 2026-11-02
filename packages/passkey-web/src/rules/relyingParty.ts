import { WEB_PASSKEY_PRODUCTION_ORIGINS, WEB_PASSKEY_RP_IDS } from "@obsidion/core/constants"

export type WebPasskeyEnvironment = keyof typeof WEB_PASSKEY_RP_IDS | "playground"
export type WebPasskeyEnv = {
  [key: string]: unknown
  VITE_PASSKEY_ENVIRONMENT?: string
  VITE_PASSKEY_RP_ID?: string
  VITE_PASSKEY_DEPLOYMENT?: string
}

/** Deployment identity is independent of the wallet's selected chain. */
export function selectWebPasskeyRpId(env: WebPasskeyEnv): string {
  const environment = env.VITE_PASSKEY_ENVIRONMENT ?? "local"
  if (environment !== "playground" && !Object.hasOwn(WEB_PASSKEY_RP_IDS, environment)) {
    throw new Error(`Unknown VITE_PASSKEY_ENVIRONMENT "${environment}"`)
  }
  const deployment = env.VITE_PASSKEY_DEPLOYMENT
  if (
    deployment &&
    (environment !== "playground" || !/^[a-z]([a-z0-9-]{0,6}[a-z0-9])?$/.test(deployment))
  ) {
    throw new Error("Named passkey deployments require a valid playground deployment")
  }
  if (environment === "playground" && !deployment)
    throw new Error("Playground requires a deployment")
  const rpId = deployment
    ? `${deployment}.plyg.zk.money`
    : WEB_PASSKEY_RP_IDS[environment as keyof typeof WEB_PASSKEY_RP_IDS]
  if (env.VITE_PASSKEY_RP_ID && env.VITE_PASSKEY_RP_ID !== rpId) {
    throw new Error(
      `VITE_PASSKEY_RP_ID "${env.VITE_PASSKEY_RP_ID}" conflicts with ${environment}: expected ${rpId}`,
    )
  }
  return rpId
}

export function isRpDomainSuffix(hostname: string, rpId: string): boolean {
  return hostname === rpId || hostname.endsWith(`.${rpId}`)
}

/** Check a web front's baked origins against its passkey RP before publishing the bundle. */
export function assertWebPasskeyBuild(
  env: WebPasskeyEnv & {
    VITE_SITE_ORIGIN?: string
    VITE_WALLET_URL?: string
  },
): string {
  const rpId = selectWebPasskeyRpId(env)
  // A prod-backed preview signs in against the production API, so its site origin is production's;
  // the wallet URL still has to sit under the preview RP.
  const prodBacked = env.VITE_PASSKEY_ENVIRONMENT === "prod-preview"
  for (const key of ["VITE_SITE_ORIGIN", "VITE_WALLET_URL"] as const) {
    const value = env[key]
    if (!value) continue
    const url = new URL(value)
    const productionOrigin = (WEB_PASSKEY_PRODUCTION_ORIGINS as readonly string[]).includes(
      url.origin,
    )
    const allowed =
      rpId === WEB_PASSKEY_RP_IDS.production
        ? productionOrigin
        : (isRpDomainSuffix(url.hostname, rpId) &&
            (url.protocol === "https:" || (rpId === "localhost" && url.protocol === "http:"))) ||
          (prodBacked && key === "VITE_SITE_ORIGIN" && productionOrigin)
    if (!allowed) throw new Error(`${key} (${url.origin}) cannot use the ${rpId} passkey RP`)
  }
  return rpId
}

/** Emit the selected RP so deployment checks do not search minified JavaScript. */
export function webPasskeyBuildPlugin(env: Parameters<typeof assertWebPasskeyBuild>[0]) {
  const rpId = assertWebPasskeyBuild(env)
  return {
    name: "web-passkey-target",
    generateBundle(this: {
      emitFile(asset: { type: "asset"; fileName: string; source: string }): unknown
    }) {
      this.emitFile({
        type: "asset",
        fileName: "passkey-target.json",
        source: JSON.stringify({
          environment: env.VITE_PASSKEY_ENVIRONMENT ?? "local",
          rpId,
          ...(env.VITE_PASSKEY_DEPLOYMENT
            ? {
                deployment: env.VITE_PASSKEY_DEPLOYMENT,
                profileUrl: env.VITE_CONFIG_PROFILE_URL,
                profileId: env.VITE_CONFIG_EXPECTED_PROFILE_ID,
              }
            : {}),
        }),
      })
    },
  }
}
