// @vitest-environment node
import { describe, expect, it } from "vitest"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { AUTH_TYPE } from "@obsidion/sdk"
import { AccountStorage } from "../../src/core/storages/AccountStorage"
import { BalanceStorage } from "../../src/core/storages/BalanceStorage"
import { TokenStorage } from "../../src/core/storages/TokenStorage"
import type { BalanceSync } from "../../src/engine/milestones"
import {
  createBalances,
  exceedsBalance,
  selectBalanceView,
  selectEntry,
  selectHomeMain,
  type BalanceEntry,
  type BalanceRecords,
  type BalanceView,
  type WalletTokens,
} from "../../src/engine/balances"
import { memoryStore } from "../../src/engine/store"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const SCOPE = "sandbox:0xacct"
const MAIN = "0xMain"
const OLD = "0xOld"
const SHARES = "0xShares"
const START = 1_000
const SETTLED: BalanceSync = { syncing: false, progress: null }
const SYNCING: BalanceSync = { syncing: true, progress: 0.25 }

const entry = (token: string, atomic: bigint, readAt = START - 1, scope = SCOPE): BalanceEntry => ({
  scope,
  token,
  atomic,
  readAt,
  updatedAt: readAt,
})

const wallet = (active: string | null, tokens = [MAIN]): WalletTokens => ({
  scope: SCOPE,
  tokens,
  active,
})

const view = (entries: BalanceEntry[], w: WalletTokens | null, sync = SETTLED) =>
  selectBalanceView({ hydrated: true, entries }, w, sync, START)

const live = (atomic: bigint, over: Partial<BalanceView> = {}): BalanceView => ({
  main: { atomic },
  live: true,
  known: true,
  syncing: false,
  progress: null,
  readAt: START,
  ...over,
})

describe("selectBalanceView", () => {
  // live: read this session; main: a wallet-token figure above zero
  it.each([
    { live: false, syncing: false, main: false, known: false },
    { live: false, syncing: false, main: true, known: true },
    { live: false, syncing: true, main: false, known: false },
    { live: false, syncing: true, main: true, known: false },
    { live: true, syncing: false, main: false, known: true },
    { live: true, syncing: false, main: true, known: true },
    { live: true, syncing: true, main: false, known: true },
    { live: true, syncing: true, main: true, known: true },
  ])("known when live=$live syncing=$syncing main=$main: $known", (row) => {
    const readAt = row.live ? START : START - 1
    const v = view(
      [entry(MAIN, row.main ? 5n : 0n, readAt)],
      wallet(MAIN),
      row.syncing ? SYNCING : SETTLED,
    )
    expect(v.live).toBe(row.live)
    expect(v.main !== null).toBe(row.main)
    expect(v.known).toBe(row.known)
  })

  it("passes the boot sync's progress through", () => {
    expect(view([], wallet(MAIN), SYNCING)).toMatchObject({ syncing: true, progress: 0.25 })
  })

  it("reads Main at the active address, case-insensitively, beside a row of the same token", () => {
    const v = view([entry(MAIN, 7n), entry(OLD, 9n)], wallet(MAIN.toUpperCase(), [OLD, MAIN]))
    expect(v.main).toEqual({ atomic: 7n })
  })

  it("takes a lone cached row before the address resolves", () => {
    expect(view([entry(MAIN, 7n), entry(OLD, 0n)], wallet(null, [OLD, MAIN])).main?.atomic).toBe(7n)
  })

  it("holds Savings' shares out of the candidates: they have no token row", () => {
    expect(view([entry(MAIN, 7n), entry(SHARES, 3n)], wallet(null)).main?.atomic).toBe(7n)
  })

  it("guesses nothing when two cached rows hold funds and no address is known", () => {
    expect(view([entry(MAIN, 7n), entry(OLD, 9n)], wallet(null, [OLD, MAIN])).main).toBeNull()
  })

  it("ignores another scope and keeps a fresh install unknown", () => {
    const other = view([entry(MAIN, 7n, START, "testnet:0xacct")], wallet(MAIN))
    expect(other).toMatchObject({ main: null, live: false, known: false })
    expect(view([], null)).toMatchObject({ main: null, live: false, known: false })
  })

  it("is not live while neither the token nor a token row names Main", () => {
    expect(view([entry(MAIN, 7n, START)], wallet(null, [])).live).toBe(false)
  })

  it("reports when Main's balance was read, zero balances included", () => {
    expect(view([entry(MAIN, 0n, 42)], wallet(MAIN)).readAt).toBe(42)
    expect(view([entry(MAIN, 0n, 42)], wallet(null)).readAt).toBeUndefined()
  })

  it("is live by when the read was written, and dated by when it resolved", () => {
    const v = view([{ ...entry(MAIN, 7n, START - 5), updatedAt: START }], wallet(MAIN))
    expect(v).toMatchObject({ live: true, readAt: START - 5 })
  })

  it("shows nothing before the records are read", () => {
    const records: BalanceRecords = { hydrated: false, entries: [entry(MAIN, 7n)] }
    expect(selectBalanceView(records, wallet(MAIN), SETTLED, START).main).toBeNull()
  })
})

