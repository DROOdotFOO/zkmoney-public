/**
 * Deposit addresses through the broadcast ledger: the real gateway, ledger, scheduler and wallet
 * storage, with fakes only at the edges a test cannot run (the stealth derivation, the unlock, the
 * sponsorship and the prover).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BroadcastAbandoned, BroadcastDeferred, OperationStore } from "@obsidion/front-core"
import type { Address } from "viem"
import { L2_ADDRESS } from "../../support/registrationFixtures"
import { PLAN, signedRecord } from "../../support/backupAdd"

const h = vi.hoisted(() => ({
  nonce: 0,
  derived: [] as string[],
  sent: [] as string[],
  landed: new Set<string>(),
  sponsor: undefined as Error | undefined,
}))

const PINNED = {
  rollupVersion: "1",
  portal: "0x00000000000000000000000000000000000000a0",
  forwardingTable: "0x00000000000000000000000000000000000000fb",
  ensDomain: "zk.money",
  l2Token: `0x${"01".repeat(32)}`,
}
const TUPLE = { ...PINNED }
const DEPLOYMENT = `1:${PINNED.portal}`
/** The pin moves, in this wallet database, to another deployment that keeps the forwarding table. */
const roll = () =>
  Object.assign(TUPLE, { rollupVersion: "2", portal: "0x00000000000000000000000000000000000000b0" })
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => TUPLE,
  l1PublicClient: () => ({}),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  chainEpochDay: async () => Math.floor(Date.now() / 86_400_000),
  ContractService: { getInstance: () => ({}) },
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => {
    if (h.sponsor) throw h.sponsor
    return {}
  },
  noteSubscribed: () => {},
}))
vi.mock("../../../src/features/broadcasts/broadcastState", () => ({
  broadcastState: async () => "included",
}))

const {
  appendToSipaPool,
  getSipaDepositGateway,
  readCachedSipa,
  readSipaPool,
  resetSipaDepositGatewayForTests,
} = await import("../../../src/features/deposit/sipaGateway")
const { getBroadcastLedger, resetBroadcastsForTests, startBroadcasts } = await import(
  "../../../src/features/broadcasts/broadcasts"
)
const { RegistrationPendingError } = await import("../../../src/features/onboarding/registrationRail")
const { AddressesPublishingError } = await import("../../../src/features/deposit/addressesPublishing")
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
const { walletStorage } = await import("../../../src/platform/storage/walletStorage")
const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
const { SIPADepositStore } = await import("@obsidion/front-core")
const { WAITING_FOR_BALANCE_MOVE } = await import("../../../src/features/broadcasts/broadcasts")
const { getBackupRotationStore, resetBackupRotationStoreForTests } = await import(
  "../../../src/features/backupPasskey/backupRotationStore"
)

const wallet = { networkId: "0xnet" } as never
const address = (n: number) => `0x${(0xd00 + n).toString(16).padStart(40, "0")}` as Address
const CACHE_KEY = `webwallet.sipa.address.sandbox.${TUPLE.forwardingTable}.${L2_ADDRESS}.alice`

/** The gateway with its derivation, unlock and prover replaced at their boundaries. */
function gateway() {
  const gw = getSipaDepositGateway() as never as Record<string, (...args: never[]) => unknown>
  vi.spyOn(gw, "unlockedKeys").mockImplementation(
    async () => ({ account: { getAddress: () => L2_ADDRESS }, msk: {} } as never),
  )
  vi.spyOn(gw, "nextNonce").mockImplementation(async () => h.nonce++ as never)
  vi.spyOn(gw, "deriveSipa").mockImplementation(async (...args: never[]) => {
    const nonce = args[4] as unknown as number
    h.derived.push(address(nonce))
    return { address: address(nonce), nonce } as never
  })
  // A broadcast publishing an address again lands only through its own send.
  vi.spyOn(gw, "broadcastLanded").mockImplementation(
    async (...args: never[]) =>
      (h.landed.has(String(args[1]).toLowerCase()) && args[2] === undefined) as never,
  )
  vi.spyOn(gw, "broadcastSipa").mockImplementation(async (...args: never[]) => {
    const entry = args[4] as unknown as { address: string }
    h.sent.push(entry.address.toLowerCase())
    return `0x${h.sent.length.toString(16).padStart(64, "0")}` as never
  })
  return getSipaDepositGateway()
}

