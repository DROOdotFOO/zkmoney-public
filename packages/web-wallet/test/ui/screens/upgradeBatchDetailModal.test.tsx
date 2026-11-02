import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeAll, describe, expect, it } from "vitest"
import type { UpgradeBatchItem } from "@obsidion/front-core"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

import { UpgradeBatchDetailModal } from "../../../src/ui/screens/UpgradeBatchDetailModal"
import { seedBootConfig } from "../../support/seedBootConfig"

const batch: UpgradeBatchItem = {
  run: "run",
  id: "remaining-0",
  recipient: `0x${"5a".repeat(20)}`,
  amount: (10n * 10n ** 18n).toString(),
  state: "refunded",
  approved: true,
  tx: `0x${"b0".repeat(32)}`,
  startTime: 1_000,
}

describe("upgrade batch details", () => {
  beforeAll(seedBootConfig)

  it("shows the refund's state and the send that carried it, with no tip and no deposit address", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<UpgradeBatchDetailModal batch={batch} onClose={() => {}} />))
    const text = document.body.textContent ?? ""
    expect(text).toContain("$10")
    expect(text).toContain("Releasing")
    expect(text).not.toContain("Relayer tip")
    expect(text).not.toContain("Paid to")
    expect(text).toContain("Sent in")
    await act(async () => root.unmount())
    container.remove()
  })
})
