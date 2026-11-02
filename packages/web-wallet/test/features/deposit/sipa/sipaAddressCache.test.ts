/**
 * The SIPA address cache decides which L1 address a sender is told to fund, and a wrong answer is
 * only visible once someone has already paid an address nobody sweeps. These are the three pieces
 * that carry that decision: what a stored entry is worth today, whether a stored entry is
 * trustworthy at all, and whether two derivations can be mistaken for one another.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { setActiveRollup } from "../../../../src/platform/storage/rollupStorage"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../../support/fakeWalletDb"
import type { Address } from "viem"
import {
  appendToSipaPool,
  drainRetiredSipaPools,
  nextSelfSipaNonce,
  readCachedSipa,
  readSipaPool,
  readUnpublishedSlots,
  takeFromSipaPool,
  writeCachedSipa,
} from "../../../../src/features/deposit/sipaGateway"

const KEY = "webwallet.sipa.address.sandbox.0xpool.0xacct.alice"
const ADDR = `0x${"ab".repeat(20)}` as Address
const OTHER = `0x${"cd".repeat(20)}` as Address
const DAY = Math.floor(Date.now() / 86_400_000)

const entry = (over: Partial<Parameters<typeof writeCachedSipa>[1]> = {}) => ({
  address: ADDR,
  day: DAY,
  nonce: 4242,
  published: false,
  ...over,
})
const DEPLOYMENT = "1:0xportal"
const pooled = (over: Partial<Parameters<typeof writeCachedSipa>[1]> = {}) =>
  entry({ deployment: DEPLOYMENT, ...over }) as ReturnType<typeof entry> & { deployment: string }

describe("readCachedSipa", () => {
  beforeEach(() => localStorage.clear())

  // The nonce regenerates the message secret. Without it the publish step derives a DIFFERENT
  // address than the one already displayed, and marks the displayed one published anyway.
  it.each([
    ["no nonce", JSON.stringify({ address: ADDR, day: DAY, published: false })],
    ["a non-integer nonce", JSON.stringify(entry({ nonce: 1.5 }))],
    ["a non-integer day", JSON.stringify(entry({ day: "20662" as unknown as number }))],
    ["a non-boolean published flag", JSON.stringify(entry({ published: 1 as unknown as boolean }))],
    ["a missing address", JSON.stringify({ day: DAY, nonce: 4242, published: true })],
    ["corrupt JSON", "{not json"],
  ])("rejects an entry with %s", (_, stored) => {
    walletStorage.setItem(KEY, stored)
    expect(readCachedSipa(KEY)).toBeNull()
  })
})

describe("sipa pool", () => {
  beforeEach(() => localStorage.clear())

  it("drops malformed and unbroadcast entries instead of failing the read", () => {
    // Pool membership means broadcast: an unpublished entry is not sweepable, and handing one out
    // as if it were invites a deposit nobody sweeps. A malformed one routes funds wrong.
    walletStorage.setItem(
      `${KEY}.pool`,
      JSON.stringify([
        pooled({ nonce: 1, published: true }),
        pooled({ nonce: 2, published: false }),
        { address: ADDR, day: DAY, published: true, deployment: DEPLOYMENT },
      ]),
    )
    expect(readSipaPool(KEY, DEPLOYMENT).map((e) => e.nonce)).toEqual([1])
    walletStorage.setItem(`${KEY}.pool`, "{not json")
    expect(readSipaPool(KEY, DEPLOYMENT)).toEqual([])
  })

  it("drops an entry older than the relayer keeps its broadcast", () => {
    appendToSipaPool(KEY, pooled({ nonce: 1, day: DAY - 14, published: true }))
    appendToSipaPool(KEY, pooled({ nonce: 2, day: DAY - 13, address: OTHER, published: true }))
    expect(readSipaPool(KEY, DEPLOYMENT).map((e) => e.nonce)).toEqual([2])
  })

  it("take pops oldest-first into the slot and removes what it hands out", async () => {
    appendToSipaPool(KEY, pooled({ nonce: 1, published: true }))
    appendToSipaPool(KEY, pooled({ nonce: 2, address: OTHER, published: true }))
    expect((await takeFromSipaPool(KEY, DEPLOYMENT))?.nonce).toBe(1)
    expect(readCachedSipa(KEY)?.nonce).toBe(1)
    // The popped one is gone — a second take must never hand the same address out twice.
    expect((await takeFromSipaPool(KEY, DEPLOYMENT))?.nonce).toBe(2)
    expect(readCachedSipa(KEY)?.nonce).toBe(2)
    expect(await takeFromSipaPool(KEY, DEPLOYMENT)).toBeNull()
  })

  it("take with an age bound skips older entries and leaves them pooled", async () => {
    appendToSipaPool(KEY, pooled({ nonce: 1, day: DAY - 5, published: true }))
    appendToSipaPool(KEY, pooled({ nonce: 2, address: OTHER, published: true }))
    expect((await takeFromSipaPool(KEY, DEPLOYMENT, 2 * 86_400_000))?.nonce).toBe(2)
    expect(await takeFromSipaPool(KEY, DEPLOYMENT, 2 * 86_400_000)).toBeNull()
    expect(readSipaPool(KEY, DEPLOYMENT).map((e) => e.nonce)).toEqual([1])
  })

  it("hands out no address when its move from the pool to the slot is not saved", async () => {
    appendToSipaPool(KEY, pooled({ nonce: 1, published: true }))
    await walletStorage.flush()
    testWalletDbs().onApply = () => {
      throw new Error("disk")
    }
    await expect(takeFromSipaPool(KEY, DEPLOYMENT)).rejects.toThrow("disk")
    testWalletDbs().onApply = undefined
    // Neither side moved: the pool keeps the entry and the slot stays empty.
    expect(readSipaPool(KEY, DEPLOYMENT).map((e) => e.nonce)).toEqual([1])
    expect(readCachedSipa(KEY)).toBeNull()
  })
})

describe("drainRetiredSipaPools", () => {
  const PREFIX = "webwallet.sipa.address.sandbox."
  beforeEach(() => localStorage.clear())

  it("drops this account's pooled entries of every other deployment, whichever table keyed them", async () => {
    const oldTable = `${PREFIX}0xoldtable.0xacct.alice`
    const newTable = `${PREFIX}0xnewtable.0xacct.alice`
    appendToSipaPool(oldTable, pooled({ nonce: 1, published: true, deployment: "1:0xretired" }))
    walletStorage.setItem(
      `${newTable}.pool`,
      JSON.stringify([
        pooled({ nonce: 2, published: true, deployment: "1:0xretired" }),
        pooled({ nonce: 3, address: OTHER, published: true }),
      ]),
    )
    await drainRetiredSipaPools("sandbox", "0xacct", DEPLOYMENT)
    expect(walletStorage.getItem(`${oldTable}.pool`)).toBeNull()
    expect(
      JSON.parse(walletStorage.getItem(`${newTable}.pool`)!).map((e: { nonce: number }) => e.nonce),
    ).toEqual([3])
  })

  it("drains the account's pools that another rollup's database kept", async () => {
    const pool = `${PREFIX}0xtable.0xacct.alice.pool`
    const othersPool = `${PREFIX}0xtable.0xother.alice.pool`
    const retired = testWalletDbs().db("111").state
    retired.set(pool, JSON.stringify([pooled({ published: true, deployment: "111:0xold" })]))
    retired.set(othersPool, "[]")
    await closeWalletStore()
    setActiveRollup("222")
    try {
      await openWalletStore("222", { persistent: true })
      await drainRetiredSipaPools("sandbox", "0xacct", "222:0xnew")
      expect(retired.has(pool)).toBe(false)
      expect(retired.has(othersPool)).toBe(true)
    } finally {
      setActiveRollup(sandboxProfile().shared.rollupVersion)
    }
  })

  it("leaves slots, other accounts and other networks alone", async () => {
    // A tag named "pool" is a slot, not a pool.
    writeCachedSipa(`${PREFIX}0xtable.0xacct.pool`, entry({ published: true }))
    const other = `${PREFIX}0xtable.0xother.alice`
    const testnet = "webwallet.sipa.address.testnet.0xtable.0xacct.alice"
    appendToSipaPool(other, pooled({ published: true, deployment: "1:0xretired" }))
    appendToSipaPool(testnet, pooled({ published: true, deployment: "1:0xretired" }))
    await drainRetiredSipaPools("sandbox", "0xacct", DEPLOYMENT)
    expect(readCachedSipa(`${PREFIX}0xtable.0xacct.pool`)).toMatchObject({ published: true })
    expect(readSipaPool(other, "1:0xretired")).toHaveLength(1)
    expect(readSipaPool(testnet, "1:0xretired")).toHaveLength(1)
  })
})

describe("nextSelfSipaNonce", () => {
  it("refuses a nonce whose reservation is not saved", async () => {
    testWalletDbs().onApply = () => {
      throw new Error("disk")
    }
    await expect(nextSelfSipaNonce("scope", DAY)).rejects.toThrow("disk")
    testWalletDbs().onApply = undefined
    expect(await nextSelfSipaNonce("scope", DAY)).toBe(999_999)
  })

  beforeEach(() => localStorage.clear())

  it("restarts at slot 0 when the day rolls and keeps scopes apart", async () => {
    await nextSelfSipaNonce("scope", DAY)
    expect(await nextSelfSipaNonce("scope", DAY + 1)).toBe(999_999)
    expect(await nextSelfSipaNonce("other", DAY + 1)).toBe(999_999)
  })

  it("takes the chain floor when it is ahead of the local counter, and vice versa", async () => {
    expect(await nextSelfSipaNonce("scope", DAY, 3)).toBe(999_996)
    expect(await nextSelfSipaNonce("scope", DAY, 1)).toBe(999_995)
    walletStorage.setItem("scope.slot", "{nope")
    expect(await nextSelfSipaNonce("scope", DAY, 2)).toBe(999_997)
  })
})

describe("readUnpublishedSlots", () => {
  const PREFIX = "webwallet.sipa.address.sandbox.0xpool.0xacct."
  beforeEach(() => localStorage.clear())

  it("finds every tag's unpublished slot under the prefix and nothing else", () => {
    writeCachedSipa(`${PREFIX}alice`, entry())
    writeCachedSipa(`${PREFIX}bob`, entry({ nonce: 7 }))
    // A tag literally named "pool" is a slot; only the `.pool` suffix marks a pool.
    writeCachedSipa(`${PREFIX}pool`, entry({ nonce: 3 }))
    writeCachedSipa(`${PREFIX}carol`, entry({ published: true }))
    appendToSipaPool(`${PREFIX}alice`, pooled({ published: true, nonce: 9 }))
    writeCachedSipa("webwallet.sipa.address.sandbox.0xpool.0xother.alice", entry())
    localStorage.setItem(`${PREFIX}mallory`, "{not json")

    const slots = readUnpublishedSlots(PREFIX).sort((a, b) => a.key.localeCompare(b.key))
    expect(slots.map((s) => s.key)).toEqual([`${PREFIX}alice`, `${PREFIX}bob`, `${PREFIX}pool`])
    expect(slots.map((s) => s.entry.nonce)).toEqual([4242, 7, 3])
  })
})
