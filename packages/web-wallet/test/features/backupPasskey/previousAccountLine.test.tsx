/**
 * Home's line for money at a rotated wallet's previous account: what it shows, which action this
 * session gets, and how a move started from it retries and stops.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BackupRotationPhase, BackupRotationRecord } from "@obsidion/front-core"
import type {
  PreviousAccountState,
  PreviousMoveOutcome,
} from "../../../src/features/backupPasskey/previousAccountWatcher"

type MoveOptions = { cap?: bigint; signal?: AbortSignal }

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const changed = new Set<(records: unknown[]) => void>()
  const h = {
    state: { signs: false, open: false, moving: false } as PreviousAccountState,
    listeners,
    changed,
    hideBal: false,
    list: (async () => []) as () => Promise<unknown[]>,
    move: vi.fn<(opts: MoveOptions) => Promise<PreviousMoveOutcome>>(),
    refresh: vi.fn(async () => {}),
    watcher: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      getSnapshot: () => h.state,
      move: (opts: MoveOptions) => h.move(opts),
      refresh: () => h.refresh(),
    },
  }
  return h
})

vi.mock("../../../src/features/backupPasskey/previousAccountWatcher", () => ({
  getPreviousAccountWatcher: () => h.watcher,
}))
// The page's rotation store runs as it is, over a store whose saved records the test sets.
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  BackupRotationStore: class {
    list() {
      return h.list()
    }
    onChanged(listener: (records: unknown[]) => void) {
      h.changed.add(listener)
      return () => h.changed.delete(listener)
    }
  },
}))
vi.mock("../../../src/ui/PasskeysModal", () => ({
  PasskeysModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="passkeys-sheet">
      <button onClick={onClose}>Close sheet</button>
    </div>
  ),
}))
vi.mock("../../../src/ui/prefs", () => ({ useHideBalances: () => [h.hideBal, () => {}] }))

import {
  PreviousAccountLine,
  resetPreviousAccountLineForTests,
} from "../../../src/features/backupPasskey/PreviousAccountLine"
import { resetBackupRotationStoreForTests } from "../../../src/features/backupPasskey/backupRotationStore"

const CENT = 10n ** 16n
const PREVIOUS = `0x${"0a".repeat(32)}`
const ELSEWHERE = `0x${"0b".repeat(32)}`
const ROOT: PreviousAccountState = {
  address: PREVIOUS,
  amount: 1234n * CENT,
  dust: CENT,
  signs: true,
  open: true,
  moving: false,
}

let owners = 0
const rotation = (
  phase: BackupRotationPhase,
  patch: Partial<BackupRotationRecord> = {},
  source = PREVIOUS,
) =>
  ({
    owner: `0x${(++owners).toString(16).padStart(40, "0")}`,
    phase,
    rotation: { builtOver: { l2Address: source.toUpperCase().replace("0X", "0x") } },
    ...patch,
  } as unknown as BackupRotationRecord)
const attention = (
  reason: BackupRotationRecord["attention"],
  suspended: BackupRotationPhase,
): BackupRotationRecord => rotation("attention", { attention: reason, suspended })

let host: HTMLDivElement
let root: Root

const publish = (patch: Partial<PreviousAccountState>) => {
  h.state = { ...h.state, ...patch }
  for (const listener of [...h.listeners]) listener()
}
const mount = () => act(async () => root.render(<PreviousAccountLine />))
const unmount = () => act(async () => root.unmount())
const line = () => host.querySelector('[data-testid="previous-account-line"]')?.textContent
const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent)
const press = (label: string) =>
  act(async () => {
    ;[...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click()
  })
/** A move that ends with `outcome`, published as the watcher does. */
const endsWith = (outcome: PreviousMoveOutcome) => async () => {
  publish({ moving: false, lastResult: outcome })
  return outcome
}

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  h.state = { ...ROOT }
  h.hideBal = false
  h.list = async () => []
  h.listeners.clear()
  h.changed.clear()
  h.move.mockReset()
  h.refresh.mockClear()
  resetPreviousAccountLineForTests()
  resetBackupRotationStoreForTests()
})

afterEach(async () => {
  await unmount()
  host.remove()
})

