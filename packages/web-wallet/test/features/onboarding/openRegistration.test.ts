import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { saveWalletIdentity } from "../../../src/features/identity/walletIdentity"
import {
  openRegistration,
  useRegistrationInCustody,
} from "../../../src/features/onboarding/openRegistration"
import { getPendingStore } from "../../../src/features/onboarding/webRegistration"
import {
  ACCOUNT,
  L2_ADDRESS,
  pendingRecord,
  resetRegistrationStores,
} from "../../support/registrationFixtures"

vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))

const record = pendingRecord({ l1ChainId: 31337 })

const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/platform/session"
)
// The session's watchers keep the withdrawals loaded: a stage is known once they land.
let unwatch = () => {}
beforeEach(async () => {
  const { withdrawals } = switchSession(activeNamespace())
  unwatch = withdrawals.list.subscribe(() => {})
  await withdrawals.all()
})
afterEach(() => unwatch())
afterEach(closeSession)

beforeEach(async () => {
  resetRegistrationStores()
  localStorage.clear()
  await getPendingStore().load()
})

describe("openRegistration", () => {
  it("reads no stage owed until the withdrawals load: a ticket's burn may fund it", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record)
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    unwatch()
    closeSession()
    switchSession(activeNamespace())
    expect(openRegistration()?.stage).toBeUndefined()
    const burns = await session().withdrawals.all()
    expect(openRegistration(burns)?.stage).toBe("reserved")
  })

  it("speaks only for the tag the active wallet still presents as pending", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record)
    expect(openRegistration()).toBeNull()
    saveWalletIdentity({
      handle: "taga",
      address: `0x${"33".repeat(32)}`,
      claimedAt: 1,
      pending: true,
    })
    expect(openRegistration()).toBeNull()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: false })
    expect(openRegistration()).toBeNull()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    expect(openRegistration()?.stage).toBe("reserved")
  })
})

describe("useRegistrationInCustody", () => {
  function Custody() {
    return createElement("span", null, String(useRegistrationInCustody()))
  }

  it("names the registration's account from the pending record, before any identity is saved", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record)
    const el = document.createElement("div")
    const root = createRoot(el)
    await act(async () => root.render(createElement(Custody)))
    expect(el.textContent).toBe(L2_ADDRESS)
    await act(async () => getPendingStore().close(ACCOUNT, "confirmed"))
    expect(el.textContent).toBe("null")
    await act(async () => root.unmount())
  })
})
