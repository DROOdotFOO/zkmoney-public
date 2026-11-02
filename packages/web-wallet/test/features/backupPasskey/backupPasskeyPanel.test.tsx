import { StrictMode, act, useState, useSyncExternalStore } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import {
  type BackupRotationStore,
  fundingLocalId,
  type BackupRotationRecord,
} from "@obsidion/front-core"
import { BackupCredentialIdLengthError, type PersistedRotationVerdict } from "@obsidion/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    onClick,
    isLoading,
    isDisabled,
    testId,
  }: {
    title: string
    onClick?: () => void
    isLoading?: boolean
    isDisabled?: boolean
    testId?: string
  }) => (
    <button onClick={onClick} disabled={isLoading || isDisabled} data-testid={testId}>
      {title}
    </button>
  ),
  Icon: () => null,
  IconCircle: () => null,
  Spinner: () => null,
  StatusBadge: ({ label }: { label: string }) => <span data-testid="badge">{label}</span>,
}))

/** The explorer links read the booted app's config, which a unit test has none of. */
vi.mock("../../../src/ui/detailRows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/detailRows")>()),
  l1TxUrl: () => undefined,
  l1AddressUrl: () => undefined,
  whenLabel: () => "19 August, 12:00",
}))

/** The Settings recovery sheet: its wallet and its L1 transaction are not the panel's to test. */
vi.mock("../../../src/features/deposit/DepositExitModal/DepositExitModal", () => ({
  DepositExitModal: ({
    stranded,
    onRecovered,
    onClose,
  }: {
    stranded: { balance: string; token: { symbol: string } }
    onRecovered?: (hash: `0x${string}`) => void
    onClose: () => void
  }) => (
    <div>
      <button onClick={() => onRecovered?.(`0x${"ab".repeat(32)}`)}>
        {`Recover ${stranded.balance} ${stranded.token.symbol}`}
      </button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

import { BackupPasskeyPanel, errorLine } from "../../../src/features/backupPasskey/BackupPasskeyPanel"
import { startBackupAdd } from "../../../src/features/backupPasskey/backupPasskeyAdd"
import { DepositReadError, EmptyDepositError } from "../../../src/features/deposit/depositReadErrors"
import type { BackupFlowDeps } from "../../../src/features/backupPasskey/backupPasskeyRuntime"
import { getRotationDriver } from "../../../src/features/backupPasskey/rotationDrive"
import {
  OWNER,
  PLAN,
  SIPA,
  createdRecord,
  makeBackupAddDeps,
  makeFlowDeps,
  phaseLine,
  receipt,
  sent,
  signedRecord,
  word,
  type World,
} from "../../support/backupAdd"

/** The store's first record as an external store, delivered the way the modal's subscription is. */
function recordState(store: BackupRotationStore) {
  let current: BackupRotationRecord | null = null
  const listeners = new Set<() => void>()
  const set = (records: readonly BackupRotationRecord[]) => {
    current = records[0] ?? null
    for (const listener of listeners) listener()
  }
  store.onChanged(set)
  void store.list().then(set)
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get: () => current,
  }
}

/** Renders the panel over whatever the store holds, as the modal does. */
function Host({
  deps,
  approver,
  onCancelled,
  onFinished,
}: {
  deps: BackupFlowDeps
  approver?: string
  onCancelled: () => void
  onFinished: () => void
}) {
  const [state] = useState(() => recordState(deps.store))
  const record = useSyncExternalStore(state.subscribe, state.get, state.get)
  return record ? (
    <BackupPasskeyPanel
      record={record}
      deps={deps}
      approver={approver}
      onCancelled={onCancelled}
      onFinished={onFinished}
    />
  ) : (
    <p data-testid="no-record" />
  )
}

let root: Root
let container: HTMLDivElement
const onCancelled = vi.fn()
const onFinished = vi.fn()

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

type Made = ReturnType<typeof makeFlowDeps>

/** A poll that never fires within a test, for the cases that drive the recheck by hand. */
const NO_POLL = 60_000

async function mount(
  record: BackupRotationRecord,
  opts: Parameters<typeof makeFlowDeps>[0] = {},
  pollMs = 0,
  approver?: string,
) {
  const made = makeFlowDeps(opts)
  await made.store.put(record)
  return render(made, false, pollMs, approver)
}

/** Flushes until the stored record reaches `phase`, or gives up after `cap` rounds. */
async function untilPhase(store: BackupRotationStore, phase: string, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if ((await store.get(OWNER))?.phase === phase) return
    await flush()
  }
}

/** Flushes until the text shows, or gives up after `cap` rounds. */
async function untilText(line: string, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if (text().includes(line)) return
    await flush()
  }
}

/** The session's driver over the test's store, as the wallet's mount starts it. */
function drive(made: Made, pollMs: number) {
  getRotationDriver().start({
    store: made.store,
    deps: async () => made.deps,
    owns: () => true,
    pollMs,
  })
}

async function render(made: Made, strict: boolean, pollMs = 0, approver?: string) {
  drive(made, pollMs)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const host = (
    <Host deps={made.deps} approver={approver} onCancelled={onCancelled} onFinished={onFinished} />
  )
  await act(async () => {
    root.render(strict ? <StrictMode>{host}</StrictMode> : host)
  })
  await flush()
  return made
}

const text = () => container.textContent ?? ""
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)
const click = async (label: string) => {
  const b = button(label)
  if (!b) throw new Error(`no button ${label}`)
  await act(async () => b.click())
  await flush()
}
const current = () => container.querySelector('[aria-current="step"]')?.textContent
const steps = () =>
  [...container.querySelectorAll(".ww-backup__step")].map((li) =>
    li.className.includes("--done")
      ? "done"
      : li.className.includes("--current")
      ? "current"
      : "todo",
  )
