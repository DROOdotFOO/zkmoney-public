import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Spinner: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button onClick={onClick} disabled={isDisabled}>
      {title}
    </button>
  ),
}))
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ accountServiceUrl: "https://account.test/" }),
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ ensDomain: "oxidestaging.eth" }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
}))
vi.mock("../../../../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../../../src/features/onboarding/steps/SignupStepper", () => ({
  SignupStepper: () => null,
}))

const { drawTag, probeNameAvailability } = await import(
  "../../../../src/features/onboarding/nameAvailability"
)
const { InvitationStep } = await import("../../../../src/features/onboarding/steps/InvitationStep")
const { ChooseTagStep } = await import("../../../../src/features/onboarding/steps/ChooseTagStep")

const answering = (body: unknown, status = 200) =>
  vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }))

describe("drawTag", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("draws under the wire domain and returns the tag with its grant", async () => {
    const drawn = { tag: "brisk-otter", nameHash: "0x01", grantToken: "draw-token", expiresAt: 1 }
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(drawn)),
    )
    vi.stubGlobal("fetch", fetchMock)

    expect(await drawTag()).toEqual(drawn)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://account.test/domain/draw")
    expect(JSON.parse(String(init?.body))).toEqual({ ensDomain: "oxidestaging.eth" })
  })
})

describe("probeNameAvailability", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("folds the tag itself, so a caller that forgets cannot probe a stray node", async () => {
    const fetchMock = answering({ status: "available" })
    vi.stubGlobal("fetch", fetchMock)
    await probeNameAvailability("ABC-DEF")
    await probeNameAvailability("abc-def")
    const [a, b] = fetchMock.mock.calls.map((c) => new URL(c[0]).searchParams.get("nameHash"))
    expect(a).toBe(b)
  })

  it("reads a refusal, an unrecognised status and a dead network as unknown", async () => {
    vi.stubGlobal("fetch", answering({ error: "down" }, 503))
    expect((await probeNameAvailability("satoshi")).status).toBe("unknown")

    vi.stubGlobal("fetch", answering({ status: "maybe" }))
    expect((await probeNameAvailability("satoshi")).status).toBe("unknown")

    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    expect((await probeNameAvailability("satoshi")).status).toBe("unknown")
  })

  it("answers unknown within one timeout, however many reads the client retries", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    )
    try {
      const probe = probeNameAvailability("satoshi")
      await vi.advanceTimersByTimeAsync(2000)
      expect((await probe).status).toBe("unknown")
    } finally {
      vi.useRealTimers()
    }
  })
})

