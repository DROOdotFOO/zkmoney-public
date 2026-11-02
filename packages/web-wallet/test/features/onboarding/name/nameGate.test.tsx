import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetDemoFlagForTests } from "../../../../src/dev/demoFlag"

const loadWalletIdentity = vi.fn()
vi.mock("../../../../src/features/identity/walletIdentity", () => ({ loadWalletIdentity }))
const useSponsoredRailPending = vi.fn()
vi.mock("../../../../src/features/onboarding/sponsoredRailReadiness", () => ({
  useSponsoredRailPending,
}))
const claimSponsorContext = vi.fn()
vi.mock("../../../../src/features/contacts/ContactDetailScreen/ContactDetailScreen", () => ({
  ContactDetailScreen: () => <div>contact page</div>,
}))
vi.mock("../../../../src/features/contacts/SendScreen/SendScreen", () => ({
  SendScreen: () => <div>send list</div>,
}))
vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ oxideProfile: { portal: "0x" + "11".repeat(20) } }),
}))
vi.mock("../../../../src/features/onboarding/claimSponsorship", () => ({ claimSponsorContext }))
let wallet: { node: object } | null
let account: object | null
let contractService: object | null
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService }),
}))

const registrationRail = await vi.importActual<
  typeof import("../../../../src/features/onboarding/registrationRail")
>("../../../../src/features/onboarding/registrationRail")
const sponsoredRailReadiness = await vi.importActual<
  typeof import("../../../../src/features/onboarding/sponsoredRailReadiness")
>("../../../../src/features/onboarding/sponsoredRailReadiness")

const { ActionGate, ContactRoute } = await import("../../../../src/App")
const { migrationDialogReason, setUpgradeStatus, useMigrationDialogRequest } = await import(
  "../../../../src/features/migration/migrationDialog"
)
const { checkUpgradeLock, markCreatedHere } = await import(
  "../../../../src/features/migration/upgradeLock"
)
// The one owner of the readiness poll, which WalletGate mounts beside the routes.
const Readiness = sponsoredRailReadiness.SponsoredRailReadinessMount

/**
 * One gate fronts the wallet's action routes. A nameless account is sent to register one. The flows
 * whose only rail is ClaimFPC-sponsored wait for it: the open rail admits an account the L1 registry
 * registered, and the registry's proof is a name plus the L1->L2 message it emits, which a
 * just-registered account gets a few L1 blocks later. Each stops the attempt with the reason rather
 * than at the fee. Deposit needs only the name: its address derives from the account, and the
 * broadcast behind it waits for the rail in the background. Every action waits for the upgrade.
 */
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../../src/platform/session"
)
const { openTestSession } = await import("../../../support/session")
/** A session with no wallet or account up. */
const servicesDown = () => {
  wallet = account = contractService = null
  closeSession()
  openTestSession()
}
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)

