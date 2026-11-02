import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import {
  BackupSetConflictError,
  VerificationUnavailableError,
  type PersistedRotationVerdict,
  type SpendShape,
} from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import {
  cancelRotation,
  cancellable,
  finishRotation,
  fundRotation,
  FundingCheckpointError,
  moveRotation,
  noteRecovery,
  PUBLISH_BOUND,
  PUBLISH_INTERVAL_MS,
  publishDue,
  publishLanded,
  publishRotation,
  recordPublishLanded,
  recordPublishSend,
  rerootRotation,
  resumeRotation,
  retryMove,
  RotationFlowError,
  signRotation,
  txOutcome,
  watchRotation,
  type FundingRow,
  type RotationFlowDeps,
  type SweepSeen,
} from "../../../src/core/rotation/backupRotationFlow"
import {
  BackupRotationStore,
  fundingLocalId,
  moveDeclined,
  moveProgress,
  persistedRotation,
  type BackupPublish,
} from "../../../src/core/storages/BackupRotationStore"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import {
  addr,
  funding,
  OWNER,
  PLAN,
  rotationRecord,
  SIPA,
  signedRecord,
  storedRotation,
  word,
} from "../../__test-helpers__/backupRotation"

const VERIFIED = { verdict: "verified" } as unknown as PersistedRotationVerdict
const CORRUPT: PersistedRotationVerdict = { verdict: "corrupt", reason: "the signature" }
const DAI = 10n ** 18n
const receipt = (status: TxStatus, reverted = false, block = 9) => ({
  status,
  executionResult: reverted ? TxExecutionResult.REVERTED : TxExecutionResult.SUCCESS,
  blockNumber: block,
  blockHash: `0xb${block}`,
})

/** The deposit address's balance per block tag, for the reads that take one. */
const balances = (deps: RotationFlowDeps, latest: bigint, finalized: bigint) =>
  (deps.l1.sipaBalance as ReturnType<typeof vi.fn>).mockImplementation(
    async (_sipa: string, at?: string) => (at === "latest" ? latest : finalized),
  )

interface World {
  clock: { t: number }
  receipts: Map<string, ReturnType<typeof receipt>>
  finalizedAt: number
  rows: Map<string, FundingRow>
  balance: bigint
  sweep?: SweepSeen
  recovery?: `0x${string}`
  final: boolean
  releaseFinal: boolean
  shape: SpendShape
  hashes: number
}

function harness(over: Partial<World> = {}) {
  const world: World = {
    clock: { t: 2000 },
    receipts: new Map(),
    finalizedAt: 0,
    rows: new Map(),
    balance: 0n,
    final: true,
    releaseFinal: true,
    shape: { notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI },
    hashes: 0,
    ...over,
  }
  const storage = new InMemoryStorageAdapter()
  const store = new BackupRotationStore(storage)
  let minted = 1
  const nextHash = () => word(0x100 + ++world.hashes)
  const deps: RotationFlowDeps = {
    store,
    now: () => world.clock.t,
    mintAttemptId: () => `attempt-${++minted}`,
    activeSince: 1000,
    session: "life-1",
    verify: vi.fn(async () => VERIFIED),
    fundability: vi.fn(async () => "fundable" as const),
    route: vi.fn(async () => "ok" as const),
    l1: {
      finalizedBlock: vi.fn(async () => ({ number: 100, hash: word(0xf1) })),
      isFinal: vi.fn(async () => world.final),
      sipaBalance: vi.fn(async () => world.balance),
      sweep: vi.fn(async () => world.sweep),
      recovery: vi.fn(async () => world.recovery),
      releaseFinal: vi.fn(async () => world.releaseFinal),
    },
    node: {
      getTxReceipt: vi.fn(async (hash: string) => {
        const r = world.receipts.get(hash)
        if (r === undefined) return receipt(TxStatus.DROPPED)
        return r
      }),
      finalizedTimestampMs: vi.fn(async () => world.finalizedAt),
    },
    tracker: {
      row: vi.fn(async (localId: string) => world.rows.get(localId)),
      stamp: vi.fn(async () => undefined),
    },
    sign: vi.fn(async () => "0x26" as const),
    publish: vi.fn(async () => undefined),
    republish: vi.fn(async () => undefined),
    fund: vi.fn(async (_r, _f, onTxHash) => {
      const hash = nextHash()
      world.receipts.set(hash, receipt(TxStatus.PENDING))
      await onTxHash(hash, { expiresAtMs: 5000 })
    }),
    reroot: vi.fn(async () => ({ switched: true, rebound: true })),
    move: {
      tokens: vi.fn(async () => ["tok"]),
      shape: vi.fn(async () => world.shape),
      deposits: vi.fn(async () => ({ kind: "exact" as const, amounts: [] })),
      cap: 2n * DAI,
      usesLeft: vi.fn(async () => true),
      send: vi.fn(async (_t: string, _a: bigint, onTxHash) => {
        const hash = nextHash()
        world.receipts.set(hash, receipt(TxStatus.PENDING))
        await onTxHash(hash, { expiresAtMs: 5000 })
      }),
      declined: vi.fn(
        (err: unknown) => err instanceof DOMException && err.name === "NotAllowedError",
      ),
    },
  }
  return { deps, world, store, storage }
}

const prepared = (() => {
  const { signature: _s, ...rest } = persistedRotation(storedRotation())
  return rest
})()

describe("txOutcome", () => {
  const node = (r: ReturnType<typeof receipt> | Error, finalizedAt = 0) => ({
    getTxReceipt: async () => {
      if (r instanceof Error) throw r
      return r
    },
    finalizedTimestampMs: async () => finalizedAt,
  })

  it.each([TxStatus.PROPOSED, TxStatus.CHECKPOINTED, TxStatus.PROVEN])(
    "%s with success is included, with its block kept",
    async (status) => {
      expect(await txOutcome(node(receipt(status)), "0x1", 10)).toEqual({
        kind: "included",
        blockNumber: 9,
        blockHash: "0xb9",
        effect: "success",
        checkpointed: status !== TxStatus.PROPOSED,
      })
    },
  )

  it("finalized is mined, or reverted", async () => {
    expect(await txOutcome(node(receipt(TxStatus.FINALIZED)), "0x1", 10)).toEqual({ kind: "mined" })
    expect(await txOutcome(node(receipt(TxStatus.FINALIZED, true)), "0x1", 10)).toEqual({
      kind: "reverted",
    })
  })

  it("reverted at a reorgable tier is included with the effect, authorizing nothing", async () => {
    expect(await txOutcome(node(receipt(TxStatus.PROVEN, true)), "0x1", 10)).toMatchObject({
      kind: "included",
      effect: "reverted",
    })
  })

  it("pending stays pending", async () => {
    expect(await txOutcome(node(receipt(TxStatus.PENDING)), "0x1", 10)).toEqual({ kind: "pending" })
  })

  it("a missing transaction with no expiry known stays pending", async () => {
    expect(await txOutcome(node(receipt(TxStatus.DROPPED), 11), "0x1", undefined)).toEqual({
      kind: "pending",
    })
  })

  it("dropped is pending until the finalized tip passes the expiry, then dead", async () => {
    expect(await txOutcome(node(receipt(TxStatus.DROPPED), 10), "0x1", 10)).toEqual({
      kind: "pending",
    })
    expect(await txOutcome(node(receipt(TxStatus.DROPPED), 11), "0x1", 10)).toEqual({
      kind: "dead",
    })
  })

  it("a missing transaction stays pending while the wallet's clock is before the expiry, whatever the tip says", async () => {
    expect(await txOutcome(node(receipt(TxStatus.DROPPED), 11), "0x1", 10, 9)).toEqual({
      kind: "pending",
    })
    expect(await txOutcome(node(receipt(TxStatus.DROPPED), 11), "0x1", 10, 11)).toEqual({
      kind: "dead",
    })
  })

  it("reads a missing transaction again once the tip passed its expiry, so an inclusion between the reads counts", async () => {
    const receipts = [receipt(TxStatus.DROPPED), receipt(TxStatus.FINALIZED)]
    const racing = {
      getTxReceipt: async () => receipts.shift()!,
      finalizedTimestampMs: async () => 11,
    }
    expect(await txOutcome(racing, "0x1", 10)).toEqual({ kind: "mined" })
    expect(receipts).toHaveLength(0)
  })

  it("a read that fails is unknown", async () => {
    expect(await txOutcome(node(new Error("down")), "0x1", 10)).toEqual({ kind: "unknown" })
    const tipDown = {
      ...node(receipt(TxStatus.DROPPED)),
      finalizedTimestampMs: async () => Promise.reject(new Error("down")),
    }
    expect(await txOutcome(tipDown, "0x1", 10)).toEqual({ kind: "unknown" })
  })
})

