import { describe, expect, it, vi } from "vitest"
import { PaylinkActionEnum, TokenActionEnum } from "@obsidion/core/constants"
import type { Transaction } from "../../../src/types/transactions"
import {
  TransferEventScanner,
  TRANSFER_SCAN_CATCH_UP_BLOCKS,
  TRANSFER_SCAN_REORG_MARGIN,
  type ScannedTransferEvent,
  type TransferEventSource,
  type TransferScanPass,
  scannedRow,
} from "../../../src/core/services/transactions/TransferEventScanner"
import { seededActivity } from "../../utils/activityFixture"
import type { MemoryBackend } from "../../../src/engine/memoryBackend"
import { syncCatchUp } from "../../../src/engine/catchUp"

const ME = "0x" + "aa".repeat(32)
const ALICE = "0x" + "bb".repeat(32)
const MALLORY = "0x" + "cc".repeat(32)
const TOKEN = { address: "0x" + "11".repeat(32), symbol: "DAI", decimals: 6 }
const STORE_WRITE_FAILED = new Error("store write failed")

function event(overrides: Partial<ScannedTransferEvent> = {}): ScannedTransferEvent {
  return {
    txHash: "0x" + "01".repeat(32),
    from: ALICE,
    to: ME,
    amount: "5000000",
    blockNumber: 10,
    senderTag: "alice",
    ...overrides,
  }
}

function harness(opts: {
  contactTag?: string
  events?: ScannedTransferEvent[]
  head?: number | (() => number)
  /** PXE synced block; unset means the source has no anchorBlock. */
  anchor?: () => number
  /** Range-aware event source; wins over `events`. */
  list?: (fromBlock: number, toBlockExclusive: number) => ScannedTransferEvent[]
  resolve?: (tag: string) => Promise<{ l2Address: string } | null>
  /** Hashes already held by a row of some OTHER action (a paylink claim/refund). */
  otherRowHashes?: string[]
  /** Throw from the store write, to exercise a poison event. */
  addThrows?: () => boolean
  onSynced?: (anchor: number) => Promise<void>
  /** Block time read; defaults to `block * 1000`. Undefined means the node could not serve it. */
  blockTime?: (block: number) => number | undefined
  sourceTimeoutMs?: number
}) {
  const activity = seededActivity(
    (opts.otherRowHashes ?? []).map((txHash) => ({
      action: PaylinkActionEnum.CLAIM,
      emailPaymentAction: PaylinkActionEnum.CLAIM,
      txHash,
      timestamp: 1,
      status: "success",
    })) as Transaction[],
  )
  const { backend } = activity
  const adds: Transaction[] = []
  const payouts: Transaction[] = []
  const record = activity.record.bind(activity)
  vi.spyOn(activity, "record").mockImplementation(async (row, recordOpts, w) => {
    if (opts.addThrows?.()) throw STORE_WRITE_FAILED
    ;(recordOpts?.replaces === TokenActionEnum.RECEIVE ? payouts : adds).push(row)
    return record(row, recordOpts, w)
  })
  const registered: { tag: string; l2Address: string }[] = []
  const listIncoming = vi.fn(async (a: number, b: number) =>
    opts.list ? opts.list(a, b) : opts.events ?? [],
  )
  const source: TransferEventSource = {
    headBlock: async () => (typeof opts.head === "function" ? opts.head() : opts.head ?? 100),
    listIncoming,
    blockTimestampMs: async (b) => (opts.blockTime ? opts.blockTime(b) : b * 1000),
    ...(opts.anchor ? { anchorBlock: async () => opts.anchor!() } : {}),
  }
  /** The persisted cursor, read straight from storage — call args are not proof of state. */
  const cursor = async () =>
    Number(backend.entries.get(`@obsidion/transfer-scan/cursor/v1/net/${ME}`) ?? 0)
  const scanner = new TransferEventScanner({
    source,
    db: activity.db,
    transactionStore: activity,
    tags: {
      resolveL2: opts.resolve ?? (async (tag) => (tag === "alice" ? { l2Address: ALICE } : null)),
    },
    contacts: {
      findByL2Address: async () => (opts.contactTag ? { tag: opts.contactTag } : null),
      registerL2: async (args) => void registered.push(args),
    },
    token: TOKEN,
    onSynced: opts.onSynced,
    sourceTimeoutMs: opts.sourceTimeoutMs,
  })
  const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }
  /** A full pass unless told otherwise: a wake, as the runtime runs on start, show and refresh. */
  const pass = (o: TransferScanPass = {}, c: typeof ctx & { endpointScope?: string } = ctx) =>
    scanner.pass(c, { full: true, ...o })
  return { scanner, ctx, pass, adds, payouts, activity, registered, listIncoming, cursor, backend }
}