describe("gates on the wallet's flows", () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    // The wallet's mount reads each account's upgrade runs once a page; until then flows wait.
    await checkUpgradeLock("0xabc")
    await checkUpgradeLock("0xdef")
    wallet = { node: {} }
    account = {}
    contractService = {}
    openTestSession({ wallet, account })
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
    loadWalletIdentity.mockReset()
    claimSponsorContext.mockReset()
    useSponsoredRailPending.mockReset()
    useSponsoredRailPending.mockReturnValue(false)
    setUpgradeStatus({ state: "none", registration: false })
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
  })

  const mount = (path = "send", action: Parameters<typeof ActionGate>[0]["action"] = "send") =>
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/${path}`]}>
          <Readiness />
          <Routes>
            <Route path="/" element={<div>home screen</div>} />
            <Route element={<ActionGate action={action} />}>
              <Route path={path} element={<div>{path} screen</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      )
    })

  describe("name gate", () => {
    it("blocks the attempt, and says why, when the account has no name", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc" })
      mount("deposit", "deposit")
      expect(host.querySelector('[data-testid="name-required"]')).toBeTruthy()
      expect(host.textContent).toContain("Register a name first")
      expect(host.textContent).not.toContain("deposit screen")
    })

    it("does not block before an identity exists — WalletGate owns that case", () => {
      loadWalletIdentity.mockReturnValue(null)
      mount("deposit", "deposit")
      expect(host.textContent).toContain("deposit screen")
    })

    it("opens the deposit screen while the registration message is still in flight", () => {
      // The address needs no rail; its broadcast waits in the background.
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(true)
      mount("deposit", "deposit")
      expect(host.textContent).toContain("deposit screen")
      expect(host.querySelector('[data-testid="registration-pending"]')).toBeNull()
    })
  })

  describe("sponsored rail gate", () => {

    it("never mounts a sponsored flow while checking registration or waiting for its sweep", async () => {
      vi.useFakeTimers()
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      let rejectCheck!: (reason: unknown) => void
      claimSponsorContext.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectCheck = reject
        }),
      )
      const withdrawMounted = vi.fn()
      function WithdrawIntroduction() {
        withdrawMounted()
        return <div>Withdraw to L1</div>
      }
      act(() => {
        root.render(
          <MemoryRouter initialEntries={["/withdraw"]}>
            <Readiness />
            <Routes>
              <Route element={<ActionGate action="withdraw" />}>
                <Route path="withdraw" element={<WithdrawIntroduction />} />
              </Route>
            </Routes>
          </MemoryRouter>,
        )
      })
      expect(withdrawMounted).not.toHaveBeenCalled()
      expect(host.textContent).toContain("Loading zk.money")
      expect(host.textContent).not.toContain("Finishing your registration")

      await act(async () => {
        rejectCheck(new registrationRail.RegistrationPendingError({ pending: "message" }))
      })
      expect(withdrawMounted).not.toHaveBeenCalled()
      expect(host.textContent).toContain("Finishing your registration")

      claimSponsorContext.mockResolvedValueOnce({})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      expect(withdrawMounted).toHaveBeenCalled()
      expect(host.textContent).toContain("Withdraw to L1")
    })

    it("tells a failed read from a registration still on its way, until a read answers", async () => {
      vi.useFakeTimers()
      claimSponsorContext.mockRejectedValueOnce(new Error("L1 unreachable"))
      claimSponsorContext.mockResolvedValueOnce({})
      const seen: [boolean | undefined, boolean][] = []
      function Probe() {
        seen.push([
          sponsoredRailReadiness.useSponsoredRailPending(),
          sponsoredRailReadiness.useSponsoredRailReadFailed(),
        ])
        return null
      }
      await act(async () => {
        root.render(
          <>
            <Readiness />
            <Probe />
          </>,
        )
      })
      expect(seen.at(-1)).toEqual([true, true])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      expect(seen.at(-1)).toEqual([false, false])
    })

    it("opens a registered account's flow after the initial check succeeds", async () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      let resolveCheck!: (value: unknown) => void
      claimSponsorContext.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCheck = resolve
        }),
      )
      mount()
      expect(host.textContent).not.toContain("send screen")
      await act(async () => {
        resolveCheck({})
      })
      expect(host.textContent).toContain("send screen")
    })

    it("asks once for every gate that reads the answer", async () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      claimSponsorContext.mockResolvedValue({})
      const gate = (path: string) => (
        <MemoryRouter initialEntries={[`/${path}`]}>
          <Routes>
            <Route element={<ActionGate action="send" />}>
              <Route path={path} element={<div>{path} screen</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      )
      await act(async () => {
        root.render(
          <>
            <Readiness />
            {gate("send")}
            {gate("withdraw")}
          </>,
        )
      })
      expect(host.textContent).toContain("send screen")
      expect(host.textContent).toContain("withdraw screen")
      expect(claimSponsorContext).toHaveBeenCalledTimes(1)
    })

    it.each(["withdraw"])("opens the demo %s route without wallet services", (path) => {
      window.history.replaceState({}, "", "/?demo=activity")
      servicesDown()
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "demo" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      mount(path, path as "send" | "withdraw")
      expect(host.textContent).toContain(`${path} screen`)
      expect(host.querySelector('[data-testid="registration-pending"]')).toBeNull()
      expect(claimSponsorContext).not.toHaveBeenCalled()
    })

    it("holds a real wallet's sponsored route behind the loading screen until wallet services are available", () => {
      servicesDown()
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockImplementation(sponsoredRailReadiness.useSponsoredRailPending)
      mount("withdraw", "withdraw")
      expect(host.textContent).toContain("Loading zk.money")
      expect(host.textContent).not.toContain("Finishing your registration")
      expect(host.textContent).not.toContain("withdraw screen")
      expect(claimSponsorContext).not.toHaveBeenCalled()
    })
  })
  describe("the upgrade", () => {
    let requests = 0
    function Requests() {
      requests = useMigrationDialogRequest()
      return null
    }
    const mountWithRequests = (
      path: string,
      action: Parameters<typeof ActionGate>[0]["action"],
      attempt = 0,
    ) =>
      act(() => {
        root.render(
          <MemoryRouter key={attempt} initialEntries={[`/${path}`]}>
            <Routes>
              <Route path="/" element={<div>home screen</div>} />
              <Route element={<ActionGate action={action} />}>
                <Route path={path} element={<div>{path} screen</div>} />
              </Route>
            </Routes>
            <Requests />
          </MemoryRouter>,
        )
      })
    afterEach(() => act(() => setUpgradeStatus({ state: "none", registration: false })))

    it.each([["send", "send"]] as const)(
      "leaves /%s for Home and asks to upgrade first, titled for the action",
      (path, action) => {
        loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
        setUpgradeStatus({ state: "offered", registration: false })
        const before = requests
        mountWithRequests(path, action)
        expect(host.textContent).toContain("home screen")
        expect(host.textContent).not.toContain(`${path} screen`)
        expect(requests).toBe(before + 1)
        expect(migrationDialogReason()).toEqual({ action })
      },
    )

    it("asks to upgrade ahead of the registration the upgrade sends", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      useSponsoredRailPending.mockReturnValue(true)
      setUpgradeStatus({ state: "offered", registration: true })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("home screen")
      expect(host.textContent).not.toContain("Finishing your registration")
    })

    it("holds the attempt while whether to upgrade is not known, then opens it", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      setUpgradeStatus({ state: "checking", registration: false })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("Loading zk.money")
      expect(host.textContent).not.toContain("send screen")
      act(() => setUpgradeStatus({ state: "none", registration: false }))
      expect(host.textContent).toContain("send screen")
    })

    it("never holds an account current on this version", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xdef", handle: "tagb" })
      markCreatedHere("0xdef")
      setUpgradeStatus({ state: "checking", registration: false })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("send screen")
    })

    it("opens the action once the upgrade is done", () => {
      loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
      setUpgradeStatus({ state: "running", phase: "arriving", registration: false })
      mountWithRequests("send", "send")
      expect(host.textContent).toContain("home screen")
      act(() => setUpgradeStatus({ state: "none", registration: false }))
      mountWithRequests("send", "send", 1)
      expect(host.textContent).toContain("send screen")
    })

    it.each(["/contacts/bob/send/"])(
      "leaves a contact's Send at %s for the contact's page, as a payment link opens it",
      (path) => {
        loadWalletIdentity.mockReturnValue({ address: "0xabc", handle: "taga" })
        setUpgradeStatus({ state: "offered", registration: false })
        const before = requests
        act(() => {
          root.render(
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="contacts/:idOrTag" element={<ContactRoute />}>
                  <Route path="send" element={<div>pay sheet</div>} />
                </Route>
              </Routes>
              <Requests />
            </MemoryRouter>,
          )
        })
        expect(host.textContent).not.toContain("pay sheet")
        expect(host.textContent).toContain("contact page")
        expect(requests).toBe(before + 1)
        expect(migrationDialogReason()).toEqual({ action: "send" })
      },
    )
  })
})
