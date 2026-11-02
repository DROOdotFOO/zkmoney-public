import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  GoldenTicketArt,
  GoldenTicketHead,
  GoldenTicketIntro,
} from "../../../src/features/onboarding/steps/GoldenTicketHead"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const ONE = 10n ** 18n

async function render(amount?: bigint, senderTag?: string) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <>
        <GoldenTicketHead
          amount={amount}
          tokenDecimals={18}
          tokenSymbol="DAI"
          senderTag={senderTag}
        />
        <GoldenTicketArt
          amount={amount}
          tokenDecimals={18}
          tokenSymbol="DAI"
          senderTag={senderTag}
          tag=""
        />
      </>,
    ),
  )
  return { container, unmount: () => act(async () => root.unmount()) }
}

describe("GoldenTicketHead", () => {
  it("floors the amount to cents rather than rounding it up", async () => {
    const { container, unmount } = await render(20n * ONE - ONE / 1000n)
    expect(container.querySelector('[data-testid="paylink-signup-paylink"]')?.textContent).toBe(
      "19.99 DAI",
    )
    await unmount()
  })

  it("says nothing is free for a link with no ticket", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    const root = createRoot(container)
    const ticket = { amount: 25n * ONE, tokenDecimals: 18, tokenSymbol: "DAI", paid: true }
    await act(async () =>
      root.render(
        <>
          <GoldenTicketHead {...ticket} />
          <GoldenTicketArt {...ticket} tag="" />
        </>,
      ),
    )
    expect(container.querySelector("h2")?.textContent).toBe("Pick any name")
    expect(container.textContent).not.toMatch(/free|golden ticket/i)
    await act(async () => root.unmount())
  })

  it("leaves the payment card out until the amount is read", async () => {
    const { container, unmount } = await render(undefined)
    expect(container.querySelector("h2")?.textContent).toBe("Pick any name, free")
    expect(container.querySelector(".ww-ticket-head")?.textContent).not.toContain("sent you")
    await unmount()
  })

  it.each([
    ["river", "@river sent you"],
    [undefined, "Someone sent you"],
  ])("the card and the ticket name the sender %s as %s", async (senderTag, line) => {
    const { container, unmount } = await render(25n * ONE, senderTag)
    expect(container.querySelector(".ww-ticket-payment__label")?.textContent).toBe(line)
    expect(container.querySelector(".ww-golden-ticket__label")?.textContent).toBe(line)
    await unmount()
  })
})

/** A phone-width screen whose `(min-width: 960px)` query can be made to match later. */
function stubPhoneScreen() {
  let narrow = true
  const listeners = new Map<string, () => void>()
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query.includes("max-width")) return narrow
      if (query.includes("min-width")) return !narrow
      return false
    },
    addEventListener: (_: string, fn: () => void) => listeners.set(query, fn),
    removeEventListener: () => listeners.delete(query),
  }))
  return {
    widen: () => {
      narrow = false
      listeners.get("(min-width: 960px)")?.()
    },
  }
}

async function renderIntro(onGone: () => void) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <GoldenTicketIntro amount={25n * ONE} tokenDecimals={18} tokenSymbol="DAI" onGone={onGone} />,
    ),
  )
  return { container, unmount: () => act(async () => root.unmount()) }
}

describe("GoldenTicketIntro", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
  })

  it("hands the form back when the screen widens past the art breakpoint", async () => {
    const screen = stubPhoneScreen()
    const onGone = vi.fn()
    const { container, unmount } = await renderIntro(onGone)
    expect(container.querySelector(".ww-ticket-intro")).not.toBeNull()
    await act(async () => screen.widen())
    expect(onGone).toHaveBeenCalledTimes(1)
    expect(container.querySelector(".ww-ticket-intro")).toBeNull()
    await unmount()
  })

  it("covers the screen from the dialog itself, so the sheet's slide-in never moves or sizes it", async () => {
    stubPhoneScreen()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <dialog>
          <div className="ww-modal">
            <GoldenTicketIntro
              amount={25n * ONE}
              tokenDecimals={18}
              tokenSymbol="DAI"
              onGone={() => {}}
            />
          </div>
        </dialog>,
      ),
    )
    const intro = container.querySelector(".ww-ticket-intro")
    expect(intro?.parentElement?.tagName).toBe("DIALOG")
    expect(container.querySelector(".ww-modal .ww-ticket-intro")).toBeNull()
    await act(async () => root.unmount())
    container.remove()
  })

  it("hands the form back once the leaving animation's time is up, even when none ran", async () => {
    vi.useFakeTimers()
    stubPhoneScreen()
    const onGone = vi.fn()
    const { container, unmount } = await renderIntro(onGone)
    await act(async () => container.querySelector("button")!.click())
    expect(onGone).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(800))
    expect(onGone).toHaveBeenCalledTimes(1)
    await unmount()
  })
})