describe("the happy path", () => {
  it("walks created → signed → published → funded → swept → rerooted → moved → done", async () => {
    const { deps, world, store } = harness()
    await store.put(rotationRecord())
    const signed = await signRotation(deps, (await store.get(OWNER))!, {
      prepared,
      plan: PLAN,
      fromBlock: 50,
    })
    expect(signed.phase).toBe("signed")
    expect(signed.rotation?.signature).toBe("0x26")
    expect(signed.fromBlock).toBe(50)

    const published = (await publishRotation(deps, signed)).record
    expect(published.phase).toBe("published")
    expect(deps.publish).toHaveBeenCalledTimes(1)
    expect(published.publish).toEqual({ count: 0, history: [] })

    const funded = (await fundRotation(deps, published)).record
    expect(funded.phase).toBe("funded")
    expect(funded.fundings).toHaveLength(1)
    expect(funded.fundings[0]).toMatchObject({
      attemptId: "attempt-1",
      txHash: word(0x101),
      expiresAtMs: 5000,
      outcome: "pending",
    })
    expect(deps.tracker.stamp).toHaveBeenCalledWith("wdraw_backup_attempt-1", word(0x101))

    expect(await watchRotation(deps, funded)).toEqual({ record: funded, wait: "sweep" })
    world.receipts.set(word(0x101), receipt(TxStatus.FINALIZED))
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "done",
      l2TxHash: word(0x101),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    const swept = (await watchRotation(deps, funded)).record
    expect(swept.phase).toBe("swept")
    expect(swept.sweep).toEqual({ index: "3", blockHash: word(0x60), credited: "1400" })
    expect(swept.fundings[0]?.outcome).toBe("swept")

    const rerooted = await rerootRotation(deps, swept)
    expect(rerooted.phase).toBe("rerooted")
    expect(rerooted.reroot).toEqual({ switched: true, rebound: true })

    const first = await moveRotation(deps, rerooted)
    expect(first.wait).toBe("chunk")
    expect(deps.move.send).toHaveBeenCalledWith("tok", 2n * DAI, expect.any(Function), undefined)
    expect(first.record.move?.runs[0]).toMatchObject({ m: 2, depositBound: false })
    expect(first.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x102),
    })

    world.receipts.set(word(0x102), receipt(TxStatus.PROPOSED))
    world.shape = { notes: [DAI], depositTotal: 0n, balance: DAI }
    const second = await moveRotation(deps, first.record)
    expect(second.record.move?.runs[0]?.chunks.map((c) => c.state)).toEqual([
      "included",
      "submitted",
    ])
    world.receipts.set(word(0x103), receipt(TxStatus.PROPOSED))
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    const moved = await moveRotation(deps, second.record)
    expect(moved.record.phase).toBe("moved")
    expect(moved.record.move?.runs[0]?.chunks.every((c) => c.state === "included")).toBe(true)

    world.receipts.set(word(0x102), receipt(TxStatus.CHECKPOINTED))
    world.receipts.set(word(0x103), receipt(TxStatus.PROVEN))
    const done = (await moveRotation(deps, moved.record)).record
    expect(done.phase).toBe("done")
    expect(done.rotation?.signature).toBeUndefined()
    expect(done.backup.envelopeHex).toBeUndefined()
    expect(done.rotation?.sharedSecretSalt).toBeUndefined()
    expect(done.rotation?.sipa).toBe(SIPA)
  })

  it("resume at each phase runs exactly the next step", async () => {
    const { deps, world, store } = harness()
    await store.put(signedRecord("signed"))
    expect((await resumeRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("published")
    expect(deps.verify).toHaveBeenCalledTimes(1)
    expect(await resumeRotation(deps, (await store.get(OWNER))!)).toMatchObject({ wait: "funding" })
    expect(deps.fund).not.toHaveBeenCalled()
    await fundRotation(deps, (await store.get(OWNER))!)
    expect(await resumeRotation(deps, (await store.get(OWNER))!)).toMatchObject({ wait: "sweep" })
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    const swept = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(swept.record.phase).toBe("rerooted")
    expect(deps.reroot).toHaveBeenCalledTimes(1)
    const asking = await resumeRotation(deps, swept.record)
    expect(asking.wait).toBe("approval")
    expect(deps.move.send).not.toHaveBeenCalled()
    const moving = await resumeRotation(deps, asking.record, { prompt: true })
    expect(moving.wait).toBe("chunk")
    expect(deps.move.send).toHaveBeenCalledTimes(1)
  })

  it("stops before a chunk's send once the screen the tap came from has closed", async () => {
    const { deps, store } = harness()
    const send = deps.move.send as ReturnType<typeof vi.fn>
    const closed = new AbortController()
    closed.abort()
    await store.put(signedRecord("rerooted"))
    const approved = await resumeRotation(deps, (await store.get(OWNER))!, {
      prompt: true,
      signal: closed.signal,
    })
    expect(approved.wait).toBe("approval")
    expect(send).not.toHaveBeenCalled()

    send.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    const declined = await resumeRotation(deps, approved.record, { prompt: true })
    expect(declined.wait).toBe("declined")
    const retried = await retryMove(deps, declined.record, { signal: closed.signal })
    expect(retried.wait).toBe("approval")
    expect(moveDeclined(retried.record)).toBe(false)
    expect(retried.record.move?.runs[0]?.chunks.map((c) => c.state)).toEqual(["planned", "planned"])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("puts a chunk back to wait for a tap when its screen closes before the prompt opens", async () => {
    const { deps, store } = harness()
    const send = deps.move.send as ReturnType<typeof vi.fn>
    const planned = ["planned", "planned"]
    // The screen closes while the send prepares; the key then refuses to ask.
    const open = new AbortController()
    send.mockImplementationOnce(async (_t, _a, _h, signal?: AbortSignal) => {
      open.abort()
      signal?.throwIfAborted()
    })
    await store.put(signedRecord("rerooted"))
    const closed = await resumeRotation(deps, (await store.get(OWNER))!, {
      prompt: true,
      signal: open.signal,
    })
    expect(send.mock.calls[0]![3]).toBe(open.signal)
    expect(closed.wait).toBe("approval")
    expect(moveDeclined(closed.record)).toBe(false)
    expect(closed.record.move?.runs[0]?.chunks.map((c) => c.state)).toEqual(planned)

    // Any other failure still throws, closed screen or not.
    const later = new AbortController()
    send.mockImplementationOnce(async () => {
      later.abort()
      throw new Error("node down")
    })
    await expect(
      resumeRotation(deps, closed.record, { prompt: true, signal: later.signal }),
    ).rejects.toThrow("node down")

    const sent = await resumeRotation(deps, (await store.get(OWNER))!, { prompt: true })
    expect(sent.wait).toBe("chunk")
    expect(send).toHaveBeenCalledTimes(3)
  })

  it("a resume that lifts a route park stops before the move's send unless it may prompt", async () => {
    const { deps, store } = harness()
    await store.put(
      signedRecord("attention", {
        attention: "route",
        suspended: "rerooted",
        sweep: { index: "3", blockHash: word(0x60), credited: "1400" },
      }),
    )
    const asking = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(asking).toMatchObject({ wait: "approval", record: { phase: "rerooted" } })
    expect(deps.move.send).not.toHaveBeenCalled()
    expect(asking.record.move?.runs[0]?.chunks.map((c) => c.state)).toEqual(["planned", "planned"])
    const sent = await resumeRotation(deps, asking.record, { prompt: true })
    expect(sent.wait).toBe("chunk")
    expect(deps.move.send).toHaveBeenCalledTimes(1)
  })
})

describe("publishing", () => {
  it("parks the attempt when the route does not pay, and returns it where it was when it does again", async () => {
    const { deps, store } = harness()
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce("route")
    await store.put(signedRecord("signed"))
    const parked = (await publishRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "route", suspended: "signed" })
    expect(deps.publish).not.toHaveBeenCalled()
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce("route")
    expect((await resumeRotation(deps, parked)).record.phase).toBe("attention")
    const back = (await resumeRotation(deps, parked)).record
    expect(back).toMatchObject({ phase: "published", suspended: undefined, attention: undefined })
    expect(deps.publish).toHaveBeenCalledTimes(1)
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce("route")
    const parkedAgain = (await fundRotation(deps, back)).record
    expect(parkedAgain).toMatchObject({ phase: "attention", suspended: "published" })
    expect(await resumeRotation(deps, parkedAgain)).toMatchObject({
      wait: "funding",
      record: { phase: "published" },
    })
    expect(deps.publish).toHaveBeenCalledTimes(1)
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("publishes nothing for a replacement signed while the first publish was still on the rail", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("signed"))
    const record = (await store.get(OWNER))!
    let release!: () => void
    const enqueuing = new Promise<void>((r) => (release = r))
    ;(deps.publish as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await enqueuing
    })
    const slow = publishRotation(deps, record)
    await new Promise((r) => setTimeout(r, 0))
    const replacement = signedRecord("signed", { rotation: storedRotation({ sipa: addr(21) }) })
    await store.put(replacement)
    release()
    await expect(slow).rejects.toThrow("moved on")
    expect(await store.get(OWNER)).toMatchObject({ phase: "signed", rotation: { sipa: addr(21) } })
    expect(deps.publish).toHaveBeenCalledTimes(1)
  })

  it("keeps the accounting the executor wrote while the publish was still enqueuing", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("signed"))
    const record = (await store.get(OWNER))!
    let release!: () => void
    const enqueuing = new Promise<void>((r) => (release = r))
    ;(deps.publish as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await enqueuing
    })
    const slow = publishRotation(deps, record)
    await new Promise((r) => setTimeout(r, 0))
    const counted = await recordPublishSend(deps, (await store.get(OWNER))!)
    await recordPublishLanded(deps, counted, { txHash: word(0x77), l2Block: 12 })
    release()
    const published = (await slow).record
    expect(published.phase).toBe("published")
    expect(published.publish).toMatchObject({ count: 1, history: [{ l2Block: 12 }] })
    expect(publishLanded(published, 12)).toBe(true)
  })

  it("marks a conflict when the keys moved, and installed when the change already ran", async () => {
    const { deps, store } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new BackupSetConflictError("keys", [], []),
    )
    await store.put(signedRecord("signed"))
    expect((await publishRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("conflict")
    await store.put(signedRecord("signed"))
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValueOnce("applied")
    const installed = (await publishRotation(deps, (await store.get(OWNER))!)).record
    expect(installed).toMatchObject({ phase: "installed", installed: { blockHash: word(0xf1) } })
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it("restarts at created, the backup kept, when the factory no longer clones the signed change", async () => {
    const { deps, store } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    for (const phase of ["signed", "published"] as const) {
      await store.put(signedRecord(phase, { publish: { count: 1, history: [] } }))
      const restarted = (await resumeRotation(deps, (await store.get(OWNER))!)).record
      expect(restarted).toMatchObject({
        phase: "created",
        plan: undefined,
        rotation: undefined,
        fromBlock: undefined,
        publish: undefined,
      })
      expect(restarted.backup.envelopeHex).toBe("01".repeat(62))
      expect(await store.get(OWNER)).toEqual(restarted)
    }
    await store.put(signedRecord("published"))
    expect((await fundRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("created")
    expect(deps.publish).not.toHaveBeenCalled()
    expect(deps.fund).not.toHaveBeenCalled()
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    expect((await resumeRotation(deps, (await store.get(OWNER))!)).record).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "funded",
    })
  })

  it("waits, unchanged, while the change is applied at latest only", async () => {
    const { deps, store } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied-pending")
    await store.put(signedRecord("signed"))
    const result = await publishRotation(deps, (await store.get(OWNER))!)
    expect(result).toMatchObject({ wait: "applied-pending", record: { phase: "signed" } })
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it("keeps the republish accounting: the count before each send, the landing after", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published", { publish: { count: 0, history: [] } }))
    const counted = await recordPublishSend(deps, (await store.get(OWNER))!)
    expect(counted.publish).toMatchObject({ count: 1, lastAt: 2000 })
    expect(publishDue(counted.publish, 2000 + PUBLISH_INTERVAL_MS - 1)).toEqual({
      due: false,
      at: 2000 + PUBLISH_INTERVAL_MS,
    })
    expect(publishDue(counted.publish, 2000 + PUBLISH_INTERVAL_MS)).toEqual({ due: true })
    expect(publishDue(undefined, 0)).toEqual({ due: true })
    const landed = await recordPublishLanded(deps, counted, { txHash: word(0x77), l2Block: 12 })
    expect(landed.publish?.history).toEqual([{ txHash: word(0x77), l2Block: 12, at: 2000 }])
    expect(publishLanded(landed, 12)).toBe(true)
    expect(publishLanded(landed, 13)).toBe(false)
  })
})

describe("funding", () => {
  it("marks a send that threw before its hash never-sent, and Fund again mints a new id beside it", async () => {
    const { deps, store } = harness()
    ;(deps.fund as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("proof failed"))
    await store.put(signedRecord("published"))
    await expect(fundRotation(deps, (await store.get(OWNER))!)).rejects.toThrow("proof failed")
    const after = (await store.get(OWNER))!
    expect(after.phase).toBe("published")
    expect(after.fundings).toMatchObject([{ attemptId: "attempt-1", outcome: "never-sent" }])
    const again = (await fundRotation(deps, after)).record
    expect(again.phase).toBe("funded")
    expect(again.fundings.map((f) => f.attemptId)).toEqual(["attempt-1", "attempt-2"])
    expect(again.fundings[0]?.outcome).toBe("never-sent")
  })

  it("aborts the send when the hash cannot be written, so nothing goes out", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published"))
    const record = (await store.get(OWNER))!
    const sent: string[] = []
    ;(deps.fund as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_r, _f, onTxHash) => {
      await store.remove(OWNER)
      await onTxHash(word(0x101), { expiresAtMs: 5000 })
      sent.push("sent")
    })
    await expect(fundRotation(deps, record)).rejects.toThrow(FundingCheckpointError)
    expect(sent).toEqual([])
  })

  it("aborts the send when the tracker's row cannot be stamped, leaving the entry never-sent", async () => {
    const { deps, store } = harness()
    ;(deps.tracker.stamp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("locked"))
    await store.put(signedRecord("published"))
    await expect(fundRotation(deps, (await store.get(OWNER))!)).rejects.toThrow(
      FundingCheckpointError,
    )
    const after = (await store.get(OWNER))!
    expect(after.phase).toBe("published")
    expect(after.fundings[0]).toMatchObject({ txHash: word(0x101), outcome: "never-sent" })
  })

  it("declines the send when a resume parked the record while its funding proved, and the record still reads", async () => {
    const { deps, store, storage } = harness()
    await store.put(signedRecord("published"))
    const record = (await store.get(OWNER))!
    const sent: string[] = []
    ;(deps.fund as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_r, _f, onTxHash) => {
      const proving = (await store.get(OWNER))!
      await store.put({
        ...proving,
        phase: "attention",
        attention: "corrupt",
        suspended: "published",
      })
      await onTxHash(word(0x101), { expiresAtMs: 5000 })
      sent.push("sent")
    })
    await expect(fundRotation(deps, record)).rejects.toThrow(FundingCheckpointError)
    expect(sent).toEqual([])
    const after = (await new BackupRotationStore(storage).get(OWNER))!
    expect(after).toMatchObject({
      phase: "attention",
      attention: "corrupt",
      suspended: "published",
    })
    expect(after.fundings[0]).toMatchObject({ outcome: "never-sent" })
    expect(after.fundings[0]?.txHash).toBeUndefined()
  })

  it("sends once when two callers fund the same record", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published"))
    const record = (await store.get(OWNER))!
    const results = await Promise.allSettled([
      fundRotation(deps, record),
      fundRotation(deps, record),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(deps.fund).toHaveBeenCalledTimes(1)
    expect((await store.get(OWNER))?.fundings).toHaveLength(1)
  })

  it("refuses a second funding while one may still land", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    await expect(fundRotation(deps, (await store.get(OWNER))!)).rejects.toThrow(RotationFlowError)
    await store.put(signedRecord("published", { fundings: [funding({ txHash: undefined })] }))
    await expect(fundRotation(deps, (await store.get(OWNER))!)).rejects.toThrow("may still land")
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("moves on without a send when the deposit address already holds settled money", async () => {
    const { deps, store, world } = harness()
    world.balance = 1400n
    await store.put(
      signedRecord("published", {
        fundings: [funding({ txHash: undefined, outcome: "never-sent" })],
      }),
    )
    expect((await fundRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("funded")
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("sends the funding when the deposit address holds nothing", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published"))
    const funded = (await fundRotation(deps, (await store.get(OWNER))!)).record
    expect(funded.phase).toBe("funded")
    expect(deps.fund).toHaveBeenCalledTimes(1)
    expect(funded.fundings[0]?.txHash).toBeDefined()
  })

  it("re-runs the route and the fundability read before a funding", async () => {
    const { deps, store } = harness()
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce("route")
    await store.put(signedRecord("published"))
    const parked = (await fundRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "route" })
    expect(deps.fund).not.toHaveBeenCalled()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValueOnce("applied")
    await store.put(signedRecord("published"))
    const installed = (await fundRotation(deps, (await store.get(OWNER))!)).record
    expect(installed.phase).toBe("installed")
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("restarts a superseded change whose deposit address is empty, and strands one whose address holds money", async () => {
    const { deps, store, world } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    await store.put(signedRecord("published"))
    expect((await fundRotation(deps, (await store.get(OWNER))!)).record).toMatchObject({
      phase: "created",
      rotation: undefined,
    })
    world.balance = 500n
    await store.put(signedRecord("published"))
    expect((await fundRotation(deps, (await store.get(OWNER))!)).record).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "published",
    })
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("keeps a funding another caller sent while this one was still reading the factory", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published"))
    const record = (await store.get(OWNER))!
    let release!: () => void
    const reading = new Promise<void>((r) => (release = r))
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await reading
      return "superseded"
    })
    const slow = fundRotation(deps, record)
    await new Promise((r) => setTimeout(r, 0))
    const fast = await fundRotation(deps, record)
    expect(fast.record).toMatchObject({ phase: "funded", fundings: [{ txHash: word(0x101) }] })
    release()
    await expect(slow).rejects.toThrow("moved on")
    const kept = (await store.get(OWNER))!
    expect(kept).toMatchObject({ phase: "funded", fundings: [{ txHash: word(0x101) }] })
    expect(kept.rotation?.signature).toBeDefined()
    expect(deps.fund).toHaveBeenCalledTimes(1)
  })

  it("never restarts a replacement signed since the factory was read", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published"))
    const record = (await store.get(OWNER))!
    let release!: () => void
    const reading = new Promise<void>((r) => (release = r))
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await reading
      return "superseded"
    })
    const slow = fundRotation(deps, record)
    await new Promise((r) => setTimeout(r, 0))
    await store.put(signedRecord("published", { rotation: storedRotation({ sipa: addr(21) }) }))
    release()
    await expect(slow).rejects.toThrow("moved on")
    expect(await store.get(OWNER)).toMatchObject({
      phase: "published",
      rotation: { sipa: addr(21) },
    })
    expect(deps.fund).not.toHaveBeenCalled()
  })
})

