/**
 * One path for every user transaction: an operation is tab-bound until its flow's record holds the
 * hash, and a reload or a takeover settles it either way. A record from before this tab became
 * active that never got a hash fails at once; one with a hash is left to the chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import {
  TRANSACTIONS_STORAGE_KEY,
  TxInFlightError,
  trackSubmission,
  WalletError,
} from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession } from "../../../src/platform/session"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { testWalletDbs } from "../../support/fakeWalletDb"
import {
  currentOperation,
  getOperationStore,
  getOperationsInProgress,
  leavingLosesTransaction,
  runBackgroundOperation,
  runListedOperation,
  runOperation,
  tabBoundOperation,
} from "../../../src/features/operations/operations"
import { userFlowActive } from "../../../src/features/provingGate"
import { recoverInterrupted } from "../../../src/features/operations/operationsTasks"
import { operationText } from "../../../src/features/operations/operationEntries"
import { sponsorshipErrorCopy } from "../../../src/features/allowance/sponsorshipError"

const hash = `0x${"ab".repeat(32)}`
const flush = () => new Promise((r) => setTimeout(r, 0))
/** An ended operation's description: its summary, then the words for how it ended. */
const described = (summary: string, words: string) => [summary, words].join(". ")

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  closeSession()
})

const opened = () => switchSession(activeNamespace())
const activity = () => opened().activity
const sweepStores = () => {
  const { db, activity, withdrawals } = opened()
  return { db, activity, withdrawals, operations: getOperationStore() }
}

describe("runOperation", () => {
  it("returns the flow's result even when the settle write fails, and stays unsettled", async () => {
    const store = getOperationStore()
    const result = await runOperation(
      { operationId: "op-full", flow: "send", summary: "$1 to @bob" },
      async () => {
        testWalletDbs().onApply = () => {
          throw new Error("QuotaExceededError")
        }
        return "done"
      },
    )
    expect(result).toBe("done")
    expect(store.get("op-full")?.state).toBe("local")
  })

  it("is local until the flow's record holds the hash, then settles with the flow", async () => {
    const store = getOperationStore()
    let seen: string | undefined
    await runOperation(
      { operationId: "op-send", flow: "send", summary: "$25" },
      async () => {
        expect(store.get("op-send")?.state).toBe("local")
        const submission = trackSubmission("op-send")
        provingProgress.emitStageStart(ProvingStage.Mining, "op-send", hash)
        submission.stop()
        await flush()
        seen = store.get("op-send")?.state
        return hash
      },
      (h) => h,
    )
    expect(seen).toBe("sent")
    expect(store.get("op-send")).toMatchObject({ state: "settled", txHash: hash })
  })

  it("drops the record when nothing was sent", async () => {
    const cancelled = runOperation(
      { operationId: "op-c", flow: "send", summary: "$1" },
      async () => {
        throw new Error("Cancelled")
      },
    )
    await expect(cancelled).rejects.toThrow("Cancelled")
    expect(getOperationStore().get("op-c")).toBeNull()
  })

  it("drops the record when the flow failed before proving began", async () => {
    const unregistered = new WalletError("contact.unregistered", "@bob", { data: { tag: "bob" } })
    const failed = runOperation({ operationId: "op-r", flow: "send", summary: "$1" }, async () => {
      throw unregistered
    })
    await expect(failed).rejects.toBe(unregistered)
    expect(getOperationStore().get("op-r")).toBeNull()
  })

  it.each([
    ["Assertion failed: Gas settings exceed whitelist max_fee", /network fees are too high/],
    ["Assertion failed: allowance exhausted", /no sponsored transactions left/],
  ])(
    "fails, not drops, a send whose screen handed off before proving began: %s",
    async (refusal, copy) => {
      const failed = runOperation(
        { operationId: "op-h", flow: "send", summary: "$1" },
        async () => {
          await getOperationStore().markHandedOff("op-h")
          throw new Error(refusal)
        },
      )
      await expect(failed).rejects.toThrow(refusal)
      const record = getOperationStore().get("op-h")
      expect(record).toMatchObject({ state: "failed", error: refusal })
      const { description } = operationText(record!)
      expect(description).toBe(
        described("$1", sponsorshipErrorCopy(refusal, "contact:send")!.message),
      )
      expect(description).toMatch(copy)
    },
  )

  it("fails a local operation with the flow's error once proving began", async () => {
    const teeDown = new Error("TEE unavailable")
    const failed = runOperation({ operationId: "op-f", flow: "send", summary: "$1" }, async () => {
      provingProgress.emitStageStart(ProvingStage.Simulating, "op-f")
      await flush()
      throw teeDown
    })
    await expect(failed).rejects.toBe(teeDown)
    expect(getOperationStore().get("op-f")).toMatchObject({
      state: "failed",
      error: teeDown.message,
    })
  })

  it("leaves a sent operation to the chain when the flow lost track of it", async () => {
    const store = getOperationStore()
    const lost = runOperation({ operationId: "op-l", flow: "send", summary: "$1" }, async () => {
      await store.markSent("op-l", hash)
      throw new TxInFlightError(hash, new Error("socket closed"))
    })
    await expect(lost).rejects.toBeInstanceOf(TxInFlightError)
    expect(store.get("op-l")?.state).toBe("sent")
    expect(store.unowned().map((r) => r.operationId)).toContain("op-l")
  })

  it("marks an in-flight operation sent from its error when nothing announced the hash", async () => {
    const store = getOperationStore()
    const lost = runOperation({ operationId: "op-w", flow: "send", summary: "$1" }, async () => {
      const submission = trackSubmission("op-w", { announce: false })
      provingProgress.emitStageStart(ProvingStage.Mining, "op-w", hash)
      submission.stop()
      throw new TxInFlightError(hash, new Error("socket closed"))
    })
    await expect(lost).rejects.toBeInstanceOf(TxInFlightError)
    expect(store.get("op-w")).toMatchObject({ state: "sent", txHash: hash })
    expect(store.unowned().map((r) => r.operationId)).toContain("op-w")
  })

  it("leaves a burn that may still land to the chain with the hash it was sent under", async () => {
    const store = getOperationStore()
    await runOperation({ operationId: "op-b", flow: "withdraw", summary: "$1" }, async (op) => {
      op.leaveToChain(hash)
      return "pending-record"
    })
    expect(store.get("op-b")).toMatchObject({ state: "sent", txHash: hash })
    expect(store.unowned().map((r) => r.operationId)).toContain("op-b")
  })

  it("fails a sent operation with the flow's error when the chain turned it down", async () => {
    const store = getOperationStore()
    const turnedDown = new Error("The network dropped this payment")
    const dropped = runOperation({ operationId: "op-d", flow: "send", summary: "$1" }, async () => {
      const submission = trackSubmission("op-d")
      provingProgress.emitStageStart(ProvingStage.Mining, "op-d", hash)
      submission.stop()
      await flush()
      expect(store.get("op-d")?.state).toBe("sent")
      throw turnedDown
    })
    await expect(dropped).rejects.toBe(turnedDown)
    expect(store.get("op-d")).toMatchObject({ state: "failed", error: turnedDown.message })
    expect(store.get("op-d")?.cause).toBeUndefined()
  })

  it("binds the tab to a live operation of any scope", async () => {
    const store = getOperationStore()
    await store.begin({
      operationId: "op-visitor",
      flow: "paylink-claim",
      summary: "$1",
      scope: "x",
    })
    try {
      expect(leavingLosesTransaction()).toBe(true)
    } finally {
      await store.remove("op-visitor")
    }
    expect(leavingLosesTransaction()).toBe(false)
  })

  it("holds the single-flight gate while it runs", async () => {
    let gated = false
    await runOperation({ operationId: "op-g", flow: "send", summary: "$1" }, async () => {
      gated = userFlowActive()
    })
    expect(gated).toBe(true)
    expect(userFlowActive()).toBe(false)
  })
})

