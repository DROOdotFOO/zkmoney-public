import { describe, expect, it, vi } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { rebuildPaylinks } from "../../src/core/services/paylink/paylinkRescan"

import { scannedRow } from "../../src/core/services/transactions/TransferEventScanner"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { deriveNotifications } from "../../src/engine/notificationFeed"
import { isOld, NOTIFICATION_WINDOW_MS } from "../../src/engine/notifications"
import type { Transaction } from "../../src/types/transactions"
import { seededActivity } from "../utils/activityFixture"

const ME = "0x00aa"
const secret = Fr.random()
const fallbackSecret = Fr.random()
const MASTER_SECRET = Fr.random()
const lane = { flavor: "direct" as const, day: 20_000, secret, fallbackKeyHash: Fr.random() }
const TOKEN = { address: "0xtoken", symbol: "DAI", decimals: 18 }

function event(over: Partial<ScannedTransferEvent>): ScannedTransferEvent {
  return {
    txHash: "0x1",
    from: ME,
    to: "0xescrow",
    amount: "2500000000000000000",
    blockNumber: 10,
    paylinkCreated: lane,
    memo: "lunch",
    ...over,
  }
}

const params = (txHash: string) => ({
  secret,
  fallbackSecret,
  classId: Fr.ZERO,
  chainId: 31337,
  rollupVersion: 1,
  txHash,
  paylinkType: "paylinkDirect" as const,
  amount: 2_500_000_000_000_000_000n,
  email: undefined,
})

function makeDeps(
  events: ScannedTransferEvent[],
  over: Record<string, unknown> = {},
  backend: MemoryBackend = memoryBackend(),
) {
  const store = seededActivity(
    [{ action: PaylinkActionEnum.PAY, txHash: "0xknown", timestamp: 1, status: "success" }],
    { backend },
  )
  vi.spyOn(store, "record")
  const paylinkService = {
    recoverPaylinkFromTransfer: vi.fn(async (e: ScannedTransferEvent) =>
      e.to === "0xescrow" ? params(e.txHash) : null,
    ),
    paylinkClaimBlock: vi.fn(async (): Promise<number | undefined> => undefined),
    sync_note: vi.fn(async () => ({
      claimableFrom: 100,
      claimableUntil: 200,
      refundableUntil: 200,
    })),
    ...over,
  }
  const linkFor = vi.fn(async (p: { txHash: string }) => `https://link/${p.txHash}`)
  return {
    deps: {
      source: {
        headBlock: vi.fn(async () => 40),
        listIncoming: vi.fn(async () => events),
        blockTimestampMs: vi.fn(async (b: number) =>
          b === 10 ? 1_000 : b === 12 ? 5_000 : undefined,
        ),
      },
      accountAddress: ME.toUpperCase(),
      masterSecret: MASTER_SECRET,
      networkId: "network-A",
      paylinkService: paylinkService as never,
      linkFor,
      store,
      db: store.db,
      token: TOKEN,
      now: () => 9_999,
    },
    store,
    backend,
    paylinkService,
    linkFor,
  }
}

/** The rows the rescan recorded: its PAY rows, and the payouts that replace a receive. */
const recorded = (store: { record: unknown }, kind: "pay" | "payout"): Transaction[] =>
  vi
    .mocked(store.record as (row: Transaction, opts?: { replaces?: string }) => unknown)
    .mock.calls.filter(([row]) => (row.action === PaylinkActionEnum.PAY) === (kind === "pay"))
    .map(([row]) => row)