describe("resume: reconciliation before any precondition", () => {
  it("leaves a record it cannot verify as it is", async () => {
    const { deps, store } = harness()
    ;(deps.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VerificationUnavailableError("the keys", new Error("down")),
    )
    const record = signedRecord("published")
    await store.put(record)
    expect(await resumeRotation(deps, record)).toEqual({ record, wait: "unverifiable" })
    expect(deps.fundability).not.toHaveBeenCalled()
  })

  it("keeps a corrupt record as attention, deletable only without funding evidence", async () => {
    const { deps, store, world } = harness()
    ;(deps.verify as ReturnType<typeof vi.fn>).mockResolvedValue(CORRUPT)
    await store.put(signedRecord("published"))
    const corrupt = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(corrupt).toMatchObject({ phase: "attention", attention: "corrupt" })
    world.balance = 1n
    await expect(cancelRotation(deps, corrupt)).rejects.toThrow("may have reached")
    expect(await store.get(OWNER)).not.toBeNull()
    world.balance = 0n
    await cancelRotation(deps, corrupt)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("recognizes a change that ran directly as installed, never corrupt", async () => {
    const { deps, store } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    for (const phase of ["signed", "published"] as const) {
      await store.put(signedRecord(phase))
      const result = await resumeRotation(deps, (await store.get(OWNER))!)
      expect(result.record.phase).toBe("rerooted")
      expect(deps.reroot).toHaveBeenCalled()
    }
  })

  it("does not install a change applied at latest only", async () => {
    const { deps, store } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied-pending")
    await store.put(signedRecord("published"))
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result).toMatchObject({ wait: "funding", record: { phase: "published" } })
  })

  it("finds a funding whose hash write was lost by the tracker's row, and never resends it", async () => {
    const { deps, store, world } = harness()
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "l2_mined",
      l2TxHash: word(0x55),
      startTime: 1500,
      recipient: SIPA,
    })
    world.receipts.set(word(0x55), receipt(TxStatus.PROVEN))
    await store.put(
      signedRecord("published", {
        fundings: [funding({ txHash: undefined, expiresAtMs: undefined })],
      }),
    )
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result.record).toMatchObject({
      phase: "funded",
      fundings: [{ txHash: word(0x55), outcome: "pending" }],
    })
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("treats a deposit address holding settled money as funded, and an empty one as not", async () => {
    const { deps, store, world } = harness()
    world.balance = 1400n
    await store.put(signedRecord("published"))
    expect((await resumeRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("funded")
    world.balance = 0n
    await store.put(signedRecord("published"))
    expect((await resumeRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("published")
  })

  it("returns a stranded attempt to the funding decision once its send died with nothing landed", async () => {
    const { deps, store, world } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "funded" })
    expect(cancellable(parked)).toBe(false)
    world.finalizedAt = 100
    const restarted = (await resumeRotation(deps, parked)).record
    expect(restarted).toMatchObject({
      phase: "created",
      attention: undefined,
      suspended: undefined,
    })
    expect(restarted.fundings[0]?.outcome).toBe("dead")
    expect(cancellable(restarted)).toBe(true)
  })

  it("strands a funded record whose signed change can no longer run, keeping the salt", async () => {
    const { deps, store } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BackupSetConflictError("keys", [], []),
    )
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "funded" })
    expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
    expect(cancellable(parked)).toBe(false)
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("marks a published record whose signed change can no longer run a conflict, unless money sits at its deposit address", async () => {
    const { deps, store } = harness()
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BackupSetConflictError("keys", [], []),
    )
    await store.put(signedRecord("published", { publish: { count: 3, history: [] } }))
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result.wait).toBeUndefined()
    expect(result.record).toMatchObject({ phase: "conflict", attention: undefined })
    expect(await store.get(OWNER)).toEqual(result.record)
    expect(cancellable(result.record)).toBe(true)
    balances(deps, 5n, 0n)
    await store.put(signedRecord("published"))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "published",
    })
    expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
  })

  it("strands a superseded signed change whose deposit address holds money, keeping the salt", async () => {
    const { deps, store } = harness({ balance: 5n })
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    await store.put(signedRecord("signed"))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "signed" })
    expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
    expect(await store.get(OWNER)).toEqual(parked)
    expect(cancellable(parked)).toBe(false)
  })

  it("keeps the salt when money reaches the deposit address between a stranded release and its re-read", async () => {
    const { deps, store } = harness({ balance: 5n })
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    ;(deps.l1.sipaBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0n)
    await store.put(signedRecord("attention", { attention: "stranded", suspended: "signed" }))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "signed" })
    expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
    expect(await store.get(OWNER)).toEqual(parked)
  })

  it("strands a superseded change over money at its deposit address not yet final, on resume and at publish", async () => {
    for (const step of [resumeRotation, publishRotation]) {
      const { deps, store } = harness()
      balances(deps, 5n, 0n)
      ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
      await store.put(signedRecord("signed"))
      const parked = (await step(deps, (await store.get(OWNER))!)).record
      expect(parked).toMatchObject({
        phase: "attention",
        attention: "stranded",
        suspended: "signed",
      })
      expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
    }
  })

  it("installs a signed change that ran directly while its route stayed parked", async () => {
    const { deps, store } = harness()
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValue("route")
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    await store.put(signedRecord("attention", { attention: "route", suspended: "signed" }))
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result.record).toMatchObject({
      phase: "rerooted",
      attention: undefined,
      suspended: undefined,
    })
    expect(deps.reroot).toHaveBeenCalledTimes(1)
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it("keeps a stranded report over a dead route, so the money's salt cannot be cancelled away", async () => {
    const { deps, store } = harness({ balance: 5n })
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValue("route")
    await store.put(signedRecord("signed"))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "signed" })
    expect(cancellable(parked)).toBe(false)
    await expect(cancelRotation(deps, parked)).rejects.toThrow("cannot be cancelled")
    expect((await store.get(OWNER))?.rotation?.sharedSecretSalt).toBe(
      storedRotation().sharedSecretSalt,
    )
  })

  it("reads the deposit address for a plan that credits nothing, and strands money found there", async () => {
    const { deps, store } = harness({ balance: 5n })
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    await store.put(signedRecord("signed", { plan: { ...PLAN, credited: "0" } }))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "signed" })
    expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
  })

  it("returns a funded record to published once its funding is dead, and not before", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("funded", { fundings: [funding({ expiresAtMs: 5000 })] }))
    world.clock.t = 5001
    world.finalizedAt = 4999
    expect((await resumeRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("funded")
    world.finalizedAt = 5001
    const back = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(back.phase).toBe("published")
    expect(back.fundings[0]?.outcome).toBe("dead")
  })

  it("keeps a record funded while its final funding awaits the sweep: no second send, no restart", async () => {
    const { deps, store, world } = harness()
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED))
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    const kept = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(kept).toMatchObject({ wait: "sweep", record: { phase: "funded" } })
    expect(kept.record.fundings[0]?.outcome).toBe("mined")
    expect(cancellable(kept.record)).toBe(false)
    await expect(fundRotation(deps, { ...kept.record, phase: "published" })).rejects.toThrow(
      "may still land",
    )
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    const parked = (await resumeRotation(deps, kept.record)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "funded" })
    expect(parked.rotation?.sipa).toBe(SIPA)
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("keeps a funding sent while a resume was still reading", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published"))
    const record = (await store.get(OWNER))!
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(deps.verify as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate
      return VERIFIED
    })
    const resumed = resumeRotation(deps, record)
    const sent = (await fundRotation(deps, record)).record
    expect(sent).toMatchObject({ phase: "funded", fundings: [{ txHash: word(0x101) }] })
    release()
    expect((await resumed).record).toMatchObject({
      phase: "funded",
      fundings: [{ txHash: word(0x101), outcome: "pending" }],
    })
    expect(deps.fund).toHaveBeenCalledTimes(1)
  })

  it("waits on a funding seeded while a resume was still reading, and restarts nothing", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("published"))
    const record = (await store.get(OWNER))!
    ;(deps.fundability as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("fundable")
      .mockResolvedValue("superseded")
    let releaseVerify!: () => void
    const verifying = new Promise<void>((r) => (releaseVerify = r))
    ;(deps.verify as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await verifying
      return VERIFIED
    })
    let releaseSend!: () => void
    const sending = new Promise<void>((r) => (releaseSend = r))
    ;(deps.fund as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_r, _f, onTxHash) => {
      await sending
      world.receipts.set(word(0x201), receipt(TxStatus.PENDING))
      await onTxHash(word(0x201), { expiresAtMs: 5000 })
    })
    const resumed = resumeRotation(deps, record)
    const funded = fundRotation(deps, record)
    await new Promise((r) => setTimeout(r, 0))
    releaseVerify()
    const paused = await resumed
    expect(paused).toMatchObject({ wait: "burn", record: { phase: "published" } })
    expect(paused.record.rotation).toBeDefined()
    releaseSend()
    const sent = (await funded).record
    expect(sent).toMatchObject({ phase: "funded", fundings: [{ txHash: word(0x201) }] })
    expect(sent.rotation).toBeDefined()
  })

  it("never promotes a published record on a hash whose send was aborted", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("published", { fundings: [funding({ outcome: "never-sent" })] }))
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result).toMatchObject({ wait: "funding", record: { phase: "published" } })
    expect(cancellable(result.record)).toBe(true)
  })

  it("takes a hash from the tracker's row with no expiry: only a receipt ends that funding", async () => {
    const { deps, store, world } = harness()
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "l2_submitted",
      l2TxHash: word(0x55),
      startTime: 1500,
      recipient: SIPA,
    })
    await store.put(
      signedRecord("published", {
        fundings: [funding({ txHash: undefined, expiresAtMs: undefined })],
      }),
    )
    world.finalizedAt = 5 + 2 * 86_400_000
    const adopted = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(adopted.fundings[0]).toMatchObject({ txHash: word(0x55), outcome: "pending" })
    expect(adopted.fundings[0]?.expiresAtMs).toBeUndefined()
    expect(adopted.phase).toBe("funded")
    expect(cancellable(adopted)).toBe(false)
    world.receipts.set(word(0x55), receipt(TxStatus.FINALIZED))
    expect((await resumeRotation(deps, adopted)).record.fundings[0]?.outcome).toBe("mined")
  })

  it("waits on a send this life of the wallet seeded before its row exists", async () => {
    const { deps, store } = harness()
    await store.put(
      signedRecord("published", {
        fundings: [funding({ txHash: undefined, expiresAtMs: undefined })],
      }),
    )
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result).toMatchObject({ wait: "burn", record: { phase: "published" } })
    expect(result.record.fundings[0]?.outcome).toBe("pending")
  })

  it("ends a send another life of the wallet seeded with no row, whatever the clock says", async () => {
    const { deps, store } = harness()
    await store.put(
      signedRecord("published", {
        fundings: [
          funding({ session: "life-0", sentAt: 5000, txHash: undefined, expiresAtMs: undefined }),
        ],
      }),
    )
    const result = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(result.wait).not.toBe("burn")
    expect(result.record.fundings[0]?.outcome).toBe("never-sent")
  })

  it("keeps the salt and parks a finished record whose late funding is final after the sweep", async () => {
    const { deps, store, world } = harness()
    await store.put(
      finish(
        signedRecord("done", {
          sweep: { index: "3", blockHash: word(0x60), credited: "1400" },
          fundings: [funding({ outcome: "swept" }), funding({ attemptId: "attempt-2" })],
        }),
      ),
    )
    expect((await store.get(OWNER))?.rotation?.sharedSecretSalt).toBe(word(9))
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "done" })
    expect(parked.fundings[1]?.outcome).toBe("mined")
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
    expect(await resumeRotation(deps, parked)).toEqual({ record: parked })
  })

  it("waits on a row this tab seeded, and ends one seeded before it became active", async () => {
    const { deps, store, world } = harness()
    const row = (startTime: number): FundingRow => ({
      phase: "submitting",
      startTime,
      recipient: SIPA,
    })
    world.rows.set("wdraw_backup_attempt-1", row(1500))
    await store.put(
      signedRecord("published", {
        fundings: [funding({ session: "life-0", txHash: undefined, expiresAtMs: undefined })],
      }),
    )
    expect(await resumeRotation(deps, (await store.get(OWNER))!)).toMatchObject({ wait: "burn" })
    world.rows.set("wdraw_backup_attempt-1", row(500))
    const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(ended.fundings[0]?.outcome).toBe("never-sent")
    expect(cancellable(ended)).toBe(true)
  })

  it("marks a row whose recipient is not the deposit address corrupt", async () => {
    const { deps, store, world } = harness()
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "l2_mined",
      l2TxHash: word(0x55),
      startTime: 1500,
      recipient: "0x9999",
    })
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    expect((await resumeRotation(deps, (await store.get(OWNER))!)).record).toMatchObject({
      attention: "corrupt",
    })
    expect(deps.fund).not.toHaveBeenCalled()
  })
})

