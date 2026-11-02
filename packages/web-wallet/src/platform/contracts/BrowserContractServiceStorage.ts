import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { ContractName, IContractServiceStorage, NetworkType } from "@obsidion/sdk"

/**
 * The web wallet's `IContractServiceStorage`: a per-process artifact memo, network-scoped so one
 * origin can hold sandbox/testnet/mainnet caches side by side.
 *
 * Nothing is persisted. Every address the wallet resolves comes from the config profile, fetched at
 * each boot (or, when the config service is unreachable, the copy baked into this build) and cached
 * nowhere, so there is no contract state worth keeping across sessions — this storage adds nothing
 * that could go stale on its own.
 */
export class BrowserContractServiceStorage implements IContractServiceStorage {
  private artifactCache = new Map<NetworkType, Map<ContractName, Promise<ContractArtifact>>>()

  constructor(private network: NetworkType) {}

  switchNetwork(network: NetworkType) {
    this.network = network
  }

  private ensureArtifactCache(): Map<ContractName, Promise<ContractArtifact>> {
    let cache = this.artifactCache.get(this.network)
    if (!cache) {
      cache = new Map()
      this.artifactCache.set(this.network, cache)
    }
    return cache
  }

  getArtifactCache(): Map<ContractName, Promise<ContractArtifact>> {
    return this.ensureArtifactCache()
  }

  setArtifactCache(name: ContractName, artifactPromise: Promise<ContractArtifact>): void {
    this.ensureArtifactCache().set(name, artifactPromise)
  }
}
