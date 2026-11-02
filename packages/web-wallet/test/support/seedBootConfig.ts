/**
 * Boot config for component tests.
 *
 * `getConfig()` throws until a profile has resolved, so any test that mounts a component reaching
 * for config has to boot one first — the app does it once in `main.tsx` before it renders anything.
 */
import { sandboxProfile, testnetProfile } from "../fixtures/sandboxProfile"

/** Resolve the boot config from an in-process profile. Safe to call more than once. */
export const seedBootConfig = () =>
  seed(sandboxProfile(), "http://localhost:8083/profiles/sandbox.json")

/** The same on testnet, whose L1 has a public explorer. */
export const seedTestnetBootConfig = () =>
  seed(testnetProfile(), "https://cdn.zk.money/profiles/v5/current.json")

async function seed(
  profile: { profileId: string; network: string },
  profileUrl: string,
): Promise<void> {
  const { resolveBootConfig } = await import("../../src/config/env")
  await resolveBootConfig({
    env: {
      VITE_NETWORK: profile.network,
      VITE_CONFIG_PROFILE_URL: profileUrl,
      VITE_CONFIG_EXPECTED_PROFILE_ID: profile.profileId,
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify(profile), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })
}
