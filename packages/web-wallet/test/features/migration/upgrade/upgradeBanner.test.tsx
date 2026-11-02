import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { UpgradeBanner } from "../../../../src/features/migration/UpgradeIntro"
import {
  setUpgradeStatus,
  useMigrationDialogRequest,
  type UpgradeStatus,
} from "../../../../src/features/migration/migrationDialog"
import { finishingCopy, upgradePhaseLabel } from "../../../../src/features/migration/upgradeCopy"

describe("Home's upgrade banner", () => {
  async function banner(status: UpgradeStatus) {
    let requests = 0
    function Requests() {
      requests = useMigrationDialogRequest()
      return null
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    await act(async () => setUpgradeStatus(status))
    await act(async () =>
      root.render(
        <>
          <UpgradeBanner />
          <Requests />
        </>,
      ),
    )
    const button = container.querySelector<HTMLButtonElement>('[data-testid="upgrade-banner"]')
    const part = (name: string) => button?.querySelector(`.ww-banner__${name}`)?.textContent ?? null
    const shown = { title: part("title"), body: part("body"), cta: part("cta") }
    const before = requests
    if (button) await act(async () => button.click())
    const opened = requests === before + 1
    await act(async () => root.unmount())
    return { ...shown, opened }
  }

  it("offers the upgrade with a button that opens its dialog", async () => {
    const shown = await banner({ state: "offered", registration: true })
    expect(shown.cta).not.toBeNull()
    expect(shown.opened).toBe(true)
  })

  it("says what is left to do or where a run stands", async () => {
    const finishing = await banner({ state: "finishing", registration: true })
    expect(finishing.title).toBe(finishingCopy.title)
    const running = (phase: "awaitingMessages" | "recovering") =>
      banner({ state: "running", phase, registration: true })
    const awaiting = await running("awaitingMessages")
    expect(awaiting.title).not.toBe(upgradePhaseLabel.awaitingMessages)
    expect((await running("recovering")).title).toBe(awaiting.title)
    const stopped = await banner({ state: "stopped", phase: "needsApproval", registration: true })
    expect(stopped.title).toBe(upgradePhaseLabel.needsApproval)
    const failed = await banner({ state: "failed", registration: false })
    expect(failed.body).not.toBeNull()
    expect(failed.cta).toBeNull()
    expect(failed.opened).toBe(true)
  })

  it("hides while there is nothing to say", async () => {
    expect((await banner({ state: "checking", registration: false })).title).toBeNull()
    expect((await banner({ state: "none", registration: false })).title).toBeNull()
  })
})