describe("the watch", () => {
  it("reports a withdrawal row naming another address over the sweep, and the resume keeps it", async () => {
    const { deps, store, world } = harness()
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED))
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "done",
      l2TxHash: word(30),
      startTime: 5,
      recipient: "0x9999",
    })
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    const corrupt = (await watchRotation(deps, (await store.get(OWNER))!)).record
    expect(corrupt).toMatchObject({ phase: "attention", attention: "corrupt", suspended: "funded" })
    expect(corrupt.sweep).toBeUndefined()
    expect(corrupt.fundings[0]?.outcome).toBe("mined")
    const kept = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(kept).toMatchObject({ phase: "attention", attention: "corrupt" })
    expect(deps.reroot).not.toHaveBeenCalled()
  })

  it("holds a finished record until its mined funding reached the deposit address and was swept", async () => {
    const { deps, store, world } = harness()
    const row = (phase: string): FundingRow => ({
      phase,
      l2TxHash: word(30),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    world.rows.set("wdraw_backup_attempt-1", row("finalizing_l1"))
    await store.put(finish(signedRecord("done", { fundings: [funding({ outcome: "mined" })] })))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "done" })
    expect(parked.fundings[0]?.outcome).toBe("mined")
    world.rows.set("wdraw_backup_attempt-1", row("done"))
    world.balance = 1400n
    const landed = (await resumeRotation(deps, parked)).record
    expect(landed).toMatchObject({ phase: "attention", fundings: [{ outcome: "mined" }] })
    expect(landed.rotation?.sharedSecretSalt).toBe(word(9))
    world.balance = 0n
    world.releaseFinal = false
    const reorged = (await resumeRotation(deps, landed)).record
    expect(reorged).toMatchObject({ phase: "attention", fundings: [{ outcome: "mined" }] })
    expect(reorged.rotation?.sharedSecretSalt).toBe(word(9))
    world.releaseFinal = true
    const released = (await resumeRotation(deps, reorged)).record
    expect(released).toMatchObject({ phase: "done", fundings: [{ outcome: "swept" }] })
    expect(released.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("keeps the salt when a finished record's last funding is released over money at its deposit address", async () => {
    const { deps, store, world } = harness()
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "done",
      l2TxHash: word(30),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    balances(deps, 5n, 0n)
    await store.put(finish(signedRecord("done", { fundings: [funding({ outcome: "mined" })] })))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "done",
      unswept: true,
      fundings: [{ outcome: "swept" }],
    })
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
  })

  it("keeps a mined funding whose withdrawal row names another transaction as corrupt, salt intact", async () => {
    const { deps, store, world } = harness()
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "done",
      l2TxHash: word(31),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    await store.put(signedRecord("funded", { fundings: [funding({ outcome: "mined" })] }))
    const corrupt = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(corrupt).toMatchObject({ phase: "attention", attention: "corrupt", suspended: "funded" })
    expect(corrupt.fundings[0]?.outcome).toBe("mined")
    expect(corrupt.rotation?.sharedSecretSalt).toBe(word(9))
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED))
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    const pending = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(pending).toMatchObject({ attention: "corrupt", fundings: [{ outcome: "mined" }] })
  })

  it("counts a sweep only once its block is final, and returns a vanished one to funded", async () => {
    const { deps, store, world } = harness()
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    world.final = false
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    expect(await watchRotation(deps, (await store.get(OWNER))!)).toMatchObject({
      wait: "sweep",
      record: { phase: "funded" },
    })
    world.final = true
    const swept = (await watchRotation(deps, (await store.get(OWNER))!)).record
    expect(swept.phase).toBe("swept")
    world.sweep = undefined
    const back = (await watchRotation(deps, swept)).record
    expect(back).toMatchObject({ phase: "funded", sweep: undefined })
  })

  it("returns a stranded record whose recorded sweep vanished to funded, readable from a fresh store", async () => {
    const { deps, store, storage } = harness()
    await store.put(
      signedRecord("attention", {
        attention: "stranded",
        suspended: "funded",
        fundings: [funding({ outcome: "mined" })],
        sweep: { index: "3", blockHash: word(0x60), credited: "1400" },
      }),
    )
    const back = (await watchRotation(deps, (await store.get(OWNER))!)).record
    expect(back).toMatchObject({
      phase: "funded",
      sweep: undefined,
      attention: undefined,
      suspended: undefined,
    })
    expect(await new BackupRotationStore(storage).get(OWNER)).toEqual(back)
  })

  it("refuses to watch a finished attempt parked over money at its deposit address", async () => {
    const { deps, store } = harness({ balance: 500n })
    const sweep = { index: "3", blockHash: word(0x60), credited: "1400" }
    const fundings = [funding({ outcome: "swept" })]
    for (const parked of [
      finish(
        signedRecord("attention", { attention: "stranded", suspended: "done", fundings, sweep }),
      ),
      finish(signedRecord("attention", { attention: "stranded", suspended: "done", fundings })),
      finish(
        signedRecord("attention", { attention: "stranded", suspended: "recovered", fundings }),
      ),
    ]) {
      await store.put(parked)
      await expect(watchRotation(deps, parked)).rejects.toThrow("nothing to watch")
      expect(await store.get(OWNER)).toEqual(parked)
    }
  })

  it("reports money at the deposit address after the sweep on the finished attempt, running nothing twice", async () => {
    const { deps, store, world } = harness()
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    expect((await watchRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("swept")
    await store.put(finish(signedRecord("done", { fundings: [funding({ outcome: "swept" })] })))
    world.balance = 500n
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "done" })
    expect(await resumeRotation(deps, parked)).toEqual({ record: parked })
    expect(deps.reroot).not.toHaveBeenCalled()
    expect(deps.move.send).not.toHaveBeenCalled()
    expect(cancellable(parked)).toBe(false)
    world.balance = 0n
    const released = (await resumeRotation(deps, parked)).record
    expect(released.phase).toBe("done")
    expect(await resumeRotation(deps, released)).toEqual({ record: released })
  })

  it("reports a finished attempt stranded over money mined at its deposit address but not yet final", async () => {
    const { deps, store } = harness()
    balances(deps, 5n, 0n)
    await store.put(finish(signedRecord("done", { fundings: [funding({ outcome: "swept" })] })))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "done" })
  })

  it("reports a funded address unswept at the publish bound as stranded, until a late sweep supersedes it", async () => {
    const { deps, store, world } = harness()
    world.balance = 1400n
    await store.put(
      signedRecord("funded", {
        fundings: [funding()],
        publish: { count: PUBLISH_BOUND, history: [] },
      }),
    )
    const parked = (await watchRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ attention: "stranded", suspended: "funded" })
    expect(await resumeRotation(deps, parked)).toMatchObject({ record: { phase: "attention" } })
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    const swept = (await resumeRotation(deps, parked)).record
    expect(swept).toMatchObject({ phase: "swept", attention: undefined, suspended: undefined })
  })

  it("publishes a funded, unswept address again once the interval passed, under the bound", async () => {
    const { deps, store, world } = harness()
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED))
    const landed = { txHash: word(0x55), l2Block: 7, at: 1 }
    const publish = (count: number, lastAt: number) => ({ count, lastAt, history: [landed] })
    const funded = (publish: BackupPublish) =>
      signedRecord("funded", { fundings: [funding()], publish })

    await store.put(funded(publish(1, world.clock.t - PUBLISH_INTERVAL_MS)))
    expect(await watchRotation(deps, (await store.get(OWNER))!)).toMatchObject({ wait: "sweep" })
    expect(deps.republish).toHaveBeenCalledTimes(1)
    expect(deps.republish).toHaveBeenCalledWith(expect.objectContaining({ phase: "funded" }))

    await store.put(funded(publish(2, world.clock.t - 1)))
    await watchRotation(deps, (await store.get(OWNER))!)
    expect(deps.republish).toHaveBeenCalledTimes(1)

    await store.put(funded(publish(PUBLISH_BOUND, world.clock.t - PUBLISH_INTERVAL_MS)))
    await watchRotation(deps, (await store.get(OWNER))!)
    expect(deps.republish).toHaveBeenCalledTimes(1)

    // Never landed: the first publication is still the ledger's to make.
    await store.put(funded({ count: 1, lastAt: 1, history: [] }))
    await watchRotation(deps, (await store.get(OWNER))!)
    expect(deps.republish).toHaveBeenCalledTimes(1)
  })

  it("reports a route that died after the funding", async () => {
    const { deps, store } = harness()
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce("route")
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    expect((await watchRotation(deps, (await store.get(OWNER))!)).record).toMatchObject({
      attention: "route",
    })
  })

  const strandedRecord = (fundings = [funding({ outcome: "mined" })]) =>
    signedRecord("attention", {
      attention: "stranded",
      suspended: "funded",
      fundings,
      publish: { count: PUBLISH_BOUND, history: [] },
    })

  it("keeps the corrupt verdict a stranded re-read reached, and installs nothing over it", async () => {
    const { deps, store, world } = harness()
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "done",
      l2TxHash: word(30),
      startTime: 5,
      recipient: "0x9999",
    })
    // The resume's own reconciliation sees no row; the watch it runs next does.
    ;(deps.tracker.row as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    await store.put(strandedRecord())
    const kept = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(kept).toMatchObject({ phase: "attention", attention: "corrupt", suspended: "funded" })
    expect(kept.sweep).toBeUndefined()
    expect(deps.reroot).not.toHaveBeenCalled()
  })

  it("re-roots a stranded attempt whose change ran directly, and reports its money to the end", async () => {
    const { deps, store, world } = harness()
    world.balance = 1400n
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    await store.put(strandedRecord())
    const rerooted = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(rerooted).toMatchObject({
      phase: "rerooted",
      installed: { blockHash: word(0xf1) },
      attention: undefined,
      suspended: undefined,
      unswept: true,
    })
    const parked = (await resumeRotation(deps, rerooted)).record
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "done",
      unswept: true,
    })
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
    expect(parked.rotation?.signature).toBeUndefined()
    const reloaded = (await store.get(OWNER))!
    expect(await resumeRotation(deps, reloaded)).toEqual({ record: reloaded })
    expect(deps.reroot).toHaveBeenCalledTimes(1)
    expect(deps.move.send).not.toHaveBeenCalled()
    world.balance = 0n
    expect((await resumeRotation(deps, reloaded)).record).toMatchObject({
      phase: "attention",
      fundings: [{ outcome: "mined" }],
    })
    expect((await store.get(OWNER))?.rotation?.sharedSecretSalt).toBe(word(9))
  })

  it("parks a change installed directly while its funding was still landing, keeping the salt", async () => {
    const { deps, store, world } = harness()
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    await store.put(signedRecord("funded", { fundings: [funding({ expiresAtMs: 5000 })] }))
    const rerooted = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(rerooted.phase).toBe("rerooted")
    expect(rerooted.unswept).toBeUndefined()
    const parked = (await resumeRotation(deps, rerooted)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "done" })
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED))
    world.balance = 1400n
    const landed = (await resumeRotation(deps, parked)).record
    expect(landed).toMatchObject({ phase: "attention", fundings: [{ outcome: "mined" }] })
    expect(landed.rotation?.sharedSecretSalt).toBe(word(9))
  })

  it("keeps a pre-install stranded report while money at its deposit address is not yet final", async () => {
    const { deps, store } = harness()
    balances(deps, 5n, 0n)
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("superseded")
    const parked = signedRecord("attention", { attention: "stranded", suspended: "signed" })
    await store.put(parked)
    const kept = (await resumeRotation(deps, parked)).record
    expect(kept).toMatchObject({ phase: "attention", attention: "stranded", suspended: "signed" })
    expect(kept.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
  })

  it("keeps a finished attempt parked while money at its deposit address is not yet final", async () => {
    const { deps, store } = harness()
    balances(deps, 5n, 0n)
    const parked = finish(
      signedRecord("attention", {
        attention: "stranded",
        suspended: "done",
        fundings: [funding({ outcome: "swept" })],
      }),
    )
    await store.put(parked)
    const kept = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(kept).toMatchObject({ phase: "attention", attention: "stranded", suspended: "done" })
    expect(kept.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
  })

  it("returns a parked attempt to done once nothing can land at its deposit address and nothing is held", async () => {
    const { deps, store, world } = harness()
    world.balance = 1400n
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    await store.put(strandedRecord([funding({ expiresAtMs: 5000 })]))
    const rerooted = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    const parked = (await resumeRotation(deps, rerooted)).record
    expect(parked).toMatchObject({ phase: "attention", suspended: "done", unswept: true })
    world.clock.t = 5001
    world.finalizedAt = 5001
    const dead = (await resumeRotation(deps, parked)).record
    expect(dead).toMatchObject({ phase: "attention", fundings: [{ outcome: "dead" }] })
    world.balance = 0n
    const released = (await resumeRotation(deps, dead)).record
    expect(released).toMatchObject({ phase: "done", attention: undefined, unswept: undefined })
    expect(released.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("declines a stale watch over a record that ended meanwhile, so a fresh load reads it", async () => {
    const { deps, store, world, storage } = harness()
    world.balance = 1400n
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    await store.put(strandedRecord())
    let release!: () => void
    const reading = new Promise<void>((r) => (release = r))
    ;(deps.l1.sweep as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await reading
      return { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    })
    const stale = watchRotation(deps, (await store.get(OWNER))!)
    await new Promise((r) => setTimeout(r, 0))
    const rerooted = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    const parked = (await resumeRotation(deps, rerooted)).record
    expect(parked).toMatchObject({ phase: "attention", suspended: "done" })
    release()
    await expect(stale).rejects.toThrow("moved on")
    expect(await new BackupRotationStore(storage).get(OWNER)).toEqual(parked)
  })

  it("keeps the unswept mark through a re-root that failed after the install was written", async () => {
    const { deps, store, world } = harness()
    world.balance = 1400n
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    ;(deps.reroot as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rebind failed"))
    await store.put(strandedRecord())
    await expect(resumeRotation(deps, (await store.get(OWNER))!)).rejects.toThrow("rebind failed")
    expect(await store.get(OWNER)).toMatchObject({
      phase: "installed",
      unswept: true,
      attention: undefined,
    })
    expect((await resumeRotation(deps, (await store.get(OWNER))!)).record).toMatchObject({
      phase: "rerooted",
      unswept: true,
    })
  })

  it("takes a final sweep on a funded attempt parked over its route, and judges its funding there", async () => {
    const { deps, store, world } = harness()
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValue("route")
    world.receipts.set(word(30), receipt(TxStatus.FINALIZED))
    await store.put(
      signedRecord("attention", {
        attention: "route",
        suspended: "funded",
        fundings: [funding()],
      }),
    )
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", suspended: "funded" })
    expect(parked.fundings[0]?.outcome).toBe("mined")
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    const moved = (await resumeRotation(deps, parked)).record
    expect(moved).toMatchObject({ phase: "rerooted", attention: undefined, suspended: undefined })
    world.sweep = undefined
    world.finalizedAt = 5000
    await store.put(
      signedRecord("attention", {
        attention: "route",
        suspended: "funded",
        fundings: [funding({ txHash: word(31), expiresAtMs: 100 })],
      }),
    )
    const dead = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(dead).toMatchObject({ phase: "attention", suspended: "published" })
    expect(dead.fundings[0]?.outcome).toBe("dead")
    expect(cancellable(dead)).toBe(true)
  })

  it("watches nothing past the sweep", async () => {
    const { deps, store } = harness()
    await store.put(
      signedRecord("rerooted", { sweep: { index: "3", blockHash: word(0x60), credited: "1400" } }),
    )
    await expect(watchRotation(deps, (await store.get(OWNER))!)).rejects.toThrow("nothing to watch")
    expect((await store.get(OWNER))?.phase).toBe("rerooted")
  })
})

describe("recovery", () => {
  const RECOVERY = word(0xaa)
  /** A stranded attempt over a funding the portal released to its deposit address. */
  const stranded = async (over: Partial<World> = {}, record = {}) => {
    const made = harness({ balance: 1400n, ...over })
    made.world.rows.set(fundingLocalId("attempt-1"), {
      phase: "done",
      l2TxHash: word(30),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    await made.store.put(
      signedRecord("attention", {
        attention: "stranded",
        suspended: "funded",
        fundings: [funding({ outcome: "mined" })],
        publish: { count: PUBLISH_BOUND, history: [] },
        ...record,
      }),
    )
    return made
  }

  it("ends a stranded attempt at recovered once its recovery is final, and a reload reads it", async () => {
    const { deps, store, storage } = await stranded()
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded" })
    const noted = await noteRecovery(deps, parked, RECOVERY)
    expect(noted).toMatchObject({ phase: "attention", recovery: { txHash: RECOVERY } })
    balances(deps, 0n, 1400n)
    const waiting = (await resumeRotation(deps, noted)).record
    expect(waiting).toMatchObject({ phase: "attention", attention: "stranded" })
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, waiting)).record
    expect(ended).toMatchObject({
      phase: "recovered",
      attention: undefined,
      suspended: undefined,
      recovery: { txHash: RECOVERY },
      fundings: [{ outcome: "swept" }],
    })
    expect(ended.rotation?.sharedSecretSalt).toBeUndefined()
    expect(ended.rotation?.signature).toBeUndefined()
    expect(ended.backup.envelopeHex).toBeUndefined()
    const reloaded = await new BackupRotationStore(storage).get(OWNER)
    expect(reloaded).toEqual(ended)
    expect((await resumeRotation(deps, reloaded!)).record).toEqual(ended)
    expect(deps.fund).not.toHaveBeenCalled()
  })

  it("reads a recovery it did not see confirm from the chain", async () => {
    const { deps, store, world } = await stranded({ balance: 0n, recovery: RECOVERY })
    const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(deps.l1.recovery).toHaveBeenCalledWith(SIPA, 50)
    world.recovery = undefined
    await store.put(
      signedRecord("attention", {
        attention: "stranded",
        suspended: "funded",
        fundings: [funding({ outcome: "swept" })],
      }),
    )
    const released = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(released.phase).toBe("published")
  })

  it("lets a sweep that lands first win over the recovery", async () => {
    const { deps, store, world } = await stranded({}, { recovery: { txHash: RECOVERY } })
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    balances(deps, 0n, 0n)
    const swept = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(swept).toMatchObject({ phase: "swept", attention: undefined, recovery: undefined })
    expect(deps.verify).toHaveBeenCalled()
  })

  it("installs a change that ran anyway once its money is gone, instead of ending it at recovered", async () => {
    const { deps, store } = await stranded({ balance: 0n }, { recovery: { txHash: RECOVERY } })
    ;(deps.fundability as ReturnType<typeof vi.fn>).mockResolvedValue("applied")
    const record = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(record).toMatchObject({ phase: "rerooted", recovery: undefined })
  })

  it("ends a damaged record whose money was recovered, without judging it again", async () => {
    const { deps, store } = await stranded({}, { attention: "corrupt" })
    ;(deps.verify as ReturnType<typeof vi.fn>).mockResolvedValue(CORRUPT)
    const parked = (await store.get(OWNER))!
    expect(cancellable(parked)).toBe(false)
    const noted = await noteRecovery(deps, parked, RECOVERY)
    balances(deps, 0n, 1400n)
    expect(await resumeRotation(deps, noted)).toMatchObject({
      record: { phase: "attention", attention: "corrupt" },
      wait: "recovery",
    })
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(deps.verify).toHaveBeenCalledTimes(0)
  })

  it("ends a damaged record whose recovery confirmed after the tab closed, re-checking until it is final", async () => {
    const { deps, store, world } = await stranded({}, { attention: "corrupt" })
    const parked = await resumeRotation(deps, (await store.get(OWNER))!)
    expect(parked.record).toMatchObject({ phase: "attention", attention: "corrupt" })
    expect(parked.wait).toBeUndefined()
    world.recovery = RECOVERY
    balances(deps, 0n, 1400n)
    expect(await resumeRotation(deps, (await store.get(OWNER))!)).toMatchObject({
      record: { phase: "attention", attention: "corrupt" },
      wait: "recovery",
    })
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: RECOVERY } })
    expect(deps.verify).not.toHaveBeenCalled()
  })

  it("notes a recovery only on an attempt parked over its money", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    await expect(noteRecovery(deps, (await store.get(OWNER))!, RECOVERY)).rejects.toThrow(
      "moved on",
    )
    await store.put(signedRecord("attention", { attention: "corrupt", suspended: "signed" }))
    await expect(noteRecovery(deps, (await store.get(OWNER))!, RECOVERY)).rejects.toThrow(
      "moved on",
    )
  })

  it("returns a finished attempt to done once a funding that landed after its sweep is recovered", async () => {
    const { deps, store } = harness({ balance: 1400n })
    const sweep = { index: "3", blockHash: word(0x60), credited: "1400" }
    await store.put(
      finish(
        signedRecord("attention", {
          attention: "stranded",
          suspended: "done",
          sweep,
          fundings: [funding({ outcome: "swept" })],
        }),
      ),
    )
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", suspended: "done" })
    expect(parked.rotation?.sharedSecretSalt).toBe(storedRotation().sharedSecretSalt)
    const noted = await noteRecovery(deps, parked, RECOVERY)
    balances(deps, 0n, 0n)
    const done = (await resumeRotation(deps, noted)).record
    expect(done).toMatchObject({ phase: "done", sweep, recovery: { txHash: RECOVERY } })
    expect(done.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("parks a recovered attempt again over money that lands later, until that is recovered too", async () => {
    const { deps, store } = harness({ balance: 5n })
    // As `endRecovered` leaves it: nothing could land, so the salt left too.
    const stripped = finish(
      signedRecord("recovered", { recovery: { txHash: RECOVERY }, fundings: [] }),
    )
    await store.put({
      ...stripped,
      rotation: { ...stripped.rotation!, sharedSecretSalt: undefined },
    })
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "recovered",
      recovery: undefined,
    })
    const again = word(0xab)
    const noted = await noteRecovery(deps, parked, again)
    balances(deps, 0n, 0n)
    const ended = (await resumeRotation(deps, noted)).record
    expect(ended).toMatchObject({ phase: "recovered", recovery: { txHash: again } })
  })
})

describe("the re-root", () => {
  it("keeps each checkpoint as it is written, so a failed re-root resumes past it", async () => {
    const { deps, store } = harness()
    ;(deps.reroot as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_r, checkpoint) => {
      await checkpoint({ switched: true })
      throw new Error("rebind failed")
    })
    await store.put(signedRecord("swept"))
    await expect(rerootRotation(deps, (await store.get(OWNER))!)).rejects.toThrow("rebind failed")
    expect(await store.get(OWNER)).toMatchObject({ phase: "swept", reroot: { switched: true } })
    const rerooted = await rerootRotation(deps, (await store.get(OWNER))!)
    expect(rerooted).toMatchObject({ phase: "rerooted", reroot: { switched: true, rebound: true } })
  })
})

