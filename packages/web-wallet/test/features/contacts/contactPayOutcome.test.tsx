import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { balancesOf } from "../../support/balances"

const m = vi.hoisted(() => ({
  pay: vi.fn(),
  upgraded: vi.fn(async (_tag: string) => true),
  reportError: vi.fn(),
  fireEvent: vi.fn(),
  entry: undefined as import("@obsidion/front-core").Contact | undefined,
}))
vi.mock("../../../src/features/operations/operations", async () =>
  (await import("../../support/fakeOperations")).fakeOperationsModule(),
)
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ getEntries: async () => [] }) },
  useContractServiceContext: () => ({ contractService: {} }),
  TxInFlightError: class TxInFlightError extends Error {},
  INTERRUPTED_ERRORS: {},
}))
vi.mock("@obsidion/web-ds", () => ({ Icon: () => null, GradientSpinner: () => null }))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: m.fireEvent,
  failureCode: () => "unknown",
  lapTimer: () => () => 0,
  amountBucket: () => "<50",
  requestAmountBucket: () => "<50",
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: m.reportError }))
vi.mock("../../../src/ui/format", () => ({ parseAmount: Number, floorToCents: () => "100" }))
vi.mock("../../../src/ui/PayModalChrome", () => ({ PayModalChrome: () => null }))
vi.mock("../../../src/platform/xmtp/MessagingBanner", () => ({ MessagingBanner: () => null }))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "me" }),
}))
vi.mock("../../../src/features/contacts/contactsView", () => ({ findContactEntry: () => m.entry }))
vi.mock("../../../src/features/contacts/unsavedContact", () => ({
  lookUpUnsavedContact: async () => null,
}))
vi.mock("../../../src/features/contacts/contactPay", () => ({
  runContactPay: m.pay,
  recipientUpgraded: m.upgraded,
  RecipientNotUpgradedError: class RecipientNotUpgradedError extends Error {},
}))
vi.mock("../../../src/features/contacts/SendScreen/SendScreen", () => ({ SendScreen: () => null }))
vi.mock("../../../src/features/actionGate", () => ({ useActionVerdict: () => "open" }))
vi.mock("../../../src/features/contacts/ContactDetailScreen/ContactDetailScreen", () => ({
  ContactDetailScreen: () => null,
}))
vi.mock("../../../src/features/contacts/PayAmountForm", () => ({ PayAmountForm: () => null }))
vi.mock("../../../src/features/contacts/PayConfirmForm", () => ({
  PayConfirmForm: ({
    onConfirm,
    payee,
  }: {
    onConfirm: () => void
    payee?: { savesContact: boolean }
  }) => (
    <button data-saves={String(payee?.savesContact)} onClick={onConfirm}>
      Send
    </button>
  ),
}))

import { ContactPayScreen } from "../../../src/features/contacts/ContactPayScreen/ContactPayScreen"
import { asOperation, endSigningAndHandOff } from "../../support/handOff"
import { openTestSession } from "../../support/session"

let container: HTMLDivElement
let root: Root
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label)!
  expect(button).toBeDefined()
  await act(async () => button.click())
}

const renderPay = (request: object = { id: "request", tag: "alice", amount: 25 }) =>
  act(async () =>
    root.render(
      <MemoryRouter initialEntries={[{ pathname: "/contacts/alice/send", state: { request } }]}>
        <Routes>
          <Route path="/contacts/:idOrTag/send" element={<ContactPayScreen mode="send" />} />
          <Route path="/activity" element={<div>Activity</div>} />
          <Route path="/contacts/:idOrTag" element={<div>Chat</div>} />
        </Routes>
      </MemoryRouter>,
    ),
  )