const row = (label: string) =>
  [...container.querySelectorAll(".ww-sheet__fact")]
    .find((fact) => fact.firstElementChild?.textContent === label)
    ?.querySelector("b")?.textContent
const fundScreen = () => container.querySelector('[data-testid="backup-fund"]')
const errorText = () => container.querySelector('[data-testid="backup-error"]')?.textContent
const badge = () => container.querySelector('[data-testid="badge"]')?.textContent

const FIRST_HASH = word(0x101)
const DONE_LINE = "Your backup passkey is ready."
const DECLINED = "The passkey request was closed or timed out."

/** Past the re-root, its funding swept, with nothing moved yet. */
const rerooted = () =>
  signedRecord({
    phase: "rerooted",
    ...sent(5, { outcome: "swept" }),
    sweep: { index: "1", blockHash: word(0x90), credited: "1400" },
  })

const approveMove = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="backup-move-approve"]')

/**
 * Finalizes every transaction the fake node holds and approves each chunk's send as it asks, until
 * the record is done or `cap` rounds pass.
 */
async function settleMove(made: Made, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if ((await made.store.get(OWNER))?.phase === "done") return
    const approve = approveMove()
    if (approve && !approve.disabled) await act(async () => approve.click())
    for (const hash of made.world.receipts.keys()) {
      made.world.receipts.set(hash, receipt(TxStatus.FINALIZED))
    }
    await flush()
  }
}

/** The world once the funding mined and the sweep ran, so the record moves to swept. */
async function swept(made: Made) {
  made.world.receipts.set(FIRST_HASH, receipt(TxStatus.FINALIZED))
  made.world.sweep = { index: "1", blockNumber: 90, blockHash: word(0x90), credited: 1400n }
  for (const funding of (await made.store.get(OWNER))?.fundings ?? []) {
    made.world.rows.set(funding.localId, {
      phase: "done",
      l2TxHash: funding.txHash,
      withdrawalId: word(0x77),
      startTime: funding.sentAt,
      recipient: SIPA,
    })
  }
}

