import { beforeEach, describe, expect, it } from "vitest"
import {
  IssuedConnectStorage,
  decodeInline,
  parseConnectLink,
  deriveBootstrapKey,
  type IStorageAdapter,
} from "@obsidion/front-core"
import { Network } from "@obsidion/core/constants"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { mintMyConnectLink } from "../../../src/features/contacts/myCode"

/** Map-backed adapter so the mint drives the real IssuedConnectStorage without a browser. */
class MemoryAdapter implements IStorageAdapter {
  private map = new Map<string, string>()
  async getItem(key: string) {
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  async removeItem(key: string) {
    this.map.delete(key)
  }
  async clear() {
    this.map.clear()
  }
}

const UUID = "a1b2c3d4-e5f6-4a7b-89ab-cdef01234567"
const MSK = new Fr(0x1234abcdn)
const L2_ADDRESS = "0x" + "2".repeat(64)

const deps = (store: IssuedConnectStorage, overrides: object = {}) => ({
  ownTag: "alice",
  masterSecret: MSK,
  chain: Network.TESTNET,
  l2Address: L2_ADDRESS,
  origin: "https://wallet.staging.zk.money",
  record: (uuid: string) => store.recordHandshake(uuid),
  uuid: () => UUID,
  now: () => 1_753_000_000_000,
  ...overrides,
})

describe("mintMyConnectLink", () => {
  let store: IssuedConnectStorage

  beforeEach(() => {
    IssuedConnectStorage.resetForTests()
    store = IssuedConnectStorage.get(new MemoryAdapter())
  })

  it("records the uuid only after a successful encode", async () => {
    await mintMyConnectLink(deps(store))
    expect(await store.lookup(UUID)).not.toBeNull()
  })

  it("leaves no local record when the encode fails", async () => {
    await expect(
      mintMyConnectLink(deps(store, { chain: "not-a-chain" as Network })),
    ).rejects.toThrow()
    expect(await store.lookup(UUID)).toBeNull()
  })

  it("packet round-trips through decodeInline", async () => {
    const link = await mintMyConnectLink(deps(store))
    const parsed = parseConnectLink(link)
    expect(parsed).not.toBeNull()
    const packet = decodeInline(parsed!)
    expect(packet).toMatchObject({
      version: "1.0:testnet",
      kind: "handshake",
      uuid: UUID,
      l2Address: L2_ADDRESS,
      tag: "alice",
      xmtpHandle: deriveBootstrapKey(MSK).address,
    })
  })

  it("mints on this deploy's own origin, with the tag in the packet not the host", async () => {
    const preview = await mintMyConnectLink(
      deps(store, { origin: "https://wallet-pr-1220.zk.money" }),
    )
    expect(preview.startsWith("https://wallet-pr-1220.zk.money/connect#")).toBe(true)

    // A localhost dev origin would mint a link the scanner rejects — fall back to the network host.
    const local = await mintMyConnectLink(deps(store, { origin: "http://localhost:5173" }))
    expect(local.startsWith("https://wallet.staging.zk.money/connect#")).toBe(true)

    const link = await mintMyConnectLink(deps(store))
    expect(link.startsWith("https://wallet.staging.zk.money/connect#")).toBe(true)
    expect(decodeInline(parseConnectLink(link)!).tag).toBe("alice")

    // A tag-less mint keeps the same host and simply omits the field.
    const anonymous = await mintMyConnectLink(deps(store, { ownTag: undefined }))
    expect(anonymous.startsWith("https://wallet.staging.zk.money/connect#")).toBe(true)
    expect(decodeInline(parseConnectLink(anonymous)!)).not.toHaveProperty("tag")
  })
})
