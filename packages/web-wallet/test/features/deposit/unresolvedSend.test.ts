/**
 * The unresolved-send marker is wallet state: kept in the active rollup's wallet database, one per account, never in
 * `localStorage`, and read back after a reload. A hold or a removal resolves only once the database has it, a failed
 * write is reported as such, never as "no hold", and holds and removals run in call order.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Address } from "viem"
import { setActiveRollup } from "../../../src/platform/storage/rollupStorage"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"
import {
  UnresolvedSendHeldError,
  UnresolvedSendStorageError,
  clearUnresolvedSend,
  holdUnresolvedSend,
  readUnresolvedSend,
} from "../../../src/features/deposit/unresolvedSend"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"

const dbs = testWalletDbs()
const ROLLUP = "1821665230"
const ALICE = `0x${"aa".repeat(32)}`
const BOB = `0x${"bb".repeat(32)}`
const SIPA = `0x${"51".repeat(20)}` as Address
const OTHER_SIPA = `0x${"52".repeat(20)}` as Address
const send = { address: SIPA, at: 1_700_000_000_000 }
const KEY = `webwallet.deposit.unresolved-send.testnet.${ALICE}`

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => (resolve = res))
  return { promise, resolve }
}

/** Closes the store and opens `version` from its saved database, as a reload does. */
async function reload(version = ROLLUP) {
  await closeWalletStore()
  setActiveRollup(version)
  await openWalletStore(version, { persistent: true })
}

const saved = (version = ROLLUP) => dbs.db(version).state.get(KEY)
const failWrites = () => {
  dbs.onApply = () => {
    throw new Error("disk")
  }
}

beforeEach(() => reload())
afterEach(() => {
  dbs.onApply = undefined
  localStorage.clear()
  setActiveRollup(sandboxProfile().shared.rollupVersion)
})

