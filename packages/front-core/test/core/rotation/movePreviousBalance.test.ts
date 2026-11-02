import { TxStatus } from "@aztec-labs/stdlib/tx"
import { MAX_TX_LIFETIME_MS } from "@obsidion/core/constants"
import type { SpendShape, TxHashCallback } from "@obsidion/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { txOutcome, type TxOutcome } from "../../../src/core/rotation/backupRotationFlow"
import {
  movePreviousBalance,
  PREVIOUS_MOVE_POLL_MS,
  settleStoredChunk,
  type PreviousMoveDeps,
} from "../../../src/core/rotation/movePreviousBalance"
import { WATCH_WINDOW_MS } from "../../../src/core/rotation/previousAccount"
import {
  PreviousAccountWatchStore,
  type PreviousAccountMove,
  type PreviousAccountWatch,
} from "../../../src/core/storages/PreviousAccountWatchStore"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { word } from "../../__test-helpers__/backupRotation"

const DAI = 10n ** 18n
const DUST = 10n ** 16n
const ONE_KEY = `0x${"11".repeat(32)}`
const TWO_KEY = `0x${"22".repeat(32)}`
const OTHER = `0x${"33".repeat(32)}`
const START = 10_000

const DONE = { kind: "done" }
const STOPPED = { kind: "stopped" }
const PENDING: TxOutcome = { kind: "pending" }
const MINED: TxOutcome = { kind: "mined" }
const included = (
  checkpointed: boolean,
  effect: "success" | "reverted" = "success",
): TxOutcome => ({
  kind: "included",
  blockNumber: 9,
  blockHash: "0xb9",
  effect,
  checkpointed,
})

const hash = (n: number) => word(0x100 + n)
const notes = (...amounts: bigint[]): SpendShape => ({
  notes: amounts,
  depositTotal: 0n,
  balance: amounts.reduce((total, amount) => total + amount, 0n),
})
const chunk = (txHash: string, over: Partial<PreviousAccountMove> = {}): PreviousAccountMove => ({
  source: ONE_KEY,
  destination: TWO_KEY,
  txHash: txHash as `0x${string}`,
  expiresAtMs: START + 60_000,
  amount: DAI.toString(),
  ...over,
})

class FlakyStorage extends InMemoryStorageAdapter {
  refuseWrites = false
  override async setItem(key: string, value: string): Promise<void> {
    if (this.refuseWrites) throw new Error("disk full")
    return super.setItem(key, value)
  }
}

interface World {
  clock: { t: number }
  shape: SpendShape
  outcomes: Map<string, TxOutcome>
  /** One runs on each wait, in order; with none left the run is cancelled. */
  waits: Array<() => void | Promise<void>>
  log: string[]
  hashes: number
  destinationOk: boolean
  /** The send's preparation, before it asks to sign. */
  prepare?: () => Promise<void>
  refuse?: Error
  afterHash?: Error
  noHash?: boolean
  expiresAtMs?: number
}

const dai = (amount: bigint) => `${Number(amount) / 1e18}`

function harness(over: Partial<World> = {}, storage = new FlakyStorage()) {
  const world: World = {
    clock: { t: START },
    shape: notes(),
    outcomes: new Map(),
    waits: [],
    log: [],
    hashes: 0,
    destinationOk: true,
    ...over,
  }
  const controller = new AbortController()
  const store = PreviousAccountWatchStore.get(storage)
  const deps: PreviousMoveDeps = {
    store,
    address: ONE_KEY,
    source: ONE_KEY,
    destination: TWO_KEY,
    shape: vi.fn(async () => world.shape),
    cap: 2n * DAI,
    dust: DUST,
    send: vi.fn(async (amount: bigint, onTxHash: TxHashCallback, signal: AbortSignal) => {
      await world.prepare?.()
      if (signal.aborted) throw new Error("aborted")
      world.log.push(`sign ${dai(amount)}`)
      if (world.refuse) throw world.refuse
      const txHash = hash(++world.hashes)
      if (world.noHash) return
      await onTxHash(txHash, { expiresAtMs: world.expiresAtMs ?? world.clock.t + 60_000 })
      world.outcomes.set(txHash, PENDING)
      world.log.push(`sent ${dai(amount)}`)
      if (world.afterHash) throw world.afterHash
    }),
    outcome: vi.fn(async (txHash: string) => world.outcomes.get(txHash) ?? PENDING),
    destinationOk: vi.fn(async () => world.destinationOk),
    sleep: vi.fn(async (ms: number) => {
      world.clock.t += ms
      const next = world.waits.shift()
      if (next) await next()
      else controller.abort()
    }),
    now: () => world.clock.t,
  }
  return { deps, world, store, storage, controller }
}

