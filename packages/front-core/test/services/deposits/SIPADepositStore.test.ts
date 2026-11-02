import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hash } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import {
  SIPA_DEPOSIT_RECORD_VERSION,
  SIPADepositStore,
  isUnfundedSipaDeposit,
  type SIPADepositPhase,
  type SIPADepositFields,
  type SIPADepositRecord,
} from "../../../src/core/services/deposits/SIPADepositStore"

const SIPA_ADDR = "0xAbCdEf0123456789abcdef0123456789abcdef01" as Address
const RECIPIENT = "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456"

function makeFallback(): SIPADepositFields {
  return {
    networkId: "0xnet",
    recipientL2Address: RECIPIENT,
    messageSecret: "0x" + "11".repeat(32),
    recipientHash: "0x" + "22".repeat(32),
    recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
    l1ChainId: 11155111,
    amount: "12.5",
    tokenSymbol: "DAI",
    startTime: 1000,
  }
}

function freshStore(): SIPADepositStore {
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  return SIPADepositStore.get(new InMemoryStorageAdapter())
}

describe("SIPADepositStore", () => {
  let store: SIPADepositStore

  beforeEach(() => {
    store = freshStore()
  })

  it("creates via fallback, keys lowercased, and reads back", async () => {
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    const record = store.get(SIPA_ADDR.toLowerCase() as Address)
    expect(record?.sipaAddress).toBe(SIPA_ADDR)
    expect(record?.phase).toBe("broadcast")
    expect(store.list()).toHaveLength(1)
  })

  it("throws when patching a missing record without a fallback", async () => {
    await expect(store.upsert(SIPA_ADDR, { phase: "sweeping" })).rejects.toThrow(/no existing/)
  })

  it("shallow-merges patches onto the existing record", async () => {
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    await store.upsert(SIPA_ADDR, {
      phase: "pendingClaim",
      inboxIndex: "42",
      netAmount: "12400000",
    })
    const record = store.get(SIPA_ADDR)
    expect(record?.phase).toBe("pendingClaim")
    expect(record?.inboxIndex).toBe("42")
    expect(record?.messageSecret).toBe(makeFallback().messageSecret)
  })

  it("round-trips the raw-units fee field", async () => {
    await store.upsert(SIPA_ADDR, { phase: "funded", fee: "250000000000000000" }, makeFallback())
    expect(store.get(SIPA_ADDR)?.fee).toBe("250000000000000000")
  })

  it("leaves fee undefined when unstamped", async () => {
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    expect(store.get(SIPA_ADDR)?.fee).toBeUndefined()
  })

  it("stamps endTime exactly on the terminal phases {claimed, failed, recovered}", async () => {
    const terminal: SIPADepositPhase[] = ["claimed", "failed", "recovered"]
    const nonTerminal: SIPADepositPhase[] = [
      "resolved",
      "funded",
      "broadcast",
      "sweeping",
      "pendingClaim",
      "recoverable",
    ]
    for (const [i, phase] of nonTerminal.entries()) {
      const addr = `0x${String(i).padStart(2, "0")}${"00".repeat(19)}` as Address
      await store.upsert(addr, { phase }, makeFallback())
      expect(store.get(addr)?.endTime).toBeUndefined()
    }
    for (const [i, phase] of terminal.entries()) {
      const addr = `0xff${String(i).padStart(2, "0")}${"00".repeat(18)}` as Address
      await store.upsert(addr, { phase }, makeFallback())
      expect(store.get(addr)?.endTime).toBeGreaterThan(0)
    }
  })

  it("notifies list listeners on upsert", async () => {
    const snapshots: SIPADepositRecord[][] = []
    store.onListChanged((records) => snapshots.push(records))
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    expect(snapshots.at(-1)).toHaveLength(1)
    expect(snapshots.at(-1)?.[0]?.phase).toBe("broadcast")
  })

  describe("demote (reorg)", () => {
    it("claimed (L2-derived) demotes to pendingClaim: endTime cleared, epoch bumped, claim anchor kept, the reorged sweep dropped", async () => {
      const sweep = (inboxIndex: string) => ({ inboxIndex, sweepTxHash: "0xs", netAmount: "1" })
      await store.upsert(
        SIPA_ADDR,
        {
          phase: "claimed",
          claimTxHash: "0x" + "aa".repeat(32),
          inboxIndex: "7",
          claimedInboxIndexes: ["5", "7"],
          sweeps: [sweep("5"), sweep("7")],
          observedFrom: "900",
          rescanFrom: "800",
        },
        makeFallback(),
      )

      const demoted = await store.demote(SIPA_ADDR, "pendingClaim")

      expect(demoted?.phase).toBe("pendingClaim")
      expect(demoted?.endTime).toBeUndefined()
      expect(demoted?.reorgEpoch).toBe(1)
      expect(demoted?.claimTxHash).toBe("0x" + "aa".repeat(32))
      expect(demoted?.claimedInboxIndexes).toEqual(["5"])
      expect(demoted?.sweeps).toEqual([sweep("5")])
      // Its sweep sits behind the cursor: the record reads its history again.
      expect(demoted?.observedFrom).toBeUndefined()
      expect(demoted?.rescanFrom).toBeUndefined()
    })

    it("L1-derived terminals (recovered, failed) refuse demote", async () => {
      await store.upsert(SIPA_ADDR, { phase: "recovered" }, makeFallback())
      const unchanged = await store.demote(SIPA_ADDR, "recoverable")
      expect(unchanged?.phase).toBe("recovered")
      expect(unchanged?.reorgEpoch).toBeUndefined()

      const addr2 = ("0x" + "bb".repeat(20)) as Address
      await store.upsert(addr2, { phase: "failed" }, makeFallback())
      expect((await store.demote(addr2, "pendingClaim"))?.phase).toBe("failed")
    })

    it("L1-derived non-terminal phases refuse demote", async () => {
      await store.upsert(SIPA_ADDR, { phase: "pendingClaim" }, makeFallback())
      expect((await store.demote(SIPA_ADDR, "sweeping"))?.phase).toBe("pendingClaim")
    })

    it("returns null for an unknown record", async () => {
      expect(await store.demote(SIPA_ADDR, "pendingClaim")).toBeNull()
    })

    it("drops the demoted inbox index from the dedup set so a rescan re-claims", async () => {
      await store.upsert(
        SIPA_ADDR,
        { phase: "claimed", inboxIndex: "7", claimedInboxIndexes: ["3", "7"] },
        makeFallback(),
      )

      const demoted = await store.demote(SIPA_ADDR, "pendingClaim")
      expect(demoted?.claimedInboxIndexes).toEqual(["3"])

      // Scan seam: dedup no longer skips index 7, and the re-claim upsert
      // carries the record's fresh epoch (what markClaimed now threads).
      await store.upsert(SIPA_ADDR, {
        phase: "claimed",
        inboxIndex: "7",
        claimedInboxIndexes: ["3", "7"],
        reorgEpoch: demoted?.reorgEpoch,
      })
      const reclaimed = store.get(SIPA_ADDR)
      expect(reclaimed?.phase).toBe("claimed")
      expect(reclaimed?.claimedInboxIndexes).toEqual(["3", "7"])
    })

    it("stale forward upsert (no epoch) after demote is a no-op; matching epoch re-advances", async () => {
      await store.upsert(SIPA_ADDR, { phase: "claimed" }, makeFallback())
      await store.demote(SIPA_ADDR, "pendingClaim") // epoch 1

      await store.upsert(SIPA_ADDR, { phase: "claimed" })
      expect(store.get(SIPA_ADDR)?.phase).toBe("pendingClaim")

      await store.upsert(SIPA_ADDR, { phase: "claimed", reorgEpoch: 1 })
      expect(store.get(SIPA_ADDR)?.phase).toBe("claimed")
      expect(store.get(SIPA_ADDR)?.endTime).toBeGreaterThan(0)
    })
  })
})

