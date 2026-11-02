// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  TokenService,
  WalletBalanceRead,
} from "@obsidion/sdk"
import type { TransferScanContext } from "../../src/core/services/transactions/TransferEventScanner"
import { fixed } from "../../src/engine/resource"
import { startRuntime } from "../../src/engine/runtime"
import { savingsLookup, transferScan, SAVINGS_LOOKUP_RETRY_MS } from "../../src/engine/transferScan"
import { later, onceSteps, periodicSteps, sessions, table } from "./taskTable"

const TOKEN = { address: "0xmain", symbol: "USD", decimals: 18 }
const reader = (read: () => Promise<bigint>) => ({ readBalanceAssumingSynced: read })
const flush = () => vi.advanceTimersByTimeAsync(0)
const mainToken = () =>
  ({ metadata: TOKEN, ...reader(async () => 100n) } as unknown as TokenService)
const ME = { getAddress: () => "0xme" } as unknown as ObsidionAccount

describe("transferScan task", () => {
  const ends: (() => void)[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const end of ends.splice(0)) end()
    vi.useRealTimers()
  })

  function start(opts: { lookupFails?: number; incomplete?: boolean; tag?: string } = {}) {
    const events: string[] = []
    const contexts: TransferScanContext[] = []
    let readBalances!: () => Promise<WalletBalanceRead>
    let { lookupFails = Infinity } = opts
    const shares = vi.fn(async () => 7n)
    const lookups = vi.fn()
    const readBalanceCoalesced = vi.fn(async () => true)
    const token = later<TokenService>("token")
    const account = later<ObsidionAccount>("account")
    const wallet = fixed("wallet", { networkId: "net" } as ObsidionWallet)
    const h = sessions(startRuntime)
    const scan = transferScan({
      wallet,
      account: account.resource,
      token: token.resource,
      contractService: fixed("contractService", {} as ContractService),
      tag: () => opts.tag,
      endpointScope: () => "edge",
      visible: h.visible.readonly,
      coordinator: (_ready, read) => {
        events.push("built")
        readBalances = read
        return {
          pass: async (context, { full }) => {
            contexts.push(context)
            events.push(full ? "full" : "pass")
            return !opts.incomplete
          },
          attach: () => () => {},
          readBalanceCoalesced,
        }
      },
    })
    const lookup = async () => {
      lookups()
      if (lookupFails-- > 0) throw new Error("no deployment")
      return { tokenService: { tokenAddress: "0xshares", ...reader(shares) } }
    }
    h.tasks.push(scan.task, savingsLookup({ wallet, account: account.resource, lookup, scan }))
    ends.push(h.end, scan.dispose)
    const read = () => readBalances()
    return { h, token, account, events, contexts, shares, lookups, readBalanceCoalesced, read }
  }

  it("scans once Main's token is ready: every 5 s while visible, paused while hidden", async () => {
    const t = start()
    t.account.ready(ME)
    await table(
      periodicSteps(t.h, () => t.token.ready(mainToken()), 5_000),
      () => t.events.filter((e) => e !== "built").length,
    )
    // Started, given its token, shown and restarted: full passes.
    expect(t.events).toEqual(["built", "full", "pass", "full", "full"])
    expect(t.contexts[0]).toEqual({
      accountAddress: "0xme",
      accountTag: "0xme",
      networkId: "net",
      endpointScope: "edge",
    })
  })

  it("builds a coordinator per value of Main's token, and names the account by its tag", async () => {
    const t = start({ tag: "me" })
    t.account.ready(ME)
    t.h.start()
    t.token.ready(mainToken())
    await flush()
    t.token.ready(mainToken())
    await flush()
    expect(t.events).toEqual(["built", "full", "built", "full"])
    expect(t.contexts[0]?.accountTag).toBe("me")
  })

  it("backs off from 10 s while passes stay incomplete", async () => {
    const t = start({ incomplete: true })
    t.account.ready(ME)
    t.token.ready(mainToken())
    t.h.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(t.events).toEqual(["built", "full"])
    await vi.advanceTimersByTimeAsync(20_001)
    expect(t.events).toEqual(["built", "full", "pass", "pass"])
  })

  it("looks Savings up once per session, after the first balance, once the account is ready", async () => {
    const t = start({ lookupFails: 0 })
    t.token.ready(mainToken())
    await table(
      onceSteps(t.h, () => t.account.ready(ME)),
      () => t.lookups.mock.calls.length,
    )
  })

  it("retries the Savings lookup, then reads its shares beside Main's, which survive a failed read", async () => {
    const t = start({ lookupFails: 1 })
    t.account.ready(ME)
    t.token.ready(mainToken())
    t.h.start()
    const balances = async () => (await t.read()).balances
    await flush()
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n })
    await vi.advanceTimersByTimeAsync(SAVINGS_LOOKUP_RETRY_MS)
    // The balances alone, through the scan's coordinator.
    expect(t.readBalanceCoalesced).toHaveBeenCalledTimes(1)
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n, "0xshares": 7n })
    t.shares.mockRejectedValueOnce(new Error("unreadable"))
    await expect(balances()).resolves.toEqual({ [TOKEN.address]: 100n })
  })

  it("stamps each balance with when its own read resolved", async () => {
    const t = start({ lookupFails: 0 })
    t.account.ready(ME)
    t.token.ready(mainToken())
    t.h.start()
    await flush()
    t.shares.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(7n), 50)))
    const pending = t.read()
    await vi.advanceTimersByTimeAsync(50)
    const { readAt = {} } = await pending
    expect(readAt["0xshares"]! - readAt[TOKEN.address]!).toBe(50)
  })
})
