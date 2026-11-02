/** The ticket claim's review: its status says where the claim stands, its error only what stops it. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  GradientSpinner: () => <i data-spinner />,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))
vi.mock("../../../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) => (
    <div>
      {onClose && <button aria-label="Close card" onClick={onClose} />}
      {children}
    </div>
  ),
}))
vi.mock("../../../src/features/onboarding/steps/PaylinkSignupRows", () => ({
  PaylinkSignupRows: ({ speed }: { speed?: React.ReactNode }) => <>{speed}</>,
}))
vi.mock("../../../src/features/onboarding/steps/SignupStepper", () => ({
  SignupStepper: () => null,
}))
/** The hand-off's own leave, which a close while the claim runs must take. */
const leave = vi.hoisted(() => vi.fn())
vi.mock("../../../src/features/operations/OperationHandOff", async () => {
  const { useImperativeHandle } = await import("react")
  return {
    OperationHandOff: ({
      onLeave,
      ref,
    }: {
      onLeave: () => void
      ref?: React.Ref<{ leave(): void }>
    }) => {
      useImperativeHandle(ref, () => ({
        leave: () => {
          leave()
          onLeave()
        },
      }))
      return <span>working</span>
    },
  }
})

const { ClaimReviewStep } = await import("../../../src/features/onboarding/steps/ClaimReviewStep")

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const quote = { paylink: 10n ** 18n, covers: true } as never
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (props: Partial<Parameters<typeof ClaimReviewStep>[0]>) =>
  act(() =>
    root.render(
      <ClaimReviewStep
        quote={quote}
        tokenSymbol="DAI"
        tokenDecimals={18}
        busy={false}
        onClaim={() => {}}
        onClose={() => {}}
        {...props}
      />,
    ),
  )
const claim = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Claim")
const close = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Close")
const cardClose = () => container.querySelector<HTMLButtonElement>('[aria-label="Close card"]')

describe("ClaimReviewStep", () => {
  it("shows a claim that went out as progress, with no warning, no Claim and no error", () => {
    render({
      status: "Registering @maple",
      statusDetail: "Waiting for the network to sweep the deposit",
      settled: true,
    })
    const status = container.querySelector('[role="status"]')
    expect(status?.querySelector("[data-spinner]")).not.toBeNull()
    expect(status?.textContent).toBe(
      "Registering @mapleWaiting for the network to sweep the deposit",
    )
    expect(container.querySelector(".ww-claim-review__status")).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(claim()).toBeUndefined()
  })

  it("offers no speed and no shortfall once the claim is at work or out", () => {
    const speed = <button>Faster</button>
    render({ quote: { paylink: 10n ** 18n, covers: false } as never, speed })
    expect(container.textContent).toContain("Faster")
    expect(container.textContent).toContain("This payment cannot cover the account deposit.")
    render({ quote: { paylink: 10n ** 18n, covers: false } as never, speed, settled: true })
    expect(container.textContent).not.toContain("Faster")
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it("closes while the claim runs, handing it to the bell rather than stopping it", () => {
    const onClose = vi.fn()
    const onHandOff = vi.fn()
    render({ busy: true, settled: true, status: "Claiming", onClose, onHandOff })
    expect(container.textContent).toContain("working")
    expect(claim()).toBeUndefined()
    act(() => close()!.click())
    expect(leave).toHaveBeenCalledOnce()
    expect(onHandOff).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()

    leave.mockClear()
    render({ busy: true, settled: true, status: "Claiming", onClose, onHandOff: vi.fn() })
    act(() => cardClose()!.click())
    expect(leave).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("keeps the error slot for what stops the claim", () => {
    render({ status: "Unclaimed", error: "This link was already claimed.", claimable: false })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This link was already claimed.",
    )
    expect(claim()?.disabled).toBe(true)
  })
})

describe("the review's head", () => {
  it("names the stored amount while the split is unpriced, never a bare payment", () => {
    render({ quote: undefined, amount: 52n * 10n ** 18n, senderTag: "maple" })
    expect(container.querySelector(".ww-paylink-summary__label")?.textContent).toBe(
      "@maple sent you",
    )
    expect(container.querySelector('[data-testid="claim-review-amount"]')?.textContent).toBe(
      "52.00 DAI",
    )
  })
})
