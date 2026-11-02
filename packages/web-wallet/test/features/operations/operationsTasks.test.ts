/**
 * The session's operation tasks run once the wallet is ready. The settle pass keeps a 10 s pace
 * while visible; the sweep runs once per session and ends only what started by the time the tab
 * became the active tab: anything later is this tab's own.
 */
import { afterEach, expect, it, vi } from "vitest"
import {
  createActivity,
  createWithdrawals,
  memoryBackend,
  openDatabase,
  startRuntime,
} from "@obsidion/front-core"
import { getOperationStore } from "../../../src/features/operations/operations"
import {
  interruptedSweep,
  operationsSettle,
} from "../../../src/features/operations/operationsTasks"
import { later, periodicSteps, sessions, table } from "../../../../front-core/test/engine/taskTable"

const db = openDatabase(memoryBackend())
const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
  vi.useRealTimers()
})

/** Sessions over one task and a wallet the test makes ready. */
function harness() {
  const wallet = later<{ node: never }>("wallet")
  const h = sessions(startRuntime)
  ends.push(h.end)
  return { ...h, wallet: wallet.resource, ready: () => wallet.ready({ node: "node" as never }) }
}

it("settles sent operations once the wallet is ready, every 10 s while visible, at once on show", async () => {
  vi.useFakeTimers()
  const resolveSent = vi.fn(async () => {})
  const h = harness()
  h.tasks.push(operationsSettle({ wallet: h.wallet, operations: { resolveSent } }))
  await table(periodicSteps(h, h.ready, 10_000), () => resolveSent.mock.calls.length)
  expect(resolveSent).toHaveBeenLastCalledWith("node")
})

it("sweeps once the wallet is ready, up to when the tab became active, and once per session", async () => {
  const store = getOperationStore()
  const begin = async (operationId: string, startedAt: number) => {
    await store.begin({ operationId, flow: "send", summary: "$5", scope: null }, startedAt)
    await store.markProving(operationId, startedAt)
  }
  await begin("before", 4_000)
  await begin("after", 6_000)
  const states = () => Object.fromEntries(store.list().map((r) => [r.operationId, r.state]))
  const h = harness()
  h.tasks.push(
    interruptedSweep({
      wallet: h.wallet,
      db,
      activity: createActivity({ db }),
      withdrawals: createWithdrawals({ db }),
      operations: store,
      activeSince: () => 5_000,
    }),
  )
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  h.start()
  await settle()
  expect(states()).toEqual({ before: "local", after: "local" })

  h.ready()
  await vi.waitFor(() => expect(states()).toEqual({ before: "failed", after: "local" }))

  await begin("later", 4_500)
  h.hide()
  h.show()
  h.stop()
  await settle()
  expect(states().later).toBe("local")

  h.start()
  await vi.waitFor(() => expect(states().later).toBe("failed"))
  expect(states().after).toBe("local")
})
