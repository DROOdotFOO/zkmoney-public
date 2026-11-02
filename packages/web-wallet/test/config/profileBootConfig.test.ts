// @vitest-environment node
/**
 * The boot path: `VITE_CONFIG_PROFILE_URL` names the profile that supplies the endpoints and the
 * contract snapshot, and the config it seeds is what every synchronous `getConfig()` consumer
 * reads.
 */
import { ZKJWT_VKEY_HASH } from "@obsidion/core/constants"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  endpointDigest,
  normalizeEndpoint,
  type EndpointKind,
  type EndpointOverrides,
} from "../../src/config/endpointOverrides"
import {
  fetchLiveProfilePortal,
  getConfig,
  resolveBootConfig,
  type RuntimeEndpoints,
} from "../../src/config/env"
import { analyticsUrl } from "../../src/lib/analytics"
import { F32, PORTAL, sandboxProfile, testnetProfile } from "../fixtures/sandboxProfile"

const PROFILE_URL = "http://localhost:8083/profiles/sandbox.json"
const PROFILE_ENV = {
  VITE_CONFIG_PROFILE_URL: PROFILE_URL,
  VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox",
}

function mainnetProfile() {
  const profile = sandboxProfile() as Record<string, any>
  profile.profileId = "mainnet"
  profile.network = "mainnet"
  delete profile.expiresAt
  // Mainnet refuses a pointer with no same-sha pin, so the fixture has to carry one.
  profile.versions["0.0.1"].oxide = {
    ...profile.versions["0.0.1"].oxide,
    expectedGitSha: "a".repeat(40),
  }
  profile.shared = { ...profile.shared, l1ChainId: 1 }
  profile.versions["0.0.1"] = {
    ...profile.versions["0.0.1"],
    nodeUrl: "https://node.example",
    l1RpcUrl: "https://l1.example",
    accountServiceUrl: "https://account.example",
    zkmoneyApiUrl: "https://api.example",
    paylinkDomain: "https://paylink.example",
  }
  profile.versions["0.0.1"].oxide.manifestUrl = "https://manifest.example/prod.v4.json"
  return profile
}

/** Mainnet refuses to build without screening; the oxide pointer comes from the document alone. */
const MAINNET_ENV = {
  VITE_NETWORK: "mainnet",
  VITE_PASSKEY_ENVIRONMENT: "production",
  VITE_PREDICATE_API_KEY: "key",
  VITE_PREDICATE_VERIFICATION_HASH: "x-managed-policy-abc",
  VITE_PREDICATE_CHAIN: "ethereum",
}

function serve(document: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => document,
  })) as unknown as typeof fetch
}

function boot(env: Record<string, string | undefined>, fetchImpl: typeof fetch) {
  return resolveBootConfig({ env, fetchImpl })
}

