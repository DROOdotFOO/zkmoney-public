/**
 * The creator-recovery confirm sheet: it names the recovery, says what to expect of the race, runs
 * the matching submit leg, and maps a lost race to the shared already-spent copy instead of a
 * reportable stack.
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { asOperation } from "../../support/handOff"

const h = vi.hoisted(() => ({
  recoverSponsoredLink: vi.fn(),
  fireEvent: vi.fn(),
}))

vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({
  recoverSponsoredLink: (...args: unknown[]) =>
    asOperation(h.recoverSponsoredLink, "paylink-reclaim")(...args),
}))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: h.fireEvent, failureCode: () => "unknown" }))

const { LinkRecoverModal } = await import("../../../src/features/paylink/LinkRecoverModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const DEPS = {} as never
const CREATED_MS = Date.UTC(2026, 4, 1, 12, 0)

describe("LinkRecoverModal", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)

  const onClose = vi.fn()
  const render = (action: "reclaim" | "cancel", deps: unknown = DEPS) =>
    // `deps` is passed through as-is; pass null (not undefined) for the still-loading case, or the
    // default parameter takes over.
    act(async () => {
      root.render(
        <LinkRecoverModal
          action={action}
          deps={deps as never}
          fragment="frag"
          amount="30 DAI"
          createdMs={CREATED_MS}
          untilClaimableSec={Math.floor(CREATED_MS / 1000) + 86_400}
          onClose={onClose}
        />,
      )
    })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.recoverSponsoredLink.mockResolvedValue(undefined)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("waits out a new link's create without reading as this link", async () => {
    let finish!: () => void
    const creating = asOperation(
      () => new Promise<void>((resolve) => (finish = resolve)),
      "paylink-create",
    )()
    await render("cancel")
    const waiting = button("Waiting for your new paylink to be created")
    expect(waiting?.disabled).toBe(true)
    await act(async () => {
      finish()
      await creating
    })
    expect(button("Cancel link")?.disabled).toBe(false)
  })
})
