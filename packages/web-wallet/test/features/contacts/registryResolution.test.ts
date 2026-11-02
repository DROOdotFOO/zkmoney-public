/**
 * The web registry-resolution binder's manifest freshness contract: debounced type-ahead
 * resolutions share ONE manifest fetch via the process tuple cache, while the commit path
 * (add-contact confirm, handshake verifyTag) refetches — a manifest rotated between resolution and
 * commit surfaces as staleRollup instead of persisting the stale record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f"
const METADATA_REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f56360"
const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const BOOTSTRAP = "0x00000000000000000000000000000000000000bb"
const ZERO = "0x0000000000000000000000000000000000000000"
const L2_ADDRESS = `0x${"11".repeat(32)}`
const MANIFEST_URL = "http://oxide-manifest.test/sandbox.json"

// Mutable stubs the mocked viem client and fetch read on every call.
const state = vi.hoisted(() => ({
  account: "0x00000000000000000000000000000000000000aa",
  recordRollupVersion: 4n,
  manifestRollupVersion: "4",
  /** A retired sibling deployment's rollup version, listed beside the pinned one when set. */
  retiredRollupVersion: undefined as string | undefined,
  manifestDown: false,
  manifestFetches: 0,
}))

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>()
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return state.account
        if (functionName === "hasUserRecord") return state.account !== ZERO
        if (functionName === "getUserRecord")
          return {
            l2Address: L2_ADDRESS,
            rollupVersion: state.recordRollupVersion,
            // Registry field name; the resolver re-exposes it as `sipaStealthPublicKey`.
            publicKey: { x: 1n, y: 2n },
            resolverOperator: state.account,
          }
        if (functionName === "bootstrapOwner") return BOOTSTRAP
        throw new Error(`unexpected read: ${functionName}`)
      },
    }),
  }
})

vi.stubGlobal("fetch", async (url: string) => {
  if (url !== MANIFEST_URL) throw new Error(`unexpected fetch: ${url}`)
  state.manifestFetches++
  if (state.manifestDown) return { ok: false, status: 503, json: async () => ({}) }
  return {
    ok: true,
    json: async () => ({
      schemaVersion: "4",
      deployments: [
        {
          schemaVersion: "1",
          label: "v4",
          portal: REGISTRY,
          deployedAt: "2026-07-29T00:00:00Z",
          updatedAt: "2026-07-29T00:00:00Z",
          rollupVersion: state.manifestRollupVersion,
          chainId: "31337",
          token: REGISTRY,
          l2Token: L2_ADDRESS,
          enclaveUrl: "http://localhost:9999",
          nameRegistry: REGISTRY,
          accountMetadataRegistry: METADATA_REGISTRY,
          ensDomain: "oxidestaging.eth",
        },
        ...(state.retiredRollupVersion
          ? [
              {
                schemaVersion: "1",
                label: "v3",
                portal: `0x${"33".repeat(20)}`,
                deployedAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-01T00:00:00Z",
                rollupVersion: state.retiredRollupVersion,
                chainId: "31337",
                token: REGISTRY,
                l2Token: L2_ADDRESS,
                enclaveUrl: "http://localhost:9999",
                nameRegistry: REGISTRY,
                accountMetadataRegistry: METADATA_REGISTRY,
                ensDomain: "oxidestaging.eth",
                accountFactory: `0x${"44".repeat(20)}`,
                namePortal: `0x${"55".repeat(20)}`,
              },
            ]
          : []),
      ],
    }),
  }
})

/**
 * The sandbox profile whose version supplies the binder's oxide pointer — `getConfig()` serves
 * only what `resolveBootConfig` seeded.
 */
function bootProfile() {
  return {
    profileId: "sandbox",
    network: "sandbox",
    publishedAt: "2026-08-12T00:00:00.000Z",
    shared: { l1ChainId: 31337, xmtpEnv: "local", rollupVersion: "1821665230" },
    current: "0.0.1",
    versions: {
      "0.0.1": {
        schemaVersion: "1",
        deployedAt: "2026-08-12T00:00:00.000Z",
        nodeUrl: "http://profile-node.test",
        l1RpcUrl: "http://profile-l1.test",
        accountServiceUrl: "http://profile-account.test",
        zkmoneyApiUrl: "http://profile-api.test",
        paylinkDomain: "http://profile-paylink.test",
        oxide: {
          manifestUrl: MANIFEST_URL,
          portal: REGISTRY,
        },
        contracts: {
          accountFactory: { address: "0x2c5eabc1c0ff859900efbe47a55e8f171d6ac001" },
        },
      },
    },
  }
}

