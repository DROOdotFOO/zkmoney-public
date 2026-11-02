import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SIGN_UP_SHEET_COPY } from "@obsidion/passkey-web"
import { PhoneSteps } from "../../../src/features/identity/PhoneSteps"
import { OnboardingSpinnerBody } from "../../../src/features/onboarding/OnboardingCard"

/** The warning sits above whatever is running: the drawn-tag sheet's button, or the spinner. */
describe("the extension warning in the busy presentations", () => {
  let container: HTMLDivElement
  let root: Root
  const alert = () =>
    container.querySelector<HTMLElement>('[data-testid="phone-steps-extension-warning"]')
  const order = (after: string) =>
    alert()!.compareDocumentPosition(container.querySelector(after)!) &
    Node.DOCUMENT_POSITION_FOLLOWING

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("the running sheet shows it above its button, and only while busy", async () => {
    await act(async () =>
      root.render(
        <PhoneSteps
          reach="unknown"
          busy="Creating your passkey…"
          warning={SIGN_UP_SHEET_COPY.extensionWarning}
          tag="brisk-otter"
          onChoose={() => {}}
        />,
      ),
    )
    expect(alert()?.textContent).toBe(SIGN_UP_SHEET_COPY.extensionWarning)
    expect(alert()?.getAttribute("role")).toBe("alert")
    expect(order('[data-testid="phone-steps-loading"]')).toBeTruthy()
    await act(async () =>
      root.render(
        <PhoneSteps
          reach="unknown"
          loading
          warning={SIGN_UP_SHEET_COPY.extensionWarning}
          onChoose={() => {}}
        />,
      ),
    )
    expect(alert()).toBeNull()
  })

  it("the spinner body shows it above the spinner", async () => {
    await act(async () =>
      root.render(
        <OnboardingSpinnerBody
          label="Creating your passkey…"
          warning={SIGN_UP_SHEET_COPY.extensionWarning}
        />,
      ),
    )
    expect(alert()?.textContent).toBe(SIGN_UP_SHEET_COPY.extensionWarning)
    expect(order(".ww-invite-spinner__label")).toBeTruthy()
    await act(async () => root.render(<OnboardingSpinnerBody label="Creating your passkey…" />))
    expect(alert()).toBeNull()
  })
})