describe("PreviousAccountLine", () => {
  it("offers Move them on a root session, shows the move, then hides below the floor", async () => {
    let finish!: (outcome: PreviousMoveOutcome) => void
    h.move.mockImplementation(() => {
      publish({ moving: true })
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    await mount()
    expect(h.refresh).toHaveBeenCalledTimes(1)
    expect(line()).toContain("$12.34 arrived at your previous account")
    expect(buttons()).toEqual(["Move them"])

    await press("Move them")
    expect(h.move).toHaveBeenCalledTimes(1)
    expect(h.move.mock.calls[0][0].cap).toBeUndefined()
    expect(line()).toBe("Moving your previous account's balance…")
    expect(buttons()).toEqual([])

    await act(async () => {
      publish({ moving: false, amount: CENT - 1n, lastResult: { kind: "done" } })
      finish({ kind: "done" })
    })
    expect(line()).toBeUndefined()
  })

  it("masks the amount while Home hides balances", async () => {
    h.hideBal = true
    await mount()
    expect(line()).toContain("$•••••• arrived at your previous account")
    expect(line()).not.toContain("12.34")
  })

  it("asks a backup session to sign in with the first passkey, with no action", async () => {
    h.state = { ...ROOT, signs: false }
    await mount()
    expect(line()).toContain("$12.34 arrived at your previous account")
    expect(line()).toContain("Sign in with your first passkey to move them.")
    expect(buttons()).toEqual([])
  })

  it.each([
    ["moved", () => [rotation("moved")]],
    ["damaged before done", () => [attention("corrupt", "rerooted")]],
    ["after a done record", () => [rotation("done"), rotation("moved")]],
  ])("sends a rotation %s to Settings instead of moving", async (_name, records) => {
    h.list = async () => records()
    await mount()
    expect(line()).toContain("$12.34 arrived at your previous account")
    expect(buttons()).toEqual(["Resume in Settings"])

    await press("Resume in Settings")
    expect(host.querySelector('[data-testid="passkeys-sheet"]')).not.toBeNull()
    expect(h.move).not.toHaveBeenCalled()
    await press("Close sheet")
    expect(host.querySelector('[data-testid="passkeys-sheet"]')).toBeNull()
  })

  it("offers Move them beside a rotation unfinished over another account", async () => {
    h.list = async () => [rotation("moved", {}, ELSEWHERE)]
    await mount()
    expect(buttons()).toEqual(["Move them"])
  })

  it("follows the rotation store as its records change", async () => {
    h.list = async () => [rotation("moved")]
    await mount()
    expect(buttons()).toEqual(["Resume in Settings"])
    await act(async () => {
      for (const listener of [...h.changed]) listener([rotation("done")])
    })
    expect(buttons()).toEqual(["Move them"])
  })

  it("shows the amount with no action while the rotation store loads or cannot be read", async () => {
    h.list = () => new Promise(() => {})
    await mount()
    expect(line()).toContain("$12.34 arrived at your previous account")
    expect(buttons()).toEqual([])
    await unmount()

    resetBackupRotationStoreForTests()
    root = createRoot(host)
    const reads = vi.fn(async () => {
      throw new Error("storage refused")
    })
    h.list = reads
    await mount()
    expect(reads).toHaveBeenCalledTimes(1)
    expect(line()).toContain("$12.34 arrived at your previous account")
    expect(buttons()).toEqual([])
  })

  it("renders nothing with no balance read", async () => {
    h.state = { ...ROOT, amount: undefined }
    await mount()
    expect(host.textContent).toBe("")
  })

  it("retries a spend refusal at half the refused amount, and stops offering after the third", async () => {
    h.move
      .mockImplementationOnce(endsWith({ kind: "refused", reason: "spend", amount: 800n }))
      .mockImplementationOnce(endsWith({ kind: "refused", reason: "spend", amount: 400n }))
      .mockImplementationOnce(endsWith({ kind: "refused", reason: "spend", amount: 200n }))
    await mount()
    await press("Move them")
    expect(line()).toContain("$12.34 is still on your previous account")
    expect(line()).toContain("It could not be moved in one go.")
    expect(buttons()).toEqual(["Try again"])

    // Leaving Home and coming back keeps the count and the cap.
    await unmount()
    root = createRoot(host)
    await mount()
    await press("Try again")
    expect(buttons()).toEqual(["Try again"])
    await press("Try again")

    expect(h.move.mock.calls.map(([opts]) => opts.cap)).toEqual([undefined, 400n, 200n])
    expect(line()).toContain("$12.34 is still on your previous account")
    expect(line()).toContain("It can't be moved from the wallet yet.")
    expect(buttons()).toEqual([])
  })

  it("stops offering a retry once half the refused amount is below one unit", async () => {
    h.move.mockImplementationOnce(endsWith({ kind: "refused", reason: "spend", amount: 1n }))
    await mount()
    await press("Move them")
    expect(line()).toContain("It can't be moved from the wallet yet.")
    expect(buttons()).toEqual([])
  })

  it("counts refusals in a row: a move that finishes starts the count again", async () => {
    h.move
      .mockImplementationOnce(endsWith({ kind: "refused", reason: "spend", amount: 800n }))
      .mockImplementationOnce(endsWith({ kind: "refused", reason: "spend", amount: 400n }))
      .mockImplementationOnce(endsWith({ kind: "done" }))
      .mockImplementationOnce(endsWith({ kind: "refused", reason: "spend", amount: 600n }))
    await mount()
    await press("Move them")
    await press("Try again")
    await press("Try again")
    expect(buttons()).toEqual(["Move them"])
    await press("Move them")

    expect(h.move.mock.calls.map(([opts]) => opts.cap)).toEqual([undefined, 400n, 200n, undefined])
    expect(buttons()).toEqual(["Try again"])
  })

  it.each([
    [
      "a destination the L1 record does not name",
      { kind: "refused", reason: "destination", amount: 5n },
    ],
    ["a failed move", { kind: "failed", error: new Error("node down") }],
  ] as [string, PreviousMoveOutcome][])("shows an error line after %s", async (_name, outcome) => {
    h.move.mockImplementationOnce(endsWith(outcome))
    await mount()
    await press("Move them")
    expect(line()).toContain("$12.34 arrived at your previous account")
    expect(line()).toContain("Could not move them.")
    expect(buttons()).toEqual(["Try again"])
  })

  it("asks for no signature when Home is left while the send is still preparing", async () => {
    const sign = vi.fn()
    let prepared!: () => void
    const preparing = new Promise<void>((resolve) => {
      prepared = resolve
    })
    let ended: Promise<PreviousMoveOutcome> | undefined
    h.move.mockImplementation((opts) => {
      publish({ moving: true })
      ended = (async () => {
        await preparing
        if (opts.signal?.aborted) return { kind: "stopped" } as const
        sign()
        return { kind: "done" } as const
      })()
      return ended
    })
    await mount()
    await press("Move them")
    const { signal } = h.move.mock.calls[0][0]
    expect(signal?.aborted).toBe(false)

    await unmount()
    expect(signal?.aborted).toBe(true)
    prepared()
    expect(await ended).toEqual({ kind: "stopped" })
    expect(sign).not.toHaveBeenCalled()
  })
})