const finish = (record: ReturnType<typeof signedRecord>) => {
  const { envelopeHex: _e, ...backup } = record.backup
  const { signature: _s, add, ...rotation } = record.rotation!
  const { envelope: _v, ...addRest } = add
  return { ...record, backup, rotation: { ...rotation, add: addRest } }
}

describe("the move", () => {
  it("waits on a submitted chunk and plans nothing new", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    expect(first.wait).toBe("chunk")
    const again = await moveRotation(deps, first.record)
    expect(again.wait).toBe("chunk")
    expect(deps.move.send).toHaveBeenCalledTimes(1)
  })

  it("settles a chunk once an L1 checkpoint holds it, re-reading one the sequencer alone holds", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.set(word(0x101), receipt(TxStatus.PROPOSED))
    const proposed = await moveRotation(deps, first.record)
    expect(proposed.record.move?.runs[0]?.chunks[0]?.state).toBe("included")
    world.receipts.set(word(0x101), receipt(TxStatus.CHECKPOINTED))
    const settled = await moveRotation(deps, proposed.record)
    expect(settled.record.move?.runs[0]?.chunks[0]?.state).toBe("mined")
  })

  it("re-cuts and resends a dead chunk, never while the node still holds it", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    expect(first.record.move?.runs[0]?.chunks[0]?.txHash).toBe(word(0x101))
    world.receipts.delete(word(0x101))
    world.clock.t = 5001
    world.finalizedAt = 4999
    await moveRotation(deps, first.record)
    expect(deps.move.send).toHaveBeenCalledTimes(1)
    world.finalizedAt = 5001
    const resent = await moveRotation(deps, first.record)
    expect(deps.move.send).toHaveBeenCalledTimes(2)
    expect(resent.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x102),
    })
    expect(resent.record.move?.runs[0]?.m).toBe(2)
  })

  it("waits on a saved chunk whose expiry is unknown until a receipt ends it, sending nothing new", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = (await moveRotation(deps, (await store.get(OWNER))!)).record
    const run = first.move!.runs[0]!
    const [sent, ...rest] = run.chunks
    const saved = {
      ...first,
      move: {
        ...first.move!,
        runs: [{ ...run, chunks: [{ ...sent!, expiresAtMs: undefined }, ...rest] }],
      },
    }
    await store.put(saved)
    world.receipts.delete(word(0x101))
    world.finalizedAt = 6000
    const waited = await moveRotation(deps, saved)
    expect(waited.wait).toBe("chunk")
    expect(waited.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x101),
    })
    expect(deps.move.send).toHaveBeenCalledTimes(1)
    world.receipts.set(word(0x101), receipt(TxStatus.FINALIZED))
    const mined = await moveRotation(deps, waited.record)
    expect(mined.record.move?.runs[0]?.chunks[0]?.state).toBe("mined")
  })

  it("marks a chunk mined that was still submitted, and demotes an included one that dropped", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.set(word(0x101), receipt(TxStatus.FINALIZED))
    world.shape = { notes: [DAI], depositTotal: 0n, balance: DAI }
    const second = await moveRotation(deps, first.record)
    expect(second.record.move?.runs[0]?.chunks.map((c) => c.state)).toEqual(["mined", "submitted"])
    world.receipts.set(word(0x102), receipt(TxStatus.PROPOSED))
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    const included = await moveRotation(deps, second.record)
    expect(included.record.phase).toBe("moved")
    expect(included.record.move?.runs[0]?.chunks[1]).toMatchObject({
      state: "included",
      inclusion: { blockNumber: 9 },
    })
    world.receipts.delete(word(0x102))
    const demoted = await moveRotation(deps, included.record)
    expect(demoted).toMatchObject({ wait: "chunk" })
    expect(demoted.record.move?.runs[0]?.chunks[1]).toMatchObject({
      state: "submitted",
      inclusion: undefined,
    })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
  })

  it("keeps a chunk submitted while another move was still cutting", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.delete(word(0x101))
    world.clock.t = 6000
    world.finalizedAt = 6000
    let release!: () => void
    const cutting = new Promise<void>((r) => (release = r))
    ;(deps.move.shape as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await cutting
      return world.shape
    })
    const slow = moveRotation(deps, first.record)
    await new Promise((r) => setTimeout(r, 0))
    const fast = await moveRotation(deps, (await store.get(OWNER))!)
    expect(fast.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x102),
    })
    release()
    await expect(slow).rejects.toThrow("moved on")
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x102),
    })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
  })

  it("sends a chunk once when two moves reach it together", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("rerooted"))
    let release!: () => void
    const checking = new Promise<void>((r) => (release = r))
    ;(deps.move.usesLeft as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await checking
      return true
    })
    const slow = moveRotation(deps, (await store.get(OWNER))!)
    await new Promise((r) => setTimeout(r, 0))
    const fast = await moveRotation(deps, (await store.get(OWNER))!)
    expect(fast.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x101),
    })
    release()
    await expect(slow).rejects.toThrow("moved on")
    expect(deps.move.send).toHaveBeenCalledTimes(1)
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x101),
    })
  })

  it("waits on a chunk another send holds, and releases a claim from an earlier life of the wallet", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    let release!: () => void
    const proving = new Promise<void>((r) => (release = r))
    ;(deps.move.send as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_t: string, _a: bigint, onTxHash) => {
        await proving
        world.receipts.set(word(0x101), receipt(TxStatus.PENDING))
        await onTxHash(word(0x101), { expiresAtMs: 5000 })
      },
    )
    const slow = moveRotation(deps, (await store.get(OWNER))!)
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "claimed",
      claim: { id: expect.any(String), session: "life-1" },
    })
    expect(await moveRotation(deps, (await store.get(OWNER))!)).toMatchObject({ wait: "chunk" })
    expect(deps.move.send).toHaveBeenCalledTimes(1)
    release()
    expect((await slow).record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x101),
    })
    const stale = (await store.get(OWNER))!
    const run = stale.move!.runs[0]!
    await store.put({
      ...stale,
      move: {
        runs: [
          {
            ...run,
            chunks: [
              {
                token: "tok",
                amount: run.chunks[0]!.amount,
                state: "claimed",
                claim: { id: "send-0", session: "life-0" },
              },
            ],
          },
        ],
      },
    })
    const resent = await moveRotation(deps, (await store.get(OWNER))!)
    expect(resent.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x101),
    })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
  })

  it("keeps a claim while another move finalizes an earlier chunk, and lands its hash over that read", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.set(word(0x101), receipt(TxStatus.PROPOSED))
    let release!: () => void
    const proving = new Promise<void>((r) => (release = r))
    ;(deps.move.send as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_t: string, _a: bigint, onTxHash) => {
        await proving
        world.receipts.set(word(0x102), receipt(TxStatus.PENDING))
        await onTxHash(word(0x102), { expiresAtMs: 5000 })
      },
    )
    const slow = moveRotation(deps, first.record)
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks.map((c) => c.state)).toEqual([
      "included",
      "claimed",
    ])
    world.receipts.set(word(0x101), receipt(TxStatus.FINALIZED))
    expect(await moveRotation(deps, (await store.get(OWNER))!)).toMatchObject({ wait: "chunk" })
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks.map((c) => c.state)).toEqual([
      "mined",
      "claimed",
    ])
    release()
    expect((await slow).record.move?.runs[0]?.chunks).toMatchObject([
      { state: "mined" },
      { state: "submitted", txHash: word(0x102) },
    ])
    expect(deps.move.send).toHaveBeenCalledTimes(2)
  })

  it("releases the claim when the send fails before its hash", async () => {
    const { deps, store } = harness()
    ;(deps.move.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("proof failed"))
    await store.put(signedRecord("rerooted"))
    await expect(moveRotation(deps, (await store.get(OWNER))!)).rejects.toThrow("proof failed")
    expect((await store.get(OWNER))?.move?.runs[0]?.chunks[0]).toEqual({
      token: "tok",
      amount: expect.any(String),
      state: "planned",
    })
    const resent = await moveRotation(deps, (await store.get(OWNER))!)
    expect(resent.record.move?.runs[0]?.chunks[0]).toMatchObject({ state: "submitted" })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
  })

  it("waits for the user after a declined prompt, sending nothing until they try again", async () => {
    const { deps, store } = harness()
    const send = deps.move.send as ReturnType<typeof vi.fn>
    send.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await store.put(signedRecord("rerooted"))
    const declined = await moveRotation(deps, (await store.get(OWNER))!)
    expect(declined.wait).toBe("declined")
    expect(moveDeclined(declined.record)).toBe(true)
    expect(declined.record.move?.runs[0]?.chunks[0]).toEqual({
      token: "tok",
      amount: expect.any(String),
      state: "planned",
    })
    const resumed = await resumeRotation(deps, declined.record)
    expect(resumed.wait).toBe("declined")
    expect(moveDeclined(resumed.record)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    const retried = await retryMove(deps, resumed.record)
    expect(retried.wait).toBe("chunk")
    expect(moveDeclined(retried.record)).toBe(false)
    expect(retried.record.move?.runs[0]?.chunks[0]).toMatchObject({ state: "submitted" })
    expect(send).toHaveBeenCalledTimes(2)
    await expect(retryMove(deps, retried.record)).rejects.toThrow(RotationFlowError)
  })

  it("drops a decline once a re-cut leaves nothing to send", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.set(word(0x101), receipt(TxStatus.PROPOSED))
    ;(deps.move.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DOMException("closed", "NotAllowedError"),
    )
    const declined = await moveRotation(deps, first.record)
    expect(moveDeclined(declined.record)).toBe(true)
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    const recut = await moveRotation(deps, declined.record)
    expect(recut).toMatchObject({ wait: "chunk", record: { phase: "moved" } })
    expect(recut.record.move?.runs[0]?.declined).toBeUndefined()
    expect(moveDeclined(recut.record)).toBe(false)
  })

  it("waits on an included chunk that reverted, moving nothing, and re-cuts it once checkpointed", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.set(word(0x101), receipt(TxStatus.PROPOSED, true))
    const reverted = await moveRotation(deps, first.record)
    expect(reverted).toMatchObject({ wait: "chunk", record: { phase: "rerooted" } })
    expect(reverted.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "included",
      effect: "reverted",
    })
    expect(moveProgress(reverted.record)?.included).toBe(0)
    expect(deps.move.send).toHaveBeenCalledTimes(1)
    world.receipts.set(word(0x101), receipt(TxStatus.CHECKPOINTED, true))
    const recut = await moveRotation(deps, reverted.record)
    expect(recut.record.move?.runs[0]?.chunks[0]).toMatchObject({
      state: "submitted",
      txHash: word(0x102),
    })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
  })

  it("revises the plan when the same total needs more chunks, keeping what was mined", async () => {
    const { deps, store, world } = harness()
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.set(word(0x101), receipt(TxStatus.FINALIZED))
    world.shape = { notes: Array(20).fill(DAI / 20n), depositTotal: 0n, balance: DAI }
    const revised = await moveRotation(deps, first.record)
    const run = revised.record.move?.runs[0]
    expect(run?.m).toBe(3)
    expect(run?.chunks.map((c) => c.state)).toEqual(["mined", "submitted", "planned"])
  })

  it("ends a run at its count and starts a new one for what arrives later, once the run is checkpointed", async () => {
    const { deps, store, world } = harness()
    world.shape = { notes: [DAI], depositTotal: 0n, balance: DAI }
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    world.receipts.set(word(0x101), receipt(TxStatus.PROPOSED))
    world.shape = { notes: [DAI], depositTotal: 0n, balance: DAI }
    const waiting = await moveRotation(deps, first.record)
    expect(waiting).toMatchObject({ wait: "chunk", record: { phase: "moved" } })
    expect(waiting.record.move?.runs).toHaveLength(1)
    world.receipts.set(word(0x101), receipt(TxStatus.CHECKPOINTED))
    const next = await moveRotation(deps, waiting.record)
    expect(next.record.move?.runs).toHaveLength(2)
    expect(next.record.move?.runs[0]?.chunks[0]?.state).toBe("mined")
    expect(next.record.move?.runs[1]).toMatchObject({ m: 1, chunks: [{ state: "submitted" }] })
  })

  it("re-cuts a dead chunk on its own token", async () => {
    const { deps, store, world } = harness()
    ;(deps.move.tokens as ReturnType<typeof vi.fn>).mockResolvedValue(["tok", "tok2"])
    world.shape = { notes: [DAI], depositTotal: 0n, balance: DAI }
    await store.put(signedRecord("rerooted"))
    const first = await moveRotation(deps, (await store.get(OWNER))!)
    expect(first.record.move?.runs[0]?.chunks.map((c) => c.token)).toEqual(["tok", "tok2"])
    world.receipts.set(word(0x101), receipt(TxStatus.FINALIZED))
    const second = await moveRotation(deps, first.record)
    expect(deps.move.send).toHaveBeenLastCalledWith("tok2", DAI, expect.any(Function), undefined)
    world.receipts.delete(word(0x102))
    world.finalizedAt = 5001
    const resent = await moveRotation(deps, second.record)
    expect(resent.record.move?.runs[0]?.chunks[1]).toMatchObject({
      token: "tok2",
      state: "submitted",
    })
    expect(deps.move.send).toHaveBeenLastCalledWith("tok2", DAI, expect.any(Function), undefined)
    expect(deps.move.shape).toHaveBeenLastCalledWith("tok2")
  })

  it("stops on a refused envelope as attention until the user tries again, and pauses when the sponsored uses ran out", async () => {
    const { deps, store } = harness()
    ;(deps.move.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Balance too low"),
    )
    await store.put(signedRecord("rerooted"))
    const parked = (await moveRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "move", suspended: "rerooted" })
    expect(await resumeRotation(deps, parked)).toEqual({ record: parked })
    expect(deps.move.send).toHaveBeenCalledTimes(1)
    const retried = await retryMove(deps, parked)
    expect(retried).toMatchObject({
      wait: "chunk",
      record: { phase: "rerooted", attention: undefined },
    })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
    ;(deps.move.usesLeft as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    await store.put(signedRecord("rerooted"))
    expect(await moveRotation(deps, (await store.get(OWNER))!)).toMatchObject({ wait: "uses" })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
  })

  it("finishes without a move when nothing is held", async () => {
    const { deps, store, world } = harness()
    world.shape = { notes: [], depositTotal: 0n, balance: 0n }
    await store.put(signedRecord("rerooted"))
    expect((await moveRotation(deps, (await store.get(OWNER))!)).record.phase).toBe("done")
    expect(deps.move.send).not.toHaveBeenCalled()
  })
})