describe("currentOperation", () => {
  it("is the outermost live operation; every live local record still binds the tab", async () => {
    const store = getOperationStore()
    let release!: () => void
    const parentDone = runOperation(
      { operationId: "parent", flow: "paylink-claim", summary: "$5 paylink" },
      () =>
        runOperation(
          { operationId: "child", flow: "deposit", summary: "Deposit address", parent: "parent" },
          () => new Promise<void>((resolve) => (release = resolve)),
        ),
    )
    await flush()
    await flush()
    const records = store.list()
    expect(records.find((r) => r.operationId === "child")?.parent).toBe("parent")
    expect(currentOperation(records)?.operationId).toBe("parent")
    // The child alone binds the tab once its parent stopped running.
    store.release("parent")
    expect(currentOperation(store.list())?.operationId).toBe("child")
    expect(tabBoundOperation(store.list())).toBeDefined()
    release()
    await parentDone
    expect(currentOperation(store.list())).toBeUndefined()
  })
})

describe("a background operation", () => {
  it("is listed in no notification, names no busy label, and leaving does not lose it", async () => {
    const store = getOperationStore()
    await store.begin({
      operationId: "op-bg",
      flow: "deposit",
      summary: "Deposit address",
      scope: null,
      resumable: true,
      background: true,
    })
    try {
      expect(store.isLive("op-bg")).toBe(true)
      expect(leavingLosesTransaction()).toBe(false)
      expect(currentOperation(store.list())).toBeUndefined()
      expect(getOperationsInProgress().map((r) => r.operationId)).not.toContain("op-bg")
    } finally {
      await store.remove("op-bg")
    }
  })
})

