import { describe, expect, it, vi } from "vitest"
import { isWalletOpenElsewhere } from "../../../src/platform/storage/walletStorage"

const { open } = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock("@aztec-labs/kv-store/sqlite-opfs", async () => ({
  ...(await vi.importActual<object>("@aztec-labs/kv-store/sqlite-opfs")),
  AztecSQLiteOPFSStore: { open },
}))

vi.resetModules()
const { openPooledStore } = await import("../../../src/platform/storage/openPooledStore")
const openWallet = () => openPooledStore({} as never, "wallet_9", ".aztec-kv-wallet_9")

describe("openPooledStore", () => {
  it("reports Safari's refusal of a file another page holds as held elsewhere", async () => {
    const refusal = new Error("The object is in an invalid state.")
    open.mockRejectedValueOnce(refusal)
    const error = await openWallet().catch((e: unknown) => e)
    expect(isWalletOpenElsewhere(error)).toBe(true)
    expect((error as Error).cause).toBe(refusal)
  })

  it("passes any other failure through unchanged", async () => {
    const failure = new Error("Failed to read at offset")
    open.mockRejectedValueOnce(failure)
    await expect(openWallet()).rejects.toBe(failure)
  })
})
