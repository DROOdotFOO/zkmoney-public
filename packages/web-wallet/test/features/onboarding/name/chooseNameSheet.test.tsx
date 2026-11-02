import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits } from "viem"
import { usdFigure } from "../../../../src/ui/format"
import { PAID_ASK } from "../../../support/registrationPrices"

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  choose: vi.fn(async () => {}),
  status: "",
  invite: { credited: false } as { code?: string; credited: boolean },
  sign: vi.fn(async () => "0x5151"),
  lookup: vi.fn(async () => true),
  claimPastUser: vi.fn(async () => {}),
  AlreadyUsed: class extends Error {},
  fire: vi.fn(),
  remember: vi.fn(),
}))
vi.mock("../../../../src/lib/analytics", () => ({ fireOnboardingEvent: h.fire }))
vi.mock("../../../../src/features/onboarding/registrationFunnel", () => ({
  rememberRegistrationRoute: h.remember,
}))
/** The own-tag price as the sheet prints it: the paid ask. */
const PRICE = usdFigure(formatUnits(PAID_ASK, 18))
const OLD = `0x3f${"00".repeat(17)}a91c`
const [account, wallet] = [{ getAddress: () => "0xaztec" }, {}]
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("../../../../src/features/invite/useInvite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/invite/useInvite")>()),
  useInvite: () => h.invite,
}))
vi.mock("../../../../src/features/onboarding/chooseOwnName", () => ({ chooseOwnName: h.choose }))
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({ account: OLD, connect: vi.fn() }),
  isWalletRejection: () => false,
}))
vi.mock("../../../../src/features/onboarding/pastUserProver", () => ({
  signPastUserMessage: h.sign,
  lookupPastUser: h.lookup,
  NotPastUserError: class extends Error {},
}))
vi.mock("../../../../src/features/onboarding/pastUserClaim", () => ({
  claimPastUser: h.claimPastUser,
  PastUserAlreadyUsedError: h.AlreadyUsed,
}))
vi.mock("../../../../src/features/onboarding/nameAvailability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/features/onboarding/nameAvailability")
  >()),
  useNameAvailability: (_typed: string, enabled: boolean) => ({
    status: enabled ? h.status : "unknown",
    checking: false,
  }),
}))
vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  PrimaryGradientButton: (p: { title: string; onClick?: () => void; isDisabled?: boolean }) => (
    <button type="button" disabled={p.isDisabled} onClick={p.onClick}>
      {p.title}
    </button>
  ),
}))

const { ChooseNameSheet } = await import("../../../../src/features/onboarding/ChooseNameSheet")
const { openTestSession } = await import("../../../support/session")

