import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { getConfig } from "../../../../src/config/env"
import {
  acquireUpgradeLock,
  checkUpgradeLock,
  markCreatedHere,
  markNewAccountHere,
  recordRetiredSourceRead,
  releaseUpgradeLock,
  retiredSourceCandidate,
  retiredSourceSettled,
  upgradeLock,
  useUpgradeLock,
} from "../../../../src/features/migration/upgradeLock"
import { closeWalletStore, openWalletStore } from "../../../../src/platform/storage/walletStorage"
import { webStorage } from "../../../../src/platform/storage/WebStorageAdapter"
import { sandboxProfile } from "../../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../../support/fakeWalletDb"
import { seedBootConfig } from "../../../support/seedBootConfig"

const ACCOUNT = "0xabc"
const SOURCE = "0x" + "05".repeat(20)

beforeAll(seedBootConfig)

/** Fails the next save once `save` is called; reads see its writes until then. */
function failNextSave(error: Error): { save: () => void } {
  const held = { save: () => {} }
  testWalletDbs().onApply = async () => {
    testWalletDbs().onApply = undefined
    await new Promise<void>((resolve) => (held.save = resolve))
    throw error
  }
  return held
}

describe("the upgrade lock", () => {
  it("reads as held until its release is saved, and stays held when saving fails", async () => {
    await acquireUpgradeLock(ACCOUNT, 7n)
    const full = new Error("disk full")
    const held = failNextSave(full)

    const released = releaseUpgradeLock(ACCOUNT)
    await vi.waitFor(() => expect(testWalletDbs().onApply).toBeUndefined())
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })
    held.save()
    await expect(released).rejects.toBe(full)
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })

    await releaseUpgradeLock(ACCOUNT)
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "released" })
  })

  it("has a second take wait on the first one's save, so neither holds when it fails", async () => {
    const full = new Error("disk full")
    const held = failNextSave(full)

    const first = acquireUpgradeLock(ACCOUNT, 7n)
    const second = acquireUpgradeLock(ACCOUNT, 7n)
    await vi.waitFor(() => expect(testWalletDbs().onApply).toBeUndefined())
    held.save()
    await expect(first).rejects.toBe(full)
    await expect(second).rejects.toBe(full)
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "pending" })
  })

  it("stays held while a run the account saved here is unfinished, wherever its source is", async () => {
    const RUN = `metadata-migration/${getConfig().oxideProfile.portal.toLowerCase()}/${
      "0x" + "03".repeat(20)
    }/${ACCOUNT}`
    await webStorage.setItem("metadata-migration/runs", JSON.stringify([RUN]))
    await webStorage.setItem(RUN, JSON.stringify({ phase: "arriving" }))
    await acquireUpgradeLock(ACCOUNT, 7n)

    await expect(releaseUpgradeLock(ACCOUNT)).rejects.toThrow()
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })

    await webStorage.setItem(RUN, JSON.stringify({ phase: "done" }))
    await releaseUpgradeLock(ACCOUNT)
    expect(upgradeLock(ACCOUNT)).toEqual({ state: "released" })
  })

  it("keeps the figure the first start held", async () => {
    await acquireUpgradeLock(ACCOUNT, 7n)
    await acquireUpgradeLock(ACCOUNT, 9n)

    expect(upgradeLock(ACCOUNT)).toEqual({ state: "held", main: 7n })
  })

  it("stays unread until the account's runs are read", async () => {
    let read = () => false
    function Probe() {
      const { checked } = useUpgradeLock("0xdef")
      read = () => checked
      return null
    }
    const root = createRoot(document.createElement("div"))
    act(() => root.render(createElement(Probe)))
    await closeWalletStore()

    await act(async () => expect(checkUpgradeLock("0xdef")).rejects.toThrow())
    expect(read()).toBe(false)
    await openWalletStore(sandboxProfile().shared.rollupVersion, { persistent: false })
    await act(async () => checkUpgradeLock("0xdef"))
    expect(read()).toBe(true)
    act(() => root.unmount())
  })
})

describe("a source on another rollup", () => {
  const tip = (number: bigint) => ({ number, hash: `0x${number.toString(16)}` })
  const empty = (number: bigint, priorFinal: boolean) => ({
    empty: true as const,
    tip: tip(number),
    priorFinal,
  })

  it("settles only once the account is current here", async () => {
    await acquireUpgradeLock(ACCOUNT, 7n)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(100n, false))
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(200n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)

    await releaseUpgradeLock(ACCOUNT)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(300n, false))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(400n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(true)
    expect(retiredSourceSettled(ACCOUNT, "0x" + "06".repeat(20))).toBe(false)
  })

  it("keeps the block that closed its latest empty read until that block is final", async () => {
    await releaseUpgradeLock(ACCOUNT)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(100n, false))
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toEqual(tip(100n))
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(150n, false))
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toEqual(tip(150n))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)

    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(200n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(true)
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toBeUndefined()
  })

  it("starts over after a read that finds funds again", async () => {
    await releaseUpgradeLock(ACCOUNT)
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(100n, false))
    recordRetiredSourceRead(ACCOUNT, SOURCE, { empty: false })
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toBeUndefined()

    // No earlier empty read is held, so nothing can be final yet.
    recordRetiredSourceRead(ACCOUNT, SOURCE, empty(200n, true))
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
    expect(retiredSourceCandidate(ACCOUNT, SOURCE)).toEqual(tip(200n))
  })

  it("is settled for a new account made here", () => {
    markNewAccountHere(ACCOUNT)

    expect(upgradeLock(ACCOUNT)).toEqual({ state: "released" })
    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(true)
  })

  it("is not settled for an account a passkey rotation made here, which keeps its keys", () => {
    markCreatedHere(ACCOUNT)

    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
  })

  it("is not settled for an account that upgraded here, before any read", async () => {
    await releaseUpgradeLock(ACCOUNT)

    expect(retiredSourceSettled(ACCOUNT, SOURCE)).toBe(false)
  })
})