describe("unresolved send marker", () => {
  it("belongs to one account", async () => {
    await holdUnresolvedSend("testnet", ALICE, send)
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "held", send })
    expect(readUnresolvedSend("testnet", BOB)).toEqual({ status: "none" })
    expect(readUnresolvedSend("testnet", ALICE.toUpperCase().replace("0X", "0x"))).toEqual({
      status: "held",
      send,
    })
    await clearUnresolvedSend("testnet", BOB)
    expect(readUnresolvedSend("testnet", ALICE).status).toBe("held")
  })

  it("is read back after a reload, and cleared for it too", async () => {
    await holdUnresolvedSend("testnet", ALICE, send)
    await reload()
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "held", send })
    await clearUnresolvedSend("testnet", ALICE)
    await reload()
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "none" })
    expect(saved()).toBeUndefined()
  })

  it("rejects a hold the database refuses, and keeps nothing", async () => {
    failWrites()
    await expect(holdUnresolvedSend("testnet", ALICE, send)).rejects.toBeInstanceOf(
      UnresolvedSendStorageError,
    )
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "none" })
    expect(saved()).toBeUndefined()
  })

  it("rejects a hold, and reads the state as unreadable, while the store is closed", async () => {
    await closeWalletStore()
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "unreadable" })
    await expect(holdUnresolvedSend("testnet", ALICE, send)).rejects.toBeInstanceOf(
      UnresolvedSendHeldError,
    )
    await expect(clearUnresolvedSend("testnet", ALICE)).rejects.toBeInstanceOf(
      UnresolvedSendStorageError,
    )
  })

  it("reports an unreadable or foreign entry as unreadable, not as no hold", async () => {
    await walletStorage.commitItem(KEY, JSON.stringify({ address: 7 }))
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "unreadable" })
    await walletStorage.commitItem(KEY, "{not json")
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "unreadable" })
  })

  it("never replaces another send's hold", async () => {
    const first = { ...send, submission: "s1" }
    await holdUnresolvedSend("testnet", ALICE, first)
    const again = { ...first, at: send.at + 1 }
    await holdUnresolvedSend("testnet", ALICE, again)
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "held", send: again })
    for (const other of [{ ...send, submission: "s2" }, send]) {
      await expect(holdUnresolvedSend("testnet", ALICE, other)).rejects.toBeInstanceOf(
        UnresolvedSendHeldError,
      )
    }
    expect(JSON.parse(saved()!)).toEqual(again)
    // A marker saved without a submission is another send's too.
    await clearUnresolvedSend("testnet", ALICE)
    await holdUnresolvedSend("testnet", ALICE, send)
    await expect(holdUnresolvedSend("testnet", ALICE, first)).rejects.toBeInstanceOf(
      UnresolvedSendHeldError,
    )
  })

  it("never replaces a marker it cannot read", async () => {
    await walletStorage.commitItem(KEY, "{not json")
    await expect(
      holdUnresolvedSend("testnet", ALICE, { ...send, submission: "s1" }),
    ).rejects.toBeInstanceOf(UnresolvedSendHeldError)
    expect(saved()).toBe("{not json")
  })

  it("checks a hold against one still being saved, not against the value before it", async () => {
    const gate = deferred()
    dbs.onApply = () => gate.promise
    const first = holdUnresolvedSend("testnet", ALICE, { ...send, submission: "s1" })
    const second = holdUnresolvedSend("testnet", ALICE, { ...send, submission: "s2" })
    gate.resolve()
    await first
    await expect(second).rejects.toBeInstanceOf(UnresolvedSendHeldError)
    expect(JSON.parse(saved()!).submission).toBe("s1")
  })

  it("lets a hold follow a removal still being saved, and keeps the hold when that removal fails", async () => {
    await holdUnresolvedSend("testnet", ALICE, { ...send, submission: "s1" })
    const gate = deferred()
    dbs.onApply = () => gate.promise
    const cleared = clearUnresolvedSend("testnet", ALICE)
    const held = holdUnresolvedSend("testnet", ALICE, { ...send, submission: "s2" })
    gate.resolve()
    await cleared
    await held
    expect(JSON.parse(saved()!).submission).toBe("s2")

    let call = 0
    dbs.onApply = () => {
      if (call++ === 0) throw new Error("disk")
    }
    const failed = clearUnresolvedSend("testnet", ALICE)
    const blocked = holdUnresolvedSend("testnet", ALICE, { ...send, submission: "s3" })
    await expect(failed).rejects.toBeInstanceOf(UnresolvedSendStorageError)
    await expect(blocked).rejects.toBeInstanceOf(UnresolvedSendHeldError)
    expect(JSON.parse(saved()!).submission).toBe("s2")
  })

  it("resolves a removal only once the database has it, and reports one that failed", async () => {
    await holdUnresolvedSend("testnet", ALICE, send)
    failWrites()
    await expect(clearUnresolvedSend("testnet", ALICE)).rejects.toBeInstanceOf(
      UnresolvedSendStorageError,
    )
    expect(readUnresolvedSend("testnet", ALICE).status).toBe("held")
    expect(saved()).toBeDefined()

    const gate = deferred()
    dbs.onApply = () => gate.promise
    let done = false
    const clear = clearUnresolvedSend("testnet", ALICE).then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    expect(readUnresolvedSend("testnet", ALICE).status).toBe("held")
    gate.resolve()
    await clear
    expect(saved()).toBeUndefined()
  })

  it("removes only the named address's marker when given one", async () => {
    await holdUnresolvedSend("testnet", ALICE, send)
    await clearUnresolvedSend("testnet", ALICE, { address: OTHER_SIPA })
    expect(readUnresolvedSend("testnet", ALICE).status).toBe("held")
    await clearUnresolvedSend("testnet", ALICE, {
      address: SIPA.toUpperCase().replace("0X", "0x") as Address,
    })
    expect(saved()).toBeUndefined()
  })

  it("removes only the named submission's marker, once a hold still being saved lands", async () => {
    await holdUnresolvedSend("testnet", ALICE, send)
    await clearUnresolvedSend("testnet", ALICE, { submission: "s1" })
    expect(JSON.parse(saved()!)).toEqual(send)
    await clearUnresolvedSend("testnet", ALICE)

    const gate = deferred()
    dbs.onApply = () => gate.promise
    const held = holdUnresolvedSend("testnet", ALICE, { ...send, submission: "s1" })
    const cleared = clearUnresolvedSend("testnet", ALICE, { submission: "s1" })
    gate.resolve()
    await held
    await cleared
    expect(saved()).toBeUndefined()
  })

  it("saves no hold while the wallet database lasts only as long as the page", async () => {
    await closeWalletStore()
    await openWalletStore(ROLLUP, { persistent: false })
    await expect(holdUnresolvedSend("testnet", ALICE, send)).rejects.toBeInstanceOf(
      UnresolvedSendStorageError,
    )
    expect(readUnresolvedSend("testnet", ALICE)).toEqual({ status: "none" })
  })
})
