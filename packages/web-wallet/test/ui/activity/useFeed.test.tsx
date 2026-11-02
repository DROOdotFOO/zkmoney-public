/** A deep-linked row joins Home's rows: opening its sheet hides nothing else Home lists. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { scannedRow } from "@obsidion/front-core"
import {
  activeNamespace,
  closeSession,
  switchSession,
  session,
} from "../../../src/platform/session"
import { feedRows } from "../../../src/ui/activity/useFeed"

afterEach(closeSession)

const token = {
  address: "0xt",
  name: "USD",
  symbol: "USD",
  decimals: 6,
  logo: "",
  amount: 1,
  price: 1,
}

describe("useFeed", () => {
  it("keeps Home's older open link while a row outside the window is opened by its hash", async () => {
    switchSession(activeNamespace())
    const { activity } = session()
    const now = Date.now()
    const received = (txHash: string, timestamp: number) =>
      activity.record(
        scannedRow({
          networkId: "0xnet",
          txHash,
          from: "alice",
          senderL2Address: "0xa11ce",
          to: "me",
          token,
          amountAtomic: 1n,
          timestamp,
        }),
      )
    await activity.record({
      id: "0xescrowed",
      networkId: "0xnet",
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      flavor: "direct",
      status: "success",
      txHash: "0xescrowed",
      token,
      amountAtomic: 1n,
      timestamp: now - 90 * 24 * 60 * 60 * 1000,
    } as never)
    await received("0xold", now - 80 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 12; i++) await received(`0x${i + 10}`, now - i)
    const feed = feedRows(session(), undefined, "0xold")
    const stop = feed.subscribe(() => {})
    const ids = () => feed.get().rows.records.map((row) => row.txHash)
    await vi.waitFor(() => expect(ids()).toContain("0xold"))
    expect(ids()).toContain("0xescrowed")
    stop()
  })
})
