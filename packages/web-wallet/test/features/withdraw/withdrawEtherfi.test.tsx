/**
 * The ether.fi sheet: the address comes from ether.fi's share-address page, is kept as the ether.fi
 * Cash contact on continue, and reaches the withdraw modal narrowed to USDC and USDT.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const RECIPIENT = "0x1111111111111111111111111111111111111111"
const SAVED = "0x2222222222222222222222222222222222222222"
const contacts = vi.hoisted(() => ({ entries: [] as object[] }))
const upsert = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const update = vi.hoisted(() => vi.fn(() => Promise.resolve({})))
const modal = vi.hoisted(() => vi.fn())
const screening = vi.hoisted(() => ({ cleared: true }))
const factory = vi.hoisted(() => ({ kind: "confirmed" as string }))
const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fireEvent,
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  ContactStorage: {
    get: () => ({
      getEntries: () => Promise.resolve(contacts.entries),
      onChange: () => () => {},
    }),
  },
  upsertSavedL1WalletContact: upsert,
  updateSavedL1WalletContact: update,
}))
vi.mock("../../../src/ui/screening", () => ({
  ScreeningNotice: () => <output data-screening />,
  useScreenedAddress: () => ({ verdict: null, cleared: screening.cleared, rescreen: vi.fn() }),
}))
vi.mock("../../../src/features/withdraw/etherfiCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/withdraw/etherfiCheck")>()),
  useEtherfiAddressVerdict: (address: string | null) => ({
    kind: address ? factory.kind : "idle",
  }),
}))
vi.mock("../../../src/features/withdraw/WithdrawToWalletModal/WithdrawToWalletModal", () => ({
  WithdrawToWalletModal: (props: object) => {
    modal(props)
    return <p data-modal />
  },
}))
vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  TopNavIconButton: () => null,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button type="button" disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))

const { WithdrawEtherfiScreen } = await import(
  "../../../src/features/withdraw/WithdrawEtherfiScreen/WithdrawEtherfiScreen"
)
const { default: copy } = await import(
  "../../../src/features/withdraw/WithdrawEtherfiScreen/WithdrawEtherfiScreen.copy"
)

describe("WithdrawEtherfiScreen", () => {
  let container: HTMLDivElement
  let root: Root

  const text = () => container.textContent ?? ""
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!
  const input = () => container.querySelector<HTMLInputElement>("input[aria-label]")!
  const checkbox = () => container.querySelector<HTMLInputElement>("input[type=checkbox]")!
  const click = (el: Element) => act(async () => (el as HTMLElement).click())
  const type = (value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input(), value)
      input().dispatchEvent(new Event("input", { bubbles: true }))
    })
  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/withdraw/etherfi"]}>
          <WithdrawEtherfiScreen />
        </MemoryRouter>,
      )
    })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    contacts.entries = []
    screening.cleared = true
    factory.kind = "confirmed"
    upsert.mockClear()
    update.mockClear()
    update.mockResolvedValue({})
    modal.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("keeps a pasted address as the ether.fi contact and opens the modal narrowed to USDC and USDT", async () => {
    await render()
    await type("nope")
    expect(text()).toContain(copy.notAnAddress)
    expect(button(copy.continue).disabled).toBe(true)
    await type(RECIPIENT)
    expect(button(copy.continue).disabled).toBe(false)
    await click(button(copy.continue))
    expect(upsert).toHaveBeenCalledWith({
      address: RECIPIENT,
      name: "ether.fi Cash",
      provider: "etherfi",
    })
    expect(container.querySelector("[data-modal]")).not.toBeNull()
    expect(modal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recipient: RECIPIENT,
        walletName: "ether.fi Cash",
        receiveAsset: "USDC",
        receiveAssets: ["USDC", "USDT"],
      }),
    )
  })

  it.each(["checking", "rejected"])(
    "holds Continue while the factory's verdict is %s",
    async (kind) => {
      factory.kind = kind
      await render()
      await type(RECIPIENT)
      expect(button(copy.continue).disabled).toBe(true)
      if (kind === "rejected") {
        expect(text()).toContain(copy.verdict.rejected.title)
        expect(container.querySelector("[role=alert]")).not.toBeNull()
      }
    },
  )

  it("lets an ether.fi Cash account that has never been funded continue, with a warning", async () => {
    factory.kind = "account"
    await render()
    await type(RECIPIENT)
    expect(button(copy.continue).disabled).toBe(false)
    expect(text()).toContain(copy.verdict.account.title)
    expect(text()).toContain(copy.verdict.account.body)
  })

  it("lets an unanswered check continue, with a warning", async () => {
    factory.kind = "unknown"
    await render()
    await type(RECIPIENT)
    expect(button(copy.continue).disabled).toBe(false)
    expect(text()).toContain(copy.verdict.unknown.title)
  })

  it("holds Continue while the screener has the address", async () => {
    screening.cleared = false
    await render()
    await type(RECIPIENT)
    expect(container.querySelector("[data-screening]")).not.toBeNull()
    expect(button(copy.continue).disabled).toBe(true)
  })

  it("does not keep the address when saving is switched off", async () => {
    await render()
    await type(RECIPIENT)
    await click(checkbox())
    await click(button(copy.continue))
    expect(upsert).not.toHaveBeenCalled()
    expect(container.querySelector("[data-modal]")).not.toBeNull()
  })

  it("ignores a removed ether.fi address", async () => {
    contacts.entries = [
      {
        name: "ether.fi Cash",
        address: SAVED,
        addressKind: "ethereum-l1",
        l1Wallet: {
          provider: "etherfi",
          provenance: "saved-recipient",
          lastUsedAt: 1,
          deletedAt: 2,
        },
      },
    ]
    await render()
    expect(container.querySelector("input[aria-label]")).not.toBeNull()
  })

  const etherfiRow = (address: string, lastUsedAt: number) => ({
    name: "ether.fi Cash",
    address,
    addressKind: "ethereum-l1",
    l1Wallet: { provider: "etherfi", provenance: "saved-recipient", lastUsedAt },
  })

  it("rewrites the saved row when a new address replaces it", async () => {
    contacts.entries = [etherfiRow(SAVED, 1)]
    await render()
    await click(button(copy.change))
    await type(RECIPIENT)
    await click(button(copy.continue))
    expect(update).toHaveBeenCalledWith({
      originalAddress: SAVED,
      provider: "etherfi",
      address: RECIPIENT,
      name: "ether.fi Cash",
    })
    expect(upsert).not.toHaveBeenCalled()
    expect(modal).toHaveBeenLastCalledWith(expect.objectContaining({ recipient: RECIPIENT }))
  })

  it("saves afresh when the store refuses the rewrite", async () => {
    contacts.entries = [etherfiRow(SAVED, 1)]
    update.mockRejectedValue(new Error("collision"))
    await render()
    await click(button(copy.change))
    await type(RECIPIENT)
    await click(button(copy.continue))
    await act(async () => {})
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ address: RECIPIENT }))
  })

  it("starts from the most recently used ether.fi row", async () => {
    contacts.entries = [etherfiRow(SAVED, 1), etherfiRow(RECIPIENT, 2)]
    await render()
    await click(button(copy.continue))
    expect(modal).toHaveBeenLastCalledWith(expect.objectContaining({ recipient: RECIPIENT }))
  })
})
