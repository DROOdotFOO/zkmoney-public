import { describe, expect, it, vi } from "vitest"
import { walletStorage } from "../../../../src/platform/storage/walletStorage"

vi.mock("../../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => {
    if (fragment === "undecodable") throw new Error("bad link")
    return `id:${fragment}`
  },
}))

const { rememberTicketSpent, ticketKnownSpent } = await import(
  "../../../../src/features/paylink/ticketSpent"
)

describe("ticketKnownSpent", () => {
  it("knows a refused link's ticket as spent, by identity alone, and no other link's", () => {
    expect(ticketKnownSpent("frag-a")).toBe(false)
    rememberTicketSpent("frag-a")
    expect(ticketKnownSpent("frag-a")).toBe(true)
    expect(ticketKnownSpent("frag-b")).toBe(false)
    expect(walletStorage.getItem("obsidion.ticket-spent")).not.toContain('"frag-a"')
    rememberTicketSpent("undecodable")
    expect(ticketKnownSpent("undecodable")).toBe(false)
  })
})