// The scan, the reorg monitor and the wallet's registration sync all write the same records.
describe("SIPADepositStore concurrent writers", () => {
  const HASH = ("0x" + "5e".repeat(32)) as Hash
  let store: SIPADepositStore

  beforeEach(async () => {
    store = freshStore()
    await store.upsert(SIPA_ADDR, { phase: "broadcast", amount: "0" }, makeFallback())
  })

  it("keep each other's fields", async () => {
    await Promise.all([
      store.upsert(SIPA_ADDR, { phase: "sweeping", sweepTxHash: HASH }),
      store.upsert(SIPA_ADDR, { phase: "sweeping", lastScanAt: 5 }),
    ])
    expect(store.get(SIPA_ADDR)).toMatchObject({
      phase: "sweeping",
      sweepTxHash: HASH,
      lastScanAt: 5,
    })
  })

  it("keep a sweep under way when another writer echoes the phase it read", async () => {
    const sweep = store.update(SIPA_ADDR, () => ({ phase: "sweeping", sweepTxHash: HASH }))
    const echo = store.upsert(SIPA_ADDR, { phase: store.get(SIPA_ADDR)!.phase, lastScanAt: 5 })
    await Promise.all([sweep, echo])
    expect(store.get(SIPA_ADDR)).toMatchObject({
      phase: "sweeping",
      sweepTxHash: HASH,
      lastScanAt: 5,
    })
  })

  it("update decides on the record as it stands at the write", async () => {
    const funded = (current: SIPADepositRecord) =>
      isUnfundedSipaDeposit(current) ? { phase: current.phase, amount: "15" } : null
    await Promise.all([
      store.upsert(SIPA_ADDR, { phase: "sweeping", sweepTxHash: HASH }),
      store.update(SIPA_ADDR, funded),
    ])
    expect(store.get(SIPA_ADDR)).toMatchObject({
      phase: "sweeping",
      sweepTxHash: HASH,
      amount: "0",
    })
  })

  it("update writes nothing for a null patch or a missing record", async () => {
    const listener = vi.fn()
    store.onListChanged(listener)
    expect(await store.update(SIPA_ADDR, () => null)).toMatchObject({ phase: "broadcast" })
    const other = ("0x" + "bb".repeat(20)) as Address
    expect(await store.update(other, () => ({ phase: "sweeping" }))).toBeNull()
    expect(store.get(other)).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it("create writes a new record and leaves one already there", async () => {
    expect(await store.create(SIPA_ADDR, { ...makeFallback(), phase: "sweeping" })).toBeNull()
    expect(store.get(SIPA_ADDR)?.phase).toBe("broadcast")
    const other = ("0x" + "bb".repeat(20)) as Address
    const created = await store.create(other, { ...makeFallback(), phase: "sweeping" })
    expect(created).toMatchObject({ sipaAddress: other, phase: "sweeping", amount: "12.5" })
    expect(store.get(other)).toEqual(created)
  })

  it("update keeps the reorg-epoch guard", async () => {
    await store.upsert(SIPA_ADDR, { phase: "claimed" })
    await store.demote(SIPA_ADDR, "pendingClaim")
    await store.update(SIPA_ADDR, () => ({ phase: "claimed" }))
    expect(store.get(SIPA_ADDR)?.phase).toBe("pendingClaim")
  })
})

describe("SIPADepositStore version 2 migration", () => {
  const NETWORK = "0x1111111111111111111111111111111111111111"
  const PINNED = {
    portal: "0x7992cd55908b19b60bc46926deb9b1f1dfb6e0a9" as Address,
    l2Token: "0x0f1c7a8b2b8a1f6de4b6a2c1c7e8d9f0a1b2c3d4e5f60718293a4b5c6d7e8f90",
    token: {
      address: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address,
      symbol: "DAI",
      decimals: 18,
    },
  }
  const v1 = (over: Partial<SIPADepositRecord>): SIPADepositRecord => ({
    sipaAddress: SIPA_ADDR,
    ...makeFallback(),
    networkId: NETWORK,
    phase: "claimed",
    ...over,
  })
  async function storeWith(records: SIPADepositRecord[]): Promise<SIPADepositStore> {
    resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
    const storage = new InMemoryStorageAdapter()
    await storage.setItem(
      "@obsidion/sipa-deposits/records",
      JSON.stringify(Object.fromEntries(records.map((r) => [r.sipaAddress.toLowerCase(), r]))),
    )
    return SIPADepositStore.get(storage)
  }

  it("stamps a version 1 record's sweeps with the one bridge they were claimed through", async () => {
    const store = await storeWith([
      v1({
        netAmount: "990000000000000000",
        inboxIndex: "7",
        sweepTxHash: "0xsweep7" as Hash,
        tokenAddress: PINNED.token.address,
        sweeps: [
          { inboxIndex: "7", sweepTxHash: "0xsweep7" as Hash, netAmount: "990000000000000000" },
        ],
      }),
    ])

    const migrated = await store.migrateSweepRows(NETWORK, PINNED)

    expect(migrated).toHaveLength(1)
    expect(store.get(SIPA_ADDR)).toMatchObject({
      version: SIPA_DEPOSIT_RECORD_VERSION,
      tokenAddress: PINNED.token.address,
      tokenSymbol: "DAI",
      sweeps: [
        {
          inboxIndex: "7",
          portal: PINNED.portal,
          l2Token: PINNED.l2Token,
          tokenAddress: PINNED.token.address,
          tokenSymbol: "DAI",
          tokenDecimals: 18,
          netAmount: "990000000000000000",
        },
      ],
    })
    // A second run finds nothing left to migrate.
    expect(await store.migrateSweepRows(NETWORK, PINNED)).toEqual([])
  })

  it("migrates a record with no stamp, or with this network's in another case", async () => {
    const store = await storeWith([
      v1({ networkId: undefined }),
      v1({ sipaAddress: `0x${"be".repeat(20)}`, networkId: NETWORK.toUpperCase() }),
    ])
    expect(await store.migrateSweepRows(NETWORK, PINNED)).toHaveLength(2)
  })

  it("gives the latest sweep the record's fee, and no older sweep a guessed one", async () => {
    const store = await storeWith([
      v1({
        netAmount: "990000000000000000",
        fee: "10000000000000000",
        inboxIndex: "7",
        sweepTxHash: "0xsweep7" as Hash,
        tokenAddress: PINNED.token.address,
        sweeps: [
          { inboxIndex: "3", sweepTxHash: "0xsweep3" as Hash, netAmount: "500000000000000000" },
          { inboxIndex: "7", sweepTxHash: "0xsweep7" as Hash, netAmount: "990000000000000000" },
        ],
      }),
    ])

    await store.migrateSweepRows(NETWORK, PINNED)

    const [older, latest] = store.get(SIPA_ADDR)!.sweeps!
    expect(older!.fee).toBeUndefined()
    expect(latest!.fee).toBe("10000000000000000")
  })

  it("keeps an unswept record's funding token and stamps only its version", async () => {
    const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address
    const store = await storeWith([
      v1({
        phase: "sweeping",
        amount: "5",
        tokenAddress: USDC,
        tokenSymbol: "USDC",
        tokenDecimals: 6,
      }),
    ])

    await store.migrateSweepRows(NETWORK, PINNED)

    const record = store.get(SIPA_ADDR)!
    expect(record).toMatchObject({
      version: SIPA_DEPOSIT_RECORD_VERSION,
      tokenAddress: USDC,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
    })
    expect(record.sweeps).toBeUndefined()
  })

  it("keeps a sweep's own row and leaves another network's records at version 1", async () => {
    const OTHER = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" as Address
    const own = {
      inboxIndex: "8",
      sweepTxHash: "0xsweep8" as Hash,
      netAmount: "1",
      portal: OTHER,
      l2Token: "0x01",
      tokenAddress: OTHER,
      tokenSymbol: "sUSDS",
      tokenDecimals: 18,
    }
    const store = await storeWith([
      v1({ sweeps: [own], netAmount: "1", inboxIndex: "8" }),
      v1({ sipaAddress: OTHER, networkId: "0x2222222222222222222222222222222222222222" }),
    ])

    await store.migrateSweepRows(NETWORK, PINNED)

    expect(store.get(SIPA_ADDR)!.sweeps).toEqual([own])
    expect(store.get(OTHER)!.version).toBeUndefined()
  })

  it("keeps the token of a record whose latest sweep already names its row", async () => {
    const SUSDS = "0x5875eee11cf8398102fdad704c9e96607675467a" as Address
    const store = await storeWith([
      v1({
        netAmount: "4990000000000000000",
        inboxIndex: "8",
        tokenAddress: SUSDS,
        tokenSymbol: "sUSDS",
        tokenDecimals: 18,
        sweeps: [
          { inboxIndex: "7", sweepTxHash: "0xsweep7" as Hash, netAmount: "1" },
          {
            inboxIndex: "8",
            sweepTxHash: "0xsweep8" as Hash,
            netAmount: "4990000000000000000",
            portal: SUSDS,
            l2Token: "0x02",
            tokenAddress: SUSDS,
            tokenSymbol: "sUSDS",
            tokenDecimals: 18,
          },
        ],
      }),
    ])

    await store.migrateSweepRows(NETWORK, PINNED)

    const record = store.get(SIPA_ADDR)!
    expect(record).toMatchObject({ tokenAddress: SUSDS, tokenSymbol: "sUSDS" })
    expect(record.sweeps!.map((s) => s.tokenSymbol)).toEqual(["DAI", "sUSDS"])
  })

  it("writes new records at the current version", async () => {
    const store = freshStore()
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    expect(store.get(SIPA_ADDR)?.version).toBe(SIPA_DEPOSIT_RECORD_VERSION)
  })
})

describe("isUnfundedSipaDeposit", () => {
  const record = (patch: Partial<SIPADepositRecord>): SIPADepositRecord =>
    ({
      ...makeFallback(),
      sipaAddress: SIPA_ADDR,
      amount: "0",
      phase: "broadcast",
      ...patch,
    } as SIPADepositRecord)

  it("hides a broadcast address nobody paid", () => {
    expect(isUnfundedSipaDeposit(record({}))).toBe(true)
    expect(isUnfundedSipaDeposit(record({ phase: "resolved" }))).toBe(true)
  })

  it("shows anything with evidence funds arrived", () => {
    expect(isUnfundedSipaDeposit(record({ amount: "5" }))).toBe(false)
    expect(isUnfundedSipaDeposit(record({ phase: "sweeping" }))).toBe(false)
    expect(isUnfundedSipaDeposit(record({ phase: "claimed", amount: "5" }))).toBe(false)
    // A sweep landed but the claim keeps failing: the phase never advances, and hiding it would
    // hide real money sitting on L1.
    expect(isUnfundedSipaDeposit(record({ sweepTxHash: "0xfeed" as `0x${string}` }))).toBe(false)
    expect(isUnfundedSipaDeposit(record({ inboxIndex: "7" }))).toBe(false)
  })
})

describe("SIPADepositStore observation cursors", () => {
  const PORTAL = "0x7992CD55908B19b60bc46926dEb9B1f1DFb6E0A9" as Address
  const OTHER = "0x9999999999999999999999999999999999999999999999999999999999999999"
  const LEGACY_KEY = `@obsidion/sipa-deposits/observed-through/${PORTAL.toLowerCase()}`
  let adapter: InMemoryStorageAdapter
  let store: SIPADepositStore

  beforeEach(() => {
    resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
    adapter = new InMemoryStorageAdapter()
    store = SIPADepositStore.get(adapter)
  })

  it("keeps one cursor per portal and recipient, whatever their case", async () => {
    await store.setObservedThrough(PORTAL, RECIPIENT, 500n)

    expect(
      await store.observedThrough(PORTAL.toLowerCase() as Address, RECIPIENT.toUpperCase()),
    ).toBe(500n)
    expect(await store.observedThrough(PORTAL, OTHER)).toBeUndefined()
  })

  it("hands the portal-only cursor to the recipient it is adopted for, once", async () => {
    await adapter.setItem(LEGACY_KEY, "500")

    await store.adoptObservedThrough(PORTAL, RECIPIENT)

    expect(await store.observedThrough(PORTAL, RECIPIENT)).toBe(500n)
    expect(await adapter.getItem(LEGACY_KEY)).toBeNull()
    await store.adoptObservedThrough(PORTAL, OTHER)
    expect(await store.observedThrough(PORTAL, OTHER)).toBeUndefined()
  })

  it("drops the portal-only cursor without touching one the recipient already has", async () => {
    await adapter.setItem(LEGACY_KEY, "500")
    await store.setObservedThrough(PORTAL, RECIPIENT, 900n)

    await store.adoptObservedThrough(PORTAL, RECIPIENT)

    expect(await store.observedThrough(PORTAL, RECIPIENT)).toBe(900n)
    expect(await adapter.getItem(LEGACY_KEY)).toBeNull()
  })

  it("writes nothing when there is no portal-only cursor to adopt", async () => {
    await store.adoptObservedThrough(PORTAL, RECIPIENT)

    expect(await store.observedThrough(PORTAL, RECIPIENT)).toBeUndefined()
    expect(await adapter.getItem(LEGACY_KEY)).toBeNull()
  })
})
