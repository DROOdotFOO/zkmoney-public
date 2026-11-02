import { describe, expect, it } from "vitest"
import { TransferEventScanner } from "../../../src/core/services/transactions/TransferEventScanner"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { seededActivity } from "../../utils/activityFixture"

const ME = "0x" + "aa".repeat(32)
const ALICE = "0x" + "bb".repeat(32)
const CURSOR = `@obsidion/transfer-scan/cursor/v1/net/${ME}`
const HASH = "0x" + "01".repeat(32)

describe("transfer scan: rows and cursor save together", () => {
  it("a failed save keeps neither the receive nor the cursor, and the next pass files both", async () => {
    const activity = seededActivity()
    const { db, backend } = activity
    await activity.ready
    const event: ScannedTransferEvent = {
      txHash: HASH,
      from: ALICE,
      to: ME,
      amount: "5",
      blockNumber: 10,
    }
    const scanner = new TransferEventScanner({
      source: {
        headBlock: async () => 100,
        listIncoming: async () => [event],
        blockTimestampMs: async (b) => b * 1000,
      },
      db,
      transactionStore: activity,
      tags: { resolveL2: async () => null },
      contacts: { findByL2Address: async () => null },
      token: { address: "0xtok", symbol: "DAI", decimals: 6 },
    })
    const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }

    backend.failing.commits = true
    await expect(scanner.pass(ctx, { full: true })).rejects.toMatchObject({ code: "unknown" })
    expect(await activity.hasTxHash(HASH)).toBe(false)
    expect(backend.entries.get(CURSOR)).toBeUndefined()
    expect([...backend.entries.keys()].filter((k) => k.startsWith("acct/activity/"))).toEqual([])

    backend.failing.commits = false
    await scanner.pass(ctx, { full: true })
    expect(await activity.hasTxHash(HASH)).toBe(true)
    expect(backend.entries.get(CURSOR)).toBe("100")
    expect(backend.entries.get(`acct/activity/${HASH}`)).toBeDefined()
  })
})
