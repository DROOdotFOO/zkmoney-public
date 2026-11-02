/**
 * The stub account classes cost a full class hash each to register. A PXE that kept them from an
 * earlier session is not asked to register them again.
 */
import { describe, expect, it, vi } from "vitest"
import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"

class Probe extends ObsidionWallet {
  init() {
    return this.initStubClasses()
  }
}

function probe(known: boolean) {
  const pxe = {
    getContractArtifact: vi.fn(async () => (known ? { name: "kept" } : undefined)),
    registerContractClass: vi.fn(async () => undefined),
  }
  return { pxe, wallet: new Probe(pxe as never, {} as never, "0xrollup") }
}

describe("initStubClasses", () => {
  it("registers each stub class a fresh PXE lacks, once", async () => {
    const { pxe, wallet } = probe(false)
    await Promise.all([wallet.init(), wallet.init()])
    expect(pxe.registerContractClass).toHaveBeenCalledTimes(3)
  }, 120_000)

  it("registers nothing a PXE already holds", async () => {
    const { pxe, wallet } = probe(true)
    await wallet.init()
    expect(pxe.getContractArtifact).toHaveBeenCalledTimes(3)
    expect(pxe.registerContractClass).not.toHaveBeenCalled()
  }, 120_000)
})