beforeEach(async () => {
  vi.clearAllMocks()
  m.pay.mockReset()
  m.upgraded.mockResolvedValue(true)
  m.entry = undefined
  openTestSession({
    wallet: {},
    account: {},
    token: { metadata: { decimals: 18 } },
    balances: balancesOf({ main: 100n * 10n ** 18n }),
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await renderPay()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("send outcome tracking", () => {
  it.each([true, false])(
    "does not report cancellation on a normal send exit (signing: %s)",
    async (signing) => {
      let settle!: (result: { txHash: string }) => void
      m.pay.mockImplementation(
        asOperation((_args: unknown, onStage: (stage: string) => void) => {
          onStage("proving")
          return new Promise<{ txHash: string }>((resolve) => {
            settle = resolve
          })
        }),
      )
      await click("Send")
      if (signing) {
        await endSigningAndHandOff()
        expect(container.textContent).toBe("Activity")
      }
      await act(async () => settle({ txHash: "0xsend" }))
      expect(container.textContent).toBe("Activity")
      expect(m.fireEvent).toHaveBeenCalledWith("send_submitted", expect.anything())
      expect(m.fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
    },
  )

  it("reports an accepted pre-prove cancellation exactly once", async () => {
    let continueSend!: () => void
    m.pay.mockImplementation(async (_args, onStage) => {
      await new Promise<void>((resolve) => {
        continueSend = resolve
      })
      onStage("proving")
      return { txHash: "0xsend" }
    })
    await click("Send")
    await click("Cancel")
    await act(async () => continueSend())
    await act(async () => root.render(null))
    expect(m.fireEvent.mock.calls.filter(([name]) => name === "proving_cancelled")).toEqual([
      ["proving_cancelled", { flow: "send", stage: "resolving" }],
    ])
  })

  it("reports a failed attempt without also reporting cancellation on exit", async () => {
    m.pay.mockRejectedValue(new Error("Failed"))
    await click("Send")
    await act(async () => root.render(null))
    expect(m.fireEvent).toHaveBeenCalledWith("action_failed", expect.anything())
    expect(m.fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
  it("preserves a failure after a Cancel click that was too late to abort", async () => {
    let advance!: (stage: string) => void
    let rejectSend!: (error: Error) => void
    m.pay.mockImplementation((_args, onStage) => {
      advance = onStage
      return new Promise((_, reject) => {
        rejectSend = reject
      })
    })
    await click("Send")
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    )!
    expect(cancel.disabled).toBe(false)
    await act(async () => {
      advance("proving")
      // React has not yet removed the Cancel handler for the new stage.
      cancel.click()
      rejectSend(new Error("Send failed"))
    })
    expect(m.fireEvent).toHaveBeenCalledWith("action_failed", expect.anything())
    await act(async () => root.render(null))
    expect(m.fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
})

describe("request funnel", () => {
  const remount = async (request: object) => {
    act(() => root.unmount())
    root = createRoot(container)
    await renderPay(request)
  }

  it("reports a send that reached the node with an unknown outcome as in flight", async () => {
    const { TxInFlightError } = await import("@obsidion/front-core")
    m.pay.mockRejectedValue(new TxInFlightError("0xsend", new Error("timeout")))
    await click("Send")
    expect(m.fireEvent).toHaveBeenCalledWith("send_submitted", {
      in_flight: true,
      amount_bucket: "<50",
      fulfills_request: true,
    })
    expect(m.fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
  })

  it("reports a pay page's open once per page load and its payment as pay_page", async () => {
    const page = { id: "0x01", tag: "river", amount: 25, source: "link", standing: true }
    await remount(page)
    // The Ethereum route and back mount the sheet again, under a new id.
    await remount({ ...page, id: "0x02" })
    const opens = m.fireEvent.mock.calls.filter(([name]) => name === "request_opened")
    expect(opens).toEqual([["request_opened", { source: "pay_page", amount_bucket: "<50" }]])

    m.pay.mockResolvedValue({ txHash: "0xsend" })
    await click("Send")
    expect(m.fireEvent).toHaveBeenCalledWith("request_paid", {
      source: "pay_page",
      amount_bucket: "<50",
    })
  })
})

describe("saving the requester on a fulfilling send", () => {
  const alice = { name: "alice", address: "0xa11ce", tag: "alice" }
  it.each([
    ["an unsaved requester", undefined, true],
    ["a sender added from a transfer", { ...alice, autoAdded: true }, true],
    ["a contact", alice, false],
  ])("%s", async (_who, entry, save) => {
    m.entry = entry
    await act(async () => root.unmount())
    root = createRoot(container)
    await renderPay()
    // The confirm step says so before the send.
    expect(container.querySelector("button")?.dataset.saves).toBe(String(save))
    m.pay.mockResolvedValue({ txHash: "0xsend" })
    await click("Send")
    expect(m.pay.mock.calls[0]![0]).toMatchObject({ saveUnsavedRequester: save })
  })
})

describe("a recipient who hasn't upgraded", () => {
  const remount = async () => {
    act(() => root.unmount())
    root = createRoot(container)
    await renderPay()
  }

  it("opens their chat before an amount is entered", async () => {
    m.upgraded.mockResolvedValue(false)
    await remount()
    expect(m.upgraded).toHaveBeenCalledWith("alice")
    expect(container.textContent).toBe("Chat")
  })

  it("shows the sheet, without an amount step, while it checks", async () => {
    m.upgraded.mockReturnValue(new Promise<boolean>(() => {}))
    await remount()
    expect(container.textContent).toContain("Checking @alice…")
    expect(container.querySelector("button")).toBeNull()
  })

  it("says so when the send-time check finds it, as a hint rather than a failure", async () => {
    const { RecipientNotUpgradedError } = await import("../../../src/features/contacts/contactPay")
    m.pay.mockRejectedValue(new RecipientNotUpgradedError("alice"))
    await click("Send")
    expect(container.textContent).toContain("@alice hasn't upgraded yet")
    expect(container.querySelector("button")).toBeNull()
    expect(m.reportError).not.toHaveBeenCalled()
    expect(m.fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
  })
})