describe("ChooseNameSheet", () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()
  const text = () => document.body.textContent
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === label)!
  const pay = () => button(`Make my deposit ${PRICE}`)

  const open = async (path = "/deposit") => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <ChooseNameSheet tag="brave-otter-42" onClose={onClose} />
        </MemoryRouter>,
      ),
    )
    expect(pay().disabled).toBe(true)
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>("input[aria-label='Your name']")!
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setValue.call(input, "river")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  // The check outlives the sheet, so each test verifies a different account.
  let accounts = 0
  beforeEach(() => {
    vi.clearAllMocks()
    const owner = `0xaztec${++accounts}`
    account.getAddress = () => owner
    openTestSession({ wallet, account })
    sessionStorage.clear()
    h.status = "available"
    h.invite = { credited: false }
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("pays for an available name and returns Home", async () => {
    await open("/settings")
    expect(text()).toContain("@river is available")
    expect(text()).toContain("Invite a friendFree")
    expect(text()).toContain("Used zk.money beforeFree")
    expect(text()).toContain(`Pay${PRICE}`)
    await act(async () => pay().click())
    expect(h.choose).toHaveBeenCalledWith("river", account, wallet, false)
    expect(onClose).toHaveBeenCalledOnce()
    expect(h.navigate).toHaveBeenCalledWith("/")
    expect(h.fire.mock.calls).toEqual([
      ["name_sheet_opened", { screen: "settings" }],
      ["onboarding_handle_checked", { status: "available" }],
      ["name_route_chosen", { route: "pay" }],
    ])
    expect(h.remember).toHaveBeenCalledWith("river", "paid")
  })

  it("shows the refusal for a held name, and Keep closes with the drawn tag", async () => {
    h.status = "reserved"
    await open()
    expect(text()).toContain("@river is being claimed by someone else.")
    expect(pay().disabled).toBe(true)
    expect(h.fire).toHaveBeenCalledWith("onboarding_handle_checked", { status: "taken" })
    await act(async () => button("Keep @brave-otter-42").click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(h.choose).not.toHaveBeenCalled()
  })

  it("says why a claim failed and stays open", async () => {
    h.choose.mockRejectedValueOnce(new Error("The name was taken."))
    await open()
    await act(async () => pay().click())
    expect(text()).toContain("The name was taken.")
    expect(onClose).not.toHaveBeenCalled()
    expect(h.fire).not.toHaveBeenCalledWith("name_route_chosen", expect.anything())
    expect(h.remember).not.toHaveBeenCalled()
  })

  const pickInvite = () =>
    act(async () => document.querySelector<HTMLButtonElement>("[role='radio']")!.click())

  it("has no invite link until the code arrives", async () => {
    await open()
    await pickInvite()
    expect(text()).toContain("Creating your link…")
    expect(button("Copy invite link").disabled).toBe(true)
  })

  it("copies the pending invite link, and deposits now on the drawn tag", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    h.invite = { code: "k7q2m9x", credited: false }
    await open("/settings")
    await pickInvite()
    expect(text()).toContain("Your invite linkinvite.zk.money/k7q2m9x")
    expect(text()).toContain("Free when a friend makes their first deposit")
    await act(async () => button("Copy invite link").click())
    expect(writeText).toHaveBeenCalledWith("https://invite.zk.money/k7q2m9x")
    writeText.mockClear()
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.startsWith("Your invite link"))!
        .click(),
    )
    expect(writeText).toHaveBeenCalledWith("https://invite.zk.money/k7q2m9x")
    expect(text()).toContain("Copied")
    await act(async () => button("Deposit now as @brave-otter-42").click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(h.navigate).toHaveBeenCalledWith("/deposit")
    expect(h.choose).not.toHaveBeenCalled()
  })

  it("claims the name for free once a friend has deposited", async () => {
    h.invite = { code: "k7q2m9x", credited: true }
    await open()
    await pickInvite()
    expect(text()).toContain("A friend you invited made their first deposit")
    await act(async () => button("Claim @river for free").click())
    expect(h.choose).toHaveBeenCalledWith("river", account, wallet, true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pickPastUser = () =>
    act(async () =>
      [...document.querySelectorAll<HTMLElement>("[role='radio']")]
        .find((r) => r.textContent?.startsWith("Used zk.money before"))!
        .click(),
    )
  const verify = async () => {
    await pickPastUser()
    expect(text()).toContain("Verify your old wallet")
    await act(async () =>
      document.querySelector<HTMLElement>("[data-testid='past-user-connect']")!.click(),
    )
    // The address check waits out typing before it runs.
    await settle(400)
    expect(h.lookup).toHaveBeenCalledWith(OLD)
    expect(text()).toContain("Eligible past zk.money user")
    expect(h.sign).not.toHaveBeenCalled()
    await act(async () => button("Sign to verify").click())
    await settle()
  }

  it("verifies a past user in the modal, then claims the name for free", async () => {
    await open()
    await verify()
    expect(h.sign).toHaveBeenCalledWith(OLD)
    expect(h.claimPastUser).toHaveBeenCalledWith(account, "0x5151")
    expect(text()).toContain("Welcome back")
    await act(async () => button("Choose my tag").click())
    expect(text()).not.toContain("Welcome back")
    await act(async () => button("Claim @river for free").click())
    expect(h.choose).toHaveBeenCalledWith("river", account, wallet, true)
    expect(h.fire).toHaveBeenCalledWith("name_route_chosen", { route: "past_user" })
    expect(h.remember).toHaveBeenCalledWith("river", "past_user")
  })

  it("remembers a passed check after the sheet is closed", async () => {
    await open()
    await verify()
    await act(async () => button("Choose my tag").click())
    await act(async () => root.unmount())
    root = createRoot(container)
    h.sign.mockClear()
    await open()
    await pickPastUser()
    expect(text()).not.toContain("Verify your old wallet")
    expect(h.sign).not.toHaveBeenCalled()
    expect(button("Claim @river for free").disabled).toBe(false)
  })

  it("says so when the old address was already used, and keeps the free claim closed", async () => {
    h.claimPastUser.mockRejectedValueOnce(new h.AlreadyUsed())
    await open()
    await verify()
    expect(text()).toContain("This address has already been claimed")
    await act(async () => button("Try another address").click())
    expect(text()).toContain("Verify your old wallet")
    // The modal's close, over the sheet's own.
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>("[aria-label='Close']")].at(-1)!.click(),
    )
    expect(text()).not.toContain("Verify your old wallet")
    expect(button("Verify to claim for free")).toBeDefined()
    expect(h.choose).not.toHaveBeenCalled()
  })

  it("keeps the sheet open to sign again when the check fails", async () => {
    h.sign.mockRejectedValueOnce(new Error("rejected"))
    await open()
    await verify()
    expect(text()).toContain("The check did not finish. Try again.")
    await act(async () => button("Sign to verify").click())
    await settle()
    expect(text()).toContain("Welcome back")
  })
})
