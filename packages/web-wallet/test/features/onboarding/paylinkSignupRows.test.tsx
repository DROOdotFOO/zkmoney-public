import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { PaylinkSignupRows } from "../../../src/features/onboarding/steps/PaylinkSignupRows"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("PaylinkSignupRows", () => {
  it("shows the speed choice just above the network fee", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <PaylinkSignupRows
          tokenSymbol="DAI"
          tokenDecimals={18}
          speed={<div data-testid="speed">Speed</div>}
        />,
      ),
    )
    const speed = container.querySelector('[data-testid="speed"]')!
    const fee = container.querySelector('[data-testid="paylink-signup-network-fee"]')!
    expect(speed.compareDocumentPosition(fee) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => root.unmount())
  })

  it("shows the name price, the network fee and the balance after the claim", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    const root = createRoot(container)
    const ONE = 10n ** 18n
    await act(async () =>
      root.render(
        <PaylinkSignupRows
          tokenSymbol="DAI"
          tokenDecimals={18}
          quote={{
            paylink: 25n * ONE,
            youReceive: 24n * ONE + ONE / 2n,
            tagFee: 0n,
            tagWaived: true,
            networkFee: ONE / 2n - ONE / 10n,
            provingFee: ONE / 10n,
            returned: 0n,
            burn: ONE / 2n,
          }}
        />,
      ),
    )
    const rows = [...container.querySelectorAll("[data-testid^=paylink-signup-]")].map((el) => [
      el.getAttribute("data-testid"),
      el.textContent,
    ])
    expect(rows).toEqual([
      ["paylink-signup-tag-price", "Free with ticket"],
      ["paylink-signup-network-fee", "0.50 DAI"],
      ["paylink-signup-balance-after", "24.50 DAI"],
    ])
    expect(container.textContent).toContain("Name price")
    expect(container.textContent).toContain("Your balance after")
    await act(async () => root.unmount())
  })

  it("pads amounts to cents without rounding away a fee's smaller digits", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    const root = createRoot(container)
    const ONE = 10n ** 18n
    await act(async () =>
      root.render(
        <PaylinkSignupRows
          tokenSymbol="DAI"
          tokenDecimals={18}
          quote={{
            youReceive: 24n * ONE,
            networkFee: (613n * ONE) / 1000n,
            provingFee: 0n,
            returned: 0n,
            burn: ONE,
          }}
        />,
      ),
    )
    const value = (id: string) =>
      container.querySelector(`[data-testid="paylink-signup-${id}"]`)?.textContent
    expect(value("network-fee")).toBe("0.613 DAI")
    expect(value("balance-after")).toBe("24.00 DAI")
    await act(async () => root.unmount())
  })

  it("counts a signed minimum's excess in the balance after, with no row of its own", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    const root = createRoot(container)
    const ONE = 10n ** 18n
    await act(async () =>
      root.render(
        <PaylinkSignupRows
          tokenSymbol="DAI"
          tokenDecimals={18}
          quote={{
            youReceive: 24n * ONE,
            networkFee: ONE / 2n,
            provingFee: 0n,
            returned: ONE / 20n,
            burn: ONE,
          }}
        />,
      ),
    )
    expect(container.textContent).not.toContain("Returned")
    expect(
      container.querySelector('[data-testid="paylink-signup-balance-after"]')?.textContent,
    ).toBe("24.05 DAI")
    await act(async () => root.unmount())
  })
})