/** A desktop build served by the launcher: the only place the host's settings count. */
const DESKTOP_ENV = { ...PROFILE_ENV, VITE_DESKTOP_BUILD: "true" }
const underLauncher = () =>
  vi.stubGlobal("__ZKMONEY_DESKTOP_BRIDGE__", { l1SubmitPath: "/desktop/l1-submit" })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a missing profile URL", () => {
  it("is fatal before anything is fetched", async () => {
    const fetchImpl = serve(sandboxProfile())

    await expect(boot({}, fetchImpl)).rejects.toThrow(/VITE_CONFIG_PROFILE_URL/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("an expected profile id alone enables nothing", async () => {
    const fetchImpl = serve(sandboxProfile())

    await expect(boot({ VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox" }, fetchImpl)).rejects.toThrow(
      /VITE_CONFIG_PROFILE_URL/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("profile mode", () => {
  it("seeds the version + shared endpoints and hands the provider the snapshot", async () => {
    const fetchImpl = serve(sandboxProfile())
    const result = await boot(PROFILE_ENV, fetchImpl)

    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(result.config.l1RpcUrl).toBe("http://profile-l1.test")
    expect(result.config.accountServiceUrl).toBe("http://profile-account.test")
    expect(result.config.xmtpEnv).toBe("local")
    expect(result.config.sourceRollupIssues).toEqual([])
    expect(getConfig()).toBe(result.config)

    expect(result.contractServiceOptions.source).toBe("profile")
    expect(result.contractServiceOptions.config?.contracts.paylinkDirect).toEqual({
      classId: F32(106),
    })
    expect(result.contractServiceOptions.resolveClassArtifact).toBeTypeOf("function")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(result.contractServiceOptions.resolveClassArtifact!(F32(999))).rejects.toThrow(
      /has no artifact manifest pin/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("warns and boots when a historical migration profile is unavailable", async () => {
    const profile = sandboxProfile() as Record<string, any>
    const historicalUrl = "https://config.example/profiles/v5/0.0.1.json"
    profile.shared.previousGenerationProfile = historicalUrl
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
          ? request.toString()
          : request.url
      return url === PROFILE_URL
        ? { ok: true, status: 200, json: async () => profile }
        : { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await boot(PROFILE_ENV, fetchImpl)

    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`migration source unavailable at ${historicalUrl} (NOT_FOUND:`),
    )
    // The upgrade check reads the unread generation as unknown, not as one with no history.
    expect(result.config.sourceRollupIssues).toEqual([
      expect.objectContaining({ profileUrl: historicalUrl, code: "NOT_FOUND" }),
    ])
  })

  it("exposes the version's assets, and none where the document lists none", async () => {
    expect((await boot(PROFILE_ENV, serve(sandboxProfile()))).config.assets).toEqual([])
    const profile = sandboxProfile()
    profile.versions["0.0.1"].assets = [
      { symbol: "DAI", portal: PORTAL },
      { symbol: "sUSDS", portal: "0x125ab92a8d8a15883b37beab1b50802fdf9b9f64" },
    ]
    const { config } = await boot(PROFILE_ENV, serve(profile))
    expect(config.assets.map((asset) => asset.symbol)).toEqual(["DAI", "sUSDS"])
  })

  it("build overrides win for RPCs, while the profile owns XMTP and account service", async () => {
    const result = await boot(
      {
        ...PROFILE_ENV,
        VITE_NODE_URL: "http://env-node.test",
        VITE_L1_RPC_URL: "http://env-l1.test",
        VITE_ACCOUNT_SERVICE_URL: "http://env-account.test",
        VITE_XMTP_ENV: "production",
      },
      serve(sandboxProfile()),
    )

    expect(result.config.nodeUrl).toBe("http://env-node.test")
    expect(result.config.l1RpcUrl).toBe("http://env-l1.test")
    expect(result.config.accountServiceUrl).toBe("http://profile-account.test")
    expect(result.config.xmtpEnv).toBe("local")
  })

  it("routes only the browser-restricted local account-service port through the proxy", async () => {
    const profile = sandboxProfile()
    profile.versions["0.0.1"].accountServiceUrl = "http://localhost:5060"
    const env = { ...PROFILE_ENV, VITE_ACCOUNT_SERVICE_URL: "http://env-account.test" }

    expect((await boot(env, serve(profile))).config.accountServiceUrl).toBe("/svc/account")

    profile.versions["0.0.1"].accountServiceUrl = "http://localhost:8060"
    expect((await boot(env, serve(profile))).config.accountServiceUrl).toBe("http://localhost:8060")
  })

  it("leaves the analytics endpoint alone", async () => {
    const result = await boot(PROFILE_ENV, serve(sandboxProfile()))

    // Read from `import.meta.env` at module scope, so the profile has no way to reach it.
    expect(analyticsUrl).toBeUndefined()
    expect(result.config).not.toHaveProperty("zkmoneyApiUrl")
  })

  it("makes the version pointer the one oxide authority", async () => {
    const result = await boot(PROFILE_ENV, serve(sandboxProfile()))

    const pointer = { manifestUrl: "http://profile-oxide.test/sandbox.json", portal: PORTAL }
    expect(result.config.oxideProfile).toEqual(pointer)
    expect(result.contractServiceOptions.oxideEnvProfile).toEqual(pointer)
    expect(result.contractServiceOptions.config?.oxide).toEqual(pointer)
  })

  it("VITE_OXIDE_* env keys do not move the pointer", async () => {
    const result = await boot(
      {
        ...PROFILE_ENV,
        VITE_OXIDE_MANIFEST_URL: "http://env-oxide.test/dev.json",
        VITE_OXIDE_PORTAL: "0x" + "1".repeat(40),
        VITE_OXIDE_EXPECTED_GIT_SHA: "f".repeat(40),
      },
      serve(sandboxProfile()),
    )

    const pointer = { manifestUrl: "http://profile-oxide.test/sandbox.json", portal: PORTAL }
    expect(result.config.oxideProfile).toEqual(pointer)
    expect(result.contractServiceOptions.oxideEnvProfile).toEqual(pointer)
  })
})

describe("boot failures are fatal — never a silent registry fallback", () => {
  it("a fetch failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch

    await expect(boot(PROFILE_ENV, fetchImpl)).rejects.toThrow(/profile fetch failed/)
  })

  it("a 404 — a torn-down profile", async () => {
    await expect(boot(PROFILE_ENV, serve({}, 404))).rejects.toThrow(/profile not found/)
  })

  it("a mainnet document with no same-sha pin — the schema refuses it", async () => {
    const env = { ...MAINNET_ENV, ...PROFILE_ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "mainnet" }
    const doc = mainnetProfile() as Record<string, any>
    delete doc.versions["0.0.1"].oxide.expectedGitSha

    await expect(boot(env, serve(doc))).rejects.toThrow(/oxide\.expectedGitSha/)
  })

  it("a mainnet document boots — the version supplies the pointer loadConfig cannot bake", async () => {
    const env = { ...MAINNET_ENV, ...PROFILE_ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "mainnet" }
    const doc = mainnetProfile() as Record<string, any>
    doc.shared.rollupVersion = "999999999"

    const result = await boot(env, serve(doc))
    expect(result.config.nodeUrl).toBe("https://node.example")
    expect(result.config.oxideProfile.expectedGitSha).toBe("a".repeat(40))
    expect(result.contractServiceOptions.source).toBe("profile")
  })

  it("a profile id can match the build independently of the mainnet network", async () => {
    const doc = mainnetProfile()
    doc.profileId = "sandbox"

    const result = await boot({ ...MAINNET_ENV, ...PROFILE_ENV }, serve(doc))
    expect(result.config.l1ChainId).toBe(1)
    expect(result.config.network).toBe("mainnet")
  })

  it("a sandbox profile cannot declare mainnet's L1 chain id", async () => {
    const doc = sandboxProfile()
    doc.shared.l1ChainId = 1

    await expect(boot(PROFILE_ENV, serve(doc))).rejects.toThrow(
      /l1ChainId 1 does not match network "sandbox"/,
    )
  })

  it("any rollupVersion boots — the profile id is what binds a build to a document", async () => {
    for (const rollupVersion of ["3685977955", "1821665230", "999999999"]) {
      const doc = sandboxProfile() as Record<string, any>
      doc.shared.rollupVersion = rollupVersion

      const result = await boot(PROFILE_ENV, serve(doc))
      expect(result.contractServiceOptions.source, `rollup ${rollupVersion}`).toBe("profile")
    }
  })

  it("a dev manifest on a durable network", async () => {
    const env = {
      ...PROFILE_ENV,
      VITE_NETWORK: "testnet",
      VITE_CONFIG_EXPECTED_PROFILE_ID: "staging",
    }
    const doc = sandboxProfile() as Record<string, any>
    doc.profileId = "staging"
    doc.network = "testnet"
    doc.shared.l1ChainId = 11155111
    doc.versions["0.0.1"] = {
      ...doc.versions["0.0.1"],
      nodeUrl: "https://node.example",
      l1RpcUrl: "https://l1.example",
      accountServiceUrl: "https://account.example",
      zkmoneyApiUrl: "https://api.example",
      paylinkDomain: "https://paylink.example",
      oxide: {
        ...doc.versions["0.0.1"].oxide,
        manifestUrl: "https://manifest.example/dev.v4.json",
      },
    }

    await expect(boot(env, serve(doc))).rejects.toThrow(/dev or local manifest/)
    doc.versions["0.0.1"].oxide.manifestUrl = "https://manifest.example/dev.v4.json?cache=1"
    await expect(boot(env, serve(doc))).rejects.toThrow(/dev or local manifest/)
  })

  it("a document identifying as something else", async () => {
    const env = { ...PROFILE_ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "testnet" }

    await expect(boot(env, serve(sandboxProfile()))).rejects.toThrow(/identifies as "sandbox"/)
  })

  it("a profile URL with no expected id", async () => {
    const env = { VITE_CONFIG_PROFILE_URL: PROFILE_URL }

    await expect(boot(env, serve(sandboxProfile()))).rejects.toThrow(/expected profile id/)
  })
})

/**
 * `vercel-build-deploy.sh` writes every allow-listed key into `.env.production` whether or not the
 * operator set it, so a deployed bundle sees `""` where a test would naturally pass `undefined`.
 */
describe("a deployed bundle's empty-string env", () => {
  const DEPLOYED = {
    ...PROFILE_ENV,
    VITE_NODE_URL: "",
    VITE_L1_RPC_URL: "",
    VITE_ACCOUNT_SERVICE_URL: "",
  }

  it("takes the profile's endpoints, not the empty strings", async () => {
    const result = await boot(DEPLOYED, serve(sandboxProfile()))

    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(result.config.l1RpcUrl).toBe("http://profile-l1.test")
    expect(result.config.oxideProfile.manifestUrl).toBe("http://profile-oxide.test/sandbox.json")
  })

  it("still lets a genuinely-set var win", async () => {
    const result = await boot(
      { ...DEPLOYED, VITE_NODE_URL: "http://operator-node.test" },
      serve(sandboxProfile()),
    )

    expect(result.config.nodeUrl).toBe("http://operator-node.test")
  })
})

/**
 * A host (the desktop launcher's settings page) may point the wallet at a different profile URL.
 * The document still has to be this build's profile, and the wallet reports what it ran on.
 */
describe("a host-supplied profile URL", () => {
  const ELSEWHERE = "https://elsewhere.example/profile.json"
  const SHAPED = "https://cdn.example/profiles/v5/current.json"
  const TESTNET_ENV = {
    ...DESKTOP_ENV,
    VITE_NETWORK: "testnet",
    VITE_CONFIG_PROFILE_URL: "https://cdn.zk.money/profiles/v5/current.json",
    VITE_CONFIG_EXPECTED_PROFILE_ID: "staging-v5",
  }
  const refuse = () =>
    vi.fn(async () => {
      throw new Error("fetch must not be called")
    }) as unknown as typeof fetch

  it("fetches from it instead of the baked URL, and says what it ran on", async () => {
    underLauncher()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetchImpl = serve(sandboxProfile())
    const result = await resolveBootConfig({
      env: DESKTOP_ENV,
      fetchImpl,
      runtime: { configProfileUrl: ELSEWHERE },
    })

    expect(fetchImpl).toHaveBeenCalledWith(ELSEWHERE, expect.anything())
    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(result.customProfileUrl).toBe(ELSEWHERE)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ELSEWHERE))
  })

  it("still refuses a document that is not this build's profile", async () => {
    underLauncher()
    const wrong = sandboxProfile()
    wrong.profileId = "somebody-elses"
    await expect(
      resolveBootConfig({
        env: DESKTOP_ENV,
        fetchImpl: serve(wrong),
        runtime: { configProfileUrl: ELSEWHERE },
      }),
    ).rejects.toThrow(/identifies as "somebody-elses"/)
  })

  it("reports the baked copy, not the URL, when the URL is unreachable", async () => {
    underLauncher()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const unreachable = vi.fn(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const result = await resolveBootConfig({
      env: DESKTOP_ENV,
      fetchImpl: unreachable,
      bakedProfile: sandboxProfile(),
      runtime: { configProfileUrl: ELSEWHERE },
    })
    expect(result.bootedFromBakedProfile).toBe(true)
    expect(result.bakedProfile?.liveFailure?.code).toBe("UNREACHABLE")
    expect(result.customProfileUrl).toBeUndefined()
  })

  it("is not consulted while the shipped-configuration setting is on", async () => {
    underLauncher()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetchImpl = refuse()
    const result = await resolveBootConfig({
      env: DESKTOP_ENV,
      fetchImpl,
      bakedProfile: sandboxProfile(),
      runtime: { configProfileUrl: ELSEWHERE, bootFromBakedProfile: true },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.bakedProfile?.forced).toBe(true)
    expect(result.customProfileUrl).toBeUndefined()
  })

  describe.each([
    ["no desktop bridge", "true", false],
    ["no desktop flag", undefined, true],
  ])("with %s", (_, flag, bridge) => {
    const env = { ...PROFILE_ENV, VITE_DESKTOP_BUILD: flag }
    it.each([
      ["a profile URL", { configProfileUrl: ELSEWHERE }],
      ["the shipped-configuration setting", { bootFromBakedProfile: true }],
    ])("ignores %s", async (_, runtime) => {
      if (bridge) underLauncher()
      const fetchImpl = serve(sandboxProfile())
      const result = await resolveBootConfig({
        env,
        fetchImpl,
        bakedProfile: sandboxProfile(),
        runtime,
      })
      expect(fetchImpl).toHaveBeenCalledWith(PROFILE_URL, expect.anything())
      expect(result.bootedFromBakedProfile).toBe(false)
      expect(result.customProfileUrl).toBeUndefined()
    })

    it("ignores a wrong-shape URL on a testnet build without refusing it", async () => {
      if (bridge) underLauncher()
      const fetchImpl = serve(testnetProfile())
      await resolveBootConfig({
        env: { ...TESTNET_ENV, VITE_DESKTOP_BUILD: flag },
        fetchImpl,
        runtime: { configProfileUrl: ELSEWHERE },
      })
      expect(fetchImpl).toHaveBeenCalledWith(TESTNET_ENV.VITE_CONFIG_PROFILE_URL, expect.anything())
    })
  })

  describe("outside sandbox", () => {
    it("fetches a URL of the profiles shape", async () => {
      underLauncher()
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const fetchImpl = serve(testnetProfile())
      const result = await resolveBootConfig({
        env: TESTNET_ENV,
        fetchImpl,
        runtime: { configProfileUrl: SHAPED },
      })
      expect(fetchImpl).toHaveBeenCalledWith(SHAPED, expect.anything())
      expect(result.customProfileUrl).toBe(SHAPED)
    })

    it.each([
      ELSEWHERE,
      "https://cdn.example/profiles/staging.json",
      "http://cdn.example/profiles/v5/current.json",
    ])("refuses %s before any fetch, naming the rule", async (url) => {
      underLauncher()
      const fetchImpl = refuse()
      await expect(
        resolveBootConfig({ env: TESTNET_ENV, fetchImpl, runtime: { configProfileUrl: url } }),
      ).rejects.toThrow(/zk\.money Desktop is refused: .*(profiles\/<generation>|plain HTTPS)/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it("refuses on mainnet too", async () => {
      underLauncher()
      const fetchImpl = refuse()
      await expect(
        resolveBootConfig({
          env: { ...MAINNET_ENV, ...DESKTOP_ENV, VITE_NETWORK: "mainnet" },
          fetchImpl,
          runtime: { configProfileUrl: ELSEWHERE },
        }),
      ).rejects.toThrow(/zk\.money Desktop is refused/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it("does not check a URL the shipped-configuration setting leaves unused", async () => {
      underLauncher()
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const fetchImpl = refuse()
      const result = await resolveBootConfig({
        env: TESTNET_ENV,
        fetchImpl,
        bakedProfile: testnetProfile(),
        runtime: { configProfileUrl: ELSEWHERE, bootFromBakedProfile: true },
      })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(result.bakedProfile?.forced).toBe(true)
    })

    it("does not hold the build's own flat URL to the rule", async () => {
      underLauncher()
      const flat = { ...TESTNET_ENV, VITE_CONFIG_PROFILE_URL: "https://cdn.example/staging.json" }
      const fetchImpl = serve(testnetProfile())
      await resolveBootConfig({ env: flat, fetchImpl })
      expect(fetchImpl).toHaveBeenCalledWith(flat.VITE_CONFIG_PROFILE_URL, expect.anything())
      await expect(
        resolveBootConfig({ env: flat, fetchImpl, runtime: { configProfileUrl: ELSEWHERE } }),
      ).rejects.toThrow(/zk\.money Desktop is refused/)
    })
  })

  it("takes no endpoint from the host's global in any build", async () => {
    underLauncher()
    vi.stubGlobal("__ZKMONEY_ENDPOINTS__", {
      nodeUrl: "http://desktop-node.test",
      nodeApiKey: "launcher-key",
      l1RpcUrl: "http://desktop-l1.test",
      enclaveUrl: "https://desktop-enclave.test",
    })
    const { config } = await resolveBootConfig({
      env: { ...DESKTOP_ENV, VITE_NODE_API_KEY: "gateway-key" },
      fetchImpl: serve(sandboxProfile()),
      readEndpointOverrides: () => ({}),
    })
    expect(config.nodeUrl).toBe("http://profile-node.test")
    expect(config.l1RpcUrl).toBe("http://profile-l1.test")
    expect(config.enclaveUrl).toBe("/svc/enclave")
    expect(config.nodeApiKey).toBe("gateway-key")
  })

  it("reads the profile URL from the host's global", async () => {
    underLauncher()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubGlobal("__ZKMONEY_ENDPOINTS__", { configProfileUrl: ELSEWHERE })
    const fetchImpl = serve(sandboxProfile())
    const result = await resolveBootConfig({ env: DESKTOP_ENV, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(ELSEWHERE, expect.anything())
    expect(result.customProfileUrl).toBe(ELSEWHERE)
  })
})

/**
 * The document baked into the bundle answers exactly one failure: the config service never
 * answered. Everything the server says — a 404 above all — stays fatal.
 */
describe("the baked profile", () => {
  const unreachable = vi.fn(async () => {
    throw new TypeError("fetch failed")
  }) as unknown as typeof fetch

  function bakedDoc() {
    const doc = sandboxProfile()
    doc.publishedAt = "2026-08-01T00:00:00.000Z"
    doc.versions["0.0.1"].nodeUrl = "http://baked-node.test"
    return doc
  }

  it("is ignored while the live document resolves", async () => {
    const result = await resolveBootConfig({
      env: PROFILE_ENV,
      fetchImpl: serve(sandboxProfile()),
      bakedProfile: bakedDoc(),
    })
    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(result.bootedFromBakedProfile).toBe(false)
    expect(result.bakedProfile).toBeUndefined()
  })

  it("boots the wallet when the service is unreachable, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await resolveBootConfig({
      env: PROFILE_ENV,
      fetchImpl: unreachable,
      bakedProfile: bakedDoc(),
    })

    expect(result.config.nodeUrl).toBe("http://baked-node.test")
    expect(result.contractServiceOptions.source).toBe("profile")
    expect(result.bootedFromBakedProfile).toBe(true)
    expect(result.bakedProfile).toEqual({
      publishedAt: "2026-08-01T00:00:00.000Z",
      current: "0.0.1",
      forced: false,
      expired: false,
      liveFailure: { code: "UNREACHABLE", message: expect.stringContaining("fetch failed") },
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fetch failed"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2026-08-01T00:00:00.000Z"))
  })

  it("a stored endpoint still outranks the snapshot's", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await resolveBootConfig({
      env: PROFILE_ENV,
      fetchImpl: unreachable,
      bakedProfile: bakedDoc(),
      readEndpointOverrides: () => ({ node: "https://n.example" }),
    })
    expect(result.config.nodeUrl).toBe("https://n.example")
  })

  describe("the host's shipped-configuration setting", () => {
    const refuse = vi.fn(async () => {
      throw new Error("fetch must not be called")
    }) as unknown as typeof fetch

    it("boots the snapshot without fetching, past a 404 and past its expiry", async () => {
      underLauncher()
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const stale = bakedDoc()
      stale.expiresAt = "2026-08-15T00:00:00.000Z"
      const result = await resolveBootConfig({
        env: DESKTOP_ENV,
        fetchImpl: refuse,
        now: () => new Date("2026-09-01T00:00:00Z"),
        bakedProfile: stale,
        runtime: { bootFromBakedProfile: true },
      })
      expect(refuse).not.toHaveBeenCalled()
      expect(result.config.nodeUrl).toBe("http://baked-node.test")
      expect(result.bakedProfile).toEqual({
        publishedAt: "2026-08-01T00:00:00.000Z",
        current: "0.0.1",
        forced: true,
        expired: true,
      })
    })

    it("is fatal when the build baked nothing", async () => {
      underLauncher()
      await expect(
        resolveBootConfig({
          env: DESKTOP_ENV,
          fetchImpl: refuse,
          runtime: { bootFromBakedProfile: true },
        }),
      ).rejects.toThrow(/baked no profile/)
    })
  })

  it("a 404 stays fatal — the server answered", async () => {
    await expect(
      resolveBootConfig({ env: PROFILE_ENV, fetchImpl: serve({}, 404), bakedProfile: bakedDoc() }),
    ).rejects.toThrow(/profile not found/)
  })

  it("a snapshot the wallet's own policy refuses is fatal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const doc = testnetProfile()
    doc.versions["0.0.1"].oxide.manifestUrl = "https://manifest.example/dev.v4.json"
    const env = {
      ...PROFILE_ENV,
      VITE_NETWORK: "testnet",
      VITE_CONFIG_EXPECTED_PROFILE_ID: "staging-v5",
    }
    await expect(
      resolveBootConfig({ env, fetchImpl: unreachable, bakedProfile: doc }),
    ).rejects.toThrow(/dev or local manifest/)
  })
})

describe("degradations", () => {
  it("a profile for another network is fatal", async () => {
    const profile = sandboxProfile() as Record<string, any>
    profile.network = "testnet"
    profile.shared.l1ChainId = 11155111
    // Every network but sandbox demands https, and this document must still parse.
    profile.versions["0.0.1"] = {
      ...profile.versions["0.0.1"],
      nodeUrl: "https://node.example",
      l1RpcUrl: "https://l1.example",
      accountServiceUrl: "https://account.example",
      zkmoneyApiUrl: "https://api.example",
      paylinkDomain: "https://paylink.example",
      oxide: {
        ...profile.versions["0.0.1"].oxide,
        manifestUrl: "https://manifest.example/staging.v4.json",
      },
    }

    await expect(boot(PROFILE_ENV, serve(profile))).rejects.toThrow(/is for network "testnet"/)
  })

  it("vkey skew is reported and boot proceeds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const profile = sandboxProfile()
    profile.versions["0.0.1"].vkeys.zkJwtVkeyHash = F32(7)

    const result = await boot(PROFILE_ENV, serve(profile))

    expect(result.zkJwtVkeySkew).toBe(true)
    expect(result.config.nodeUrl).toBe("http://profile-node.test")
    expect(error).toHaveBeenCalledWith(expect.stringContaining(F32(7)))
    expect(error).toHaveBeenCalledWith(expect.stringContaining(ZKJWT_VKEY_HASH))
  })
})

/**
 * Settings-stored overrides, read through the injected reader; one case stubs localStorage to show
 * the default reader is wired.
 * The sandbox profile's defaults: node http://profile-node.test, L1 http://profile-l1.test, and
 * the same-origin `/svc/enclave` proxy for the enclave.
 */
describe("endpoint overrides", () => {
  const KEYED_ENV = { ...PROFILE_ENV, VITE_NODE_API_KEY: "gateway-key" }
  const DEFAULT = { source: "default", isDefault: true }
  const CUSTOM = { source: "settings", isDefault: false }
  const digestOf = (url: string) => endpointDigest(normalizeEndpoint(url))

  function bootWith(
    overrides: EndpointOverrides,
    input: { env?: Record<string, string | undefined>; runtime?: RuntimeEndpoints } = {},
  ) {
    return resolveBootConfig({
      env: input.env ?? KEYED_ENV,
      fetchImpl: serve(sandboxProfile()),
      readEndpointOverrides: () => overrides,
      ...(input.runtime ? { runtime: input.runtime } : {}),
    })
  }

  it("reads the record once, so the three endpoints never come from two saves", async () => {
    const first = { node: "https://n.example", l1Rpc: "https://l1.example" }
    const later = { enclave: "https://e.example" }
    const reader = vi.fn<() => Partial<Record<EndpointKind, string>>>()
    reader.mockReturnValueOnce(first).mockReturnValue(later)
    const { config } = await resolveBootConfig({
      env: KEYED_ENV,
      fetchImpl: serve(sandboxProfile()),
      readEndpointOverrides: reader,
    })
    expect(reader).toHaveBeenCalledTimes(1)
    expect(config.nodeUrl).toBe(first.node)
    expect(config.l1RpcUrl).toBe(first.l1Rpc)
    expect(config.endpoints.enclave).toEqual(DEFAULT)
  })

  it("no override: the profile's endpoints, every source default, the key kept, no digest", async () => {
    const { config } = await bootWith({})

    expect(config.nodeUrl).toBe("http://profile-node.test")
    expect(config.l1RpcUrl).toBe("http://profile-l1.test")
    expect(config.enclaveUrl).toBe("/svc/enclave")
    expect(config.endpoints).toEqual({
      node: DEFAULT,
      sourceNode: DEFAULT,
      l1Rpc: DEFAULT,
      enclave: DEFAULT,
    })
    expect(config.nodeApiKey).toBe("gateway-key")
    expect(config.nodeEndpointDigest).toBeUndefined()
  })

  it("carries the profile's rollupVersion for the skew report", async () => {
    const { config } = await bootWith({})
    expect(config.profileRollupVersion).toBe(sandboxProfile().shared.rollupVersion)
  })

  it("a stored node: the override, custom, no key, a digest", async () => {
    const { config } = await bootWith({ node: "https://n.example/rpc" })

    expect(config.nodeUrl).toBe("https://n.example/rpc")
    expect(config.endpoints.node).toEqual(CUSTOM)
    expect(config.nodeApiKey).toBeUndefined()
    expect(config.nodeEndpointDigest).toBe(digestOf("https://n.example/rpc"))
    expect(config.nodeEndpointDigest).toMatch(/^[0-9a-f]{32}$/)
    expect(config.endpoints.l1Rpc).toEqual(DEFAULT)
    expect(config.endpoints.enclave).toEqual(DEFAULT)
  })

  it("with no reader injected, a stored override reaches the config from localStorage", async () => {
    const stored = new Map([
      ["webwallet.endpoints", JSON.stringify({ node: "https://n.example/rpc" })],
    ])
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    })
    const { config } = await resolveBootConfig({
      env: KEYED_ENV,
      fetchImpl: serve(sandboxProfile()),
    })
    expect(config.nodeUrl).toBe("https://n.example/rpc")
    expect(config.endpoints.node).toEqual(CUSTOM)
  })

  it("the URL dialed is the input as typed; the digest is over the normalized form", async () => {
    const { config } = await bootWith({ node: "https://n.example" })

    expect(config.nodeUrl).toBe("https://n.example")
    expect(config.nodeEndpointDigest).toBe(endpointDigest("https://n.example/"))
  })

  it("a desktop build under the launcher uses its stored overrides like any other", async () => {
    underLauncher()
    const { config } = await bootWith(
      { node: "https://n.example", l1Rpc: "https://l1.example", enclave: "https://e.example" },
      { env: { ...KEYED_ENV, VITE_DESKTOP_BUILD: "true" } },
    )

    expect(config.nodeUrl).toBe("https://n.example")
    expect(config.l1RpcUrl).toBe("https://l1.example")
    expect(config.enclaveUrl).toBe("https://e.example")
    expect(config.endpoints).toEqual({
      node: CUSTOM,
      sourceNode: DEFAULT,
      l1Rpc: CUSTOM,
      enclave: CUSTOM,
    })
    expect(config.nodeApiKey).toBeUndefined()
    expect(config.nodeEndpointDigest).toBe(digestOf("https://n.example"))
  })

  it("a stored L1 RPC: custom on its own, the node stays default with its key", async () => {
    const { config } = await bootWith({ l1Rpc: "https://l1.example/v2/mykey" })

    expect(config.l1RpcUrl).toBe("https://l1.example/v2/mykey")
    expect(config.endpoints.l1Rpc).toEqual(CUSTOM)
    expect(config.endpoints.node).toEqual(DEFAULT)
    expect(config.nodeApiKey).toBe("gateway-key")
    expect(config.nodeEndpointDigest).toBeUndefined()
  })

  describe("a stored enclave", () => {
    it("is dialed verbatim and is custom against the proxy default", async () => {
      const { config } = await bootWith({ enclave: "https://enclave.example" })

      expect(config.enclaveUrl).toBe("https://enclave.example")
      expect(config.endpoints.enclave).toEqual(CUSTOM)
      expect(config.endpoints.node).toEqual(DEFAULT)
      expect(config.nodeEndpointDigest).toBeUndefined()
    })

    it('is custom against the "" default (the manifest\'s own) without throwing', async () => {
      const { config } = await bootWith(
        { enclave: "https://enclave.example" },
        { env: { ...KEYED_ENV, VITE_ENCLAVE_URL: "" } },
      )

      expect(config.enclaveUrl).toBe("https://enclave.example")
      expect(config.endpoints.enclave).toEqual(CUSTOM)
    })
  })

  it("the default retyped is still the default: key kept, no digest, source settings", async () => {
    const { config } = await bootWith({ node: "http://PROFILE-NODE.test/" })

    expect(config.nodeUrl).toBe("http://PROFILE-NODE.test/")
    expect(config.endpoints.node).toEqual({ source: "settings", isDefault: true })
    expect(config.nodeApiKey).toBe("gateway-key")
    expect(config.nodeEndpointDigest).toBeUndefined()
  })

  describe("a key goes only to the URL it came with", () => {
    it("a stored node's key goes to that node; the digest ignores it", async () => {
      const { config } = await bootWith({ node: "https://n.example/rpc", nodeApiKey: "user-key" })

      expect(config.nodeUrl).toBe("https://n.example/rpc")
      expect(config.nodeApiKey).toBe("user-key")
      expect(config.nodeEndpointDigest).toBe(digestOf("https://n.example/rpc"))
    })

    it("the default retyped with a key: the user's key replaces the build's", async () => {
      const { config } = await bootWith({
        node: "http://PROFILE-NODE.test/",
        nodeApiKey: "user-key",
      })

      expect(config.endpoints.node).toEqual({ source: "settings", isDefault: true })
      expect(config.nodeApiKey).toBe("user-key")
      expect(config.nodeEndpointDigest).toBeUndefined()
    })

    it("under the launcher: a stored custom node without a key sends none", async () => {
      underLauncher()
      const { config } = await bootWith(
        { node: "https://n.example" },
        { env: { ...KEYED_ENV, VITE_DESKTOP_BUILD: "true" } },
      )

      expect(config.nodeApiKey).toBeUndefined()
    })

    it("under the launcher: the default retyped without a key keeps the build's", async () => {
      underLauncher()
      const { config } = await bootWith(
        { node: "http://PROFILE-NODE.test/" },
        { env: { ...KEYED_ENV, VITE_DESKTOP_BUILD: "true" } },
      )

      expect(config.endpoints.node).toEqual({ source: "settings", isDefault: true })
      expect(config.nodeApiKey).toBe("gateway-key")
    })

    it("under the launcher: a stored key goes with its node", async () => {
      underLauncher()
      const { config } = await bootWith(
        { node: "https://n.example", nodeApiKey: "user-key" },
        { env: { ...KEYED_ENV, VITE_DESKTOP_BUILD: "true" } },
      )

      expect(config.nodeApiKey).toBe("user-key")
    })
  })

  it.each(["http://profile-node.test/rpc/other", "http://profile-node.test/?tenant=B"])(
    "the default's origin with another path or query is custom: %s",
    async (url) => {
      const { config } = await bootWith({ node: url })

      expect(config.endpoints.node).toEqual(CUSTOM)
      expect(config.nodeApiKey).toBeUndefined()
      expect(config.nodeEndpointDigest).toBe(digestOf(url))
    },
  )

  it("takes no endpoint from the page URL", async () => {
    const evil = "https://evil.example"
    vi.stubGlobal("location", {
      search: `?node=${evil}&nodeUrl=${evil}&l1RpcUrl=${evil}&enclaveUrl=${evil}`,
      hash: `#node=${evil}&l1=${evil}&enclave=${evil}`,
    })
    const { config } = await bootWith({})

    expect(config.nodeUrl).toBe("http://profile-node.test")
    expect(config.l1RpcUrl).toBe("http://profile-l1.test")
    expect(config.enclaveUrl).toBe("/svc/enclave")
  })
})

describe("the v5 archive node", () => {
  /** The live version plus a retired one on another node: the rollup a cutover left. */
  function withRetiredRollup() {
    const profile = sandboxProfile()
    profile.versions["0.0.2"] = { ...profile.versions["0.0.1"] }
    profile.versions["0.0.1"].nodeUrl = "http://retired-node.test"
    profile.current = "0.0.2"
    return profile
  }

  it("reads the retired rollup through the archive node the build names", async () => {
    const { config } = await boot(
      {
        ...PROFILE_ENV,
        VITE_NODE_API_KEY: "active-key",
        VITE_V5_ARCHIVE_NODE_URL: "https://archive.example",
        VITE_V5_ARCHIVE_NODE_API_KEY: "archive-key",
      },
      serve(withRetiredRollup()),
    )
    expect(config.nodeUrl).toBe("http://profile-node.test")
    expect(config.nodeApiKey).toBe("active-key")
    expect(config.sourceRollupApiKey).toBe("archive-key")
    expect(config.sourceRollups?.map((rollup) => rollup.nodeUrl)).toEqual([
      "https://archive.example",
    ])
    expect(config.sourceRollupNodes?.get(PORTAL.toLowerCase())).toBe("https://archive.example")
  })

  it("keeps the retired rollup's own node when the build names none", async () => {
    const { config } = await boot(PROFILE_ENV, serve(withRetiredRollup()))
    expect(config.sourceRollups?.map((rollup) => rollup.nodeUrl)).toEqual([
      "http://retired-node.test",
    ])
    expect(config.sourceRollupNodes?.get(PORTAL.toLowerCase())).toBe("http://retired-node.test")
  })
})

describe("fetchLiveProfilePortal", () => {
  const NEW_PORTAL = "0x" + "77".repeat(20)

  function repointed() {
    const doc = sandboxProfile() as Record<string, any>
    doc.versions["0.0.1"].oxide = { ...doc.versions["0.0.1"].oxide, portal: NEW_PORTAL }
    return doc
  }

  it("re-reads the profile with the boot's expectations and returns the portal it pins now", async () => {
    await boot(PROFILE_ENV, serve(sandboxProfile()))
    expect(getConfig().oxideProfile.portal).toBe(PORTAL)
    const live = serve(repointed())
    await expect(fetchLiveProfilePortal(live)).resolves.toBe(NEW_PORTAL)
    expect(live).toHaveBeenCalledWith(PROFILE_URL, expect.anything())
    expect(getConfig().oxideProfile.portal).toBe(PORTAL)
  })

  it("applies the identity check, so a wrong document never reports a repoint", async () => {
    await boot(PROFILE_ENV, serve(sandboxProfile()))
    const wrong = repointed()
    wrong.profileId = "other"
    await expect(fetchLiveProfilePortal(serve(wrong))).rejects.toThrow(/identifies as "other"/)
  })

  it("throws before boot", async () => {
    vi.resetModules()
    const fresh = await import("../../src/config/env")
    await expect(fresh.fetchLiveProfilePortal(serve(sandboxProfile()))).rejects.toThrow(
      /before resolveBootConfig/,
    )
  })
})