describe("rebuildPaylinks", () => {
  it("writes one PAY row per unknown, unspent funding transfer of the account, oldest first", async () => {
    const { deps, store, paylinkService } = makeDeps([
      event({ txHash: "0x2", blockNumber: 20 }),
      event({ txHash: "0x1", blockNumber: 10 }),
      event({ txHash: "0xknown", blockNumber: 30 }),
      event({ txHash: "0xin", from: "0xother", to: ME }), // a receive
      event({ txHash: "0xplain", paylinkCreated: undefined }), // a plain send
      event({ txHash: "0xforged", to: "0xelsewhere" }), // lane does not derive the payee
    ])

    const { created, complete } = await rebuildPaylinks(deps)

    expect(deps.source.listIncoming).toHaveBeenCalledWith(1, 41)
    expect(created.map((r) => r.txHash)).toEqual(["0x1", "0x2"])
    expect(complete).toBe(true)
    expect(paylinkService.recoverPaylinkFromTransfer).toHaveBeenCalledTimes(3)
    expect(paylinkService.recoverPaylinkFromTransfer).toHaveBeenCalledWith(
      expect.anything(),
      MASTER_SECRET,
    )
    expect(recorded(store, "pay")[0]).toMatchObject({
      txHash: "0x1",
      flavor: "direct",
      blockNumber: 10,
      timestamp: 1_000,
      payToEmailSecret: secret.toString(),
      fallbackSecret: fallbackSecret.toString(),
      obsidionAccountAddress: ME.toUpperCase(),
      tokenAddress: "0xtoken",
      paylink: "https://link/0x1",
      fromClaimable: 100,
      untilClaimable: 200,
      refundableUntil: 200,
      memo: "lunch",
      networkId: "network-A",
      token: { symbol: "DAI", amount: 2.5, price: 1 },
    })
    expect(recorded(store, "pay")[1]).toMatchObject({
      txHash: "0x2",
      timestamp: 9_999,
    })
  })

  it("defers a link whose note cannot be read, and says the pass is not complete", async () => {
    const { deps, store } = makeDeps([event({ txHash: "0x1" })], {
      sync_note: vi.fn().mockRejectedValue(new Error("not synced")),
    })

    expect(await rebuildPaylinks(deps)).toEqual({ created: [], complete: false })
    expect(recorded(store, "pay")).toEqual([])
  })

  it("is not complete when aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps } = makeDeps([event({ txHash: "0x1" })])

    expect(await rebuildPaylinks({ ...deps, signal: controller.signal })).toEqual({
      created: [],
      complete: false,
    })
  })

  // Claimed at the claim's block, whose time the source reads as 5_000.
  const CLAIMED = { isClaimed: true, claimedAt: 5_000, claimedBy: "self" }
  const REFUNDED = { isRefunded: true, refundTxHash: "0xpayout" }
  it.each([
    [
      "no payout: someone else claimed it",
      {},
      undefined,
      { ...CLAIMED, claimedBy: "chain" },
      undefined,
    ],
    [
      "an empty payout carrying the verified lane: a self-claim",
      { memo: undefined },
      { paylinkPayout: lane },
      CLAIMED,
      PaylinkActionEnum.CLAIM,
    ],
    [
      "a payout forwarding the tag: a self-claim",
      { senderTag: "me", memo: undefined },
      { senderTag: "me" },
      CLAIMED,
      PaylinkActionEnum.CLAIM,
    ],
    [
      "a payout forwarding the memo: a self-claim",
      { memo: "lunch" },
      { memo: "lunch" },
      CLAIMED,
      PaylinkActionEnum.CLAIM,
    ],
    [
      "an empty payout of a tagged link: a refund",
      { senderTag: "me", memo: "lunch" },
      {},
      REFUNDED,
      PaylinkActionEnum.CLAIM_BACK,
    ],
    [
      "an empty payout of a bare link: a refund by default",
      { memo: undefined },
      {},
      REFUNDED,
      PaylinkActionEnum.CLAIM_BACK,
    ],
  ])("classifies a spent escrow with %s", async (_, fundingMeta, payoutMeta, row, payoutAction) => {
    const funding = event({ senderTag: undefined, ...fundingMeta })
    const payout = event({
      txHash: "0xpayout",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      memo: undefined,
      senderTag: undefined,
      ...payoutMeta,
    })
    const { deps, store, paylinkService } = makeDeps(payoutMeta ? [funding, payout] : [funding], {
      paylinkClaimBlock: vi.fn(async () => 12),
    })

    await rebuildPaylinks(deps)

    expect(paylinkService.sync_note).not.toHaveBeenCalled()
    const written = recorded(store, "pay")[0]
    expect(written).toMatchObject({ txHash: "0x1", untilClaimable: undefined, ...row })
    if (!("isRefunded" in row)) expect(written).not.toHaveProperty("isRefunded")
    if (!("isClaimed" in row)) expect(written).not.toHaveProperty("claimedAt")
    if (payoutAction) {
      expect(recorded(store, "payout")).toEqual([
        expect.objectContaining({ action: payoutAction, txHash: "0xpayout", blockNumber: 12 }),
      ])
    } else {
      expect(recorded(store, "payout")).toEqual([])
    }
  })
})