describe("runBackgroundOperation", () => {
  const step = { operationId: "op-step", flow: "migration" as const, summary: "Upgrade" }

  it("runs a background record outside the user's gate, and a user flow raised meanwhile waits it out", async () => {
    const store = getOperationStore()
    let release!: () => void
    const running = runBackgroundOperation(step, () => new Promise<void>((r) => (release = r)))
    await flush()
    expect(store.get("op-step")).toMatchObject({ state: "local", background: true })
    expect(userFlowActive()).toBe(false)
    expect(leavingLosesTransaction()).toBe(false)
    let sent = false
    const user = runOperation({ operationId: "op-user", flow: "send", summary: "$1" }, async () => {
      sent = true
    })
    await flush()
    expect(sent).toBe(false)
    release()
    await Promise.all([running, user])
    expect(sent).toBe(true)
    expect(store.get("op-step")?.state).toBe("settled")
  })

  it("drops a step that failed before proving, and fails one a reload cut off while proving", async () => {
    const store = getOperationStore()
    const relayerDown = new Error("relayer unavailable")
    await expect(
      runBackgroundOperation(step, async () => {
        throw relayerDown
      }),
    ).rejects.toBe(relayerDown)
    expect(store.get("op-step")).toBeNull()
    await store.begin({ ...step, scope: null, background: true }, 9_000)
    await store.markProving("op-step")
    store.release("op-step")
    await recoverInterrupted(sweepStores(), 10_000, 20_000)
    expect(store.get("op-step")).toMatchObject({ state: "failed", cause: "interrupted" })
  })
})

describe("runListedOperation", () => {
  it("lists the operation and keeps the tab, but raises no user flow, so a background step inside runs", async () => {
    const store = getOperationStore()
    const steps: boolean[] = []
    await runListedOperation(
      { operationId: "op-listed", flow: "migration", summary: "Upgrade" },
      async () => {
        expect(userFlowActive()).toBe(false)
        expect(store.get("op-listed")).toMatchObject({ state: "local" })
        expect(store.get("op-listed")?.background).toBeFalsy()
        expect(leavingLosesTransaction()).toBe(true)
        await runBackgroundOperation(
          { operationId: "op-step", flow: "migration", summary: "Upgrade" },
          async () => void steps.push(userFlowActive()),
        )
      },
    )
    expect(steps).toEqual([false])
    expect(store.get("op-listed")?.state).toBe("settled")
  })

  it("removes the record of a flow that stopped before anything was proven", async () => {
    const store = getOperationStore()
    await expect(
      runListedOperation({ operationId: "op-stop", flow: "migration", summary: "Upgrade" }, () =>
        Promise.reject(new Error("stopped")),
      ),
    ).rejects.toThrow("stopped")
    expect(store.get("op-stop")).toBeNull()
  })
})

