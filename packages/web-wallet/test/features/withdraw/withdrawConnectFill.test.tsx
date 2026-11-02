/**
 * The existing-address sheet: what becomes the destination and its name, when a pressed row
 * leaves the step, which verdicts show the privacy step, and what the amount sheet is handed.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAddress } from "viem"
import { L1_PLACEHOLDER_NAME, type Contact } from "@obsidion/front-core"

type SheetProps = { recipient: string; walletName?: string; onClose(): void; onDone(): void }

const h = vi.hoisted(() => ({
  l1: { account: null as string | null, walletName: null as string | null, disconnect: vi.fn() },
  entries: [] as unknown[],
  verdict: { kind: "fresh" },
  cleared: true,
  freshOffered: true,
  hook: vi.fn(),
  sheet: vi.fn(),
  ens: {} as { name?: string; state?: string; address?: string },
}))

vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ l1ChainId: 11155111, l1RpcUrl: "" }) }))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => h.l1 }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ getEntries: async () => h.entries }) },
  useEnsAddress: (text: string) => (text === h.ens.name ? h.ens : {}),
}))
vi.mock("../../../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ records: [] }),
}))
vi.mock("../../../src/features/withdraw/freshAddressAvailability", () => ({
  useFreshAddressAvailable: () => h.freshOffered,
}))
vi.mock("../../../src/features/withdraw/freshAddressCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/withdraw/freshAddressCheck")>()),
  useFreshAddressVerdict: (address: unknown, waitMs: unknown) => (
    h.hook(address, waitMs), address ? h.verdict : { kind: "idle" }
  ),
}))
vi.mock("../../../src/features/withdraw/WithdrawFreshScreen", () => ({
  VerdictCard: ({ kind }: { kind: string }) => <output data-verdict={kind} />,
}))
vi.mock("../../../src/features/withdraw/WithdrawToWalletModal/WithdrawToWalletModal", () => ({
  WithdrawToWalletModal: (props: SheetProps) => {
    h.sheet(props)
    return <div data-sheet />
  },
}))
vi.mock("../../../src/ui/screening", () => ({
  ScreeningNotice: () => <output data-screening />,
  useScreenedAddress: () => ({ verdict: null, cleared: h.cleared, rescreen: vi.fn() }),
}))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: vi.fn() }))
vi.mock("../../../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => false }))
vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  Icon: () => null,
  PrimaryGradientButton: (p: { title: string; onClick?: () => void; isDisabled?: boolean }) => (
    <button disabled={p.isDisabled} onClick={p.onClick} children={p.title} />
  ),
}))

const { WithdrawScreen } = await import("../../../src/features/withdraw/WithdrawScreen")

let go: ReturnType<typeof useNavigate>
const Probe = () => {
  go = useNavigate()
  return <output data-location>{useLocation().pathname}</output>
}

const [ACCOUNT, TYPED, FUNDER, OLDEST] = ["11", "22", "33", "44"].map((byte) =>
  getAddress(`0x${byte.repeat(20)}`),
)
const wallet = (name: string, address: string, funder = false, lastUsedAt = 1): Contact => ({
  name,
  address,
  addressKind: "ethereum-l1",
  l1Wallet: {
    provider: "manual",
    provenance: funder ? "deposit-attested" : "saved-recipient",
    lastUsedAt,
  },
})

describe("WithdrawScreen", () => {
  let container: HTMLDivElement
  let root: Root

  const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Address"]')!
  const nameField = () =>
    container.querySelector<HTMLInputElement>('input[placeholder="e.g. Rainbow"]')!
  const button = (name: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === name || b.textContent?.startsWith(name),
    )
  const rows = () =>
    Array.from(container.querySelectorAll<HTMLElement>(".ww-withdraw__saved .ww-paymethod"))
  /** The row for the address in the field: its own, or the saved wallet that answers to it. */
  const row = () => button("Use this address") ?? rows()[0]
  const target = () => h.hook.mock.lastCall?.[0]
  const sheet = () => h.sheet.mock.lastCall?.[0] as SheetProps
  const location = () => container.querySelector("[data-location]")?.textContent
  const left = () => !!container.querySelector("[data-verdict], [data-sheet]")
  const click = (el?: Element) => act(async () => (el as HTMLElement).click())
  const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  const render = (state?: { recipient: string; alias?: string }) =>
    act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={["/withdraw", { pathname: "/withdraw/existing", state }]}
          initialIndex={1}
        >
          <Probe />
          <WithdrawScreen />
        </MemoryRouter>,
      )
    })

  beforeEach(() => {
    Object.assign(h, {
      entries: [],
      verdict: { kind: "fresh" },
      cleared: true,
      freshOffered: true,
      ens: {},
    })
    Object.assign(h.l1, { account: null, walletName: null })
    vi.clearAllMocks()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("takes a wallet that connects as the destination, fixed once its row is pressed", async () => {
    h.verdict = { kind: "contract" }
    await render()
    expect(target()).toBeNull()
    expect(button("Continue")).toBeUndefined()
    Object.assign(h.l1, { account: ACCOUNT, walletName: "Rainbow" })
    await render()
    expect(target()).toBe(ACCOUNT)
    expect(left()).toBe(false)
    await click(button("Use your connected wallet"))
    Object.assign(h.l1, { account: TYPED, walletName: "Rabby" })
    await render()
    await click(button("Continue without privacy"))
    expect(target()).toBe(ACCOUNT)
    expect(sheet()).toMatchObject({ recipient: ACCOUNT, walletName: "Rainbow" })
    expect(sheet()).toHaveProperty("recipientIsContract", true)
  })

  it.each<[string, { recipient: string } | undefined, () => Promise<void>]>([
    ["typed", undefined, () => type(field(), TYPED)],
    ["picked", undefined, () => click(rows()[0])],
  ])("leaves a %s address alone when a wallet connects", async (_, state, choose) => {
    h.entries = [wallet("Rainbow", TYPED)]
    await render(state)
    await choose()
    h.l1.account = ACCOUNT
    await render(state)
    expect(target()).toBe(TYPED)
  })

  it("carries the prefill alias and the connector's name only onto their own addresses", async () => {
    Object.assign(h.l1, { account: ACCOUNT, walletName: "Rainbow" })
    await render({ recipient: TYPED, alias: "Ledger" })
    expect(field().value).toBe(TYPED)
    expect(row()!.textContent).toContain("Ledger")
    await click(row())
    expect(sheet().walletName).toBe("Ledger")
    await act(async () => sheet().onClose())
    await type(field(), OLDEST)
    await click(row())
    expect(sheet()).toMatchObject({ recipient: OLDEST, walletName: undefined })
    expect(sheet()).toHaveProperty("recipientIsContract", false)
  })

  it("keeps a typed address and its name apart from a picked wallet", async () => {
    h.entries = [wallet("Rainbow", TYPED)]
    await render()
    await click(button("New address"))
    await type(nameField(), "Ledger")
    await click(rows()[0])
    await click(button("Continue without privacy"))
    expect(sheet()).toMatchObject({ recipient: TYPED, walletName: "Rainbow" })
    await act(async () => sheet().onClose())
    await type(field(), "0x")
    await type(field(), "")
    expect(target()).toBeNull()
  })

  it("a pressed row waits while the verdict is still running, and leaves once it can", async () => {
    Object.assign(h, { cleared: true, verdict: { kind: "checking" } })
    await render({ recipient: TYPED })
    expect(h.hook).toHaveBeenLastCalledWith(TYPED, expect.any(Number))
    expect(container.querySelector("[data-screening]")).toBeNull()
    await click(row())
    expect(left()).toBe(false)
    expect(row()!.getAttribute("aria-current")).toBe("true")
    h.verdict = { kind: "fresh" }
    await render({ recipient: TYPED })
    expect(left()).toBe(true)
  })

  it("a row pressed and then retyped over does not leave", async () => {
    Object.assign(h, { cleared: false })
    await render({ recipient: TYPED })
    await click(row())
    await type(field(), OLDEST)
    h.cleared = true
    await render({ recipient: TYPED })
    expect(left()).toBe(false)
    expect(row()!.getAttribute("aria-current")).toBeNull()
  })

  it("unknown verdict: privacy step reads unknown", async () => {
    Object.assign(h, { entries: [], verdict: { kind: "unknown" } })
    await render({ recipient: TYPED })
    await click(row())
    // A later answer leaves what the step reads alone.
    h.verdict = { kind: "withdrew-before" }
    await render({ recipient: TYPED })
    expect(container.querySelector<HTMLElement>("[data-verdict]")?.dataset.verdict).toBe("unknown")
    expect(container.querySelector("[data-sheet]")).toBeNull()
  })

  it("lists the three latest wallets and every match of a search, each opening its contact", async () => {
    h.entries = [
      wallet("Oldest", OLDEST, false, 1),
      wallet("Rainbow", TYPED, false, 4),
      wallet("Funder", FUNDER, true, 3),
      wallet("Ledger", ACCOUNT, false, 2),
    ]
    await render()
    const tones = () => rows().map((r) => r.querySelector<HTMLElement>("[data-tone]")?.dataset.tone)
    expect(tones()).toEqual(["warning", "error", "warning"])
    await type(field(), "oldest")
    expect(rows().map((r) => r.querySelector("b")?.textContent)).toEqual(["Oldest"])
    await click(button("Edit Oldest"))
    expect(decodeURIComponent(location()!)).toBe(`/contacts/l1:manual:${OLDEST.toLowerCase()}`)
  })

  it("lists only the wallet an ENS name resolves to, and names the withdrawal after it", async () => {
    h.ens = { name: "alice.fkey.id", state: "found", address: TYPED }
    h.entries = [wallet("alice.fkey.id", OLDEST), wallet(L1_PLACEHOLDER_NAME, TYPED)]
    await render()
    await type(field(), "alice.fkey.id")
    expect(rows()).toHaveLength(1)
    await click(rows()[0])
    await click(button("Continue without privacy"))
    expect(sheet()).toMatchObject({ recipient: TYPED, walletName: "alice.fkey.id" })
  })

  it("searches saved wallets as usual when dotted text is not a name to resolve", async () => {
    h.ens = { name: "ether.fi Cash", state: "invalid" }
    h.entries = [wallet("ether.fi Cash", TYPED)]
    await render()
    await type(field(), "ether.fi Cash")
    await click(rows()[0])
    await click(button("Continue without privacy"))
    expect(sheet()).toMatchObject({ recipient: TYPED, walletName: "ether.fi Cash" })
  })

  it("marks a pressed wallet while the screener holds it, and leaves when it clears", async () => {
    Object.assign(h, { entries: [wallet("Rainbow", TYPED)], cleared: false })
    await render()
    await click(rows()[0])
    expect(left()).toBe(false)
    expect(rows()[0].getAttribute("aria-current")).toBe("true")
    expect(!!container.querySelector("[data-screening]")).toBe(true)
    h.cleared = true
    await render()
    expect(container.querySelector<HTMLElement>("[data-verdict]")?.dataset.verdict).toBe(
      "withdrew-before",
    )
  })

  it("hands the amount sheet the picked wallet, and goes home once the withdrawal is away", async () => {
    Object.assign(h, { entries: [wallet("Rainbow", TYPED)], verdict: { kind: "contract" } })
    await render()
    await click(rows()[0])
    await click(button("Back"))
    expect(rows()[0].getAttribute("aria-current")).toBe("true")
    await click(rows()[0])
    await click(button("Continue without privacy"))
    expect(sheet()).toMatchObject({
      recipient: TYPED,
      walletName: "Rainbow",
      recipientIsContract: true,
    })
    await act(async () => sheet().onDone())
    expect(location()).toBe("/")
  })

  it("the fresh route is one entry past the method step", async () => {
    Object.assign(h, { freshOffered: true, verdict: { kind: "history" } })
    await render({ recipient: TYPED })
    await click(row())
    await click(button("Use a fresh address instead"))
    expect(location()).toBe("/withdraw/fresh")
    await act(async () => go(-1))
    expect(location()).toBe("/withdraw")
  })
})
