/**
 * The plain-Noir prover takes bb.js's page-wide instance, the one the PXE's ClientIVC prover takes
 * too, and leaves it alive; a warm-up readies it ahead of the proof.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  initACVM: vi.fn(async () => {}),
  initABI: vi.fn(async () => {}),
  api: { destroy: vi.fn(async () => {}) },
  initSingleton: vi.fn(),
  newInstance: vi.fn(),
  generateProof: vi.fn(async () => ({ proof: new Uint8Array([7]), publicInputs: ["0x1"] })),
  backends: [] as unknown[],
}))

vi.mock("@aztec-foundation/noir-acvm_js/web/acvm_js.js", () => ({
  default: h.initACVM,
  compressWitness: () => new Uint8Array([1]),
  executeCircuit: async () => new Map(),
}))
vi.mock("@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm.js", () => ({
  default: h.initABI,
  abiEncode: () => new Map(),
}))
vi.mock("@aztec-foundation/bb.js", () => ({
  Barretenberg: { initSingleton: h.initSingleton, new: h.newInstance },
  UltraHonkBackend: class {
    constructor(_bytecode: string, api: unknown) {
      h.backends.push(api)
    }
    generateProof = h.generateProof
  },
}))

const CIRCUIT = { bytecode: btoa("bytecode"), abi: {} }

describe("noirProver", () => {
  beforeEach(() => {
    vi.resetModules()
    h.backends.length = 0
    h.initSingleton.mockReset().mockResolvedValue(h.api)
    h.newInstance.mockReset()
    h.api.destroy.mockClear()
    h.initACVM.mockReset().mockResolvedValue(undefined)
  })

  it("proves on the page-wide instance and never destroys it", async () => {
    const { proveNoirCircuit } = await import("../../src/platform/noirProver")
    await proveNoirCircuit(CIRCUIT, {}, "test")
    await proveNoirCircuit(CIRCUIT, {}, "test")
    expect(h.backends).toEqual([h.api, h.api])
    expect(h.newInstance).not.toHaveBeenCalled()
    expect(h.api.destroy).not.toHaveBeenCalled()
  })

  it("leaves a proof its own wasm init when the warm-up's failed", async () => {
    h.initACVM.mockRejectedValueOnce(new Error("wasm fetch failed"))
    const { proveNoirCircuit, warmNoirProver } = await import("../../src/platform/noirProver")
    await expect(warmNoirProver()).rejects.toThrow("wasm fetch failed")
    await expect(proveNoirCircuit(CIRCUIT, {}, "test")).resolves.toMatchObject({
      publicInputs: ["0x1"],
    })
    expect(h.initACVM).toHaveBeenCalledTimes(2)
  })
})