describe("recoverInterrupted", () => {
  const activeSince = 10_000
  const now = 20_000

  async function sendRow(operationId: string, txHash = "") {
    const rows = activity()
    await rows.insertPending({
      networkId: "0xnet",
      id: operationId,
      operationId,
      action: "send",
      token: {
        address: "0x1",
        name: "DAI",
        symbol: "DAI",
        decimals: 18,
        logo: "",
        price: 1,
        amount: 1,
      },
      amountAtomic: 10n ** 18n,
      timestamp: activeSince - 1,
      status: "pending",
      txHash,
      to: "0x2",
    })
    return () => rows.get(operationId)
  }

  it("fails a withdrawal a reload cut off before submit, and keeps one that was sent", async () => {
    const withdrawals = opened().withdrawals
    const seed = (localId: string, l2TxHash?: string) =>
      withdrawals.create({
        localId,
        networkId: "0xnet",
        recipient: `0x${"22".repeat(20)}`,
        recipientProvenance: "saved-recipient",
        amount: "12.1",
        tokenSymbol: "DAI",
        phase: "submitting",
        startTime: activeSince - 5_000,
        ...(l2TxHash ? { l2TxHash } : {}),
      } as Parameters<typeof withdrawals.create>[0])
    await seed("cut-off")
    await seed("sent", hash)
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect((await withdrawals.get("cut-off"))?.phase).toBe("failed")
    expect((await withdrawals.get("sent"))?.phase).toBe("submitting")
  })

  it("fails a send row and every operation from before this tab became active, never this tab's", async () => {
    const ops = getOperationStore()
    await ops.begin(
      { operationId: "old", flow: "send", summary: "$1", scope: null },
      activeSince - 1,
    )
    await ops.markProving("old")
    ops.release("old")
    await ops.begin(
      { operationId: "other-scope", flow: "paylink-claim", summary: "$1", scope: "acct" },
      activeSince - 1,
    )
    await ops.markProving("other-scope")
    ops.release("other-scope")
    await ops.begin(
      { operationId: "never-proved", flow: "send", summary: "$1", scope: null },
      activeSince - 1,
    )
    ops.release("never-proved")
    await ops.begin(
      { operationId: "new", flow: "send", summary: "$1", scope: null },
      activeSince + 1,
    )
    const row = await sendRow("old")
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect(ops.get("old")).toMatchObject({ state: "failed", cause: "interrupted" })
    expect(ops.get("other-scope")).toMatchObject({ state: "failed", cause: "interrupted" })
    expect(ops.get("never-proved")).toBeNull()
    expect(ops.get("new")?.state).toBe("local")
    expect((await row())?.status).toBe("failed")
  })

  it("stamps a sent operation's hash onto the flow's records, so neither is failed", async () => {
    const ops = getOperationStore()
    await ops.begin({ operationId: "rep", flow: "send", summary: "$1", scope: null }, 1)
    await ops.markSent("rep", hash)
    ops.release("rep")
    const row = await sendRow("rep")
    const withdrawals = opened().withdrawals
    await withdrawals.create({
      localId: "rep-burn",
      operationId: "rep",
      networkId: "0xnet",
      recipient: `0x${"22".repeat(20)}`,
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: activeSince - 5_000,
    } as Parameters<typeof withdrawals.create>[0])
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect(await row()).toMatchObject({ status: "pending", txHash: hash })
    expect(await withdrawals.get("rep-burn")).toMatchObject({ phase: "submitting", l2TxHash: hash })
    expect(ops.get("rep")?.state).toBe("sent")
  })

  it("saves an operation's hash on its row and its burn together, or on neither", async () => {
    const ops = getOperationStore()
    await ops.begin({ operationId: "pair", flow: "send", summary: "$1", scope: null }, 1)
    await ops.markSent("pair", hash)
    ops.release("pair")
    const row = await sendRow("pair")
    const withdrawals = opened().withdrawals
    await withdrawals.create({
      localId: "pair-burn",
      operationId: "pair",
      networkId: "0xnet",
      recipient: `0x${"22".repeat(20)}`,
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: activeSince - 5_000,
    } as Parameters<typeof withdrawals.create>[0])
    testWalletDbs().onApply = (_version, written) => {
      if (written.some(([key]) => key.includes("acct/withdrawals/pair-burn")))
        throw new Error("disk full")
    }
    await recoverInterrupted(sweepStores(), activeSince, now)
    testWalletDbs().onApply = undefined
    expect((await row())?.txHash).toBe("")
    expect((await withdrawals.get("pair-burn"))?.l2TxHash).toBeUndefined()
  })

  it("sends, not fails, a local operation whose flow's record holds the hash", async () => {
    const ops = getOperationStore()
    await ops.begin({ operationId: "rep2", flow: "send", summary: "$1", scope: null }, 1)
    await ops.markProving("rep2")
    ops.release("rep2")
    const row = await sendRow("rep2", hash)
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect(ops.get("rep2")).toMatchObject({ state: "sent", txHash: hash })
    expect((await row())?.status).toBe("pending")
  })

  it("sends, not fails, a local operation whose legacy row holds the hash, once an open lands", async () => {
    const token = { address: "0x1", name: "DAI", symbol: "DAI", decimals: 18, logo: "", price: 1 }
    const legacy = {
      operationId: "imported",
      action: "send",
      token: { ...token, amount: 1 },
      amountAtomic: "1",
      timestamp: 1,
      status: "pending",
      txHash: hash,
    }
    await walletStorage.commitItem(`obsidion.${TRANSACTIONS_STORAGE_KEY}`, JSON.stringify([legacy]))
    let failed = false
    testWalletDbs().onApply = (_version, ops) => {
      if (failed || !ops.some(([key]) => key.endsWith("acct/meta/activity"))) return
      failed = true
      throw new Error("disk full")
    }
    const ops = getOperationStore()
    await ops.begin({ operationId: "imported", flow: "send", summary: "$1", scope: null }, 1)
    await ops.markProving("imported")
    ops.release("imported")
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect(failed).toBe(true)
    // A store that did not open is not empty: nothing is failed until a later page reads it.
    expect(ops.get("imported")).toMatchObject({ state: "local" })
    closeSession()
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect(ops.get("imported")).toMatchObject({ state: "sent", txHash: hash })
  })

  it("sends an operation begun the moment this tab became active whose flow's record holds the hash", async () => {
    const ops = getOperationStore()
    await ops.begin({ operationId: "edge", flow: "send", summary: "$1", scope: null }, activeSince)
    await ops.markProving("edge")
    ops.release("edge")
    await sendRow("edge", hash)
    await recoverInterrupted(sweepStores(), activeSince, now)
    expect(ops.get("edge")).toMatchObject({ state: "sent", txHash: hash })
  })
})