/** The typed tag is probed while the user is still on the invitation step. */
describe("InvitationStep availability", () => {
  let container: HTMLDivElement
  let root: Root
  const onUnlock = vi.fn()
  const onBoundGrant = vi.fn()

  const render = async (
    header: boolean = true,
    initialHandle?: string,
    resuming = false,
    grant?: { handle: string; token: string },
    boundGrantOwner = false,
  ) => {
    await act(async () => {
      root.render(
        <InvitationStep
          busy={false}
          header={header ? <span /> : undefined}
          initialHandle={initialHandle}
          checkAvailability
          grant={grant}
          resuming={resuming}
          boundGrantOwner={boundGrantOwner}
          onBoundGrant={onBoundGrant}
          onUnlock={onUnlock}
          onCancelSignIn={vi.fn()}
        />,
      )
    })
  }
  const cta = () => container.querySelector("button")!
  const type = async (value: string) => {
    const input = container.querySelector("input")!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  /** Past the probe's debounce, with the answer applied. */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it("lets a reservation through when the signup is being resumed", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved" }))
    await render(true, undefined, true)
    await type("satoshi")
    await settle()

    // The probe knows the name is held, never by whom, so the line claims neither owner.
    expect(container.textContent).not.toContain("being claimed by someone else")
    expect(container.textContent).not.toContain("is yours")
    expect(container.textContent).toContain("Continue with your passkey to pick it back up")
    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onUnlock).toHaveBeenCalledWith("satoshi")
  })

  it("still refuses a blocklisted name while resuming", async () => {
    vi.stubGlobal("fetch", answering({ status: "blocked" }))
    await render(true, undefined, true)
    await type("admin")
    await settle()

    expect(container.textContent).toContain("is reserved")
    expect(cta().disabled).toBe(true)
  })

  it("refuses a blocked reservation when resuming without a grant", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", blocked: true }))
    await render(true, undefined, true)
    await type("admin")
    await settle()

    expect(container.textContent).toContain("is reserved")
    expect(container.textContent).not.toContain("Continue with your passkey")
    expect(cta().disabled).toBe(true)
  })

  it("lets a route grant pass a blocklisted name", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ status: "blocked", blocked: true, grantValid: true, grantBound: false }),
    )
    await render(true, undefined, false, { handle: "admin", token: "grant-token" })
    await type("admin")
    await settle()

    expect(container.textContent).not.toContain("is reserved")
    expect(cta().disabled).toBe(false)
  })

  it("sends a bound grant to its existing passkey instead of creating an account", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ status: "blocked", blocked: true, grantValid: false, grantBound: true }),
    )
    await render(true, "admin", false, { handle: "admin", token: "bound-token" })
    await settle()

    expect(container.textContent).toContain("already linked to a passkey")
    expect(cta().textContent).toContain("Continue with passkey")
    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onBoundGrant).toHaveBeenCalledWith("admin")
    expect(onUnlock).not.toHaveBeenCalled()
  })

  it("lets the recovered owner continue a bound, blocked reservation", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ status: "reserved", blocked: true, grantValid: false, grantBound: true }),
    )
    await render(true, "admin", true, { handle: "admin", token: "bound-token" }, true)
    await settle()

    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onUnlock).toHaveBeenCalledWith("admin")
    expect(onBoundGrant).not.toHaveBeenCalled()
  })

  it("does not offer an unverified grant when the service cannot answer", async () => {
    vi.stubGlobal("fetch", answering({ error: "missing route" }, 404))
    await render(true, "admin", false, { handle: "admin", token: "grant-token" })
    await settle()

    expect(container.textContent).toContain("couldn't check this grant")
    expect(cta().disabled).toBe(true)
  })

  it("does not let a route grant pass a live reservation", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", grantValid: true, grantBound: false }))
    await render(true, undefined, false, { handle: "satoshi", token: "grant-token" })
    await type("satoshi")
    await settle()

    expect(container.textContent).toContain("is being claimed by someone else")
    expect(cta().disabled).toBe(true)
  })

  it("still checks a blocked reservation when a grant is present", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ status: "reserved", blocked: true, grantValid: true, grantBound: false }),
    )
    await render(true, undefined, false, { handle: "admin", token: "grant-token" })
    await type("admin")
    await settle()

    expect(container.textContent).toContain("is being claimed by someone else")
    expect(cta().disabled).toBe(true)
  })

  it("lets the granted holder retry a blocked reservation", async () => {
    vi.stubGlobal(
      "fetch",
      answering({ status: "reserved", blocked: true, grantValid: true, grantBound: false }),
    )
    await render(true, undefined, true, { handle: "admin", token: "grant-token" })
    await type("admin")
    await settle()

    expect(container.textContent).toContain("Continue with your passkey")
    expect(cta().disabled).toBe(false)
  })

  it("stays out of the way when the service cannot answer", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    await render()
    await type("satoshi")
    // The read retries at 250ms and 500ms after the 350ms debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1250))
    })

    expect(container.textContent).not.toContain("available")
    expect(cta().disabled).toBe(false)
  })

  it("spins while the answer is outstanding, then resolves to it", async () => {
    vi.stubGlobal("fetch", answering({ status: "available" }))
    await render()
    await type("satoshi")

    expect(container.textContent).toContain("Checking availability")
    expect(container.textContent).not.toContain("is available.")
    expect(cta().disabled).toBe(true)
    await act(async () => cta().click())
    expect(onUnlock).not.toHaveBeenCalled()

    await settle()
    expect(container.textContent).not.toContain("Checking availability")
    expect(container.textContent).toContain("@satoshi is available.")
    expect(cta().disabled).toBe(false)
  })

  it("folds a typed tag to the case it will register under", async () => {
    const fetchMock = answering({ status: "available" })
    vi.stubGlobal("fetch", fetchMock)
    await render(false)
    await type("ABC-DEF")
    await settle()

    expect(container.querySelector("input")!.value).toBe("abc-def")
    expect(container.textContent).toContain("@abc-def is available.")
    // Registration hashes the tag as typed while every resolver normalises first, so an
    // uppercase tag would register under a hash nobody can pay to.
    const probed = new URL(fetchMock.mock.calls[0][0]).searchParams.get("nameHash")
    const lower = await probeNameAvailability("abc-def")
    expect(lower.status).toBe("available")
    expect(probed).toBe(
      new URL(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]).searchParams.get(
        "nameHash",
      ),
    )
  })

  it("folds a seeded tag that never passes through the field", async () => {
    vi.stubGlobal("fetch", answering({ status: "available" }))
    // A claim link (/claim/:handle) seeds the input directly, bypassing onChange entirely.
    await render(false, "@ABC-DEF.zk.money")
    expect(container.querySelector("input")!.value).toBe("abc-def")
    expect(cta().disabled).toBe(true)

    await settle()
    expect(container.textContent).toContain("@abc-def is available.")
    expect(cta().disabled).toBe(false)
  })

  it("never probes a malformed tag", async () => {
    const fetchMock = answering({ status: "available" })
    vi.stubGlobal("fetch", fetchMock)
    await render()
    await type("not a tag!")
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(cta().disabled).toBe(true)
  })

  it("on a phone the tag field waits for a tap instead of focusing as the sheet opens", async () => {
    const { deviceStorage } = await import("../../../../src/platform/storage/rollupStorage")
    deviceStorage.setItem("webwallet.ticket-intro-seen", "1")
    const media = { matches: true, addEventListener() {}, removeEventListener() {} }
    vi.stubGlobal("matchMedia", () => media)
    vi.stubGlobal("fetch", answering({ status: "available" }))
    await act(async () => {
      root.render(
        <ChooseTagStep
          ticket={{ tokenDecimals: 18, tokenSymbol: "DAI" }}
          busy={false}
          onClaim={vi.fn()}
          onLogIn={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Your tag"]')!
    expect(field.hasAttribute("data-autofocus")).toBe(false)
    expect(document.activeElement).not.toBe(field)
    media.matches = false
    deviceStorage.removeItem("webwallet.ticket-intro-seen")
  })

  it("holds a seeded paylink tag while availability is pending", async () => {
    const onClaim = vi.fn()
    vi.stubGlobal("fetch", answering({ status: "available" }))
    await act(async () => {
      root.render(
        <ChooseTagStep
          ticket={{ tokenDecimals: 18, tokenSymbol: "DAI" }}
          initialHandle="alice"
          busy={false}
          onClaim={onClaim}
          onLogIn={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })
    expect(cta().disabled).toBe(true)
    await act(async () => cta().click())
    expect(onClaim).not.toHaveBeenCalled()

    await settle()
    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onClaim).toHaveBeenCalledWith("alice")
  })

  it("keeps a blocked reservation out of the paylink flow without a grant", async () => {
    vi.stubGlobal("fetch", answering({ status: "reserved", blocked: true }))
    await act(async () => {
      root.render(
        <ChooseTagStep
          ticket={{ tokenDecimals: 18, tokenSymbol: "DAI" }}
          initialHandle="alice"
          busy={false}
          resuming
          onClaim={vi.fn()}
          onLogIn={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })
    await settle()
    expect(container.textContent).toContain("is reserved")
    expect(cta().disabled).toBe(true)
  })

  it("shows a golden ticket's split on the tag step and claims the name with the amount", async () => {
    vi.stubGlobal("fetch", answering({ status: "available" }))
    const step = (held: boolean) => (
      <ChooseTagStep
        ticket={{ amount: 25n * 10n ** 18n, tokenDecimals: 18, tokenSymbol: "DAI" }}
        split={<p>Network fee</p>}
        warning={<p>Keep this phone</p>}
        held={held}
        initialHandle="alice"
        busy={false}
        onClaim={vi.fn()}
        onLogIn={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await act(async () => root.render(step(false)))
    await settle()
    expect(container.textContent).toContain("Network fee")
    expect(container.textContent).toContain("Keep this phone")
    expect(cta().textContent).toBe("Claim @alice and 25.00 DAI")
    expect(container.querySelector('[data-testid="ticket-art"]')).not.toBeNull()
    expect(cta().disabled).toBe(false)
    await act(async () => root.render(step(true)))
    expect(cta().disabled).toBe(true)
  })
})