describe("cancelling", () => {
  it("drops created, signed, a published attempt with no funding that can land, a conflict and a parked route", async () => {
    const { deps, store } = harness()
    for (const record of [
      rotationRecord(),
      signedRecord("signed"),
      signedRecord("published", {
        fundings: [funding({ txHash: undefined, outcome: "never-sent" })],
      }),
      signedRecord("published", {
        fundings: [
          funding({ outcome: "dead" }),
          funding({ attemptId: "attempt-2", outcome: "reverted" }),
        ],
      }),
      signedRecord("conflict"),
      signedRecord("attention", { attention: "route", suspended: "signed" }),
    ]) {
      await store.put(record)
      expect(cancellable(record)).toBe(true)
      await cancelRotation(deps, record)
      expect(await store.get(OWNER)).toBeNull()
    }
  })

  it("never drops an attempt whose funding may still land, read as it is removed", async () => {
    const { deps, store } = harness()
    const stale = signedRecord("published")
    await store.put(signedRecord("funded", { fundings: [funding()] }))
    expect(cancellable(signedRecord("funded", { fundings: [funding()] }))).toBe(false)
    await expect(cancelRotation(deps, stale)).rejects.toThrow("may still land")
    expect(await store.get(OWNER)).not.toBeNull()
  })

  it("keeps a route park over a signed change while its deposit address holds money", async () => {
    const { deps, store } = harness({ balance: 1400n })
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValue("route")
    await store.put(signedRecord("signed"))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "route", suspended: "signed" })
    expect(cancellable(parked)).toBe(true)
    await expect(cancelRotation(deps, parked)).rejects.toThrow("may have reached")
    expect((await store.get(OWNER))?.rotation?.sharedSecretSalt).toBe(
      storedRotation().sharedSecretSalt,
    )
  })

  it("judges a published change funded by settled money at its deposit address, whatever the plan credits", async () => {
    const { deps, store } = harness({ balance: 5n })
    await store.put(signedRecord("published", { plan: { ...PLAN, credited: "0" } }))
    const record = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(record.phase).toBe("funded")
    expect(cancellable(record)).toBe(false)
    await expect(cancelRotation(deps, record)).rejects.toThrow("cannot be cancelled")
    expect(await store.get(OWNER)).toEqual(record)
  })

  it("judges the record the store holds, not the snapshot handed in", async () => {
    const { deps, store } = harness()
    const moved = addr(0x99)
    ;(deps.l1.sipaBalance as ReturnType<typeof vi.fn>).mockImplementation(async (sipa: string) =>
      sipa === moved ? 5n : 0n,
    )
    await store.put(signedRecord("signed", { rotation: storedRotation({ sipa: moved }) }))
    for (const snapshot of [rotationRecord(), signedRecord("signed")]) {
      await expect(cancelRotation(deps, snapshot)).rejects.toThrow("may have reached")
      expect((await store.get(OWNER))?.rotation?.sipa).toBe(moved)
    }
  })

  it("keeps a route park over money mined at the deposit address but not yet final", async () => {
    const { deps, store } = harness()
    ;(deps.l1.sipaBalance as ReturnType<typeof vi.fn>).mockImplementation(
      async (_sipa: string, at?: string) => (at === "latest" ? 5n : 0n),
    )
    ;(deps.route as ReturnType<typeof vi.fn>).mockResolvedValue("route")
    await store.put(signedRecord("signed"))
    const parked = (await resumeRotation(deps, (await store.get(OWNER))!)).record
    expect(parked).toMatchObject({ phase: "attention", attention: "route", suspended: "signed" })
    await expect(cancelRotation(deps, parked)).rejects.toThrow("may have reached")
    expect((await store.get(OWNER))?.rotation?.sharedSecretSalt).toBe(
      storedRotation().sharedSecretSalt,
    )
  })

  it("keeps a signed change over money final at its deposit address but gone on the latest block", async () => {
    const { deps, store } = harness()
    balances(deps, 0n, 5n)
    const record = signedRecord("signed")
    await store.put(record)
    await expect(cancelRotation(deps, record)).rejects.toThrow("may have reached")
    expect(await store.get(OWNER)).toEqual(record)
  })

  it("keeps a signed change over a sweep seen since it began", async () => {
    const { deps, store, world } = harness()
    world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
    const record = signedRecord("signed")
    await store.put(record)
    await expect(cancelRotation(deps, record)).rejects.toThrow("may have reached")
    expect(await store.get(OWNER)).toEqual(record)
  })

  it("judges a parked attempt by the phase it left", () => {
    const parked = (
      suspended: "signed" | "funded" | "rerooted",
      fundings = [funding({ outcome: "mined" })],
    ) => signedRecord("attention", { attention: "route", suspended, fundings })
    expect(cancellable(parked("signed", []))).toBe(true)
    expect(cancellable(parked("funded"))).toBe(false)
    expect(cancellable(parked("rerooted"))).toBe(false)
    expect(
      cancellable(signedRecord("attention", { attention: "corrupt", suspended: "moved" })),
    ).toBe(false)
  })

  it("keeps a corrupt record over every trace of a funding", async () => {
    const { deps, store, world } = harness()
    ;(deps.verify as ReturnType<typeof vi.fn>).mockResolvedValue(CORRUPT)
    const traces: (() => Partial<ReturnType<typeof signedRecord>>)[] = [
      () => ({ fundings: [funding({ outcome: "never-sent" })] }),
      () => {
        world.rows.set("wdraw_backup_attempt-1", {
          phase: "l2_mined",
          l2TxHash: word(0x55),
          startTime: 1500,
          recipient: SIPA,
        })
        return { fundings: [funding({ txHash: undefined, outcome: "never-sent" })] }
      },
      () => {
        world.rows.clear()
        world.sweep = { index: "3", blockNumber: 60, blockHash: word(0x60), credited: 1400n }
        return { fundings: [] }
      },
    ]
    for (const trace of traces) {
      await store.put(signedRecord("published", trace()))
      const corrupt = (await resumeRotation(deps, (await store.get(OWNER))!)).record
      expect(cancellable(corrupt)).toBe(true)
      await expect(cancelRotation(deps, corrupt)).rejects.toThrow("may have reached")
      expect(await store.get(OWNER)).not.toBeNull()
    }
  })

  it("strips a finished record, and parks one with the salt while a funding may still land", async () => {
    const { deps, store } = harness()
    await store.put(signedRecord("moved", { fundings: [funding({ outcome: "swept" })] }))
    const done = await finishRotation(deps, (await store.get(OWNER))!)
    expect(done.phase).toBe("done")
    expect(done.rotation?.sharedSecretSalt).toBeUndefined()
    expect(done.rotation?.signature).toBeUndefined()
    await store.put(
      signedRecord("moved", {
        fundings: [funding({ outcome: "swept" }), funding({ attemptId: "attempt-2" })],
      }),
    )
    const parked = await finishRotation(deps, (await store.get(OWNER))!)
    expect(parked).toMatchObject({ phase: "attention", attention: "stranded", suspended: "done" })
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
    expect(parked.rotation?.signature).toBeUndefined()
  })

  it("keeps the salt and parks over done when money sits at the deposit address at finish", async () => {
    const { deps, store } = harness()
    balances(deps, 5n, 0n)
    await store.put(signedRecord("moved", { fundings: [funding({ outcome: "swept" })] }))
    const parked = await finishRotation(deps, (await store.get(OWNER))!)
    expect(parked).toMatchObject({
      phase: "attention",
      attention: "stranded",
      suspended: "done",
      unswept: true,
    })
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
    expect(parked.rotation?.signature).toBeUndefined()
  })
})
