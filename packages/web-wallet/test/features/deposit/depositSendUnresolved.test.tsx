/**
 * A desktop deposit approved without a reported hash may still be sent. The screen saves a hold to the wallet database
 * before every approval (and refuses the approval when it cannot), then keeps that address out of use and pauses new
 * funding across reloads until funds reach the address, a hash is known, or the user starts a new deposit. Storage
 * failures are reported, never read as "no hold".
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const FIRST = `0x${"a1".repeat(20)}`
const SECOND = `0x${"b2".repeat(20)}`

// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({ availableAtomic: 40_000n * 10n ** 18n }))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
const feed = vi.hoisted(() => ({
  records: [] as { sipaAddress: string; phase: string; amount: string; sweepTxHash?: string }[],
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
  useCachedRecords: () => ({ records: feed.records }),
}))
const pool = vi.hoisted(() => ({ next: [] as string[] }))
const gateway = {
  // An open with nothing queued stays resolving.
  depositAddress: vi.fn(() => {
    const address = pool.next.shift()
    return address
      ? Promise.resolve({ address, name: "alice.oxide.eth" })
      : new Promise<never>(() => {})
  }),
}
vi.mock("../../../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => gateway,
}))
const loadDepositDisplayFacts = vi.hoisted(() =>
  vi.fn(async () => ({
    fee: "0.25",
    token: "0x00000000000000000000000000000000000000bb" as Hex,
    sweepFeeAtomic: 250_000_000_000_000_000n,
    txAmountCap: 5166n * 10n ** 18n,
  })),
)
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../support/depositTokens")
  const tokens = singleToken("0x00000000000000000000000000000000000000bb", "TEST")
  return mockLoadDepositFacts(importOriginal, () => tokens, loadDepositDisplayFacts)
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// A test's own target stands in for the registration's.
const targeted = vi.hoisted(() => ({
  target: undefined as
    | import("../../../src/features/deposit/depositTarget").DepositTarget
    | undefined,
}))
vi.mock("../../../src/features/onboarding/registrationDepositTarget", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/features/onboarding/registrationDepositTarget")
  >()
  return {
    useRegistrationDepositTarget: (
      ...args: Parameters<typeof real.useRegistrationDepositTarget>
    ) => {
      const made = real.useRegistrationDepositTarget(...args)
      return targeted.target ?? made
    },
  }
})
vi.mock("../../../src/platform/desktopBridge", () => ({
  isDesktopL1SubmitActive: () => true,
  getDesktopL1Bridge: () => ({ l1SubmitPath: "/desktop/l1-submit" }),
}))
const approvals = vi.hoisted(() => ({
  errors: [] as unknown[],
  submission: "submission-1",
  pending: Promise.resolve(),
}))
vi.mock("../../../src/features/deposit/DepositFromWalletModal", () => ({
  DepositFromWalletModal: (props: {
    deposit: { address: string }
    onSendUnresolved: () => void
    onApproving: (submission: string) => Promise<void>
    onNotApproved: (submission: string) => void
    onSent: (sent: { address: string; txHash: string; amount: string; tokenSymbol: string }) => void
    onFeeChanged?: () => void
  }) => (
    <div data-testid="fund-sheet" data-address={props.deposit.address}>
      <button
        type="button"
        onClick={() => {
          approvals.pending = props.onApproving(approvals.submission).catch((err: unknown) => {
            approvals.errors.push(err)
          })
        }}
      >
        approve
      </button>
      <button
        type="button"
        onClick={() =>
          props.onSent({
            address: props.deposit.address,
            txHash: `0x${"12".repeat(32)}`,
            amount: "2.5",
            tokenSymbol: "DAI",
          })
        }
      >
        sent
      </button>
      <button type="button" onClick={props.onSendUnresolved}>
        unresolved
      </button>
      <button type="button" onClick={() => props.onNotApproved(approvals.submission)}>
        not-approved
      </button>
      <button type="button" onClick={props.onFeeChanged}>
        fee-changed
      </button>
    </div>
  ),
}))
const sentFacts = vi.hoisted(() => [] as unknown[])
vi.mock("../../../src/features/deposit/sentDepositRecord", () => ({
  sentDepositRecord: (
    sent: { address: string },
    _stored: unknown,
    _chain: number,
    facts: unknown,
  ) => {
    sentFacts.push(facts)
    return { sipaAddress: sent.address }
  },
}))
vi.mock("../../../src/ui/screens/DepositDetailModal", () => ({
  DepositDetailModal: ({
    record,
    onClose,
  }: {
    record: { sipaAddress: string }
    onClose: () => void
  }) => (
    <div data-testid="deposit-detail">
      {record.sipaAddress}
      <button type="button" aria-label="close detail" onClick={onClose} />
    </div>
  ),
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({
    account: null,
    accounts: [],
    chainId: null,
    connecting: false,
    wrongChain: false,
    pickerOpen: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}))

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
import { seedBootConfig } from "../../support/seedBootConfig"
import { shortL1Addr } from "../../../src/ui/format"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"

const dbs = testWalletDbs()
const ROLLUP = sandboxProfile().shared.rollupVersion
const openSaved = () => openWalletStore(ROLLUP, { persistent: true })

const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")
beforeEach(() => void openTestSession({ wallet: {} }))
afterEach(closeSession)

describe("DepositScreen after an unresolved desktop send", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const buttonContaining = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))
  const render = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screener={passThroughScreener}>
            <DepositScreen />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })
    for (let i = 0; i < 3; i++) await act(async () => {})
  }
  /** Unmounts, reopens the wallet database from what it saved, and mounts again, as a page reload does. */
  const reload = async () => {
    await act(async () => root.unmount())
    await closeWalletStore()
    await openSaved()
    root = createRoot(container)
    await render()
  }
  const openSheet = async () => {
    await act(async () => buttonContaining("deposit from your browser")!.click())
    expect(byTestId("fund-sheet")!.dataset.address).toBe(FIRST)
  }
  const addressSheet = () => document.querySelector("dialog[aria-label='Deposit address']")
  /** Opens the address sheet for the one coin the sandbox lists. */
  const openAddress = () => act(async () => byTestId("deposit-coin-TEST")!.click())
  const closeAddress = () =>
    act(async () =>
      addressSheet()!.querySelector<HTMLButtonElement>("[aria-label='Close']")!.click(),
    )
  /** Copies in the address sheet and waits out the copied feedback, so the sheet waits for funds. */
  const copyAndWait = async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      await act(async () => byTestId("deposit-copy")!.click())
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)))
    } finally {
      vi.useRealTimers()
    }
    expect(addressSheet()!.textContent).toContain("Waiting for your TEST")
  }
  /** Presses one of the funding sheet's buttons by its exact label. */
  const click = (label: string) =>
    act(async () => {
      ;[...container.querySelectorAll("button")].find((b) => b.textContent === label)!.click()
      await approvals.pending
    })
  /** Opens the funding sheet on the pooled address, approves a send, and ends it without a hash. */
  const sendUnresolved = async () => {
    await openSheet()
    await click("approve")
    expect(approvals.errors).toEqual([])
    await click("unresolved")
  }
  const markerKey = async () => {
    const { getConfig } = await import("../../../src/config/env")
    return `webwallet.deposit.unresolved-send.${getConfig().network}.${L2_ADDRESS.toLowerCase()}`
  }

  beforeEach(async () => {
    // Copy hands the sheet to the waiting state only when the clipboard took the address.
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    vi.clearAllMocks()
    vi.restoreAllMocks()
    approvals.errors = []
    approvals.submission = "submission-1"
    approvals.pending = Promise.resolve()
    await closeWalletStore()
    await openSaved()
    // Discovery records every published address before anything is sent to it.
    feed.records = [{ sipaAddress: FIRST, phase: "broadcast", amount: "0" }]
    pool.next = [FIRST, SECOND]
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    dbs.onApply = undefined
    await act(async () => root.unmount())
    targeted.target = undefined
    container.remove()
  })

  it("waits on the old address with funding paused, and keeps waiting after a reload", async () => {
    await render()
    await sendUnresolved()

    const notice = byTestId("deposit-send-unresolved")!
    expect(notice.textContent).toContain("Waiting for your browser wallet")
    expect(notice.textContent).toContain("may still be sent")
    expect(byTestId("fund-sheet")).toBeNull()
    expect(buttonContaining("deposit from your browser")).toBeUndefined()
    // The old address is never shown again, and no new one is taken from the pool.
    expect(byTestId("deposit-address")).toBeNull()
    expect(gateway.depositAddress).toHaveBeenCalledTimes(1)

    await reload()
    expect(byTestId("deposit-send-unresolved")).not.toBeNull()
    expect(buttonContaining("deposit from your browser")).toBeUndefined()
    expect(gateway.depositAddress).toHaveBeenCalledTimes(1)
  })

  it("holds from the waiting sheet, and a new deposit's sheet opens ready", async () => {
    await render()
    await openAddress()
    await copyAndWait()
    await closeAddress()
    await sendUnresolved()

    expect(byTestId("deposit-send-unresolved")).not.toBeNull()
    expect(container.querySelector(".ww-deposit__stealth > span")!.textContent).toBe(
      "Deposit funds",
    )
    expect(addressSheet()).toBeNull()

    await act(async () => byTestId("deposit-send-unresolved-restart")!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    await openAddress()
    expect(addressSheet()!.textContent).toContain("Send TEST to this address")
    expect(byTestId("deposit-address")!.title).toBe(SECOND)
  })

  it("opens the next sheet ready once a send made while waiting is reported", async () => {
    await render()
    await openAddress()
    await copyAndWait()
    await closeAddress()
    await openSheet()
    await click("sent")
    for (let i = 0; i < 3; i++) await act(async () => {})

    expect(byTestId("deposit-detail")!.textContent).toBe(FIRST)
    await openAddress()
    expect(addressSheet()!.textContent).toContain("Send TEST to this address")
    expect(byTestId("deposit-address")!.title).toBe(SECOND)
  })

  it("keeps waiting on the address's unfunded record, and ends once funds reach it", async () => {
    await render()
    await sendUnresolved()
    expect(byTestId("deposit-send-unresolved")).not.toBeNull()
    expect(byTestId("deposit-detail")).toBeNull()
    await reload()
    expect(byTestId("deposit-send-unresolved")).not.toBeNull()

    // The late transfer lands and discovery records it funded.
    feed.records = [
      { sipaAddress: FIRST.toUpperCase().replace("0X", "0x"), phase: "funded", amount: "24" },
    ]
    await render()
    expect(byTestId("deposit-send-unresolved")).toBeNull()
    expect(byTestId("deposit-detail")!.textContent).toBe(FIRST.toUpperCase().replace("0X", "0x"))
    await reload()
    expect(byTestId("deposit-send-unresolved")).toBeNull()
  })

  it("resolves an approval only once its hold is in the database", async () => {
    await render()
    await openSheet()
    let save = () => {}
    dbs.onApply = () => new Promise<void>((resolve) => (save = resolve))
    let approved = false
    await act(async () => buttonContaining("approve")!.click())
    const approval = approvals.pending.then(() => (approved = true))
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(approved).toBe(false)
    expect(dbs.db(ROLLUP).state.has(await markerKey())).toBe(false)
    save()
    await act(async () => approval)
    expect(approvals.errors).toEqual([])
    expect(JSON.parse(dbs.db(ROLLUP).state.get(await markerKey())!)).toMatchObject({
      address: FIRST,
      submission: "submission-1",
    })
  })

  it("refuses the approval when the database cannot save the hold", async () => {
    await render()
    await openSheet()
    dbs.onApply = () => {
      throw Object.assign(new Error("disk full"), { name: "SQLiteError" })
    }
    await click("approve")
    const { UnresolvedSendStorageError } = await import(
      "../../../src/features/deposit/unresolvedSend"
    )
    expect(approvals.errors).toHaveLength(1)
    expect(approvals.errors[0]).toBeInstanceOf(UnresolvedSendStorageError)
    dbs.onApply = undefined
    // Nothing was approved, so nothing is held.
    await reload()
    expect(byTestId("deposit-send-unresolved")).toBeNull()
  })

  it("keeps a hold saved after this screen mounted: its approval is refused, and it waits on that send", async () => {
    await render()
    await openSheet()
    const other = { address: SECOND, at: 1, submission: "other-send" }
    await walletStorage.commitItem(await markerKey(), JSON.stringify(other))
    await click("approve")
    const { UnresolvedSendHeldError } = await import("../../../src/features/deposit/unresolvedSend")
    expect(approvals.errors).toHaveLength(1)
    expect(approvals.errors[0]).toBeInstanceOf(UnresolvedSendHeldError)
    expect(JSON.parse(dbs.db(ROLLUP).state.get(await markerKey())!)).toEqual(other)
    expect(byTestId("deposit-send-unresolved")!.textContent).toContain(shortL1Addr(SECOND))
  })

  it("drops a hold saved after its send was refused, so the next send is not held", async () => {
    await render()
    await openSheet()
    let save = () => {}
    dbs.onApply = () => new Promise<void>((resolve) => (save = resolve))
    await act(async () => buttonContaining("approve")!.click())
    const late = approvals.pending
    await act(async () => buttonContaining("not-approved")!.click())
    dbs.onApply = undefined
    save()
    await act(async () => late)
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(dbs.db(ROLLUP).state.has(await markerKey())).toBe(false)

    approvals.submission = "submission-2"
    await click("approve")
    expect(approvals.errors).toEqual([])
    expect(JSON.parse(dbs.db(ROLLUP).state.get(await markerKey())!).submission).toBe("submission-2")
  })

  it("keeps another send's hold when a send it refused ends", async () => {
    await render()
    await openSheet()
    const other = { address: SECOND, at: 1, submission: "other-send" }
    await walletStorage.commitItem(await markerKey(), JSON.stringify(other))
    await click("approve")
    await click("not-approved")
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(JSON.parse(dbs.db(ROLLUP).state.get(await markerKey())!)).toEqual(other)
  })

  it("lets each approval of the same send refresh its hold", async () => {
    await render()
    await openSheet()
    await click("approve")
    await click("approve")
    expect(approvals.errors).toEqual([])
    await reload()
    expect(byTestId("deposit-send-unresolved")).not.toBeNull()
  })

  it("resolves the next address only once the sent deposit's detail is closed", async () => {
    await render()
    await openSheet()
    await click("approve")
    await click("sent")
    expect(byTestId("deposit-detail")).not.toBeNull()
    expect(gateway.depositAddress).toHaveBeenCalledTimes(1)
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='close detail']")!.click(),
    )
    expect(gateway.depositAddress).toHaveBeenCalledTimes(2)
    await openAddress()
    expect(byTestId("deposit-address")?.title).toBe(SECOND)
  })

  it("drops the hold once the send's hash is known", async () => {
    await render()
    await openSheet()
    await click("approve")
    await click("sent")
    expect(byTestId("deposit-detail")!.textContent).toBe(FIRST)
    await reload()
    expect(byTestId("deposit-send-unresolved")).toBeNull()
    expect(dbs.db(ROLLUP).state.has(await markerKey())).toBe(false)
  })

  it("pauses new deposits when the saved state cannot be read, and Check again reads it again", async () => {
    await walletStorage.commitItem(await markerKey(), "{not json")
    await render()
    const notice = byTestId("deposit-send-unresolved")!
    expect(notice.textContent).toContain("Deposit state unavailable")
    expect(buttonContaining("deposit from your browser")).toBeUndefined()
    expect(gateway.depositAddress).not.toHaveBeenCalled()

    await walletStorage.commitRemove(await markerKey())
    await click("Check again")
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(byTestId("deposit-send-unresolved")).toBeNull()
    await openAddress()
    expect(byTestId("deposit-address")!.title).toBe(FIRST)
  })

  it("keeps the hold when starting again cannot remove the saved marker", async () => {
    await render()
    await sendUnresolved()
    dbs.onApply = () => {
      throw Object.assign(new Error("disk full"), { name: "SQLiteError" })
    }
    await act(async () => byTestId("deposit-send-unresolved-restart")!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(byTestId("deposit-send-unresolved")).not.toBeNull()
    expect(byTestId("deposit-send-unresolved-error")).not.toBeNull()
    await reload()
    expect(byTestId("deposit-send-unresolved")).not.toBeNull()

    dbs.onApply = undefined
    await act(async () => byTestId("deposit-send-unresolved-restart")!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(byTestId("deposit-send-unresolved")).toBeNull()
    await reload()
    expect(byTestId("deposit-send-unresolved")).toBeNull()
  })

  it("records a send to a target's address at the target's fee, not the plain deposit's", async () => {
    sentFacts.length = 0
    const fee = 5n * 10n ** 17n
    targeted.target = {
      kind: "registration",
      address: { address: SECOND as Hex, name: "alice" },
      fee,
      floor: fee + 1n,
      ask: 10n ** 18n,
      onFunded: () => {},
      onShown: () => {},
    }
    await render()
    await act(async () => buttonContaining("deposit from your browser")!.click())
    expect(byTestId("fund-sheet")!.dataset.address).toBe(SECOND)
    await click("sent")
    expect(sentFacts.at(-1)).toMatchObject({ sweepFeeAtomic: fee })
  })

  it("reloads the fee when a send stops on a changed fee", async () => {
    await render()
    expect(loadDepositDisplayFacts).toHaveBeenCalledTimes(1)
    await act(async () => buttonContaining("deposit from your browser")!.click())
    await act(async () => buttonContaining("fee-changed")!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(loadDepositDisplayFacts).toHaveBeenCalledTimes(2)
  })
})