afterEach(async () => {
  getRotationDriver().stop()
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("BackupPasskeyPanel", () => {
  it("walks a created attempt through the approval, the publish, the Fund screen and the funding", async () => {
    const made = await mount(createdRecord())
    const { store, deps } = made
    expect(steps()).toEqual(["done", "current", "todo", "todo", "todo"])
    expect(current()).toContain("Approve with your current passkey")
    expect(button("Cancel")).toBeDefined()

    await click("Approve with your current passkey")
    await untilPhase(store, "published")
    expect(deps.prepare).toHaveBeenCalledTimes(1)
    expect(deps.sign).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenCalledTimes(1)
    await flush(3)
    expect(current()).toContain("Fund")
    expect(fundScreen()).not.toBeNull()
    expect(row("Your new account")).toBe(`${word(0x2b).slice(0, 6)}…${word(0x2b).slice(-4)}`)
    expect(row("Fees")).toBe("0.60 DAI")
    expect(row("You'll receive")).toBe("1.40 DAI")
    expect(row("Approvals")).toBe("1 now, then 2 to move your balance")
    expect(row("Takes")).toBe("Up to 40 minutes")
    expect(text()).toContain(
      "Once sent, the funding cannot be cancelled. You can close this tab while it waits.",
    )
    expect(text()).toContain("The approval you gave stays usable until your account next changes.")

    await click("Fund and continue")
    await flush(3)
    expect(deps.fund).toHaveBeenCalledTimes(1)
    const funded = (await store.get(OWNER))!
    expect(funded.fundings[0]).toMatchObject({ txHash: FIRST_HASH, outcome: "pending" })
    expect(fundScreen()).toBeNull()
    expect(current()).toContain("Waiting for the network")
    expect(text()).toContain("Your funding is on its way.")
    expect(text()).toContain("can take up to 40 minutes")
    expect(text()).toContain("You can close this tab and come back later")
    expect(button("Cancel")).toBeUndefined()

    await swept(made)
    await untilPhase(store, "rerooted")
    expect(deps.reroot).toHaveBeenCalledTimes(1)
    await untilText("Approve moving part 1 of 2 of your balance to your new account.")
    expect(steps()).toEqual(["done", "done", "done", "done", "current"])
    expect(button("Cancel")).toBeUndefined()
    expect(deps.move.send).not.toHaveBeenCalled()
    await settleMove(made)
    expect(await store.get(OWNER)).toMatchObject({ phase: "done" })
    expect(deps.move.send).toHaveBeenCalledTimes(2)
    await untilText(DONE_LINE)
    await click("Done")
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("keeps Check again and Cancel on a parked route whose only funding never went out", async () => {
    await mount(
      signedRecord({
        phase: "attention",
        attention: "route",
        suspended: "published",
        ...sent(5, { outcome: "never-sent" }),
      }),
      { world: { route: "route" } },
      NO_POLL,
    )
    await flush(2)
    expect(text()).toContain("The network is not paying for this right now.")
    expect(button("Check again")).toBeDefined()
    expect(button("Cancel")).toBeDefined()
  })

  it("keeps Cancel beside Try again when a signed record's checks fail", async () => {
    const made = makeFlowDeps()
    ;(made.deps.route as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"))
    await made.store.put(signedRecord())
    await render(made, false)
    await flush(3)
    expect(errorText()).toBe("Could not check, try again")
    expect(button("Try again")).toBeDefined()
    expect(button("Cancel")).toBeDefined()
    await click("Cancel")
    expect(onCancelled).toHaveBeenCalledTimes(1)
  })

  it("refuses to cancel once the deposit address shows money, and says so", async () => {
    const made = makeFlowDeps({ world: { balance: 1n } })
    made.deps.publish = vi.fn(() => new Promise<void>(() => {}))
    await made.store.put(signedRecord())
    await render(made, false)
    await flush(2)
    await click("Cancel")
    expect(errorText()).toContain("money may have reached its deposit address")
    expect(onCancelled).not.toHaveBeenCalled()
    expect((await made.store.get(OWNER))?.phase).toBe("signed")
  })

  it("a parked route whose recheck fails says so, and the next recheck can still return it", async () => {
    const made = await mount(signedRecord(), { world: { route: "route" } }, NO_POLL)
    await untilPhase(made.store, "attention")
    await flush(2)
    expect(text()).toContain("The network is not paying for this right now.")
    const route = made.deps.route as ReturnType<typeof vi.fn>
    route.mockRejectedValueOnce(new Error("rpc down"))
    await click("Check again")
    await flush(3)
    expect(text()).toContain("Could not check, try again")
    expect(text()).not.toContain("The network is not paying for this right now.")
    expect((await made.store.get(OWNER))?.attention).toBe("route")
    expect(button("Cancel")).toBeDefined()
    made.world.route = "ok"
    await click("Check again")
    await untilPhase(made.store, "published")
    await flush(3)
    expect(fundScreen()).not.toBeNull()
  })

  it("a published record whose funding may still land waits instead of offering the Fund screen", async () => {
    await mount(signedRecord({ phase: "published", ...sent() }), {
      world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) },
    })
    await flush(3)
    expect(fundScreen()).toBeNull()
    expect(current()).toContain("Waiting for the network")
    expect(button("Cancel")).toBeUndefined()
  })

  it("publishes once under StrictMode, where effects run twice", async () => {
    const made = makeFlowDeps()
    await made.store.put(signedRecord())
    const seen: string[] = []
    made.store.onChanged(([r]) => {
      const line = r ? phaseLine(r) : "gone"
      if (line !== "signed" && seen.at(-1) !== line) seen.push(line)
    })
    await render(made, true)
    await untilPhase(made.store, "published")
    await flush(3)
    expect(made.deps.publish).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(["published"])
  })

  it("offers to retry a resume that failed, asks again on its own, and keeps the record", async () => {
    const made = makeFlowDeps({
      world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) },
    })
    await made.store.put(signedRecord({ phase: "funded", ...sent() }))
    const sweep = made.deps.l1.sweep as ReturnType<typeof vi.fn>
    sweep.mockRejectedValue(new Error("rpc down"))
    await render(made, false)
    await flush(3)
    expect(errorText()).toBe("Could not check, try again")
    expect(container.querySelector('[data-testid="backup-watch-retry"]')).not.toBeNull()
    expect((await made.store.get(OWNER))?.phase).toBe("funded")
    const asked = sweep.mock.calls.length
    await flush(3)
    expect(sweep.mock.calls.length).toBeGreaterThan(asked)
    sweep.mockResolvedValue(undefined)
    await flush(3)
    expect(errorText()).toBe("")
    expect(current()).toContain("Waiting for the network")
  })

  it("keeps watching a retried chunk whose send failed after its hash", async () => {
    const made = makeFlowDeps()
    const send = made.deps.move.send as ReturnType<typeof vi.fn>
    const late = word(0x1f0)
    send.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    send.mockImplementationOnce(async (_token: string, _amount: bigint, onTxHash) => {
      await onTxHash(late, { expiresAtMs: 5000 })
      made.world.receipts.set(late, receipt(TxStatus.PENDING))
      throw new Error("wait timed out")
    })
    await made.store.put(rerooted())
    await render(made, false)
    await untilText("Approve moving")
    await act(async () => approveMove()!.click())
    await untilText(DECLINED)
    await click("Try again")
    expect(send).toHaveBeenCalledTimes(2)
    await settleMove(made)
    expect((await made.store.get(OWNER))?.phase).toBe("done")
  })

  it("keeps watching the move when a retry overtakes the resume its own phase change started", async () => {
    const made = makeFlowDeps()
    // The retry plans first; the resume plans once the retry's send is out, so its write is refused.
    let retryPlans!: () => void
    let resumePlans!: () => void
    let sends!: () => void
    const retryPlanned = new Promise<void>((resolve) => (retryPlans = resolve))
    const resumePlanned = new Promise<void>((resolve) => (resumePlans = resolve))
    const sending = new Promise<void>((resolve) => (sends = resolve))
    let shapes = 0
    ;(made.deps.move.shape as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const call = ++shapes
      if (call === 1) await retryPlanned
      if (call === 2) await resumePlanned
      return made.world.shape
    })
    const send = made.deps.move.send as ReturnType<typeof vi.fn>
    const live = send.getMockImplementation()!
    send.mockImplementationOnce(async (...args: Parameters<typeof live>) => {
      resumePlans()
      await sending
      return live(...args)
    })
    await made.store.put({
      ...rerooted(),
      phase: "attention",
      attention: "move",
      suspended: "rerooted",
    })
    await render(made, false)
    await click("Try again")
    retryPlans()
    await flush(10)
    sends()
    await settleMove(made)
    expect((await made.store.get(OWNER))?.phase).toBe("done")
  })

  it("renders each attention reason with only its permitted actions", async () => {
    const pending = { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) }
    const corrupt = {
      verdict: {
        verdict: "corrupt",
        reason: "the signature",
      } as unknown as PersistedRotationVerdict,
    }
    const cases: [BackupRotationRecord, Partial<World>, string, string[]][] = [
      [
        signedRecord({ phase: "attention", attention: "stranded", suspended: "funded", ...sent() }),
        pending,
        "Adding this backup stopped. Your funding is safe at its deposit address.",
        ["Recover funds"],
      ],
      [
        signedRecord({
          phase: "attention",
          attention: "stranded",
          suspended: "funded",
          recovery: { txHash: word(0xab) },
          ...sent(),
        }),
        pending,
        "Recovery sent. Ethereum finalizes it within about 20 minutes.",
        ["Check the address"],
      ],
      [
        signedRecord({ phase: "attention", attention: "corrupt", suspended: "funded", ...sent() }),
        { ...pending, ...corrupt },
        "This attempt's record is damaged. Its funding is safe at the deposit address.",
        ["Recover funds"],
      ],
      [
        signedRecord({ phase: "attention", attention: "corrupt", suspended: "signed" }),
        corrupt,
        "This attempt's record is damaged.",
        ["Start over"],
      ],
      [
        signedRecord({ phase: "attention", attention: "move", suspended: "rerooted", ...sent() }),
        pending,
        "It stays yours on your previous account.",
        ["Try again"],
      ],
      [
        signedRecord({ phase: "attention", attention: "route", suspended: "funded", ...sent() }),
        { ...pending, route: "route" },
        "The network is not paying for this right now.",
        [],
      ],
      // Funded from outside, with no funding of ours: the money's salt cannot be dropped.
      [
        signedRecord({ phase: "attention", attention: "route", suspended: "funded" }),
        { route: "route", balance: BigInt(PLAN.fundingAmount) },
        "The network is not paying for this right now.",
        ["Check again"],
      ],
      [
        createdRecord({ phase: "conflict" }),
        {},
        "Your passkeys changed on another device.",
        ["Start over"],
      ],
      [
        signedRecord({ phase: "conflict", ...sent() }),
        pending,
        "Your passkeys changed on another device.",
        [],
      ],
    ]
    for (const [record, world, line, actions] of cases) {
      await mount(record, { world }, NO_POLL)
      await flush(2)
      expect(text()).toContain(line)
      expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(actions)
      expect(container.querySelector('[aria-current="step"]')).toBeNull()
      await act(async () => root.unmount())
      container.remove()
    }
    await mount(createdRecord())
  })

  it("keeps the generic line for an approval that fails for another reason", async () => {
    const made = await mount(createdRecord(), {}, 0, "Security key")
    made.deps.sign = vi.fn(async () => {
      throw new Error("rpc")
    })
    await click("Approve with Security key")
    expect(errorText()).toBe("Could not check, try again")
  })

  it("names the approving passkey when the approval prompt ends without it", async () => {
    const made = await mount(createdRecord(), {}, 0, "Security key")
    made.deps.sign = vi.fn(async () => {
      throw new DOMException("closed", "NotAllowedError")
    })
    await click("Approve with Security key")
    expect(errorText()).toBe(
      "Use Security key, the passkey you signed in with. The new backup can't approve itself.",
    )
    expect(container.querySelector('[data-testid="backup-error"] b')?.textContent).toBe(
      "Security key",
    )
    expect((await made.store.get(OWNER))?.phase).toBe("created")
    await act(async () => root.unmount())
    container.remove()

    const unnamed = await mount(createdRecord())
    unnamed.deps.sign = vi.fn(async () => {
      throw new DOMException("closed", "NotAllowedError")
    })
    await click("Approve with your current passkey")
    expect(errorText()).toBe(
      "Use the passkey you signed in with. The new backup can't approve itself.",
    )
  })

  it("recovers a stranded funding, ends the attempt at recovered once final, and lets a new add start", async () => {
    const made = await mount(
      signedRecord({
        phase: "attention",
        attention: "stranded",
        suspended: "funded",
        ...sent(5, { outcome: "mined" }),
      }),
      { world: { balance: 1400n } },
    )
    await untilText("Adding this backup stopped.")
    expect(container.querySelector(".ww-backup__step")).toBeNull()
    expect(badge()).toBe("Needs recovery")
    // What reached the address, not the 2.00 DAI sent: the withdrawal kept its charges.
    expect(row("Funding")).toBe("1.80 DAI")
    await click("Recover funds")
    expect(made.deps.strandedDeposit).toHaveBeenCalledTimes(1)
    await click("Recover 1.4 DAI")
    await untilText("Recovery sent.")
    expect(badge()).toBe("Recovering")
    expect(button("Recover funds")).toBeUndefined()
    expect(await made.store.get(OWNER)).toMatchObject({
      phase: "attention",
      recovery: { txHash: `0x${"ab".repeat(32)}` },
    })
    await click("Close")
    // Final on L1: the funding reached the address and the recovery emptied it.
    made.world.balance = 0n
    made.world.rows.set(fundingLocalId("attempt-1"), {
      phase: "done",
      l2TxHash: FIRST_HASH,
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    await untilPhase(made.store, "recovered")
    await untilText("Your funds were sent back.")
    expect(badge()).toBe("Recovered")
    expect(container.querySelector(".ww-backup__step")).toBeNull()
    await click("Done")
    expect(await made.store.get(OWNER)).toBeNull()
    const add = makeBackupAddDeps({ store: made.store })
    await expect(startBackupAdd(add.deps)).resolves.toMatchObject({ phase: "created" })
  })

  it("says why the recovery cannot open, in the recovery's own words", async () => {
    const made = await mount(
      signedRecord({ phase: "attention", attention: "stranded", suspended: "funded", ...sent() }),
      { world: { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) } },
      NO_POLL,
    )
    await flush(2)
    vi.mocked(made.deps.strandedDeposit).mockRejectedValueOnce(
      new DepositReadError("That address is not an ERC-20 token on this network."),
    )
    await click("Recover funds")
    expect(errorText()).toBe("That address is not an ERC-20 token on this network.")
    expect(button("Recover 1.4 DAI")).toBeUndefined()
    vi.mocked(made.deps.strandedDeposit).mockRejectedValueOnce(
      new Error("no account factory predicts the account from this wallet's keys"),
    )
    await click("Recover funds")
    expect(errorText()).toBe("Could not check, try again")
  })

  it("says plainly when the deposit address holds nothing, without an error, and checks again", async () => {
    const pending = { receipts: new Map([[FIRST_HASH, receipt(TxStatus.PENDING)]]) }
    const held = await mount(
      signedRecord({ phase: "attention", attention: "stranded", suspended: "funded", ...sent() }),
      { world: pending },
      NO_POLL,
    )
    await flush(2)
    vi.mocked(held.deps.strandedDeposit).mockRejectedValueOnce(new EmptyDepositError())
    await click("Recover funds")
    expect(errorText()).toBe("")
    expect(text()).toContain("Nothing at the deposit address right now. This updates shortly.")
    expect(button("Recover funds")).toBeDefined()
    await act(async () => root.unmount())
    container.remove()

    const sentBack = await mount(
      signedRecord({
        phase: "attention",
        attention: "stranded",
        suspended: "funded",
        recovery: { txHash: word(0xab) },
        ...sent(),
      }),
      { world: pending },
      NO_POLL,
    )
    await flush(2)
    vi.mocked(sentBack.deps.strandedDeposit).mockRejectedValueOnce(new EmptyDepositError())
    await click("Check the address")
    expect(errorText()).toBe("")
    expect(text()).toContain("Nothing new at the deposit address.")
    // Funding that lands after the empty check leaves the recovery as it was, so the link must stay.
    expect(container.querySelector('[data-testid="backup-recover-later"]')).not.toBeNull()
    await click("Check the address")
    await click("Recover 1.4 DAI")
    await untilText("Recovery sent.")
    expect((await sentBack.store.get(OWNER))?.recovery?.txHash).toBe(`0x${"ab".repeat(32)}`)
  })

  it("offers a declined move's retry only once no earlier chunk is back in flight", async () => {
    const made = makeFlowDeps()
    const first = word(0x1a0)
    made.world.receipts.set(first, receipt(TxStatus.PENDING))
    await made.store.put(
      signedRecord({
        phase: "rerooted",
        ...sent(5, { outcome: "swept" }),
        move: {
          runs: [
            {
              plannedAt: 1,
              m: 2,
              depositBound: false,
              declined: true,
              chunks: [
                { token: "tok", amount: "1", state: "submitted", txHash: first, expiresAtMs: 5000 },
                { token: "tok", amount: "1", state: "planned" },
              ],
            },
          ],
        },
      }),
    )
    let built!: (deps: BackupFlowDeps) => void
    getRotationDriver().start({
      store: made.store,
      deps: () => new Promise((resolve) => (built = resolve)),
      owns: () => true,
      pollMs: NO_POLL,
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Host deps={made.deps} onCancelled={onCancelled} onFinished={onFinished} />)
    })
    await flush(3)
    // Checking: the earlier chunk may be back in flight, so no decline is offered yet.
    expect(button("Try again")).toBeUndefined()
    expect(errorText()).toBe("")
    expect(text()).toContain("Moving your balance (0 of 2).")
    built(made.deps)
    await flush(5)
    expect(button("Try again")).toBeUndefined()
    expect(errorText()).toBe("")
    made.world.receipts.set(first, receipt(TxStatus.PROPOSED))
    getRotationDriver().check(OWNER)
    await untilText(DECLINED)
    expect(button("Try again")).toBeDefined()
    expect(text()).toContain("Approve moving part 2 of 2 of your balance to your new account.")
    expect(made.deps.move.send).not.toHaveBeenCalled()
  })

  it("asks for no passkey after the panel closes mid-approval", async () => {
    const made = await mount(signedRecord({ phase: "rerooted", ...sent(5, { outcome: "swept" }) }))
    await untilText("Approve moving part 1 of 2")
    const shape = made.deps.move.shape as ReturnType<typeof vi.fn>
    let read!: () => void
    shape.mockImplementationOnce(
      () => new Promise((resolve) => (read = () => resolve(made.world.shape))),
    )
    await act(async () => approveMove()!.click())
    await flush(3)
    expect(getRotationDriver().drive(OWNER)?.approving).toBe(true)
    await act(async () => root.unmount())
    root = createRoot(container)
    read()
    await flush(5)
    expect(made.deps.move.send).not.toHaveBeenCalled()
    expect(getRotationDriver().drive(OWNER)?.resume).toEqual({ wait: "approval" })
    expect((await made.store.get(OWNER))?.move?.runs[0]?.chunks[0]?.state).toBe("planned")
  })

  it("shows Checking… and reads nothing until the session's driver runs", async () => {
    const made = makeFlowDeps()
    await made.store.put(signedRecord({ phase: "published" }))
    getRotationDriver().stop()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Host deps={made.deps} onCancelled={onCancelled} onFinished={onFinished} />)
    })
    await flush(5)
    expect(text()).toContain("Checking…")
    expect(text()).not.toContain("Could not check")
    expect(made.deps.verify).not.toHaveBeenCalled()
    drive(made, 0)
    await flush(3)
    expect(fundScreen()).not.toBeNull()
  })
})

describe("errorLine", () => {
  it("names a credential id the account cannot store, which no retry changes", () => {
    expect(errorLine(new BackupCredentialIdLengthError(129))).toBe(
      "This passkey can't be a backup: its credential id is longer than the account can store. Cancel and use another passkey.",
    )
  })
})