describe("exceedsBalance", () => {
  it("compares atomic units exactly against a live balance", () => {
    const balance = 2n * 10n ** 18n - 1n
    expect(exceedsBalance(live(balance), 2n * 10n ** 18n)).toBe(true)
    expect(exceedsBalance(live(balance), balance)).toBe(false)
    expect(exceedsBalance(live(0n, { main: null }), 1n)).toBe(true)
    expect(exceedsBalance(live(balance), undefined)).toBe(false)
  })

  it("never trusts a cached figure", () => {
    expect(exceedsBalance(live(0n, { live: false }), 10n)).toBe(false)
  })
})

describe("selectHomeMain", () => {
  const open = { checked: true, held: false }
  const args = { arriving: 3n, lock: open, upgradesLoaded: true }

  it("adds funds on their way to Main's balance", () => {
    expect(selectHomeMain(live(10n), args)).toEqual({ shown: 13n, known: true })
    expect(selectHomeMain(live(0n, { main: null }), args).shown).toBe(3n)
  })

  it("shows what a held upgrade will land, known once the lock is read", () => {
    const lock = { checked: true, held: true, main: 99n }
    expect(selectHomeMain(live(10n, { known: false }), { ...args, lock })).toEqual({
      shown: 99n,
      known: true,
    })
  })

  it.each([{ lock: { checked: false, held: false } }, { upgradesLoaded: false }])(
    "waits on %o",
    (over) => {
      expect(selectHomeMain(live(10n), { ...args, ...over }).known).toBe(false)
    },
  )

  it("does not wait on the old versions' reads", () => {
    expect(selectHomeMain(live(10n, { syncing: true }), args)).toEqual({ shown: 13n, known: true })
  })
})

