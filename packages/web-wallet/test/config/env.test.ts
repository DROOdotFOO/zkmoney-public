// @vitest-environment node
import { Network } from "@obsidion/sdk"
import { CLAIM_FPC_FUNDING } from "@obsidion/core/constants"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getConfig, loadConfig } from "../../src/config/env"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("getConfig", () => {
  it("throws before a profile boot has seeded it", () => {
    // Nothing in this file runs resolveBootConfig, so the module-level cache is unseeded here.
    expect(() => getConfig()).toThrow(/before resolveBootConfig/)
  })
})

const sandboxEnv = {}
const testnetEnv = { VITE_NETWORK: "testnet" }

// Production deployment with a mainnet chain.
const mainnetEnv = {
  VITE_NETWORK: "mainnet",
  VITE_NODE_URL: "https://node.example",
  VITE_L1_RPC_URL: "https://l1.example",
  VITE_PASSKEY_ENVIRONMENT: "production",
}

describe("loadConfig", () => {
  it("defaults to sandbox with the local stack", () => {
    const config = loadConfig(sandboxEnv)
    expect(config.network).toBe(Network.SANDBOX)
    expect(config.nodeUrl).toBe("http://localhost:8080")
    expect(config.l1ChainId).toBe(31337)
    expect(config.l1Chain.id).toBe(31337)
  })

  it("rejects an unknown network", () => {
    expect(() => loadConfig({ VITE_NETWORK: "stagenet" })).toThrow(/Unknown VITE_NETWORK/)
  })

  it("takes no endpoint from the page URL", () => {
    // Settings storage and the build are the only sources; a link can name none.
    const evil = "https://evil.example"
    vi.stubGlobal("location", {
      search: `?node=${evil}&nodeUrl=${evil}&l1=${evil}&l1RpcUrl=${evil}&enclave=${evil}&enclaveUrl=${evil}`,
      hash: `#node=${evil}&l1=${evil}&enclave=${evil}`,
    })

    const config = loadConfig({
      ...testnetEnv,
      VITE_NODE_URL: "https://node.example",
      VITE_L1_RPC_URL: "https://l1.example",
    })
    expect(config.nodeUrl).toBe("https://node.example")
    expect(config.l1RpcUrl).toBe("https://l1.example")
    expect(config.enclaveUrl).toBe("")
  })

  describe("enclaveUrl", () => {
    it("dials the manifest's enclaveUrl off sandbox, and proxies on sandbox", () => {
      // Empty = "use the manifest's own enclaveUrl" — the URL attestation binds to portal/pcr0.
      expect(loadConfig(testnetEnv).enclaveUrl).toBe("")
      // Sandbox's mock TEE serves no CORS, so it has to stay same-origin.
      expect(loadConfig(sandboxEnv).enclaveUrl).toBe("/svc/enclave")
    })

    it("honors an explicit proxy override for a CORS-free tier", () => {
      expect(loadConfig({ ...testnetEnv, VITE_ENCLAVE_URL: "/svc/enclave" }).enclaveUrl).toBe(
        "/svc/enclave",
      )
    })

    it("takes nothing from the desktop launcher's global", () => {
      vi.stubGlobal("__ZKMONEY_DESKTOP_BRIDGE__", { l1SubmitPath: "/desktop/l1-submit" })
      vi.stubGlobal("__ZKMONEY_ENDPOINTS__", {
        nodeUrl: "https://my-node.example",
        l1RpcUrl: "https://my-l1.example",
        enclaveUrl: "https://enclave.example/rpc",
      })
      const config = loadConfig({ ...testnetEnv, VITE_DESKTOP_BUILD: "true" })
      expect(config.nodeUrl).toBe("http://localhost:8080")
      expect(config.l1RpcUrl).toBe("http://localhost:8545")
      expect(config.enclaveUrl).toBe("")
    })
  })

  describe("nodeApiKey", () => {
    const keyed = { ...testnetEnv, VITE_NODE_API_KEY: "baked-key" }

    it("sends the baked key to the baked node", () => {
      expect(loadConfig(keyed).nodeApiKey).toBe("baked-key")
      expect(loadConfig(testnetEnv).nodeApiKey).toBeUndefined()
    })
  })

  describe("the campaign", () => {
    it("names no campaign, whatever the env bakes", () => {
      const config = loadConfig({
        ...testnetEnv,
        VITE_CAMPAIGN_URL: "http://launch.staging.zk.money",
        VITE_ADMISSION_GATE: "true",
      })
      expect(config.campaignUrl).toBe("")
    })
  })

  describe("fpcRefuelThreshold", () => {
    const screenedMainnet = {
      ...mainnetEnv,
      VITE_PREDICATE_VERIFICATION_HASH: "x-managed-policy-abc",
      VITE_PREDICATE_CHAIN: "ethereum-mainnet",
    }

    it("refuels below the network's ClaimFPC refuel threshold", () => {
      expect(loadConfig(screenedMainnet).fpcRefuelThreshold).toBe(
        CLAIM_FPC_FUNDING[Network.MAINNET].refuelBelow,
      )
      expect(loadConfig(testnetEnv).fpcRefuelThreshold).toBe(
        CLAIM_FPC_FUNDING[Network.TESTNET].refuelBelow,
      )
    })

    it("honors an explicit threshold in whole FJ", () => {
      expect(
        loadConfig({ ...screenedMainnet, VITE_FPC_REFUEL_THRESHOLD: "5" }).fpcRefuelThreshold,
      ).toBe(5n * 10n ** 18n)
    })
  })

  describe("accountServiceTestMode fails closed", () => {
    it("defaults ON only for sandbox", () => {
      expect(loadConfig(sandboxEnv).accountServiceTestMode).toBe(true)
      expect(loadConfig(testnetEnv).accountServiceTestMode).toBe(false)
    })

    it("honors an explicit flag on sandbox/testnet", () => {
      expect(
        loadConfig({ ...sandboxEnv, VITE_ACCOUNT_SERVICE_TEST_MODE: "false" })
          .accountServiceTestMode,
      ).toBe(false)
      expect(
        loadConfig({ ...testnetEnv, VITE_ACCOUNT_SERVICE_TEST_MODE: "true" })
          .accountServiceTestMode,
      ).toBe(true)
    })

    it("refuses the bypass on mainnet", () => {
      expect(() => loadConfig({ ...mainnetEnv, VITE_ACCOUNT_SERVICE_TEST_MODE: "true" })).toThrow(
        /not valid on mainnet/,
      )
    })
  })

  describe("mainnet fails closed on missing pointers", () => {
    const screened = {
      VITE_PREDICATE_VERIFICATION_HASH: "x-managed-policy-abc",
      VITE_PREDICATE_CHAIN: "ethereum-mainnet",
    }

    it("selects the RP by deployment even when the chain changes", () => {
      expect(loadConfig({ ...mainnetEnv, ...screened }).rpId).toBe("auth.zk.money")
      expect(loadConfig({ ...mainnetEnv, ...screened, VITE_NETWORK: "testnet" }).rpId).toBe(
        "auth.zk.money",
      )
      expect(loadConfig({ VITE_NETWORK: "mainnet", ...screened }).rpId).toBe("localhost")
    })
  })

  describe("predicate screening config", () => {
    const complete = {
      VITE_PREDICATE_API_KEY: "key",
      VITE_PREDICATE_VERIFICATION_HASH: "x-managed-policy-abc",
      VITE_PREDICATE_CHAIN: "ethereum-sepolia",
    }

    it("is off when unset", () => {
      expect(loadConfig(sandboxEnv).predicate).toBeUndefined()
      expect(loadConfig(testnetEnv).predicate).toBeUndefined()
    })

    it("parses the complete triple, defaulting baseUrl to the same-origin proxy", () => {
      // Predicate serves no CORS — the default must be the /svc/predicate proxy, never direct.
      expect(loadConfig({ ...testnetEnv, ...complete }).predicate).toEqual({
        apiKey: "key",
        verificationHash: "x-managed-policy-abc",
        chain: "ethereum-sepolia",
        baseUrl: "/svc/predicate",
      })
    })

    it("honors the staging base URL", () => {
      const config = loadConfig({
        ...testnetEnv,
        ...complete,
        VITE_PREDICATE_BASE_URL: "https://staging.api.predicate.io",
      })
      expect(config.predicate?.baseUrl).toBe("https://staging.api.predicate.io")
    })

    it("VITE_PREDICATE_DISABLED=true turns screening off despite a complete config", () => {
      expect(
        loadConfig({ ...testnetEnv, ...complete, VITE_PREDICATE_DISABLED: "true" }).predicate,
      ).toBeUndefined()
    })

    it("refuses the disable switch on mainnet", () => {
      expect(() =>
        loadConfig({ ...mainnetEnv, ...complete, VITE_PREDICATE_DISABLED: "true" }),
      ).toThrow(/not valid on mainnet/)
    })

    it("rejects a partial credential pair", () => {
      expect(() => loadConfig({ ...sandboxEnv, VITE_PREDICATE_API_KEY: "key" })).toThrow(
        /Partial Predicate/,
      )
      expect(() =>
        loadConfig({ ...sandboxEnv, ...complete, VITE_PREDICATE_CHAIN: undefined }),
      ).toThrow(/Partial Predicate/)
    })

    it("chain/baseUrl alone (committed env file, credentials elsewhere) stay inert", () => {
      const config = loadConfig({
        ...testnetEnv,
        VITE_PREDICATE_CHAIN: "ethereum-sepolia",
        VITE_PREDICATE_BASE_URL: "https://staging.api.predicate.io",
      })
      expect(config.predicate).toBeUndefined()
    })

    it("arms key-less on hash+chain — the CDN's /svc proxy owns the key", () => {
      const config = loadConfig({
        ...testnetEnv,
        VITE_PREDICATE_VERIFICATION_HASH: "x-managed-policy-abc",
        VITE_PREDICATE_CHAIN: "ethereum-sepolia",
      })
      expect(config.predicate).toEqual({
        apiKey: undefined,
        verificationHash: "x-managed-policy-abc",
        chain: "ethereum-sepolia",
        baseUrl: "/svc/predicate",
      })
    })

    it("mainnet refuses to build unscreened, with or without a client-side key", () => {
      const mainnetEnv = { VITE_NETWORK: "mainnet", VITE_PASSKEY_ENVIRONMENT: "production" }
      expect(() => loadConfig(mainnetEnv)).toThrow(/requires L1 address screening/)
      expect(loadConfig({ ...mainnetEnv, ...complete }).predicate).toBeDefined()
      const { VITE_PREDICATE_API_KEY: _key, ...keyless } = complete
      expect(loadConfig({ ...mainnetEnv, ...keyless }).predicate).toBeDefined()
    })
  })
})