describe("TransferEventScanner", () => {
  it("files a receive with a verified payout lane as a paylink claim, not a receive", async () => {
    const lane = { flavor: "direct" as const, secret: {} as never, fallbackKeyHash: {} as never }
    const h = harness({
      events: [
        event({ paylinkPayout: lane, senderTag: "notme", memo: "lunch" }),
        event({ txHash: "0x" + "02".repeat(32) }),
      ],
    })
    await h.pass()
    expect(h.payouts).toEqual([
      expect.objectContaining({
        action: PaylinkActionEnum.CLAIM,
        txHash: "0x" + "01".repeat(32),
        flavor: "direct",
        memo: "lunch",
        blockNumber: 10,
        timestamp: 10_000,
        networkId: "net",
      }),
    ])
    expect(h.adds.map((a) => a.txHash)).toEqual(["0x" + "02".repeat(32)])
    await h.pass()
    expect(h.payouts).toHaveLength(2) // re-offered each pass; the store upgrades only a plain receive
  })

  it("upgrades a payout filed as a plain receive before its lane was read", async () => {
    const lane = { flavor: "direct" as const, secret: {} as never, fallbackKeyHash: {} as never }
    const h = harness({ events: [event({ paylinkPayout: lane })] })
    await h.activity.record(
      scannedRow({
        txHash: event().txHash,
        from: ALICE,
        senderL2Address: ALICE,
        to: "me",
        token: { ...TOKEN, name: "DAI", logo: "", amount: 5, price: 1 },
        amountAtomic: 5_000_000n,
        timestamp: 10_000,
        networkId: "net",
      }),
    )
    h.adds.length = 0
    await h.pass()
    expect(h.adds).toEqual([])
    expect(h.payouts.map((p) => p.txHash)).toEqual([event().txHash])
  })

  it("flags catch-up for the cursorless first pass, and clears it when that pass ends", async () => {
    const seen: boolean[] = []
    const listener = (v: boolean) => void seen.push(v)
    const off = syncCatchUp.status.subscribe(() => listener(syncCatchUp.status.get()))
    const h = harness({ events: [event()] })
    await h.pass()
    expect(seen).toEqual([true, false])
    expect(syncCatchUp.status.get()).toBe(false)
    await h.pass()
    expect(seen).toEqual([true, false]) // cursor present: a normal reopen never flags

    // Nested holders (withdrawal rescan, deposit sync) collapse into one true/false pair.
    const endA = syncCatchUp.begin()
    const endB = syncCatchUp.begin()
    endA()
    endA()
    expect(syncCatchUp.status.get()).toBe(true)
    endB()
    expect(seen).toEqual([true, false, true, false])
    off()
  })

  it("holds catch-up only when the cursor lags head by more than the catch-up distance", async () => {
    const seen: boolean[] = []
    const listener = (v: boolean) => void seen.push(v)
    const off = syncCatchUp.status.subscribe(() => listener(syncCatchUp.status.get()))
    let head = 100
    const h = harness({ events: [event()], head: () => head })
    await h.pass() // cursorless first pass
    head = 100 + TRANSFER_SCAN_CATCH_UP_BLOCKS
    await h.pass() // an hours-long gap is still a routine reopen: rows land live
    expect(seen).toEqual([true, false])
    head += TRANSFER_SCAN_CATCH_UP_BLOCKS + 1
    await h.pass() // far behind head: rows land behind the skeleton
    expect(seen).toEqual([true, false, true, false])
    off()
  })

  it("writes a verified receive attributed to the sender's tag and auto-adds the contact", async () => {
    const h = harness({ events: [event({ requestId: "0x" + "0c".repeat(32), memo: "hi" })] })
    await h.pass()
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]).toMatchObject({
      from: "alice",
      senderL2Address: ALICE,
      to: "me",
      memo: "hi",
      requestId: "0x" + "0c".repeat(32),
      amountAtomic: 5_000_000n,
      blockNumber: 10,
      timestamp: 10_000,
    })
    expect(h.adds[0]!.token).toMatchObject({ address: TOKEN.address, symbol: "DAI", amount: 5 })
    expect(h.registered).toEqual([{ tag: "alice", l2Address: ALICE }])
  })

  it("falls back to the raw address and adds no contact when the tag does not resolve to the sender", async () => {
    const h = harness({ events: [event({ from: MALLORY, senderTag: "alice" })] })
    await h.pass()
    expect(h.adds[0]!.from).toBe(MALLORY)
    expect(h.registered).toEqual([])
  })

  it("skips self-transfers, other accounts' transfers, and already-stored hashes", async () => {
    const h = harness({
      events: [
        event({ from: ME, txHash: "0x" + "02".repeat(32) }),
        event({ from: ALICE, to: MALLORY, txHash: "0x" + "03".repeat(32) }),
        event(),
        event(),
      ],
    })
    await h.pass()
    expect(h.adds).toHaveLength(1)
  })

  it("adopts a send's recipient tag as a contact once the registry resolves it to the recipient", async () => {
    const h = harness({
      events: [
        event({ from: ME, to: ALICE, recipientTag: "alice", txHash: "0x" + "04".repeat(32) }),
        event({ from: ME, to: MALLORY, recipientTag: "alice", txHash: "0x" + "05".repeat(32) }),
      ],
    })
    await h.pass()
    expect(h.adds.map((a) => a.to)).toEqual([ALICE, MALLORY])
    expect(h.registered).toEqual([{ tag: "alice", l2Address: ALICE }])
  })

  it("holds the cursor when the recipient-tag registry read fails, like a receive", async () => {
    const h = harness({
      events: [event({ from: ME, to: ALICE, recipientTag: "alice" })],
      resolve: async () => {
        throw new Error("registry down")
      },
    })
    await h.pass()
    expect(h.adds).toHaveLength(0)
    expect(await h.cursor()).toBe(0)
  })

  it("sheds a hanging contact lookup on a send after repeated timeouts instead of stalling the cursor", async () => {
    const h = harness({ events: [event({ from: ME, to: ALICE, recipientTag: "alice" })] })
    const hung = h.scanner as unknown as {
      opts: { contacts: { findByL2Address: () => Promise<{ tag: string } | null> } }
    }
    Object.defineProperty(hung, "sourceTimeoutMs", { value: 20 })
    hung.opts.contacts.findByL2Address = () => new Promise(() => {})
    await h.pass()
    expect(h.adds).toHaveLength(0)
    await h.pass()
    await h.pass()
    await h.pass()
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]).toMatchObject({ action: "send", to: ALICE })
    expect(h.registered).toEqual([])
    await h.pass()
    expect(h.listIncoming).toHaveBeenLastCalledWith(100 - TRANSFER_SCAN_REORG_MARGIN, 101)
  })

  it("writes the account's own sends as send rows; no registry lookup without a recipient tag", async () => {
    const resolve = vi.fn(async () => null)
    const h = harness({
      events: [event({ from: ME, to: ALICE, senderTag: "me", memo: "rent" })],
      resolve,
    })
    await h.pass()
    expect(resolve).not.toHaveBeenCalled()
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]).toMatchObject({
      action: "send",
      from: "me",
      to: ALICE,
      senderL2Address: ME,
      memo: "rent",
      amountAtomic: 5_000_000n,
      blockNumber: 10,
    })
    expect(h.registered).toEqual([])
  })

  it.each([undefined, "alice"])(
    "keeps rebuilt sends in contact history with saved tag %s",
    async (contactTag) => {
      const h = harness({ contactTag, events: [event({ from: ME, to: ALICE })] })
      await h.pass()
      // The contact chat matches a send by the address it went to.
      expect(h.adds[0]?.to).toBe(ALICE)
    },
  )

  it("holds the cursor when the registry is unavailable and advances it once ingest succeeds", async () => {
    let fail = true
    const h = harness({
      events: [event()],
      resolve: async () => {
        if (fail) throw new Error("registry down")
        return { l2Address: ALICE }
      },
    })
    await h.pass()
    expect(h.adds).toHaveLength(0)
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 101)

    fail = false
    await h.pass()
    expect(h.adds).toHaveLength(1)
    await h.pass()
    expect(h.listIncoming).toHaveBeenLastCalledWith(100 - TRANSFER_SCAN_REORG_MARGIN, 101)
  })

  it("skips a Transfer whose hash a paylink row already holds", async () => {
    // The paylink escrow pays its claimant with the same token `transfer`, so a claim lands here
    // as an ordinary incoming Transfer. Matching only send/receive rows would file it twice.
    const claimHash = "0x" + "01".repeat(32)
    const h = harness({ events: [event({ txHash: claimHash })], otherRowHashes: [claimHash] })
    await h.pass()
    expect(h.adds).toHaveLength(0)
  })

  it("degrades to raw-address attribution after repeated registry failures instead of skipping", async () => {
    const h = harness({
      events: [event()],
      resolve: async () => {
        throw new Error("registry down")
      },
    })
    await h.pass()
    expect(h.adds).toHaveLength(0)
    // Retried while it might still be transient, then the registry lookup is shed — never the event.
    await h.pass()
    await h.pass()
    await h.pass()
    expect(h.adds).toHaveLength(1)
    expect(h.adds[0]!.from).toBe(ALICE)
    expect(h.registered).toEqual([])
    // The chunk completed, so the cursor moved on.
    await h.pass()
    expect(h.listIncoming).toHaveBeenLastCalledWith(100 - TRANSFER_SCAN_REORG_MARGIN, 101)
  })

  it("defers an event whose block time cannot be read, and dates it by chain once it can", async () => {
    let blockTime: number | undefined = undefined
    const h = harness({ events: [event()], blockTime: () => blockTime })
    await h.pass()
    await h.pass()
    expect(h.adds).toHaveLength(0)
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 101) // cursor held, never stamped 777
    blockTime = 10_000
    await h.pass()
    expect(h.adds.map((a) => a.timestamp)).toEqual([10_000])
  })

  it("holds the cursor for a persistently failing store write and never drops the event", async () => {
    const h = harness({ events: [event()], addThrows: () => true })
    for (let i = 0; i < 6; i++) await expect(h.pass()).rejects.toBe(STORE_WRITE_FAILED)
    expect(h.adds).toHaveLength(0)
    // Still retrying the same range from block 1 — the event was never abandoned.
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 101)
  })

  it("never persists the cursor past the PXE anchor, and ingests the gap once it catches up", async () => {
    // Head is the node tip; PXE (pinned during a send) has only synced to 40. A transfer sits at
    // block 70 — beyond the anchor, so PXE cannot return it yet, and below head minus the reorg
    // margin, so a cursor persisted at head would skip it for good.
    let anchor = 40
    const h = harness({
      head: 1_000,
      anchor: () => anchor,
      list: (a, b) => {
        const e = event({ blockNumber: 70 })
        return e.blockNumber >= a && e.blockNumber < b && e.blockNumber <= anchor ? [e] : []
      },
    })
    await h.pass()
    expect(h.adds).toHaveLength(0)
    expect(await h.cursor()).toBe(40)

    // Anchor unchanged: a scheduled pass rescans (re-triggering the sync) rather than idling.
    const calls = h.listIncoming.mock.calls.length
    await h.pass({ full: false })
    expect(h.listIncoming.mock.calls.length).toBe(calls + 1)
    expect(await h.cursor()).toBe(40)

    // Send finished, sync caught up: the block-70 payment lands and the cursor reaches head.
    anchor = 1_000
    await h.pass()
    expect(h.adds).toHaveLength(1)
    expect(await h.cursor()).toBe(1_000)
  })

  it("rewinds the cursor when the anchor regresses below it (PXE store rebuilt)", async () => {
    let anchor = 500
    const events: ScannedTransferEvent[] = []
    const h = harness({
      head: 500,
      anchor: () => anchor,
      list: (a, b) =>
        events.filter((e) => e.blockNumber >= a && e.blockNumber < b && e.blockNumber <= anchor),
    })
    await h.pass()
    expect(await h.cursor()).toBe(500)

    // PXE store wiped: the anchor regresses far below the cursor. Without the rewind, blocks below
    // cursor minus the margin would never be listed again once PXE re-syncs.
    anchor = 0
    await h.pass()
    expect(await h.cursor()).toBe(0)

    // PXE re-syncs and re-decrypts a transfer the old cursor had already passed.
    events.push(event({ blockNumber: 100 }))
    anchor = 500
    await h.pass()
    expect(h.adds).toHaveLength(1)
    expect(await h.cursor()).toBe(500)
  })

  it("rewinds the cursor when head regresses below it", async () => {
    let head = 5000
    const h = harness({ events: [], head: () => head })
    await h.pass()
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 5001)

    // A rebuild deeper than the reorg margin: without the rewind, `from` would stay at
    // 5000 - margin and the surviving blocks below it would never be rescanned.
    head = 4800
    await h.pass()
    await h.pass()
    expect(h.listIncoming).toHaveBeenLastCalledWith(4800 - TRANSFER_SCAN_REORG_MARGIN, 4801)
  })

  it("skips the sync-triggering scan while head is static, but never on a full pass", async () => {
    const h = harness({ events: [] })
    await h.pass()
    const afterStart = h.listIncoming.mock.calls.length

    // A scheduled pass with an unchanged head: no PXE sync.
    await h.pass({ full: false })
    expect(h.listIncoming.mock.calls.length).toBe(afterStart)

    // Pull-to-refresh must still rescan the reorg margin.
    await h.pass()
    expect(h.listIncoming.mock.calls.length).toBe(afterStart + 1)
  })

  it("runs onSynced with the anchor after a pass that listed events, never on an idle one", async () => {
    const synced: number[] = []
    const h = harness({ events: [], head: 100, onSynced: async (a) => void synced.push(a) })
    await h.pass()
    expect(synced).toEqual([100])

    await h.pass({ full: false }) // static head: no sync, no hook
    expect(synced).toEqual([100])

    await h.pass()
    expect(synced).toEqual([100, 100])

    // The hook gets the PXE anchor the events were read at, not head.
    const lagging = harness({
      events: [],
      head: 100,
      anchor: () => 90,
      onSynced: async (a) => void synced.push(a),
    })
    await lagging.pass()
    expect(synced.at(-1)).toBe(90)
  })

  it("a throwing onSynced fails the pass and forces a full pass next time", async () => {
    let fail = true
    const synced: number[] = []
    const h = harness({
      events: [],
      head: 100,
      onSynced: async (a) => {
        synced.push(a)
        if (fail) throw new Error("balance read failed")
      },
    })
    expect(await h.pass()).toBe(false)
    expect(synced).toEqual([100])
    const listed = h.listIncoming.mock.calls.length

    fail = false
    await h.pass({ full: false }) // the scheduled retry with the same head still rescans
    expect(h.listIncoming.mock.calls.length).toBe(listed + 1)
    expect(synced).toEqual([100, 100])
  })

  it("stamps rows with the scan context's networkId", async () => {
    const h = harness({ events: [event()] })
    await h.pass()
    expect(h.adds[0]!.networkId).toBe("net")
  })

  it("times out a hung source call instead of wedging the pass", async () => {
    const h = harness({ events: [], sourceTimeoutMs: 20 })
    const hung = h.scanner as unknown as { opts: { source: { headBlock: () => Promise<number> } } }
    hung.opts.source.headBlock = () => new Promise<number>(() => {})
    await expect(h.pass()).rejects.toMatchObject({ code: "timeout" })
  })

  it("writes nothing once its pass is stopped, and does not count that as a failure", async () => {
    const h = harness({ events: [event()] })
    const stop = new AbortController()
    stop.abort()
    expect(await h.pass({ signal: stop.signal })).toBe(true)
    expect(h.adds).toEqual([])
    expect(await h.cursor()).toBe(0)
  })

  it("scans history in bounded chunks and persists the cursor per completed chunk", async () => {
    const calls: Array<[number, number]> = []
    const h = harness({ head: 25_000, events: [] })
    const src = h.scanner as unknown as {
      opts: { source: { listIncoming: (a: number, b: number) => Promise<ScannedTransferEvent[]> } }
    }
    src.opts.source.listIncoming = async (a, b) => {
      calls.push([a, b])
      return []
    }
    await h.pass()
    expect(calls).toEqual([
      [1, 10_001],
      [10_001, 20_001],
      [20_001, 25_001],
    ])
  })

  it("syncs a snapshot pass on its first chunk only", async () => {
    const h = harness({ head: 25_000, events: [] })
    const readSnapshot = vi.fn(async () => ({ events: [], balance: 1n, anchorBlock: 25_000 }))
    const src = h.scanner as unknown as { opts: { source: Record<string, unknown> } }
    src.opts.source.readSnapshot = readSnapshot
    await h.pass()
    expect(readSnapshot.mock.calls).toEqual([
      [1, 10_001, undefined],
      [10_001, 20_001, { assumeSynced: true }],
      [20_001, 25_001, { assumeSynced: true }],
    ])
    await h.pass()
    expect(readSnapshot.mock.calls[3][2]).toBeUndefined()
  })

  it("keeps completed-chunk progress when a later chunk fails", async () => {
    const h = harness({
      head: 15_000,
      resolve: async () => {
        throw new Error("registry down")
      },
    })
    const src = h.scanner as unknown as {
      opts: { source: { listIncoming: (a: number, b: number) => Promise<ScannedTransferEvent[]> } }
    }
    const calls: Array<[number, number]> = []
    // Chunk 1 is clean; chunk 2 carries an event whose ingest fails (registry down).
    src.opts.source.listIncoming = async (a, b) => {
      calls.push([a, b])
      return a > 10_000 ? [event({ blockNumber: 10_500 })] : []
    }
    await h.pass()
    expect(h.adds).toHaveLength(0)
    calls.length = 0
    await h.pass()
    // Resumes from the persisted chunk-1 cursor (minus the reorg margin), not from block 1.
    expect(calls[0]![0]).toBe(10_000 - TRANSFER_SCAN_REORG_MARGIN)
  })

  it("rescans the reorg margin without double-inserting", async () => {
    const h = harness({ events: [event()] })
    await h.pass()
    await h.pass()
    await h.pass()
    expect(h.adds).toHaveLength(1)
  })
})

