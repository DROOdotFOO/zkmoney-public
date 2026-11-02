import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import type { MintedRequestLink } from "@obsidion/front-core"
import {
  CODE_LIFETIME_MS,
  currentCode,
  openCode,
  setCodeAmount,
  type CodeDeps,
  type ReadyAddress,
} from "../../../src/features/receive/receiveCode"

const DAY_MS = 86_400_000
const NOW = 1_800_000_000_000
const TODAY = Math.floor(NOW / DAY_MS)
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address

let seq = 0
function harness(ready: Array<ReadyAddress | null> = []) {
  const key = `webwallet.receiveCode.test.${++seq}`
  const cancelled: string[] = []
  const minted: Array<{ amountInput: string; sipaAddress?: Address }> = []
  const paidIds = new Set<string>()
  const deps: CodeDeps = {
    key,
    readyAddress: async () => ready.shift() ?? null,
    mint: async (args) => {
      minted.push(args)
      const id = `0x${seq}${minted.length}`
      const amount = Number(args.amountInput) || 0
      return {
        url: `https://wallet.test/pay/river#${id}`,
        row: { id, amount, expiresAt: args.now + args.durationMs },
        note: args.noteInput || undefined,
      } as MintedRequestLink
    },
    cancel: async (id: string) => cancelled.push(id),
    paid: async (code) => paidIds.has(code.requestId),
  }
  return { deps, cancelled, paidIds }
}

describe("receive code", () => {
  it("carries no address while none is ready, and takes one once it is", async () => {
    const { deps, cancelled } = harness([null, null, { address: addr(2), day: TODAY }])
    const plain = await currentCode(deps, NOW)
    expect(plain.address).toBeUndefined()
    expect(await currentCode(deps, NOW)).toEqual(plain)
    const upgraded = await currentCode(deps, NOW)
    expect(upgraded.address).toBe(addr(2))
    expect(cancelled).toEqual([plain.requestId])
  })

  it.each([
    ["an address older than 48 hours", { address: addr(3), day: TODAY - 3 }, NOW],
    ["an expired request", { address: addr(3), day: TODAY }, NOW + CODE_LIFETIME_MS],
  ])("replaces a code with %s and cancels it", async (_label, ready, later) => {
    const { deps, cancelled } = harness([
      ready,
      { address: addr(4), day: Math.floor(later / DAY_MS) },
    ])
    const old = await currentCode(deps, NOW)
    const fresh = await currentCode(deps, later)
    expect(fresh.address).toBe(addr(4))
    expect(cancelled).toEqual([old.requestId])
  })

  it("puts an amount on the code, then opens on a plain code with the same address", async () => {
    const { deps, cancelled } = harness([{ address: addr(5), day: TODAY }])
    await currentCode(deps, NOW)
    const priced = await setCodeAmount(deps, { amountInput: "12.5", noteInput: "Lunch" }, NOW)
    expect(priced).toMatchObject({ address: addr(5), amount: 12.5, note: "Lunch" })
    const opened = await openCode(deps, NOW)
    expect(opened).toMatchObject({ address: addr(5), amount: 0, note: undefined })
    expect(cancelled).toContain(priced.requestId)
    expect(await openCode(deps, NOW)).toEqual(opened)
  })

  it.each([
    ["a plain code", ""],
    ["a code with an amount", "25"],
  ])("moves %s paid while Receive was closed to a new address", async (_label, amountInput) => {
    const { deps, cancelled, paidIds } = harness([
      { address: addr(7), day: TODAY },
      { address: addr(8), day: TODAY },
    ])
    const first = await setCodeAmount(deps, { amountInput, noteInput: "" }, NOW)
    paidIds.add(first.requestId)
    const opened = await openCode(deps, NOW + 1)
    expect(opened.address).toBe(addr(8))
    expect(opened.amount).toBe(0)
    expect(cancelled).not.toContain(first.requestId)
  })
})
