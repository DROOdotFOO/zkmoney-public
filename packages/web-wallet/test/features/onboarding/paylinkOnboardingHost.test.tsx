/**
 * What the paylink host hands the wizard: the session's paylink services, read by the real
 * `usePaylinkKit`, so a ticket-funded signup can claim its link. The wizard is a probe here; what
 * it does with the services is the pending-step suite's subject.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: { service: true } }),
}))
vi.mock("../../../src/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: ({
    paylinkKit,
    ticketSignup,
  }: {
    paylinkKit?: unknown
    ticketSignup?: boolean
  }) => (
    <div data-testid="wizard" data-ticket={String(Boolean(ticketSignup))}>
      {paylinkKit ? JSON.stringify(paylinkKit) : "no kit"}
    </div>
  ),
}))

const { PaylinkOnboardingScreen } = await import(
  "../../../src/features/paylink/PaylinkOnboardingScreen"
)
const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")

const wallet = { wallet: true, networkId: "0xrollup" }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  closeSession()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = () =>
  act(async () => {
    root.render(<PaylinkOnboardingScreen embedded ticketSignup />)
  })

const wizard = () => container.querySelector('[data-testid="wizard"]')

describe("PaylinkOnboardingScreen", () => {
  it("hands nothing while the layer is still connecting", async () => {
    openTestSession({ wallet, token: { token: true } })
    await render()
    expect(wizard()?.textContent).toBe("no kit")
  })
})