describe("TransferEventScanner cursor scope", () => {
  const UNSCOPED_KEY = `@obsidion/transfer-scan/cursor/v1/net/${ME}`
  const SCOPED_KEY = `@obsidion/transfer-scan/cursor/v1/net/A/${ME}`
  const cursorKeys = (backend: MemoryBackend) =>
    [...backend.entries.keys()].filter((k) => k.startsWith("@obsidion/transfer-scan/cursor/"))

  it("keeps the cursor under the scoped key and never touches the unscoped one", async () => {
    const h = harness({ events: [] })
    const scoped = { ...h.ctx, endpointScope: "A" }
    await h.pass({}, scoped)
    await h.pass({}, scoped)
    expect(cursorKeys(h.backend)).toEqual([SCOPED_KEY])
    expect(h.backend.entries.get(SCOPED_KEY)).toBe("100")
  })

  it("uses the unscoped key without a scope", async () => {
    const h = harness({ events: [] })
    await h.pass()
    expect(cursorKeys(h.backend)).toEqual([UNSCOPED_KEY])
    expect(h.backend.entries.get(UNSCOPED_KEY)).toBe("100")
  })

  it("a scoped scan advances its own cursor; the unscoped scan resumes from its older one", async () => {
    let head = 1_000
    const h = harness({ events: [], head: () => head })
    await h.pass()
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 1_001)

    head = 5_000
    await h.pass({}, { ...h.ctx, endpointScope: "A" })
    expect(h.listIncoming).toHaveBeenLastCalledWith(1, 5_001) // cursorless under A
    expect(h.backend.entries.get(SCOPED_KEY)).toBe("5000")
    expect(h.backend.entries.get(UNSCOPED_KEY)).toBe("1000")

    await h.pass()
    expect(h.listIncoming).toHaveBeenLastCalledWith(1_000 - TRANSFER_SCAN_REORG_MARGIN, 5_001)
    expect(h.backend.entries.get(UNSCOPED_KEY)).toBe("5000")
    expect(h.backend.entries.get(SCOPED_KEY)).toBe("5000")
  })
})