const seed = (store: PreviousAccountWatchStore, over: Partial<PreviousAccountWatch> = {}) =>
  store.update(ONE_KEY, () => ({ address: ONE_KEY, watchUntilMs: START, ...over }))

const stored = async (store: PreviousAccountWatchStore) => (await store.get(ONE_KEY))?.move

beforeEach(() => PreviousAccountWatchStore.resetForTests())

describe("movePreviousBalance", () => {
  it("sends one chunk, waits for its checkpoint, then sends the next, and ends done", async () => {
    const { deps, world, controller, store } = harness({ shape: notes(2n * DAI, 1n * DAI) })
    await seed(store)
    world.waits = [
      () => {
        world.log.push("proposed")
        world.outcomes.set(hash(1), included(false))
      },
      () => {
        world.log.push("checkpointed")
        world.outcomes.set(hash(1), included(true))
        world.shape = notes(1n * DAI)
      },
      () => {
        world.log.push("final")
        world.outcomes.set(hash(2), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(world.log).toEqual([
      "sign 2",
      "sent 2",
      "proposed",
      "checkpointed",
      "sign 1",
      "sent 1",
      "final",
    ])
    expect(deps.destinationOk).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledWith(PREVIOUS_MOVE_POLL_MS)
    expect(await stored(store)).toBeUndefined()
  })

  it("checks the destination again before each chunk", async () => {
    const { deps, world, controller } = harness({ shape: notes(2n * DAI, 1n * DAI) })
    world.waits = [
      () => {
        world.outcomes.set(hash(1), MINED)
        world.shape = notes(1n * DAI)
        world.destinationOk = false
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual({
      kind: "refused",
      reason: "destination",
      amount: DAI,
    })
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it("ends done with nothing sent when the balance is below the dust floor", async () => {
    const { deps, controller } = harness({ shape: notes(DUST - 1n) })
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.destinationOk).not.toHaveBeenCalled()
  })

  it.each([
    ["pending", PENDING],
    ["included without a checkpoint", included(false)],
    ["included and reverted without a checkpoint", included(false, "reverted")],
    ["unreadable", { kind: "unknown" } as TxOutcome],
  ])("asks for no signature while the stored chunk is %s", async (_, outcome) => {
    const { deps, world, controller, store } = harness({ shape: notes(1n * DAI) })
    await seed(store, { move: chunk(hash(9)) })
    world.outcomes.set(hash(9), outcome)
    world.waits = [
      () => {
        world.log.push("waited")
      },
      () => {
        world.log.push("checkpointed")
        world.outcomes.set(hash(9), included(true))
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(STOPPED)
    expect(world.log).toEqual(["waited", "checkpointed", "sign 1", "sent 1"])
    expect(vi.mocked(deps.shape).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(deps.outcome).mock.invocationCallOrder[2]!,
    )
  })

  it("resolves a chunk a reload left in flight before it plans", async () => {
    const storage = new FlakyStorage()
    await seed(harness({}, storage).store, { move: chunk(hash(9)) })
    PreviousAccountWatchStore.resetForTests()
    const { deps, world, controller } = harness({ shape: notes(1n * DAI) }, storage)
    world.outcomes.set(hash(9), MINED)
    world.waits = [
      () => {
        world.outcomes.set(hash(1), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(deps.outcome).toHaveBeenNthCalledWith(1, hash(9), START + 60_000)
    expect(vi.mocked(deps.outcome).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.shape).mock.invocationCallOrder[0]!,
    )
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["destination", { destination: OTHER }],
    ["source", { source: OTHER }],
  ])(
    "resolves a stored chunk naming another %s by its hash, then refuses with no new send",
    async (_, fields) => {
      const { deps, world, controller, store } = harness({ shape: notes(1n * DAI) })
      await seed(store, { move: chunk(hash(9), fields) })
      world.waits = [() => void world.outcomes.set(hash(9), MINED)]
      expect(await movePreviousBalance(deps, controller.signal)).toEqual({
        kind: "refused",
        reason: "destination",
        amount: DAI,
      })
      expect(deps.outcome).toHaveBeenCalledTimes(2)
      expect(deps.outcome).toHaveBeenCalledWith(hash(9), START + 60_000)
      expect(deps.send).not.toHaveBeenCalled()
      expect(deps.shape).not.toHaveBeenCalled()
      expect(await stored(store)).toBeUndefined()
    },
  )

  it.each([
    ["dead", { kind: "dead" } as TxOutcome],
    ["reverted", { kind: "reverted" } as TxOutcome],
    ["reverted at a checkpoint", included(true, "reverted")],
  ])("clears a %s chunk and plans again", async (_, outcome) => {
    const { deps, world, controller, store } = harness({ shape: notes(1n * DAI) })
    await seed(store, { move: chunk(hash(9)) })
    world.outcomes.set(hash(9), outcome)
    world.waits = [
      () => {
        world.outcomes.set(hash(1), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(world.log).toEqual(["sign 1", "sent 1"])
    expect(await stored(store)).toBeUndefined()
  })

  it("stops with nothing sent when cancelled while the send prepares", async () => {
    const { deps, world, controller, store } = harness({ shape: notes(1n * DAI) })
    await seed(store)
    world.prepare = async () => {
      await Promise.resolve()
      controller.abort()
    }
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(STOPPED)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(world.log).toEqual([])
    expect(await stored(store)).toBeUndefined()
  })

  it("stops while a chunk is in flight and keeps it", async () => {
    const { deps, world, controller, store } = harness({ shape: notes(1n * DAI) })
    world.waits = [() => controller.abort()]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(STOPPED)
    expect(await stored(store)).toEqual(chunk(hash(1)))
  })

  it("on an aborted signal reads a stored chunk once and keeps it, and with none sends nothing", async () => {
    const { deps, controller, store } = harness({ shape: notes(1n * DAI) })
    controller.abort()
    await seed(store, { move: chunk(hash(9)) })
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(STOPPED)
    expect(deps.outcome).toHaveBeenCalledTimes(1)
    expect(await stored(store)).toEqual(chunk(hash(9)))
    await seed(store)
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(STOPPED)
    expect(deps.shape).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  it("stops the send when the chunk cannot be saved, and the next run plans again", async () => {
    const { deps, world, controller, store, storage } = harness({ shape: notes(1n * DAI) })
    await seed(store)
    storage.refuseWrites = true
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toThrow("disk full")
    expect(world.log).toEqual(["sign 1"])
    storage.refuseWrites = false
    world.waits = [
      () => {
        world.outcomes.set(hash(2), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(world.log).toEqual(["sign 1", "sign 1", "sent 1"])
  })

  it("keeps a chunk whose send threw after its hash was saved, and resolves it by hash next time", async () => {
    const { deps, world, controller, store } = harness({
      shape: notes(1n * DAI),
      afterHash: new Error("node unreachable"),
    })
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toThrow("node unreachable")
    expect((await stored(store))?.txHash).toBe(hash(1))
    world.afterHash = undefined
    world.waits = [
      () => {
        world.outcomes.set(hash(1), MINED)
        world.shape = notes()
      },
    ]
    expect(await movePreviousBalance(deps, controller.signal)).toEqual(DONE)
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it("ends refused with the chunk's amount on a spend refusal, with no chunk in flight", async () => {
    const { deps, controller, store } = harness({
      shape: notes(2n * DAI, 1n * DAI),
      refuse: new Error("simulation failed", { cause: new Error("Balance too low") }),
    })
    expect(await movePreviousBalance(deps, controller.signal)).toEqual({
      kind: "refused",
      reason: "spend",
      amount: 2n * DAI,
    })
    expect(await stored(store)).toBeUndefined()
  })

  it("rethrows a send that fails before its hash for another reason, with nothing stored", async () => {
    const { deps, controller, store } = harness({
      shape: notes(1n * DAI),
      refuse: new Error("The passkey prompt was dismissed"),
    })
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toThrow("dismissed")
    expect(await stored(store)).toBeUndefined()
  })

  it("cuts a smaller first chunk under a cap of half the refused amount", async () => {
    const { deps, world, controller } = harness({
      shape: notes(2n * DAI),
      refuse: new Error("Balance too low"),
    })
    const refused = await movePreviousBalance(deps, controller.signal)
    expect(refused).toEqual({ kind: "refused", reason: "spend", amount: 2n * DAI })
    world.refuse = undefined
    const amount = refused.kind === "refused" ? refused.amount : 0n
    expect(await movePreviousBalance({ ...deps, cap: amount / 2n }, controller.signal)).toEqual(
      STOPPED,
    )
    expect(world.log).toEqual(["sign 2", "sign 1", "sent 1"])
  })

  it("refuses before any send when the destination check fails", async () => {
    const { deps, world, controller, store } = harness({
      shape: notes(1n * DAI),
      destinationOk: false,
    })
    expect(await movePreviousBalance(deps, controller.signal)).toEqual({
      kind: "refused",
      reason: "destination",
      amount: DAI,
    })
    expect(deps.send).not.toHaveBeenCalled()
    expect(world.log).toEqual([])
    expect(await stored(store)).toBeUndefined()
  })

  it("ends a run whose send returned without saving a hash, sending nothing more", async () => {
    const { deps, controller } = harness({ shape: notes(1n * DAI), noHash: true })
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toThrow("saved no hash")
    expect(deps.send).toHaveBeenCalledTimes(1)
  })
})

describe("the chunk's expiry", () => {
  it("caps a far-future expiry once when saved, so a transaction that never lands ends dead", async () => {
    const storage = new FlakyStorage()
    let finalizedAt = 0
    const node = {
      getTxReceipt: vi.fn(async () => ({ status: TxStatus.DROPPED })),
      finalizedTimestampMs: vi.fn(async () => finalizedAt),
    }
    const run = harness({ shape: notes(1n * DAI), expiresAtMs: 10 ** 15 }, storage)
    run.deps.outcome = vi.fn((txHash: string, expiresAtMs: number) =>
      txOutcome(node, txHash, expiresAtMs, run.world.clock.t),
    )
    run.world.waits = [() => undefined, () => undefined]
    expect(await movePreviousBalance(run.deps, run.controller.signal)).toEqual(STOPPED)
    const capped = START + MAX_TX_LIFETIME_MS
    expect((await stored(run.store))?.expiresAtMs).toBe(capped)
    expect(run.deps.outcome).toHaveBeenCalledTimes(4)
    for (const call of vi.mocked(run.deps.outcome).mock.calls) expect(call[1]).toBe(capped)

    PreviousAccountWatchStore.resetForTests()
    const reloaded = harness({}, storage)
    reloaded.deps.outcome = vi.fn((txHash: string, expiresAtMs: number) =>
      txOutcome(node, txHash, expiresAtMs, reloaded.world.clock.t),
    )
    reloaded.world.clock.t = capped - 1
    finalizedAt = capped - 1
    expect(await settleStoredChunk(reloaded.deps)).toBe(true)
    reloaded.world.clock.t = capped + 1
    finalizedAt = capped + 1
    expect(await settleStoredChunk(reloaded.deps)).toBe(false)
    expect(vi.mocked(reloaded.deps.outcome).mock.calls.map((call) => call[1])).toEqual([
      capped,
      capped,
    ])
    expect(await stored(reloaded.store)).toBeUndefined()
  })

  it("keeps an expiry inside the transaction's lifetime as reported", async () => {
    const { deps, world, controller, store } = harness({
      shape: notes(1n * DAI),
      expiresAtMs: START + 1_000,
    })
    world.waits = [() => controller.abort()]
    await movePreviousBalance(deps, controller.signal)
    expect((await stored(store))?.expiresAtMs).toBe(START + 1_000)
  })
})

describe("settleStoredChunk", () => {
  it("clears a checkpointed chunk and sends nothing", async () => {
    const { deps, world, store } = harness({ shape: notes(1n * DAI) })
    await seed(store, { move: chunk(hash(9)) })
    world.outcomes.set(hash(9), included(true))
    expect(await settleStoredChunk(deps)).toBe(false)
    expect(await stored(store)).toBeUndefined()
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.shape).not.toHaveBeenCalled()
  })

  it("keeps a pending chunk and sends nothing", async () => {
    const { deps, store } = harness({ shape: notes(1n * DAI) })
    await seed(store, { move: chunk(hash(9)) })
    expect(await settleStoredChunk(deps)).toBe(true)
    expect(await stored(store)).toEqual(chunk(hash(9)))
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it("answers false with no chunk stored, reading nothing", async () => {
    const { deps, store } = harness()
    await seed(store)
    expect(await settleStoredChunk(deps)).toBe(false)
    expect(deps.outcome).not.toHaveBeenCalled()
  })

  it("leaves a newer chunk stored while its read of an older one was slow", async () => {
    const { deps, store } = harness()
    await seed(store, { move: chunk(hash(1)) })
    let release!: (outcome: TxOutcome) => void
    const reading = new Promise<void>((called) => {
      vi.mocked(deps.outcome).mockImplementationOnce(() => {
        called()
        return new Promise((resolve) => (release = resolve))
      })
    })
    const settling = settleStoredChunk(deps)
    await reading
    await store.update(ONE_KEY, (current) => current && { ...current, move: chunk(hash(2)) })
    release(MINED)
    expect(await settling).toBe(true)
    expect((await stored(store))?.txHash).toBe(hash(2))
  })
})

describe("the watch window", () => {
  const closed = { closed: true as const, watchUntilMs: 0, lastCheckAtMs: 0 }

  it.each([
    ["done", {}, false],
    ["refused", { shape: notes(1n * DAI), destinationOk: false }, false],
    ["stopped", { shape: notes(1n * DAI) }, true],
  ] as const)("is pushed out when a run ends %s", async (end, over, aborted) => {
    const { deps, world, controller, store } = harness(over)
    await seed(store, closed)
    world.clock.t = START + 5_000
    if (aborted) controller.abort()
    expect((await movePreviousBalance(deps, controller.signal)).kind).toBe(end)
    expect(await store.get(ONE_KEY)).toEqual({
      address: ONE_KEY,
      lastCheckAtMs: 0,
      watchUntilMs: START + 5_000 + WATCH_WINDOW_MS,
    })
  })

  it("is pushed out when a run throws", async () => {
    const { deps, world, controller, store } = harness({
      shape: notes(1n * DAI),
      refuse: new Error("The passkey prompt was dismissed"),
    })
    await seed(store, closed)
    world.prepare = async () => {
      world.clock.t = START + 5_000
    }
    await expect(movePreviousBalance(deps, controller.signal)).rejects.toThrow("dismissed")
    expect((await store.get(ONE_KEY))?.watchUntilMs).toBe(START + 5_000 + WATCH_WINDOW_MS)
  })

  it("is pushed out by each submitted chunk", async () => {
    const { deps, world, controller, store } = harness({ shape: notes(1n * DAI) })
    await seed(store, closed)
    world.prepare = async () => {
      world.clock.t = START + 1_000
    }
    let seen: PreviousAccountWatch | null = null
    world.waits = [
      async () => {
        seen = await store.get(ONE_KEY)
        controller.abort()
      },
    ]
    await movePreviousBalance(deps, controller.signal)
    expect(seen).toEqual({
      address: ONE_KEY,
      lastCheckAtMs: 0,
      watchUntilMs: START + 1_000 + WATCH_WINDOW_MS,
      move: chunk(hash(1), { expiresAtMs: START + 1_000 + 60_000 }),
    })
  })

  it("opens a watch to save the chunk when none is stored", async () => {
    const { deps, world, controller, store } = harness({ shape: notes(1n * DAI) })
    world.waits = [() => controller.abort()]
    await movePreviousBalance(deps, controller.signal)
    expect(await store.get(ONE_KEY)).toEqual({
      address: ONE_KEY,
      watchUntilMs: START + PREVIOUS_MOVE_POLL_MS + WATCH_WINDOW_MS,
      move: chunk(hash(1)),
    })
  })
})
