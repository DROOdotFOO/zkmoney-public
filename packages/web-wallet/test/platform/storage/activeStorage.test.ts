/** The cached master key's shape on disk and the id encoding. */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { beforeEach, describe, expect, it } from "vitest"
import {
  clearActiveStorage,
  clearCachedMsk,
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  storageIdFromSecret,
  writeCachedMsk,
} from "../../../src/platform/storage/activeStorage"
import { walletStorage } from "../../../src/platform/storage/walletStorage"

const MSK = `0x${"1f".repeat(32)}`

describe("cached master key", () => {
  beforeEach(() => localStorage.clear())

  it.each([
    ["not json", "{"],
    ["another version", JSON.stringify({ v: 2, storageId: "s", credentialId: "c", msk: MSK })],
    ["no credential", JSON.stringify({ v: 1, storageId: "s", msk: MSK })],
    ["a short key", JSON.stringify({ v: 1, storageId: "s", credentialId: "c", msk: "0x1f" })],
    [
      "a key without the prefix",
      JSON.stringify({ v: 1, storageId: "s", credentialId: "c", msk: "1f".repeat(32) }),
    ],
  ])(
    "reads a blob this wallet did not write (%s) as no cache, and leaves it for the next commit",
    (_name, raw) => {
      walletStorage.setItem("webwallet.msk", raw)
      expect(readCachedMsk()).toBeNull()
      expect(walletStorage.getItem("webwallet.msk")).toBe(raw)
      writeCachedMsk({ v: 1, storageId: "s", credentialId: "c", msk: MSK })
      expect(readCachedMsk()).not.toBeNull()
    },
  )

  it("goes with the pointers", () => {
    setActiveStorageId("s")
    setActiveCredentialId("c")
    writeCachedMsk({ v: 1, storageId: "s", credentialId: "c", msk: MSK })
    clearActiveStorage()
    expect(readCachedMsk()).toBeNull()
    expect(walletStorage.getItem("webwallet.storageId")).toBeNull()
    clearCachedMsk()
  })
})

describe("storageIdFromSecret", () => {
  it("hashes the key's 32 big-endian bytes, the encoding a cached hex key must reproduce", async () => {
    const key = Fr.fromString("0x01")
    const bytes = new Uint8Array(key.toBuffer())
    expect(bytes).toHaveLength(32)
    expect(bytes[31]).toBe(1)
    expect(bytes.slice(0, 31).every((b) => b === 0)).toBe(true)
    const fromHex = new Uint8Array(Buffer.from(key.toString().slice(2), "hex"))
    expect(await storageIdFromSecret(fromHex)).toBe(await storageIdFromSecret(bytes))
    // sha256("zk.money/storage-id" || 0x00…01): the id every reader of the namespace must agree on.
    expect(await storageIdFromSecret(bytes)).toBe(
      "cbb1066358144ae11bb2bbee06277dbafb1277b353841901b4f5af56a1afc512",
    )
  })
})