const ACCOUNT = {
  name: "Account 1",
  completeAddress: "0xacct",
  signKeyConfig: { type: AUTH_TYPE.WEB_AUTHN, webauthnData: { credentialId: "c", pubkey: "p" } },
}
const ROW = { address: MAIN, name: "Main", symbol: WALLET_TOKEN_SYMBOL, decimals: 18 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createBalances", () => {
  /** Seeds through other instances, so the stores under test must read what is stored. */
  async function setup(
    seed: { account?: boolean; row?: boolean; symbol?: string; active?: string | null } = {},
  ) {
    const adapter = new InMemoryStorageAdapter()
    if (seed.account ?? true) await new AccountStorage(adapter).setAccount(ACCOUNT)
    if (seed.row ?? true)
      await new TokenStorage(adapter).addToken({ ...ROW, symbol: seed.symbol ?? ROW.symbol })
    const storage = new BalanceStorage(adapter)
    const accounts = new AccountStorage(adapter)
    const tokens = new TokenStorage(adapter)
    const sync = memoryStore<BalanceSync>(SETTLED)
    const active = memoryStore<string | null>(seed.active === undefined ? MAIN : seed.active)
    // Writes stamp the wall clock, long after this session start.
    const balances = createBalances(
      storage,
      {
        network: "sandbox",
        account: accounts.current,
        tokens: tokens.rows,
        activeToken: active,
      },
      sync.readonly,
      () => START,
    )
    const stop = balances.view.subscribe(() => {})
    await storage.load()
    await settle()
    return { storage, accounts, tokens, active, sync, balances, stop }
  }

  it("hydrates from storage and mirrors every write as a live read", async () => {
    const { storage, balances } = await setup()
    expect(balances.records.get().hydrated).toBe(true)
    expect(balances.view.get()).toMatchObject({ main: null, live: false, known: false })
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({ main: { atomic: 5n }, live: true, known: true })
    expect(selectEntry(balances.records.get(), SCOPE, MAIN)).toMatchObject({
      atomic: 5n,
      anchor: 10,
    })
  })

  it("dates a stored read by when it resolved", async () => {
    const { storage, balances } = await setup()
    await storage.updateBalance(SCOPE, MAIN, 5n, 10, { readAt: 7 })
    expect(balances.view.get()).toMatchObject({ live: true, readAt: 7 })
  })

  it("names Main when the token row is saved after the first balance read", async () => {
    const { storage, tokens, balances } = await setup({ row: false, active: null })
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({ main: null, known: false })
    await tokens.addToken(ROW)
    await settle()
    expect(balances.view.get()).toMatchObject({ main: { atomic: 5n }, live: true, known: true })
  })

  it("names Main's row by the active address, whatever its symbol", async () => {
    const { storage, balances } = await setup({ symbol: "USDC" })
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({ main: { atomic: 5n }, live: true, known: true })
  })

  it("names Main by the token's address, with no row stored", async () => {
    const { storage, active, balances } = await setup({ row: false, active: null })
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({ main: null, known: false })
    active.set(MAIN)
    expect(balances.view.get()).toMatchObject({ main: { atomic: 5n }, live: true, known: true })
  })

  it("resolves when the account is stored after the first balance read", async () => {
    const { storage, accounts, balances } = await setup({ account: false })
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get()).toMatchObject({ main: null, known: false })
    await accounts.setAccount(ACCOUNT)
    await settle()
    expect(balances.view.get()).toMatchObject({ main: { atomic: 5n }, known: true })
  })

  it("follows a balance record change after hydration", async () => {
    const { storage, balances } = await setup()
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    await storage.updateBalance(SCOPE, MAIN, 7n, 11)
    expect(balances.view.get().main?.atomic).toBe(7n)
  })

  it("never lets a read at an older anchor replace a newer one", async () => {
    const { storage, balances } = await setup()
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    expect(await storage.updateBalance(SCOPE, MAIN, 4n, 9)).toBe(false)
    expect(balances.view.get().main?.atomic).toBe(5n)
    await storage.updateBalance(SCOPE, MAIN, 6n, 11)
    expect(balances.view.get().main?.atomic).toBe(6n)
  })

  it("joins the boot sync, so a cached figure waits while it runs", async () => {
    const { storage, accounts, tokens, active, sync } = await setup()
    await storage.updateBalance(SCOPE, MAIN, 5n, 1)
    const cached = createBalances(
      storage,
      {
        network: "sandbox",
        account: accounts.current,
        tokens: tokens.rows,
        activeToken: active,
      },
      sync.readonly,
      () => Date.now() + 60_000,
    )
    cached.view.subscribe(() => {})
    await storage.load()
    expect(cached.view.get()).toMatchObject({ main: { atomic: 5n }, live: false, known: true })
    sync.set(SYNCING)
    expect(cached.view.get()).toMatchObject({ known: false, syncing: true, progress: 0.25 })
  })

  it("stops mirroring once nothing watches", async () => {
    const { storage, balances, stop } = await setup()
    stop()
    await storage.updateBalance(SCOPE, MAIN, 5n, 10)
    expect(balances.view.get().main).toBeNull()
  })
})
