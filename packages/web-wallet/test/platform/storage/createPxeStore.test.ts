import { afterEach, describe, expect, it, vi } from "vitest"

const { open } = vi.hoisted(() => ({ open: vi.fn(async (..._args: unknown[]) => ({})) }))
vi.mock("@aztec-labs/kv-store/sqlite-opfs", () => ({ AztecSQLiteOPFSStore: { open } }))

vi.resetModules()
const { createPxeStore, pxeStoreNames } = await import(
  "../../../src/platform/storage/createPxeStore"
)

const ROLLUP = "0x" + "a".repeat(40)
const DIGEST = "0123456789abcdef0123456789abcdef"

function stubStorage(getDirectory: () => Promise<unknown>) {
  Object.defineProperty(navigator, "storage", { value: { getDirectory }, configurable: true })
  Object.defineProperty(navigator, "locks", { value: { request: vi.fn() }, configurable: true })
}

afterEach(() => open.mockClear())

describe("createPxeStore", () => {
  it("names the default node's store as it always has", () => {
    expect(pxeStoreNames(ROLLUP, undefined)).toEqual({
      dbName: `pxe_data_${ROLLUP}`,
      directory: `.aztec-kv-pxe-${ROLLUP}`,
    })
  })

  it("opens a custom node's store under digest-suffixed names", async () => {
    stubStorage(async () => ({}))
    await createPxeStore(ROLLUP, DIGEST)
    expect(open.mock.calls[0]!.slice(1)).toEqual([
      `pxe_data_${ROLLUP}_${DIGEST}`,
      false,
      `.aztec-kv-pxe-${ROLLUP}_${DIGEST}`,
    ])
  })

  it("falls back to an in-memory DB when getDirectory rejects (Safari private mode)", async () => {
    stubStorage(() => Promise.reject(new DOMException("unknown transient reason", "UnknownError")))
    await createPxeStore(ROLLUP, undefined)
    expect(open.mock.calls[0].slice(1)).toEqual([undefined, true])
  })
})
