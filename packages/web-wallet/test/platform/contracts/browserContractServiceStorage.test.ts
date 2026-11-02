import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { type ContractName, Network } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import { BrowserContractServiceStorage } from "../../../src/platform/contracts/BrowserContractServiceStorage"

const NAME = "token" as ContractName
const artifact = (name: string) => Promise.resolve({ name } as ContractArtifact)

describe("BrowserContractServiceStorage", () => {
  it("memoizes artifacts for the current network", async () => {
    const storage = new BrowserContractServiceStorage(Network.SANDBOX)
    storage.setArtifactCache(NAME, artifact("sandbox"))
    expect((await storage.getArtifactCache().get(NAME))?.name).toBe("sandbox")
  })

  it("scopes the memo per network", async () => {
    const storage = new BrowserContractServiceStorage(Network.SANDBOX)
    storage.setArtifactCache(NAME, artifact("sandbox"))

    storage.switchNetwork(Network.TESTNET)
    expect(storage.getArtifactCache().get(NAME)).toBeUndefined()
    storage.setArtifactCache(NAME, artifact("testnet"))

    storage.switchNetwork(Network.SANDBOX)
    expect((await storage.getArtifactCache().get(NAME))?.name).toBe("sandbox")
  })

  it("keeps nothing across instances — every boot re-resolves from the profile", () => {
    new BrowserContractServiceStorage(Network.SANDBOX).setArtifactCache(NAME, artifact("first"))
    const fresh = new BrowserContractServiceStorage(Network.SANDBOX)
    expect(fresh.getArtifactCache().get(NAME)).toBeUndefined()
  })
})
