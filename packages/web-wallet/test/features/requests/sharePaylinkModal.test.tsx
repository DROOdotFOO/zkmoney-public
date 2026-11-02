import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { PaymentRequest } from "@obsidion/front-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  ActivityListRow: ({
    counterparty,
    actions = [],
    onClick,
  }: {
    counterparty: string
    actions?: { title: string; onClick?: () => void }[]
    onClick?: () => void
  }) => (
    <div>
      <button data-testid="activity-row" onClick={onClick}>
        {counterparty}
      </button>
      {actions.map((action) => (
        <button key={action.title} onClick={action.onClick}>
          {action.title}
        </button>
      ))}
    </div>
  ),
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  StatusPill: ({ label }: { label: string }) => <span>{label}</span>,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  avatarColors: () => ["#000", "#fff"],
}))

const cancelRequestById = vi.fn(async (_id: string) => true)
vi.mock("../../../src/features/contacts/requestActions", () => ({
  cancelRequestById: (id: string) => cancelRequestById(id),
}))
const showErrorModal = vi.fn()
const layout = vi.hoisted(() => ({ phone: false }))
vi.mock("../../../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => layout.phone }))
afterEach(() => {
  layout.phone = false
})
vi.mock("../../../src/features/requests/requestLinkCreation", () => ({
  requestLinkOrigin: () => "https://wallet.zk.money",
}))
vi.mock("../../../src/errors/errorModal", () => ({
  showErrorModal: (...a: unknown[]) => showErrorModal(...a),
  showReportableError: vi.fn(),
}))

// Publishing needs the wallet; test/features/requests/shortRequestLink.test.tsx covers it. The full link stands in.
const publish = vi.hoisted(() => vi.fn())
vi.mock("../../../src/features/requests/shortRequestLink", () => ({
  useShortRequestLink: (request?: { url: string }) => ({ url: request?.url, publish }),
}))

const { SharePaylinkModal } = await import("../../../src/features/requests/SharePaylinkModal")

const FIELD_ID = `0x${"0a".repeat(32)}`
const TOKEN_ADDRESS = `0x${"1b".repeat(32)}`
const REQUESTER_ADDRESS = `0x${"2c".repeat(32)}`
const NOW = Date.now()

const request: PaymentRequest = {
  id: FIELD_ID,
  contactTag: "",
  amount: 1250,
  asset: "DAI",
  direction: "outgoing",
  status: "pending",
  createdAt: NOW,
  kind: "link",
  tokenAddress: TOKEN_ADDRESS,
  amountAtomic: "25000000000000000000",
  tokenDecimals: 18,
  note: "Dinner",
  expiresAt: NOW + 7 * 86_400_000,
  networkId: "0xrollup",
  requesterTag: "alice",
  requesterAddress: REQUESTER_ADDRESS,
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("SharePaylinkModal", () => {
  let container: HTMLDivElement
  let root: Root
  const writeText = vi.fn(async (_text: string) => {})
  const share = vi.fn(async (_data: ShareData) => {})

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(navigator, "share", { configurable: true, value: share })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    writeText.mockClear()
    share.mockClear()
    cancelRequestById.mockClear()
    showErrorModal.mockClear()
  })

  async function render(overrides: Partial<PaymentRequest> = {}, onClose = () => {}) {
    await act(async () => {
      root.render(
        <SharePaylinkModal
          request={{ ...request, ...overrides }}
          requesterTag="renamed"
          onClose={onClose}
        />,
      )
    })
  }

  it("reads as a result when opened from the create step, and as the link otherwise", async () => {
    await act(async () => {
      root.render(
        <SharePaylinkModal
          request={request}
          requesterTag="renamed"
          justCreated
          onClose={() => {}}
        />,
      )
    })
    expect(container.textContent).toContain("Your request link is ready")
    expect(container.textContent).toContain("Share it with whoever owes you $1,250.00.")
    await render()
    expect(container.textContent).toContain("Request link")
    expect(container.textContent).not.toContain("is ready")
  })

  it("copies a request's saved short link, and publishes one for a request without", async () => {
    publish.mockClear()
    await render({ shortLink: "https://zk.money/r#short" })
    const copy = () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Copy link")
    await act(async () => copy()?.click())
    expect(writeText).toHaveBeenLastCalledWith("https://zk.money/r#short")

    await render()
    await act(async () => copy()?.click())
    expect(publish).toHaveBeenCalled()
  })

  it("reopens a stored link request and copies its reconstructed URL", async () => {
    await render()
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy link",
    )

    await act(async () => copy?.click())

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0][0].startsWith("https://wallet.zk.money/pay/alice#")).toBe(true)
    expect(container.textContent).toContain("Dinner")
    // The amount is the hero, the created date sits under the link, and the status matches the row.
    expect(container.textContent).toContain("$1,250.00")
    expect(container.textContent).toContain("Unpaid")
    expect(container.textContent).toContain("7 days")
    // Rows the paylink idiom left behind: the request surface must not claim to be a Send.
    expect(container.textContent).not.toContain("Type")
    expect(container.textContent).not.toContain("Requested amount")
    expect(container.textContent).not.toContain("Date created")
    // The fee is the sender's concern: the requester sees no fee row and no net figure.
    expect(container.textContent).not.toContain("Paid by sender")
    expect(container.textContent).not.toContain("Received")
    expect(container.textContent).not.toContain("You receive")
  })

  it("promises no figure on an any-amount link", async () => {
    await render({ amount: 0, amountAtomic: "0" })
    expect(container.textContent).not.toContain("Paid by sender")
    expect(container.textContent).not.toContain("Received")
    expect(container.textContent).not.toContain("You receive")
  })

  it("shares the reconstructed URL through the Web Share API", async () => {
    // Share is a phone affordance; desktop offers Copy link alone.
    layout.phone = true
    await render()
    const shareButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Share",
    )

    await act(async () => shareButton?.click())

    expect(share).toHaveBeenCalledWith({
      title: "Payment request",
      text: "Requesting $1,250.00 on zk.money",
      url: expect.stringContaining("https://wallet.zk.money/pay/alice#"),
    })
  })

  it("shows Paid when the stored request is fulfilled", async () => {
    await render({ status: "fulfilled" })
    expect(container.textContent).toContain("Paid")
    expect(container.textContent).not.toContain("Unpaid")
    expect(container.textContent).not.toContain("Copy link")
    expect(container.textContent).not.toContain("cannot be shared")
    expect(container.textContent).not.toContain("Paid by")
    // The fee block is forward-looking: a settled link states what happened, not what will.
    expect(container.textContent).not.toContain("Paid by sender")
    expect(container.textContent).not.toContain("You receive")
  })

  it("shows who paid a fulfilled link when a payer is supplied", async () => {
    await act(async () => {
      root.render(
        <SharePaylinkModal
          request={{ ...request, status: "fulfilled" }}
          requesterTag="alice"
          payer={{ displayName: "@bob" }}
          onClose={() => {}}
        />,
      )
    })
    expect(container.textContent).toContain("Paid by")
    expect(container.textContent).toContain("@bob")
  })

  it("copies the URL when the browser has no Web Share API", async () => {
    layout.phone = true
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined })
    await render()
    const shareButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Share",
    )

    await act(async () => shareButton?.click())

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0][0].startsWith("https://wallet.zk.money/pay/alice#")).toBe(true)
  })

  it("offers Cancel beside Share on an unpaid link opened from its row", async () => {
    layout.phone = true
    const onCancel = vi.fn()
    await act(async () => {
      root.render(
        <SharePaylinkModal
          request={request}
          requesterTag="alice"
          onCancel={onCancel}
          onClose={() => {}}
        />,
      )
    })
    const titles = [...container.querySelectorAll("button")].map((b) => b.textContent)
    expect(titles).toEqual(expect.arrayContaining(["Cancel request", "Share"]))
    expect(titles).not.toContain("Copy link")
    await act(async () => {
      ;[...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Cancel request")
        ?.click()
    })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("keeps Cancel on an older link that cannot be shared, and confirms a copied share", async () => {
    layout.phone = true
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined })
    const onCancel = vi.fn()
    const view = (overrides: Partial<PaymentRequest>) => (
      <SharePaylinkModal
        request={{ ...request, ...overrides }}
        requesterTag="alice"
        onCancel={onCancel}
        onClose={() => {}}
      />
    )
    const titles = () => [...container.querySelectorAll("button")].map((b) => b.textContent)
    await act(async () => root.render(view({ networkId: undefined })))
    expect(container.textContent).toContain("cannot be shared again")
    expect(titles()).toContain("Cancel request")

    await act(async () => root.render(view({})))
    await act(async () => {
      ;[...container.querySelectorAll("button")].find((b) => b.textContent === "Share")?.click()
    })
    expect(writeText).toHaveBeenCalledOnce()
    expect(titles()).toContain("Copied!")
  })
})