describe("paylink rescan cursor", () => {
  const KEY = `@obsidion/paylink-rescan/cursor/v2/network-A/${ME}`
  const cursors = (backend: MemoryBackend) =>
    [...backend.entries.keys()].filter((k) => k.startsWith("@obsidion/paylink-rescan/"))

  it("resumes a reorg margin behind the saved cursor and saves PXE's synced block", async () => {
    const { deps, backend } = makeDeps([])
    const source = { ...deps.source, anchorBlock: vi.fn(async () => 38) }
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 41)
    expect(backend.entries.get(KEY)).toBe("38")

    backend.entries.set(KEY, "100")
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 41)
    expect(backend.entries.get(KEY)).toBe("38")

    backend.entries.set(KEY, "30")
    source.headBlock.mockResolvedValue(200)
    source.anchorBlock.mockResolvedValue(200)
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(1, 201)
    await rebuildPaylinks({ ...deps, source })
    expect(source.listIncoming).toHaveBeenLastCalledWith(200 - 64, 201)
  })

  it("keeps neither the rebuilt rows nor the cursor when their save fails", async () => {
    const { deps, store, backend } = makeDeps([event({ txHash: "0x1", blockNumber: 10 })])
    await store.ready
    backend.failing.commits = true
    await expect(rebuildPaylinks(deps)).rejects.toMatchObject({ code: "unknown" })
    expect(await store.hasTxHash("0x1")).toBe(false)
    expect(backend.entries.get(KEY)).toBeUndefined()
    backend.failing.commits = false
    expect((await rebuildPaylinks(deps)).created.map((r) => r.txHash)).toEqual(["0x1"])
    expect(backend.entries.get(KEY)).toBe("40")
  })

  it("holds the cursor below a link whose note is not readable yet, and saves nothing when aborted", async () => {
    const { deps, backend } = makeDeps(
      [event({ txHash: "0x1", blockNumber: 10 }), event({ txHash: "0x2", blockNumber: 20 })],
      {
        sync_note: vi
          .fn()
          .mockResolvedValueOnce({ claimableFrom: 1, claimableUntil: 2, refundableUntil: 2 })
          .mockRejectedValueOnce(new Error("not synced")),
      },
    )
    await rebuildPaylinks(deps)
    expect(backend.entries.get(KEY)).toBe("19")

    const controller = new AbortController()
    controller.abort()
    backend.entries.set(KEY, "5")
    await rebuildPaylinks({ ...deps, signal: controller.signal })
    expect(backend.entries.get(KEY)).toBe("5")
  })

  describe("endpoint scope", () => {
    const SCOPED_KEY = `@obsidion/paylink-rescan/cursor/v2/network-A/A/${ME}`

    it("keeps the cursor under the scoped key and never touches the unscoped one", async () => {
      const { deps, backend } = makeDeps([])
      await rebuildPaylinks({ ...deps, endpointScope: "A" })
      expect(cursors(backend)).toEqual([SCOPED_KEY])
      expect(backend.entries.get(SCOPED_KEY)).toBe("40")
    })

    it("uses the unscoped key without a scope", async () => {
      const { deps, backend } = makeDeps([])
      await rebuildPaylinks(deps)
      expect(cursors(backend)).toEqual([KEY])
    })

    it("a scoped pass advances its own cursor; the unscoped pass resumes from its older one", async () => {
      const { deps, backend } = makeDeps([])
      const source = { ...deps.source, anchorBlock: vi.fn(async () => 200) }
      source.headBlock.mockResolvedValue(200)
      backend.entries.set(KEY, "100")

      await rebuildPaylinks({ ...deps, source, endpointScope: "A" })
      expect(source.listIncoming).toHaveBeenLastCalledWith(1, 201) // cursorless under A
      expect(backend.entries.get(SCOPED_KEY)).toBe("200")
      expect(backend.entries.get(KEY)).toBe("100")

      await rebuildPaylinks({ ...deps, source })
      expect(source.listIncoming).toHaveBeenLastCalledWith(100 - 64, 201)
      expect(backend.entries.get(KEY)).toBe("200")
      expect(backend.entries.get(SCOPED_KEY)).toBe("200")
    })
  })
})