const refill = (gw: ReturnType<typeof gateway>) =>
  (gw as never as { refillPool: (...a: unknown[]) => Promise<void> }).refillPool(
    wallet,
    {},
    TUPLE,
    CACHE_KEY,
  )

let stop: (() => void) | undefined
const run = (gw: ReturnType<typeof gateway>) =>
  (stop = startBroadcasts(wallet, { slot: gw.slotExecutor(wallet) }))

beforeEach(async () => {
  localStorage.clear()
  resetBroadcastsForTests()
  resetSipaDepositGatewayForTests()
  resetBackupRotationStoreForTests()
  OperationStore.reset()
  Object.assign(h, { nonce: 0, derived: [], sent: [], landed: new Set(), sponsor: undefined })
  Object.assign(TUPLE, PINNED)
  await saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.restoreAllMocks()
})

describe("deposit addresses on the broadcast ledger", () => {
  it("owes one pool fill at a time, and the landed fill joins the pool", async () => {
    const gw = gateway()
    await refill(gw)
    await refill(gw)
    expect(h.derived).toEqual([address(0)])
    run(gw)
    await vi.waitFor(() =>
      expect(readSipaPool(CACHE_KEY, DEPLOYMENT).map((e) => e.address)).toEqual([address(0)]),
    )
    expect(h.sent).toEqual([address(0).toLowerCase()])
  })

  it("pools a fill once when its landing is reported again", async () => {
    const gw = gateway()
    await refill(gw)
    const job = getBroadcastLedger().get(address(0))!
    const executor = gw.slotExecutor(wallet)
    await executor.onLanded!(job)
    await executor.onLanded!(job)
    expect(readSipaPool(CACHE_KEY, DEPLOYMENT).map((e) => e.address)).toEqual([address(0)])
    await expect(gw.depositAddress(wallet, {} as never, "alice")).resolves.toMatchObject({
      address: address(0),
      source: "pool",
    })
  })

  it("hands the user a pool fill still being proven instead of deriving a second address", async () => {
    const gw = gateway()
    await refill(gw)
    const shown = await gw.depositAddress(wallet, {} as never, "alice")
    expect(shown).toMatchObject({ address: address(0), source: "filling" })
    expect(h.derived).toEqual([address(0)])
    expect(getBroadcastLedger().get(address(0))).toMatchObject({ kind: "deposit" })

    run(gw)
    await shown.publish!()
    expect(h.sent).toEqual([address(0).toLowerCase()])
    // Shown, so it never reaches the pool; its slot reads published.
    expect(readSipaPool(CACHE_KEY, DEPLOYMENT)).toEqual([])
    expect(readCachedSipa(CACHE_KEY)).toMatchObject({ address: address(0), published: true })
  })

  it("gives each view an address nobody was shown, and keeps the previous one owed", async () => {
    const gw = gateway()
    const first = await gw.depositAddress(wallet, {} as never, "alice")
    const second = await gw.depositAddress(wallet, {} as never, "alice")
    expect(second.address).not.toBe(first.address)
    expect(first.source).toBe("derived")
    // The first view never published it; the ledger still finishes it.
    expect(getBroadcastLedger().get(first.address)).toMatchObject({
      kind: "deposit",
      state: "queued",
    })
    expect(getBroadcastLedger().get(first.address)?.shownAt).toBeDefined()
  })

  it("hands out a new address after a table repoint, and still publishes the earlier table's", async () => {
    const gw = gateway()
    const before = await gw.depositAddress(wallet, {} as never, "alice")
    await before.owe!()
    const table = TUPLE.forwardingTable
    TUPLE.forwardingTable = "0x00000000000000000000000000000000000000fc"
    try {
      const after = await gw.depositAddress(wallet, {} as never, "alice")
      expect(after.address).not.toBe(before.address)
      expect(readCachedSipa(CACHE_KEY.replace(table, TUPLE.forwardingTable))).toMatchObject({
        address: after.address,
      })
      expect(readCachedSipa(CACHE_KEY)).toMatchObject({ address: before.address })
      await after.owe!()
      run(gw)
      await vi.waitFor(() => expect(h.sent).toHaveLength(2))
      expect(h.sent).toContain(before.address.toLowerCase())
    } finally {
      TUPLE.forwardingTable = table
    }
  })

  it("derives no fresh address past the publishing limit, but still hands out a pool fill", async () => {
    const gw = gateway()
    for (let i = 0; i < 2; i++) await (await gw.depositAddress(wallet, {} as never, "alice")).owe!()
    await expect(
      gw.depositAddress(wallet, {} as never, "alice", { publishingLimit: 2 }),
    ).rejects.toBeInstanceOf(AddressesPublishingError)
    await refill(gw)
    const pooled = h.derived.at(-1)
    const shown = await gw.depositAddress(wallet, {} as never, "alice", { publishingLimit: 2 })
    expect(shown.address).toBe(pooled)
  })

  it("leaves broadcasts that keep failing out of the publishing limit", async () => {
    const gw = gateway()
    for (let i = 0; i < 2; i++) {
      const shown = await gw.depositAddress(wallet, {} as never, "alice")
      await shown.owe!()
      for (let f = 0; f < 2; f++) await getBroadcastLedger().markFailed(shown.address, "offline")
    }
    await expect(
      gw.depositAddress(wallet, {} as never, "alice", { publishingLimit: 2 }),
    ).resolves.toMatchObject({ address: address(2) })
  })

  it("never hands one in-flight pool fill to two views asking at once", async () => {
    const gw = gateway()
    await refill(gw)
    const [a, b] = await Promise.all([
      gw.depositAddress(wallet, {} as never, "alice"),
      gw.depositAddress(wallet, {} as never, "alice"),
    ])
    expect(a.address).not.toBe(b.address)
  })

  it("pools an in-flight fill once it lands when handing it out failed", async () => {
    const gw = gateway()
    await refill(gw)
    vi.spyOn(getBroadcastLedger(), "markShown").mockRejectedValueOnce(new Error("disk"))
    await expect(gw.depositAddress(wallet, {} as never, "alice")).rejects.toThrow("disk")
    await gw.slotExecutor(wallet).onLanded!(getBroadcastLedger().get(address(0))!)
    expect(readSipaPool(CACHE_KEY, DEPLOYMENT).map((e) => e.address)).toEqual([address(0)])
  })

  it("keeps a fill a view took out of the pool, even when it lands before the view records it", async () => {
    const gw = gateway()
    await refill(gw)
    const job = getBroadcastLedger().get(address(0))!
    const recording = vi
      .spyOn(getBroadcastLedger(), "markShown")
      .mockImplementation(() => new Promise(() => {}))
    void gw.depositAddress(wallet, {} as never, "alice")
    await vi.waitFor(() => expect(recording).toHaveBeenCalled())
    await gw.slotExecutor(wallet).onLanded!(job)
    expect(readSipaPool(CACHE_KEY, DEPLOYMENT)).toEqual([])
  })

  it("hands out no pooled address of a retired deployment, even under the same table", async () => {
    const gw = gateway()
    await refill(gw)
    run(gw)
    await vi.waitFor(() => expect(readSipaPool(CACHE_KEY, DEPLOYMENT)).toHaveLength(1))
    roll()
    const shown = await gw.depositAddress(wallet, {} as never, "alice")
    expect(shown).toMatchObject({ source: "derived" })
    expect(shown.address).not.toBe(address(0))
  })

  it("drains a retired deployment only once registered on the new rollup", async () => {
    const gw = gateway()
    await refill(gw)
    const retiredTable = CACHE_KEY.replace(PINNED.forwardingTable, "0xretiredtable")
    appendToSipaPool(retiredTable, {
      address: address(9),
      day: 7,
      nonce: 9,
      published: true,
      deployment: DEPLOYMENT,
    })
    roll()
    const job = getBroadcastLedger().get(address(0))!
    const attempt = { onTxHash: async () => {} }

    h.sponsor = new RegistrationPendingError({ pending: "message" } as never)
    await expect(gw.slotExecutor(wallet).send(job, attempt)).rejects.toBeInstanceOf(
      BroadcastDeferred,
    )
    expect(walletStorage.getItem(`${retiredTable}.pool`)).not.toBeNull()

    h.sponsor = undefined
    await expect(gw.slotExecutor(wallet).send(job, attempt)).rejects.toBeInstanceOf(
      BroadcastAbandoned,
    )
    expect(walletStorage.getItem(`${retiredTable}.pool`)).toBeNull()
    expect(h.sent).toEqual([])
  })

  it("waits out a backup passkey's balance move, which spends the note the broadcast pays with", async () => {
    const gw = gateway()
    await refill(gw)
    const job = getBroadcastLedger().get(address(0))!
    const attempt = { onTxHash: async () => {} }
    const plan = { ...PLAN, address: L2_ADDRESS }
    await getBackupRotationStore().put(signedRecord({ phase: "rerooted", plan }))
    const waiting = gw.slotExecutor(wallet).send(job, attempt)
    await expect(waiting).rejects.toBeInstanceOf(BroadcastDeferred)
    await expect(waiting).rejects.toThrow(WAITING_FOR_BALANCE_MOVE)
    expect(h.sent).toEqual([])

    await getBackupRotationStore().put(signedRecord({ phase: "done", plan }))
    await gw.slotExecutor(wallet).send(job, attempt)
    expect(h.sent).toEqual([address(0)])
  })

  it("does not pool a fill that lands after its deployment retired", async () => {
    const gw = gateway()
    await refill(gw)
    roll()
    await gw.slotExecutor(wallet).onLanded!(getBroadcastLedger().get(address(0))!)
    expect(readSipaPool(CACHE_KEY, DEPLOYMENT)).toEqual([])
    expect(readSipaPool(CACHE_KEY, `2:${TUPLE.portal}`)).toEqual([])
  })

  it("still publishes an address shown before the roll", async () => {
    const gw = gateway()
    await refill(gw)
    const shown = await gw.depositAddress(wallet, {} as never, "alice")
    expect(shown).toMatchObject({ address: address(0), source: "filling" })
    // The hand-out's refill owes its fill before the pin moves, so it is the retired deployment's.
    await vi.waitFor(() => expect(h.derived).toHaveLength(2))
    roll()
    run(gw)
    await vi.waitFor(() => expect(h.sent).toEqual([address(0).toLowerCase()]))
  })

  it("rejects publish with the registration's wait while no rail can pay, keeping it owed", async () => {
    h.sponsor = new RegistrationPendingError({ pending: "message" } as never)
    const gw = gateway()
    const fresh = await gw.depositAddress(wallet, {} as never, "alice")
    run(gw)
    await expect(fresh.publish!()).rejects.toBeInstanceOf(RegistrationPendingError)
    expect(getBroadcastLedger().get(fresh.address)).toMatchObject({ state: "queued", failures: 0 })
    expect(h.sent).toEqual([])
  })

  it("rejects publish with the attempt's error, and the ledger retries it", async () => {
    const gw = gateway()
    vi.spyOn(gw as never as Record<string, () => unknown>, "broadcastSipa").mockRejectedValueOnce(
      new Error("proving died") as never,
    )
    const fresh = await gw.depositAddress(wallet, {} as never, "alice")
    run(gw)
    await expect(fresh.publish!()).rejects.toThrow("proving died")
    expect(getBroadcastLedger().get(fresh.address)).toMatchObject({ state: "queued", failures: 1 })
  })

  it("does not prove an address whose broadcast already landed, and marks its slot", async () => {
    const gw = gateway()
    const fresh = await gw.depositAddress(wallet, {} as never, "alice")
    h.landed.add(fresh.address.toLowerCase())
    run(gw)
    await fresh.publish!()
    expect(h.sent).toEqual([])
    expect(readCachedSipa(CACHE_KEY)?.published).toBe(true)
  })

  it("proves an address again when it is paid after its broadcast landed", async () => {
    const gw = gateway()
    const fresh = await gw.depositAddress(wallet, {} as never, "alice")
    const key = fresh.address.toLowerCase()
    run(gw)
    await fresh.publish!()
    h.landed.add(key)
    expect(await getBroadcastLedger().republish(fresh.address, 40)).toBe(true)
    await vi.waitFor(() => expect(getBroadcastLedger().get(key)?.state).toBe("landed"))
    expect(h.sent).toEqual([key, key])
  })

  it("proves an address someone already paid before an older unpaid one", async () => {
    const gw = gateway()
    const unpaid = await gw.depositAddress(wallet, {} as never, "alice")
    const paid = await gw.depositAddress(wallet, {} as never, "bob")
    void unpaid.publish!().catch(() => {})
    void paid.publish!().catch(() => {})
    const store = SIPADepositStore.get(webStorage)
    await store.load()
    await store.upsert(paid.address, { phase: "resolved", amount: "5" }, {
      networkId: "0xnet",
      recipientL2Address: L2_ADDRESS,
      messageSecret: "0x01",
      recipientHash: "0x02",
      recoveryAddress: "",
      l1ChainId: 31337,
      tokenAddress: TUPLE.portal,
      amount: "5",
      tokenSymbol: "DAI",
      startTime: 1,
    } as never)
    await (gw as never as { markOwedFunded: () => Promise<void> }).markOwedFunded()
    expect(getBroadcastLedger().get(paid.address)?.fundedAt).toBeDefined()
    run(gw)
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    expect(h.sent).toEqual([paid.address.toLowerCase(), unpaid.address.toLowerCase()])
  })

  it("owes the ledger a slot an earlier version keyed by the pinned portal", async () => {
    walletStorage.setItem(
      `webwallet.sipa.address.sandbox.${TUPLE.portal}.${L2_ADDRESS}.alice`,
      JSON.stringify({ address: address(7), day: 7, nonce: 7, published: false }),
    )
    const gw = gateway()
    await refill(gw)
    expect(getBroadcastLedger().get(address(7))).toMatchObject({ kind: "deposit", state: "queued" })
  })

  it("owes the ledger a slot an earlier version left unpublished, and lets the chain decide a sent one", async () => {
    walletStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ address: address(5), day: 7, nonce: 5, published: false }),
    )
    walletStorage.setItem(
      `${CACHE_KEY.slice(0, -"alice".length)}bob`,
      JSON.stringify({
        address: address(6),
        day: 7,
        nonce: 6,
        published: false,
        broadcastTxHash: `0x${"ee".repeat(32)}`,
      }),
    )
    const gw = gateway()
    await refill(gw)
    expect(getBroadcastLedger().get(address(5))).toMatchObject({ kind: "deposit", state: "queued" })
    expect(getBroadcastLedger().get(address(6))).toMatchObject({ state: "sent" })
    run(gw)
    await vi.waitFor(() => expect(getBroadcastLedger().get(address(5))?.state).toBe("landed"))
    await vi.waitFor(() => expect(getBroadcastLedger().get(address(6))?.state).toBe("landed"))
    // The sent one was decided from its receipt, never proven again.
    expect(h.sent).not.toContain(address(6).toLowerCase())
  })
})
