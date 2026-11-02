import { Network } from "@obsidion/core/constants"
import { AZTEC_NODE_URL, L1_RPC_URL, TESTNET_NODE_URL } from "@obsidion/core/constants"
import { NETWORK_STORAGE_KEY } from "./storage-constants.js"
import type { IStorageAdapter } from "./adapter.js"
import { getActiveGenerationNode } from "../activeGenerationNode.js"
import { setNodeApiKey } from "../nodeApiKey.js"
import { logger } from "../../utils/logger"

export const DEFAULT_TESTNET_NAME = Network.TESTNET
export const DEFAULT_SANDBOX_NAME = Network.SANDBOX
export const DEFAULT_MAINNET_NAME = Network.MAINNET
export const DEFAULT_TESTNET_NODE_URL = TESTNET_NODE_URL
export const DEFAULT_TESTNET_L1_RPC_URL = L1_RPC_URL.SEPOLIA
export const DEFAULT_MAINNET_L1_RPC_URL = L1_RPC_URL.MAINNET

export interface NetworkConfig {
  name: string
  displayName: string
  description: string
  id: string // first block hash
  type: Network
  nodeUrl: string
  l1RpcUrl: string
  current?: boolean
}

export interface NetworkStorageConfig {
  /** The active network this build runs as — drives which default entry is `current`. */
  activeNetwork: Network
  nodeUrl?: string
  /** Key for a gateway-fronted node; published to {@link setNodeApiKey} for every node-RPC caller. */
  nodeApiKey?: string
  l1RpcUrl?: string
  /** Build-flag gate for the mainnet default entry; off keeps testnet installs mainnet-free (R9). */
  enableMainnet?: boolean
}

export class NetworkStorage {
  private static instance: NetworkStorage | null = null
  private defaultNetworks: NetworkConfig[]
  private storage: IStorageAdapter
  private runtimeConfig: NetworkStorageConfig

  private constructor(storage: IStorageAdapter, config: NetworkStorageConfig) {
    this.storage = storage
    this.runtimeConfig = config
    this.defaultNetworks = this.getDefaultNetworks(config)
    setNodeApiKey(config.nodeApiKey)
  }

  static get(storage?: IStorageAdapter, config?: NetworkStorageConfig): NetworkStorage {
    if (!NetworkStorage.instance) {
      if (!storage || !config) {
        throw new Error("First call to getInstance requires config parameter")
      }

      NetworkStorage.instance = new NetworkStorage(storage, config)
    } else if (config) {
      NetworkStorage.instance.updateRuntimeConfig(config)
    }
    return NetworkStorage.instance
  }

  /** Refresh URLs from the latest app config (env changes) without resetting storage. */
  private updateRuntimeConfig(config: NetworkStorageConfig) {
    this.runtimeConfig = config
    this.defaultNetworks = this.getDefaultNetworks(config)
    setNodeApiKey(config.nodeApiKey)
  }

  /**
   * Persisted network list can lag behind the build's configured URLs.
   * Patch the active default entry from runtime config and clear chain id when the L2 URL changes.
   */
  private syncStoredConfigsWithRuntime(configs: Record<string, NetworkConfig>): boolean {
    const cfg = this.runtimeConfig
    const active = configs[cfg.activeNetwork]
    if (!active) return false

    let changed = false
    if (cfg.nodeUrl && active.nodeUrl !== cfg.nodeUrl) {
      active.nodeUrl = cfg.nodeUrl
      active.id = ""
      changed = true
    }
    if (cfg.l1RpcUrl && active.l1RpcUrl !== cfg.l1RpcUrl) {
      active.l1RpcUrl = cfg.l1RpcUrl
      changed = true
    }
    // `activeNetwork` is the sole source of `current` — nothing else ever writes it. Re-point it
    // here too, or a map persisted under a different build keeps `getNetwork()` on that build's
    // network for good: two builds sharing an origin (a sandbox run, then a testnet one, both on
    // localhost:5173) otherwise leave the testnet build dialling the sandbox row's localhost URLs.
    for (const [name, entry] of Object.entries(configs)) {
      const isActive = name === cfg.activeNetwork
      if (!!entry.current !== isActive) {
        entry.current = isActive
        changed = true
      }
    }
    return changed
  }