describe("paylink rescan ownership", () => {
  it.each(["send-first", "paylink-first"])("keeps one complete PAY row when %s", async (order) => {
    const { deps } = makeDeps([event({})])
    const storage = seededActivity()
    const writeSend = () =>
      storage.record(
        scannedRow({
          action: "send",
          txHash: "0x1",
          from: ME,
          senderL2Address: ME,
          to: "0xescrow",
          token: { ...TOKEN, name: "DAI", logo: "", amount: 2.5, price: 0 },
          amountAtomic: 2_500_000_000_000_000_000n,
          timestamp: 1_000,
          networkId: "network-A",
        }),
      )
    if (order === "send-first") await writeSend()
    expect(
      (await rebuildPaylinks({ ...deps, store: storage, db: storage.db })).created,
    ).toHaveLength(1)
    // Also covers a scanner that passed its hasTxHash check before recovery wrote.
    if (order === "paylink-first") await writeSend()
    expect((await rebuildPaylinks({ ...deps, store: storage, db: storage.db })).created).toEqual([])
    expect(await storage.all()).toEqual([
      expect.objectContaining({
        txHash: "0x1",
        flavor: "direct",
        paylink: "https://link/0x1",
        fallbackSecret: fallbackSecret.toString(),
      }),
    ])
  })

  it("turns a refunded link's send and payout receive into one refunded PAY row", async () => {
    const payout = event({
      txHash: "0x2",
      from: "0xescrow",
      to: ME,
      paylinkCreated: undefined,
      memo: undefined,
    })
    const { deps } = makeDeps([event({}), payout], { paylinkClaimBlock: vi.fn(async () => 12) })
    const storage = seededActivity()
    const token = { ...TOKEN, name: "DAI", logo: "", amount: 2.5, price: 0 }
    const row = {
      token,
      amountAtomic: 2_500_000_000_000_000_000n,
      timestamp: 1_000,
      networkId: "network-A",
      senderL2Address: ME,
    }
    await storage.record(
      scannedRow({ ...row, action: "send", txHash: "0x1", from: ME, to: "0xescrow" }),
    )
    await storage.record(
      scannedRow({ ...row, action: "receive", txHash: "0x2", from: "0xescrow", to: ME }),
    )

    await rebuildPaylinks({ ...deps, store: storage, db: storage.db })

    const rows = await storage.all()
    expect(rows).toEqual([
      expect.objectContaining({
        txHash: "0x1",
        action: PaylinkActionEnum.PAY,
        isRefunded: true,
        isClaimed: false,
        refundTxHash: "0x2",
      }),
      expect.objectContaining({ txHash: "0x2", action: PaylinkActionEnum.CLAIM_BACK }),
    ])
    expect((rows[0] as { paylink?: string }).paylink).toBeUndefined()
    // The transfer scanner now sees the payout as filed.
    expect(await storage.hasTxHash("0x2")).toBe(true)
  })

  it("settles a PAY row that read claimed once its refund payout lands", async () => {
    const funding = event({})
    const payout = event({
      txHash: "0x2",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      memo: undefined,
    })
    const { deps } = makeDeps([funding], { paylinkClaimBlock: vi.fn(async () => 12) })
    const storage = seededActivity()

    // The funding event is decrypted before the payout: the link reads claimed by someone else.
    await rebuildPaylinks({ ...deps, store: storage, db: storage.db })
    expect(await storage.all()).toEqual([
      expect.objectContaining({ txHash: "0x1", isClaimed: true, paylink: "https://link/0x1" }),
    ])

    deps.source.listIncoming.mockResolvedValue([funding, payout])
    await rebuildPaylinks({ ...deps, store: storage, db: storage.db })
    await rebuildPaylinks({ ...deps, store: storage, db: storage.db }) // idempotent
    const rows = await storage.all()
    expect(rows).toEqual([
      expect.objectContaining({
        txHash: "0x1",
        isRefunded: true,
        isClaimed: false,
        refundTxHash: "0x2",
      }),
      expect.objectContaining({ txHash: "0x2", action: PaylinkActionEnum.CLAIM_BACK }),
    ])
    expect((rows[0] as { paylink?: string }).paylink).toBeUndefined()
  })

  it("persists the source network", async () => {
    const { deps } = makeDeps([event({})])
    const storage = seededActivity()

    await rebuildPaylinks({ ...deps, store: storage, db: storage.db })

    expect(await storage.all()).toEqual([
      expect.objectContaining({ txHash: "0x1", networkId: "network-a" }),
    ])
  })

  it.each(["events", "note", "link"])(
    "does not write after disposal during %s discovery",
    async (stage) => {
      const controller = new AbortController()
      const { deps, store, paylinkService, linkFor } = makeDeps([event({})])
      if (stage === "events") {
        deps.source.listIncoming.mockImplementation(async () => {
          controller.abort()
          return [event({})]
        })
      } else if (stage === "note") {
        paylinkService.sync_note.mockImplementation(async () => {
          controller.abort()
          return { claimableFrom: 100, claimableUntil: 200, refundableUntil: 200 }
        })
      } else {
        linkFor.mockImplementation(async () => {
          controller.abort()
          return "https://link/0x1"
        })
      }

      expect((await rebuildPaylinks({ ...deps, signal: controller.signal })).created).toEqual([])
      expect(recorded(store, "pay")).toEqual([])
    },
  )
})

