import { act } from "react"
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

const { InvitationStep } = await import("../../../src/features/onboarding/steps/InvitationStep")

/** Landing layout of the invitation step — the surface a paylink visitor signs up from. */
describe("InvitationStep landing layout", () => {
  let container: HTMLDivElement
  let root: Root
  const onUnlock = vi.fn()
  const onLogIn = vi.fn()

  const render = async (props: Partial<Parameters<typeof InvitationStep>[0]> = {}) => {
    await act(async () => {
      root.render(
        <InvitationStep
          busy={false}
          header={<span data-testid="header" />}
          onUnlock={onUnlock}
          onLogIn={onLogIn}
          onCancelSignIn={vi.fn()}
          {...props}
        />,
      )
    })
  }
  const cta = () => container.querySelector("button")!
  const input = () => container.querySelector("input")!
  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input(), value)
      input().dispatchEvent(new Event("input", { bubbles: true }))
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
  })

  it("renders the header above the tag field and holds the CTA until the tag is valid", async () => {
    await render()
    expect(container.querySelector("[data-testid=header]")).not.toBeNull()
    expect(cta().textContent).toBe("Create account")
    expect(cta().disabled).toBe(true)

    await type("satoshi")
    expect(cta().disabled).toBe(false)
    await act(async () => cta().click())
    expect(onUnlock).toHaveBeenCalledWith("satoshi")
  })

  it("drops a pasted @ so the field's own @ is not doubled", async () => {
    await render()
    await type("@satoshi")
    expect(input().value).toBe("satoshi")
  })

  it("offers a log in to a returning account", async () => {
    await render()
    const logIn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Log in")!
    await act(async () => logIn.click())
    expect(onLogIn).toHaveBeenCalled()
  })

  it("keeps the heading layout when no header is given", async () => {
    await render({ header: undefined })
    expect(container.querySelector("h1")?.textContent).toBe("You're in!")
    expect(container.querySelector("[data-testid=header]")).toBeNull()
  })
})