  private getDefaultNetworks(config: NetworkStorageConfig): NetworkConfig[] {
    const networks: NetworkConfig[] = [
      {
        name: DEFAULT_TESTNET_NAME,
        displayName: Network.TESTNET,
        description: "Official Aztec Testnet",
        id: "",
        type: Network.TESTNET,
        nodeUrl: config.nodeUrl ?? DEFAULT_TESTNET_NODE_URL,
        l1RpcUrl: config.l1RpcUrl ?? DEFAULT_TESTNET_L1_RPC_URL,
        current: config.activeNetwork === Network.TESTNET,
      },
      {
        name: DEFAULT_SANDBOX_NAME,
        displayName: Network.SANDBOX,
        description: "Localhost Sandbox. PXE is in browser by default.",
        id: "",
        type: Network.SANDBOX,
        nodeUrl: config.nodeUrl ?? AZTEC_NODE_URL,
        l1RpcUrl: config.l1RpcUrl ?? L1_RPC_URL.LOCAL,
        current: config.activeNetwork === Network.SANDBOX,
      },
    ]
    // Gated behind the mainnet build flag (U4): a fresh testnet/sandbox install
    // must not persist a mainnet row (R9). Node URL rides the active-network
    // `config.nodeUrl` like sandbox; L1 defaults to the public mainnet RPC.
    if (config.enableMainnet) {
      networks.push({
        name: DEFAULT_MAINNET_NAME,
        displayName: Network.MAINNET,
        description: "Aztec Mainnet",
        id: "",
        type: Network.MAINNET,
        nodeUrl: config.nodeUrl ?? "",
        l1RpcUrl: DEFAULT_MAINNET_L1_RPC_URL,
        current: config.activeNetwork === Network.MAINNET,
      })
    }
    return networks
  }

  public async getNetwork(): Promise<NetworkConfig> {
    const networkConfigs = await this.getAllNetworkConfigs()

    // Find the current network
    const currentNetwork = Object.values(networkConfigs).find((config) => config.current)

    if (!currentNetwork) {
      throw new Error("No current network found")
    }
    // If no current network found, return the first one
    return currentNetwork
  }

  public async getAllNetworkConfigs(): Promise<Record<string, NetworkConfig>> {
    const configsJson = await this.storage.getItem(NETWORK_STORAGE_KEY)

    // Malformed persisted configs (e.g. inherited from an older install) are
    // treated like missing ones: discard and rebuild from defaults — configs
    // carry no user-authored data.
    let stored: Record<string, NetworkConfig> | null = null
    if (configsJson) {
      try {
        stored = JSON.parse(configsJson) as Record<string, NetworkConfig>
      } catch (e) {
        console.warn("[NetworkStorage] Discarding malformed persisted configs:", e)
      }
    }

    if (!stored) {
      // Initialize with default networks
      // Check if any default networks don't have network.id
      const networksWithIds = await Promise.all(
        this.defaultNetworks.map(async (network) => {
          if (network.current && !network.id) {
            // Get network id if it doesn't exist
            network.id = await this.getNetworkId(network.nodeUrl)
          }

          return network
        }),
      )

      const configs = this.createNetworkConfigsMap(networksWithIds)
      await this.storage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(configs))
      return configs
    }

    if (this.syncStoredConfigsWithRuntime(stored)) {
      await this.storage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(stored))
    }

    // Back-fill a current network whose id never populated — e.g. stored empty
    // by a pre-fix boot when the fingerprint RPC failed against a v4 node. Now
    // that the generation node is published, fill it in.
    const current = Object.values(stored).find((c) => c.current)
    if (current && !current.id) {
      current.id = await this.getNetworkId(current.nodeUrl)
      if (current.id) {
        await this.storage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(stored))
      }
    }

    return stored
  }

  private createNetworkConfigsMap(networks: NetworkConfig[]): Record<string, NetworkConfig> {
    return networks.reduce((acc, network) => {
      acc[network.name] = network
      return acc
    }, {} as Record<string, NetworkConfig>)
  }

  // Testnet AND mainnet are production (prover on, long tx timeout); only
  // the local sandbox is not. The one genuinely per-network value (`l1ChainId`)
  // is selected by `network.type` at its call site, not via this flag.
  public async isProd(): Promise<boolean> {
    const network = await this.getNetwork()
    return network.type !== Network.SANDBOX
  }

  public async getNetworkId(_nodeUrl: string): Promise<string> {
    // Use the canonical generation's node (published by the wallet) rather than a
    // fresh v5 client — the latter speaks aztec_* and fails against a v4
    // node. The rollup's L1 address is a stable, version-agnostic per-deployment
    // fingerprint (getNodeInfo returns it identically on v4 and v5). Empty until
    // the wallet has booted; getAllNetworkConfigs back-fills it once available.
    const node = getActiveGenerationNode()
    if (!node) return ""

    try {
      const info = await node.getNodeInfo()
      return info.l1ContractAddresses.rollupAddress.toString()
    } catch (error) {
      logger.log("Failed to get network id", error)
      return ""
    }
  }
}