describe("a rebuilt claim in the bell", () => {
  // The link was funded at 1_000 and claimed at 5_000: a day after the claim, its creation is old.
  const now = 5_000 + NOTIFICATION_WINDOW_MS - 1
  async function rebuiltClaim(...passes: ScannedTransferEvent[][]) {
    const storage = seededActivity()
    for (const events of passes) {
      const { deps } = makeDeps(events, { paylinkClaimBlock: vi.fn(async () => 12) })
      await rebuildPaylinks({ ...deps, store: storage, db: storage.db })
    }
    const sources = {
      rows: [...(await storage.all())],
      oldVersionWithdrawals: [],
      deposits: { records: [], hydrated: true },
      withdrawals: { records: [], hydrated: true },
      upgrades: { items: [], recipients: new Set<string>(), loaded: true },
      processing: new Map(),
      registrations: [],
      operations: { ended: [], running: [] },
      loaded: true,
    }
    return deriveNotifications(sources, new Map(), now).filter((e) => e.id.startsWith("paylink:"))
  }

  it("rings for a link another account claimed within the window, whenever it was made", async () => {
    const [entry] = await rebuiltClaim([event({})])
    expect(entry).toMatchObject({ timestampMs: 5_000, settledAt: 5_000 })
    expect(isOld(entry!, () => false, now)).toBe(false)
  })

  it("stays quiet for a link this account claimed itself", async () => {
    const payout = event({
      txHash: "0xpayout",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      paylinkPayout: lane,
      memo: undefined,
    })
    expect(await rebuiltClaim([event({}), payout])).toEqual([])
  })

  it("stays quiet once its payout to this account turns up in a later pass", async () => {
    const payout = event({
      txHash: "0xpayout",
      from: "0xescrow",
      to: ME,
      blockNumber: 12,
      paylinkCreated: undefined,
      paylinkPayout: lane,
      memo: undefined,
    })
    expect(await rebuiltClaim([event({})], [event({}), payout])).toEqual([])
  })
})
