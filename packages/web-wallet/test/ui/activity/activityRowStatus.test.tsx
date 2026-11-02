/**
 * The activity row's status badge draws only labels the design system knows, so every word the feed
 * puts under an amount — a deposit needing recovery, a link's claim state — has to be one of them:
 * an unknown label renders nothing at all. The row also colours an amount as a credit off its
 * leading "+" alone, which is what lets a deposit that credited nothing drop the sign and render
 * neutrally.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PAYLINK_STATUS_LABEL } from "@obsidion/front-core"
import { ActivityListRow, type StatusLabel } from "@obsidion/web-ds"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("ActivityListRow status badge", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  // Every word a creator paylink row can put under its amount, so none of them silently draws blank.
  it.each<StatusLabel>([
    "Needs recovery",
    "Pending",
    "Recovered",
    "Failed",
    ...Object.values(PAYLINK_STATUS_LABEL),
  ])("draws %s as a badge", async (statusLabel) => {
    await act(async () => {
      root.render(
        <ActivityListRow
          counterparty="Deposit"
          timestamp="Today, 11:15"
          amount="+0.4 DAI"
          statusLabel={statusLabel}
        />,
      )
    })
    expect(container.querySelector(".zkm-status-badge")?.textContent).toContain(statusLabel)
  })

  it("colours the amount only where it leads with a plus", async () => {
    const colourOf = async (amount: string) => {
      await act(async () => {
        root.render(
          <ActivityListRow counterparty="Deposit" timestamp="Today, 11:15" amount={amount} />,
        )
      })
      return container.querySelector<HTMLElement>(".zkm-activity-row__amount")!.style.color
    }
    expect(await colourOf("+0.4 DAI")).not.toBe("")
    expect(await colourOf("0.4 DAI")).toBe("")
  })
})
