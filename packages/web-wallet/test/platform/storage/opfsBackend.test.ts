import { describe, expect, it } from "vitest"
import { backendContract } from "../../../../front-core/test/engine/backendContract"
import {
  closeWalletStore,
  opfsBackend,
  openWalletStore,
  walletStorage,
  type WalletOp,
} from "../../../src/platform/storage/walletStorage"
import { testWalletDbs } from "../../support/fakeWalletDb"

const VERSION = "backend-contract"

const reopen = async () => {
  await walletStorage.flush()
  await closeWalletStore()
  await openWalletStore(VERSION, { persistent: true })
  return opfsBackend
}

// Each case opens an empty database; the fake's map ranges with the SQLite map's bounds.
backendContract(
  "opfsBackend",
  async () => {
    await closeWalletStore()
    testWalletDbs().stored.delete(VERSION)
    return reopen()
  },
  {
    reopen,
    failing: (on) => {
      testWalletDbs().onApply = on
        ? () => {
            throw new Error("disk full")
          }
        : undefined
    },
  },
)

describe("opfsBackend", () => {
  it("commits in call order with walletStorage's writes", async () => {
    const landed: (readonly WalletOp[])[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    testWalletDbs().onApply = async (_version, ops) => {
      if (ops.some(([key]) => key === "legacy/a")) await held
      landed.push(ops)
    }
    walletStorage.setItem("legacy/a", "1")
    const applied = opfsBackend.apply([["acct/x/1", "2"]])
    const after = walletStorage.commitItem("legacy/b", "3")
    await Promise.resolve()
    expect(landed).toEqual([])
    release()
    await Promise.all([applied, after])
    expect(landed).toEqual([[["legacy/a", "1"]], [["acct/x/1", "2"]], [["legacy/b", "3"]]])
    expect(await opfsBackend.get("acct/x/1")).toBe("2")
  })

  it("keeps the accounts' persistent stores out of walletStorage's copy", async () => {
    const key = "obsidion.ab12.acct/withdrawals/1"
    await closeWalletStore()
    testWalletDbs().stored.delete(VERSION)
    await reopen()
    await opfsBackend.apply([
      [key, "w"],
      ["obsidion.acct/requests/1", "r"],
    ])
    await walletStorage.commitItem("obsidion.ab12.contacts", "c")
    expect(walletStorage.getItem(key)).toBeNull()
    expect(walletStorage.keys()).toEqual(["obsidion.ab12.contacts"])
    await reopen()
    expect(walletStorage.getItem(key)).toBeNull()
    expect(walletStorage.keys()).toEqual(["obsidion.ab12.contacts"])
    expect(await opfsBackend.get(key)).toBe("w")
  })

  it("rejects while the wallet database is closed", async () => {
    await closeWalletStore()
    await expect(opfsBackend.get("a")).rejects.toThrow(/closed/)
    await expect(opfsBackend.apply([["a", "1"]])).rejects.toThrow(/closed/)
  })
})