const serveProfile = () =>
  (async () => ({
    ok: true,
    status: 200,
    json: async () => bootProfile(),
  })) as unknown as typeof fetch

/**
 * Fresh module graph so the getOxideTuple cache starts empty per test. Seeding order matters:
 * reset first, then boot the config inside that graph, then import the binder — a config seeded
 * before the reset would be wiped with the old graph.
 */
async function loadBinder() {
  vi.resetModules()
  const { resolveBootConfig } = await import("../../../src/config/env")
  await resolveBootConfig({
    env: {
      VITE_CONFIG_PROFILE_URL: "http://localhost:8083/profiles/sandbox.json",
      VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox",
    },
    fetchImpl: serveProfile(),
  })
  return import("../../../src/features/contacts/registryResolution")
}

beforeEach(() => {
  state.account = ACCOUNT
  state.recordRollupVersion = 4n
  state.manifestRollupVersion = "4"
  state.retiredRollupVersion = undefined
  state.manifestDown = false
  state.manifestFetches = 0
})

describe("web registry resolution binder", () => {
  it("repeated type-ahead resolutions fetch the manifest once", async () => {
    const binder = await loadBinder()
    for (let i = 0; i < 3; i++) {
      const r = await binder.resolveTagViaRegistry("alice")
      expect(r).toMatchObject({ status: "resolved", xmtpAddress: BOOTSTRAP })
    }
    expect(state.manifestFetches).toBe(1)
  }, 30_000)

  it("the commit path refetches — a rotated manifest never persists the stale record", async () => {
    const binder = await loadBinder()
    expect((await binder.resolveTagViaRegistry("alice")).status).toBe("resolved")
    expect(state.manifestFetches).toBe(1)

    // Deployment rotates under the user between type-ahead and confirm.
    state.manifestRollupVersion = "5"

    expect((await binder.resolveTagForCommit("alice")).status).toBe("staleRollup")
    expect(state.manifestFetches).toBe(2)

    // Type-ahead keeps reading its cached tuple (no new fetch).
    expect((await binder.resolveTagViaRegistry("alice")).status).toBe("resolved")
    expect(state.manifestFetches).toBe(2)
  }, 30_000)

  it("maps resolved / notFound / staleRollup from record vs tuple state", async () => {
    const binder = await loadBinder()

    expect((await binder.resolveTagForCommit("alice")).status).toBe("resolved")

    state.account = ZERO
    expect((await binder.resolveTagForCommit("ghost")).status).toBe("notFound")

    state.account = ACCOUNT
    state.recordRollupVersion = 3n
    expect((await binder.resolveTagForCommit("olduser")).status).toBe("staleRollup")
  }, 30_000)

  it("sign-in resolves a tag on a retired rollup; contacts still refuse it", async () => {
    const binder = await loadBinder()
    state.recordRollupVersion = 3n
    state.retiredRollupVersion = "3"

    expect(await binder.resolveSignInTag("olduser")).toMatchObject({
      status: "resolved",
      rollupId: "3",
    })
    expect(await binder.resolveSignInTagForCommit("olduser")).toMatchObject({
      status: "resolved",
      rollupId: "3",
    })
    expect((await binder.resolveTagViaRegistry("olduser")).status).toBe("staleRollup")
    expect((await binder.resolveTagForCommit("olduser")).status).toBe("staleRollup")
    expect(await binder.verifyTag("olduser")).toBeNull()
  }, 30_000)

  it("sign-in still refuses a tag on a rollup the manifest does not list", async () => {
    const binder = await loadBinder()
    state.recordRollupVersion = 2n
    state.retiredRollupVersion = "3"

    expect((await binder.resolveSignInTag("olduser")).status).toBe("staleRollup")
  }, 30_000)

  it("a failed retired-list read fails sign-in only for a tag off the current rollup", async () => {
    const binder = await loadBinder()
    expect((await binder.resolveSignInTag("alice")).status).toBe("resolved")

    state.manifestDown = true
    expect((await binder.resolveSignInTag("alice")).status).toBe("resolved")

    state.recordRollupVersion = 3n
    await expect(binder.resolveSignInTag("olduser")).rejects.toThrow(/503/)
  }, 30_000)

  it("verifyTag maps non-discoverable to null and surfaces the identity when resolved", async () => {
    const binder = await loadBinder()

    expect(await binder.verifyTag("alice")).toEqual({
      l2Address: L2_ADDRESS,
      xmtpAddress: BOOTSTRAP,
    })
    expect(await binder.verifyTag("not a valid tag!")).toBeNull()

    state.account = ZERO
    expect(await binder.verifyTag("ghost")).toBeNull()
  }, 30_000)
})
