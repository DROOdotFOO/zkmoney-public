import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { BackupRotationRecord } from "@obsidion/front-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { signedRecord, storedRotation, TWO_KEY, word } from "../../support/backupAdd"

const ONE_KEY = word(10)
const OTHER = word(0x99)
const identity = { address: TWO_KEY as string, handle: "taga" }
vi.mock("../../../src/features/identity/walletIdentity", () => ({ loadWalletIdentity: () => identity }))
vi.mock("../../../src/features/onboarding/openRegistration", () => ({
  useNameClaimPending: () => false,
  useRegistrationDepositOwed: () => false,
}))
vi.mock("../../../src/features/onboarding/sponsoredRailReadiness", () => ({
  useSponsoredRailPending: () => false,
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ oxideProfile: { portal: "0x" + "11".repeat(20) } }),
}))
vi.mock("../../../src/features/contacts/ContactDetailScreen/ContactDetailScreen", () => ({
  ContactDetailScreen: () => <div>contact page</div>,
}))
const showErrorModal = vi.fn()
vi.mock("../../../src/errors/errorModal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/errors/errorModal")>()),
  showErrorModal,
}))

const { ActionGate, ContactRoute } = await import("../../../src/App")
const { useActionGuard } = await import("../../../src/features/actionGate")
const { useBalanceMovingPause } = await import("../../../src/features/backupPasskey/balanceMovingPause")
const { getBackupRotationStore, resetBackupRotationStoreForTests } = await import(
  "../../../src/features/backupPasskey/backupRotationStore"
)
const { setUpgradeStatus } = await import("../../../src/features/migration/migrationDialog")
const { checkUpgradeLock } = await import("../../../src/features/migration/upgradeLock")
type Action = Parameters<typeof ActionGate>[0]["action"]

const record = (over: Partial<BackupRotationRecord>) => signedRecord(over)
const moving = () => record({ phase: "rerooted", reroot: { switched: true } })

/**
 * After the re-root the two-key account's sponsored spends pay with the one-key account's note, the
 * same note the balance move's chunks spend. Each sponsored action waits from the re-root's switch
 * until the move ends, and says why.
 */
describe("sponsored spends during a backup passkey's balance move", () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    // The wallet's mount reads each account's upgrade runs once a page; until then flows wait.
    await checkUpgradeLock(TWO_KEY)
    await checkUpgradeLock(ONE_KEY)
    await checkUpgradeLock(OTHER)
    localStorage.clear()
    resetBackupRotationStoreForTests()
    identity.address = TWO_KEY
    setUpgradeStatus({ state: "none", registration: false })
    showErrorModal.mockReset()
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const save = (r: BackupRotationRecord) => act(() => getBackupRotationStore().put(r))
  const render = async (node: ReactNode) => {
    await act(async () => root.render(node))
  }
  const mount = (action: Action, path: string = action) =>
    render(
      <MemoryRouter key={path} initialEntries={[`/${path}`]}>
        <Routes>
          <Route path="/" element={<div>home screen</div>} />
          <Route element={<ActionGate action={action} />}>
            <Route path={path} element={<div>{path} screen</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  const paused = () => !!host.querySelector('[data-testid="balance-moving"]')

  it.each([["rerooted", {}]] as const)(
    "pauses withdraw and link creation while the record is %s",
    async (phase, over) => {
      await save(record({ phase, ...over }))
      for (const [action, path] of [
        ["withdraw", "withdraw"],
        ["link", "links/new"],
      ] as const) {
        await mount(action, path)
        expect(paused()).toBe(true)
        expect(host.textContent).toContain("Moving your balance")
        expect(host.textContent).toContain("once the move finishes")
        expect(host.textContent).not.toContain(`${path} screen`)
      }
    },
  )

  it("opens them once the move is done, without a reload", async () => {
    await save(moving())
    await mount("withdraw")
    expect(paused()).toBe(true)
    await save(record({ phase: "done", rotation: storedRotation({ signature: undefined }) }))
    expect(paused()).toBe(false)
    expect(host.textContent).toContain("withdraw screen")
  })

  it("keeps deposit, receive and Requests open during the move", async () => {
    await save(moving())
    for (const action of ["deposit", "receive", "requests"] as const) {
      await mount(action)
      expect(host.textContent).toContain(`${action} screen`)
    }
  })

  it("pauses the one-key account too, and leaves another account alone", async () => {
    await save(moving())
    identity.address = ONE_KEY
    await mount("withdraw")
    expect(paused()).toBe(true)
    identity.address = OTHER
    await mount("withdraw")
    expect(host.textContent).toContain("withdraw screen")
  })

  it("pauses a send or a request payment from a contact's page", async () => {
    await save(moving())
    await render(
      <MemoryRouter initialEntries={["/contacts/bob/send"]}>
        <Routes>
          <Route path="contacts/:idOrTag" element={<ContactRoute />}>
            <Route path="send" element={<div>pay flow</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(paused()).toBe(true)
    expect(host.textContent).not.toContain("pay flow")
  })

  it("says why at the press and starts nothing", async () => {
    await save(moving())
    let guard!: ReturnType<typeof useActionGuard>
    function Probe() {
      guard = useActionGuard()
      return null
    }
    await render(<Probe />)
    const run = vi.fn()
    for (const action of ["send", "withdraw", "link", "savings", "claim"] as const) {
      act(() => guard(action, run))
    }
    expect(run).not.toHaveBeenCalled()
    expect(showErrorModal).toHaveBeenCalledTimes(5)
    expect(showErrorModal).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Moving your balance" }),
    )
    act(() => guard("deposit", run))
    expect(run).toHaveBeenCalledOnce()
  })

  it("holds a payment link refund's press until the move is done", async () => {
    await save(moving())
    let pause!: ReturnType<typeof useBalanceMovingPause>
    function Probe() {
      pause = useBalanceMovingPause()
      return null
    }
    await render(<Probe />)
    const run = vi.fn()
    act(() => pause(run))
    expect(run).not.toHaveBeenCalled()
    expect(showErrorModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Moving your balance" }),
    )
    await save(record({ phase: "done" }))
    act(() => pause(run))
    expect(run).toHaveBeenCalledOnce()
  })
})
