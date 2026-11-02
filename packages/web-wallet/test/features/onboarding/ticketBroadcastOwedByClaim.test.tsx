/**
 * A ticket signup's address is published by its claim, which runs only on the tab holding the link
 * the signup is bound to. There neither a surface nor a detection tick owes its broadcast to the
 * ledger; anywhere else a surface showing the address owes it, as for every other registration.
 */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore } from "@obsidion/front-core"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { saveRegistrationTerms } from "../../../src/features/onboarding/registrationTerms"
import { stashClaimLink } from "../../../src/features/paylink/claimStash"
import {
  freshPayloads,
  getBroadcastLedger,
  resetBroadcastsForTests,
} from "../../../src/features/broadcasts/broadcasts"
import { useOweRegistrationBroadcast } from "../../../src/features/broadcasts/useOweRegistrationBroadcast"
import { buildWebDetectionDeps } from "../../../src/features/onboarding/webRegistration"
import {
  pendingRecord,
  resetRegistrationStores,
  ticketBoundTerms,
} from "../../support/registrationFixtures"

// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
// The detection deps' chain reads; only their broadcast owing is under test.
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  oxideEnvFor: async () => ({
    tuple: {
      sipaFactory: "0x01",
      portal: "0x02",
      registry: "0x03",
      forwardingTable: `0x${"04".repeat(20)}`,
      token: `0x${"05".repeat(20)}`,
    },
    env: {},
    publicClient: {},
  }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  registrationSipaImplementation: async () => "0x",
}))
vi.mock("../../../src/features/onboarding/registrationTerms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/registrationTerms")>()),
  scheduleSource: async () => undefined,
}))
vi.mock("../../../src/features/deposit/loadDepositFacts", () => ({ sipaFundingTokens: () => [] }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const record = pendingRecord({ broadcast: false })

function Owes() {
  useOweRegistrationBroadcast(record, true, { confirmed: true })
  return null
}

async function shown(): Promise<void> {
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(<Owes />))
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  await act(async () => root.unmount())
}

const { activeNamespace, closeSession, switchSession } = await import(
  "../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)

describe("who owes a registration's broadcast", () => {
  beforeEach(async () => {
    localStorage.clear()
    sessionStorage.clear()
    resetRegistrationStores()
    resetBroadcastsForTests()
    await PendingRegistrationStore.get(webStorage).upsert(record.account, {}, record)
    await getBroadcastLedger().load()
  })

  it("a surface showing an ordinary registration's address owes it to the ledger", async () => {
    saveRegistrationTerms({ ...ticketBoundTerms(), paylinkFunded: false, paylinkId: undefined })
    await shown()
    expect(getBroadcastLedger().get(record.sipaAddress)).toMatchObject({ kind: "registration" })
  })

  it("nothing owes a ticket signup's on the tab holding its link: that claim publishes it", async () => {
    saveRegistrationTerms(ticketBoundTerms())
    stashClaimLink("paylink-frag")
    await shown()
    expect(getBroadcastLedger().get(record.sipaAddress)).toBeNull()
  })

  it("a surface showing a ticket signup's address without its link owes it, since nothing claims", async () => {
    saveRegistrationTerms(ticketBoundTerms())
    stashClaimLink("another-link")
    await shown()
    expect(getBroadcastLedger().get(record.sipaAddress)).toMatchObject({ kind: "registration" })
  })

  describe("a detection tick", () => {
    const payload = { sipaAddress: record.sipaAddress } as never
    const owe = async () =>
      (await buildWebDetectionDeps({} as never)).oweBroadcast!(record, { payload, now: true })

    it("owes nothing for a ticket signup on the tab holding its link, keeping its payload for the claim", async () => {
      saveRegistrationTerms(ticketBoundTerms())
      stashClaimLink("paylink-frag")
      await owe()
      expect(getBroadcastLedger().get(record.sipaAddress)).toBeNull()
      expect(freshPayloads.get(record.sipaAddress.toLowerCase())).toBe(payload)
    })

    it("owes a ticket signup's without its link, as any registration's", async () => {
      saveRegistrationTerms(ticketBoundTerms())
      stashClaimLink("another-link")
      await owe()
      expect(getBroadcastLedger().get(record.sipaAddress)).toMatchObject({ kind: "registration" })
      expect(freshPayloads.get(record.sipaAddress.toLowerCase())).toBe(payload)
    })
  })
})
