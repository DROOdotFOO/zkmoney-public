/**
 * An upgrade shares the single-flight prover with the user's own transactions through the REAL
 * proving gate and operations. Only the prepare pass is a user flow. Each funds send, and each
 * re-send of the observe pass, is its own background operation. So a funds-only run that waits for
 * the registration run's sponsorship never holds the user flow that the sponsorship step waits for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MetadataMigrationController,
  runMetadataMigration,
  type MetadataMigrationObservation,
  type MetadataMigrationRecord,
  type MetadataMigrationSteps,
} from "@obsidion/front-core"
import { getOperationStore } from "../../../src/features/operations/operations"
import { runUserFlow, userFlowActive } from "../../../src/features/provingGate"
import { backgroundSend, runGatedMigrationQueue } from "../../../src/features/migration/gatedMigration"

const POLL_MS = 5
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Resolves once `check` holds; fails the test if it never does. */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => (resolve = res))
  return { promise, resolve }
}

/** A durable controller on memory, with `record` saved under its key. */
function controllerOf(steps: MetadataMigrationSteps, record?: MetadataMigrationRecord) {
  const memory = new Map<string, string>()
  if (record) memory.set(record.id, JSON.stringify(record))
  const key = record?.id ?? "funds"
  const controller = new MetadataMigrationController(
    {
      getItem: async (k: string) => memory.get(k) ?? null,
      setItem: async (k: string, v: string) => void memory.set(k, v),
    },
    steps,
    key,
  )
  return controller
}

/** Steps where every action fails the test unless the case replaces it. */
function steps(
  observe: () => MetadataMigrationObservation,
  patch: Partial<MetadataMigrationSteps>,
): MetadataMigrationSteps {
  const never = (name: string) => async () => {
    throw new Error(`unexpected ${name}`)
  }
  return {
    binding: async () => "bound",
    prepare: never("prepare"),
    ready: async () => {},
    observe: async () => observe(),
    broadcast: never("broadcast"),
    subscribe: never("subscribe"),
    recoverRemaining: never("recoverRemaining"),
    ...patch,
  }
}

const observation = (patch: Partial<MetadataMigrationObservation>) => ({
  bootstrapSpent: false,
  metadataSettled: false,
  messagesReady: false,
  recurringSponsorship: false,
  sent: false,
  complete: false,
  ...patch,
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("an upgrade on the real proving gate", () => {
  it("lets the registration run subscribe while a funds-only run waits, then sends the funds", async () => {
    let sponsored = false
    let fundsSent = false
    const events: string[] = []

    // The funds-only run: it waits until the destination has recurring sponsorship.
    let fundsPhase: string | undefined
    const funds = controllerOf(
      steps(
        () =>
          observation({
            recurringSponsorship: sponsored,
            metadataSettled: sponsored,
            sent: fundsSent,
          }),
        {
          waitsForRegistration: true,
          prepare: async () => {
            expect(userFlowActive()).toBe(true)
            events.push("funds prepared")
            return "funds-plan"
          },
          recoverRemaining: async (_plan, _signal, gate) => {
            // Every batch is sent: a later pass has nothing to send.
            if (fundsSent) return
            await gate!(async (operationId) => {
              // A background step: no user flow runs, and the step has its own operation.
              expect(userFlowActive()).toBe(false)
              expect(getOperationStore().get(operationId!)?.background).toBe(true)
              events.push("funds sent")
              fundsSent = true
            })
          },
        },
      ),
    )
    funds.subscribe(() => (fundsPhase = funds.getSnapshot()?.phase))

    // The registration run: its bootstrap is included and its messages are ready, so its promptless
    // follower sends the subscription.
    const registration = controllerOf(
      steps(() => observation({ messagesReady: !sponsored, recurringSponsorship: sponsored }), {
        subscribe: async (_plan, onTxHash, operationId) => {
          expect(userFlowActive()).toBe(false)
          expect(getOperationStore().get(operationId!)?.background).toBe(true)
          events.push(`subscribe while funds ${fundsPhase}`)
          await onTxHash("0xsubscription")
          sponsored = true
        },
      }),
      {
        id: "registration",
        binding: "bound",
        phase: "awaitingMessages",
        plan: "registration-plan",
        bootstrapTx: "0xbootstrap",
        bootstrapStatus: "included",
        allowance: "spent",
      },
    )

    const signal = new AbortController()
    const operationId = "migration_queue"
    const queue = runGatedMigrationQueue(
      { operationId, flow: "migration", summary: "Upgrade" },
      [{ controller: funds }],
      {
        signal: signal.signal,
        pollMs: POLL_MS,
        onActive: () => () => {},
        onPrepared: () => events.push("prepared"),
        onArriving: () => events.push("funds arriving"),
      },
    )
    // The send pass waits for the registration; it holds no user flow while it waits.
    await until(() => fundsPhase === "waiting", "the funds run waits")
    expect(userFlowActive()).toBe(false)
    expect(getOperationStore().get(operationId)).toMatchObject({ state: "local" })
    expect(getOperationStore().get(operationId)?.background).toBeFalsy()

    const follower = runMetadataMigration(registration, {
      signal: signal.signal,
      promptless: true,
      pollMs: POLL_MS,
      exclusive: backgroundSend,
      until: (record) => record.allowance === "registered",
    })

    await expect(queue).resolves.toBe(true)
    signal.abort()
    await follower
    expect(events).toEqual([
      "funds prepared",
      "prepared",
      "subscribe while funds waiting",
      "funds sent",
      "funds arriving",
    ])
    // The bell row covered the whole upgrade, and ended with it.
    expect(getOperationStore().get(operationId)?.state).toBe("settled")
  })

  it("holds an observe pass's re-send while a user flow runs, and sends it once the flow ends", async () => {
    const sent = vi.fn()
    const observed = controllerOf(
      steps(() => observation({ recurringSponsorship: true, metadataSettled: true, sent: true }), {
        reconcileRemaining: async (_plan, _signal, gate) => {
          await gate!(async (operationId) => {
            expect(userFlowActive()).toBe(false)
            sent(operationId)
          })
        },
      }),
      {
        id: "observed",
        binding: "bound",
        phase: "arriving",
        plan: "plan",
        bootstrapTx: "0xbootstrap",
        allowance: "registered",
      },
    )
    const userTx = deferred()
    const flow = runUserFlow(() => userTx.promise)

    const signal = new AbortController()
    const follow = runMetadataMigration(observed, {
      signal: signal.signal,
      observeOnly: true,
      pollMs: POLL_MS,
      exclusive: backgroundSend,
    })
    for (let i = 0; i < 5; i++) await flush()
    expect(sent).not.toHaveBeenCalled()

    userTx.resolve()
    await flow
    await until(() => sent.mock.calls.length > 0, "the re-send runs")
    expect(getOperationStore().get(sent.mock.calls[0]![0])?.background).toBe(true)
    signal.abort()
    await follow
  })
})
