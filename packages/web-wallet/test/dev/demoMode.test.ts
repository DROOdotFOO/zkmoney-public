/**
 * Demo mode: the activation flag, the records the seeded stores hold, and the two collaborators that
 * stand in for an L1 (the injected wallet and the RPC behind it). What the fixtures are asserted
 * against are the predicates that decide a record's state and affordances — a scenario that stops
 * covering a state fails here. How that state draws is covered over constructed records, not
 * through the fixtures.
 *
 * Each test re-imports the module graph: the front-core stores are singletons that cache their
 * loaded records, so two scenarios in one graph would see each other's rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PaylinkTransaction } from "@obsidion/front-core"
import type { Hex } from "viem"
import { DEMO_ROLLUP, setActiveRollup } from "../../src/platform/storage/rollupStorage"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../fixtures/sandboxProfile"
import { testWalletDbs } from "../support/fakeWalletDb"

// Every test, and the hook closing its session, re-imports the aztec + front-core graph; the first
// one pays the cold transform.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const originalFetch = globalThis.fetch

// viem's HTTP transport cannot run under jsdom; the app's L1 reads go through `fetch`, which the
// demo's RPC stub answers.
vi.mock("../../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env")>()
  const { custom } = await import("viem")
  return {
    ...actual,
    l1Transport: (config: { l1RpcUrl: string }) =>
      custom({
        request: async ({ method, params }) => {
          const response = await fetch(config.l1RpcUrl, {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
          const { result, error } = await response.json()
          if (error) throw new Error(error.message)
          return result
        },
      }),
  }
})

/** The injected provider, un-narrowed: these tests probe methods viem's union doesn't model. */
const injected = () =>
  window.ethereum as unknown as {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  }

/**
 * The wallet boots from a config profile and `seedDemo` reads `getConfig()`, so the module graph
 * needs a resolved boot before seeding — main.tsx establishes the same precondition from the same
 * in-process demo profile. One boot per fresh graph (`vi.resetModules` wipes the seeded config with
 * the graph). The empty base env stands in for a shell with no profile pair.
 */
async function bootConfig() {
  const { resolveBootConfig } = await import("../../src/config/env")
  const { demoBootInput } = await import("../../src/dev/demoProfile")
  await resolveBootConfig(demoBootInput({}))
}

async function seed(scenario: string): Promise<boolean> {
  await bootConfig()
  const { seedDemo } = await import("../../src/dev/seedDemo")
  return seedDemo(scenario as never)
}

/** Move the wall clock the fake L1 ages its transactions and its head against. */
function travel(ms: number) {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + ms)
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  // The partition outlives the module graph; each test starts on the real one, as a fresh page does.
  setActiveRollup(sandboxProfile().shared.rollupVersion)
  window.history.replaceState({}, "", "/")
  vi.spyOn(console, "info").mockImplementation(() => {})
})

/** The open session's withdrawals, once its migration is saved. */
async function withdrawalStore() {
  const store = (await import("../../src/platform/session")).session().withdrawals
  await store.ready
  return store
}

afterEach(async () => {
  ;(await import("../../src/platform/session")).closeSession()
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("demo flag", () => {
  const flag = () => import("../../src/dev/demoFlag")

  it("activates on ?demo=<scenario>", async () => {
    window.history.replaceState({}, "", "/?demo=activity")
    const { demoScenario, isDemoMode } = await flag()
    expect(demoScenario()).toBe("activity")
    expect(isDemoMode()).toBe(true)
  })

  it("picks the flagship scenario for a bare ?demo", async () => {
    window.history.replaceState({}, "", "/?demo")
    expect((await flag()).demoScenario()).toBe("recovery")
  })

  it("boots the real app on an unknown scenario", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    window.history.replaceState({}, "", "/?demo=nope")
    expect((await flag()).isDemoMode()).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it("stays on after in-app navigation drops the query string", async () => {
    window.history.replaceState({}, "", "/?demo=recovery")
    const { demoScenario } = await flag()
    expect(demoScenario()).toBe("recovery")
    window.history.replaceState({}, "", "/activity")
    expect(demoScenario()).toBe("recovery")
  })

  it("survives a reload of a route that carries no query string", async () => {
    window.history.replaceState({}, "", "/?demo=activity")
    expect((await flag()).demoScenario()).toBe("activity")
    vi.resetModules()
    window.history.replaceState({}, "", "/activity")
    expect((await flag()).demoScenario()).toBe("activity")
  })

  it("clears on ?demo=off", async () => {
    window.history.replaceState({}, "", "/?demo=recovery")
    expect((await flag()).demoScenario()).toBe("recovery")
    vi.resetModules()
    window.history.replaceState({}, "", "/?demo=off")
    expect((await flag()).demoScenario()).toBe(null)
  })
})

describe("explorer links", () => {
  const l1TxUrl = async () => (await import("../../src/ui/detailRows")).l1TxUrl

  it("links L1 hashes in demo mode, where the chain carries no explorer", async () => {
    window.history.replaceState({}, "", "/?demo=activity")
    await bootConfig()
    expect((await l1TxUrl())("0xabc")).toBe("https://sepolia.etherscan.io/tx/0xabc")
  })

  it("leaves the hash bare off demo when the chain carries no explorer", async () => {
    await bootConfig()
    const { getConfig } = await import("../../src/config/env")
    expect(getConfig().l1Chain.blockExplorers).toBeUndefined()
    expect((await l1TxUrl())("0xabc")).toBeUndefined()
  })

  it("links L2 hashes in demo mode at the local node", async () => {
    window.history.replaceState({}, "", "/?demo=activity")
    await bootConfig()
    const { l2TxUrl } = await import("../../src/lib/explorer")
    const { getConfig } = await import("../../src/config/env")
    const config = getConfig()
    expect(l2TxUrl(config.network, config.nodeUrl, "0xabc")).toContain("/tx-effects/0xabc")
  })
})

describe("seeded session", () => {
  it("keeps onboarding identity-free without replacing the provider", async () => {
    const provider = { request: vi.fn() }
    const originalProvider = Object.getOwnPropertyDescriptor(window, "ethereum")
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true })
    try {
      const fetchBefore = vi.fn(async () => new Response("{}"))
      globalThis.fetch = fetchBefore
      window.history.replaceState({}, "", "/?demo=onboarding")
      await seed("onboarding")
      const { loadWalletIdentity } = await import("../../src/features/identity/walletIdentity")
      const { getOxideTuple } = await import("../../src/config/oxideTuple")
      const { loadDepositTokens } = await import("../../src/features/deposit/loadDepositFacts")
      const { getConfig } = await import("../../src/config/env")
      const { DEMO_OXIDE_TUPLE } = await import("../../src/dev/demoFixtures")
      expect(loadWalletIdentity()).toBeNull()
      expect(window.ethereum).toBe(provider)
      expect(await getOxideTuple(getConfig())).toEqual(DEMO_OXIDE_TUPLE)
      // Only the L1 endpoint is answered locally, so the token lists read the table.
      expect((await loadDepositTokens(getConfig())).options.map((t) => t.symbol)).toEqual([
        "DAI",
        "USDC",
        "USDT",
      ])
      expect(fetchBefore).not.toHaveBeenCalled()
      await fetch("https://elsewhere.invalid/")
      expect(fetchBefore).toHaveBeenCalledWith("https://elsewhere.invalid/", undefined)
      expect(provider.request).not.toHaveBeenCalled()
    } finally {
      if (originalProvider) Object.defineProperty(window, "ethereum", originalProvider)
      else delete window.ethereum
    }
  })

  it.each(["recovery", "activity", "fresh", "empty"])(
    "opens the wallet route gate for the %s scenario",
    async (scenario) => {
      await seed(scenario)
      const { loadOnboardedIdentity } = await import("../../src/features/identity/walletIdentity")
      const { getAuthService } = await import("../../src/platform/auth/useAuthenticator")
      expect(loadOnboardedIdentity()?.handle).toBe("demo")
      expect(getAuthService().isUnlocked()).toBe(true)
    },
  )

  it("prints a help block covering every query demo mode understands", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    await seed("fresh")
    const { DEMO_SCENARIOS } = await import("../../src/dev/demoFlag")
    const help = info.mock.calls
      .map(([line]) => String(line))
      .find((l) => l.includes("URL queries"))!

    expect(help).toBeDefined()
    // Derived, so a scenario added without a help line fails here rather than going undocumented.
    for (const scenario of DEMO_SCENARIOS) expect(help).toContain(`?demo=${scenario}`)
    expect(help).toContain("?demo=off")
    expect(help).toContain("sessionStorage")
    // No scenario reaches the console unlabelled.
    expect(help).not.toContain("(no description)")
  })

  it("seeds the token + balance pair the home figure hydrates from", async () => {
    await seed("fresh")
    const { BalanceStorage, TokenStorage } = await import("@obsidion/front-core")
    const { DEMO_BALANCE_RAW, DEMO_COMPLETE_ADDRESS, DEMO_L2_TOKEN } = await import(
      "../../src/dev/demoFixtures"
    )
    const { getConfig } = await import("../../src/config/env")
    expect(await TokenStorage.get().getTokens()).toEqual([
      { address: DEMO_L2_TOKEN, name: "DAI", symbol: "DAI", decimals: 18 },
    ])
    const scope = `${getConfig().network}:${DEMO_COMPLETE_ADDRESS}`
    expect(await BalanceStorage.get().getBalance(scope, DEMO_L2_TOKEN)).toBe(DEMO_BALANCE_RAW)
  })

  it("seeds the empty scenario with a known zero balance and no transactions", async () => {
    await seed("empty")
    const { BalanceStorage } = await import("@obsidion/front-core")
    const { DEMO_COMPLETE_ADDRESS, DEMO_L2_TOKEN } = await import("../../src/dev/demoFixtures")
    const { getConfig } = await import("../../src/config/env")
    const scope = `${getConfig().network}:${DEMO_COMPLETE_ADDRESS}`
    expect(await BalanceStorage.get().getBalance(scope, DEMO_L2_TOKEN)).toBe(0n)
    expect((await (await import("../../src/platform/session")).session().activity.all())).toEqual([])
  })

  it("leaves the fresh scenario with nothing in the feed", async () => {
    await seed("fresh")
    const { SIPADepositStore } = await import("@obsidion/front-core")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const adapter = new WebStorageAdapter()
    await SIPADepositStore.get(adapter).load()
    expect(SIPADepositStore.get().list()).toEqual([])
    expect((await withdrawalStore()).list.get().records).toEqual([])
    expect((await (await import("../../src/platform/session")).session().activity.all())).toEqual([])
  })
})

describe("existing wallet guard", () => {
  it("refuses to seed over an identity already in the demo partition and boots the real app", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    window.history.replaceState({}, "", "/?demo=recovery")
    const { isDemoMode, demoScenario } = await import("../../src/dev/demoFlag")
    expect(demoScenario()).toBe("recovery")

    setActiveRollup(DEMO_ROLLUP)
    await openWalletStore(DEMO_ROLLUP, { persistent: false })
    const { saveWalletIdentity, loadWalletIdentity } = await import(
      "../../src/features/identity/walletIdentity"
    )
    saveWalletIdentity({ handle: "alice", address: `0x${"a1".repeat(32)}`, claimedAt: 1 })
    localStorage.setItem("obsidion.marker", "untouched")

    expect(await seed("recovery")).toBe(false)

    expect(error).toHaveBeenCalledWith(expect.stringContaining("refusing to seed"))
    expect(loadWalletIdentity()?.handle).toBe("alice")
    expect(localStorage.getItem("obsidion.marker")).toBe("untouched")
    expect(isDemoMode()).toBe(false)
    expect(sessionStorage.getItem("webwallet.demo")).toBe(null)
  })

  it("seeds beside a real rollup's identity without reading or touching it", async () => {
    window.history.replaceState({}, "", "/?demo=recovery")
    const rollup = sandboxProfile().shared.rollupVersion
    await closeWalletStore()
    await openWalletStore(rollup, { persistent: true })
    const { saveWalletIdentity } = await import("../../src/features/identity/walletIdentity")
    saveWalletIdentity({ handle: "alice", address: `0x${"a1".repeat(32)}`, claimedAt: 1 })
    await walletStorage.flush()
    const real = testWalletDbs().db(rollup).state.get("webwallet.identity")
    expect(real).toBeDefined()

    expect(await seed("recovery")).toBe(true)

    expect(testWalletDbs().db(rollup).state.get("webwallet.identity")).toBe(real)
    const { loadWalletIdentity } = await import("../../src/features/identity/walletIdentity")
    expect(loadWalletIdentity()?.handle).not.toBe("alice")
  })

  it("refuses on a passkey from an onboarding that never claimed a handle", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    window.history.replaceState({}, "", "/?demo=recovery")
    await bootConfig()
    const { isDemoMode } = await import("../../src/dev/demoFlag")
    const { WebPasskeyIdentityMap } = await import("../../src/platform/auth/WebPasskeyIdentityMap")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const { getConfig } = await import("../../src/config/env")
    // Half-onboarded: the passkey exists and holds the account key, the handle never landed. The
    // identity record alone would read this origin as empty and seed over a real wallet's key.
    await new WebPasskeyIdentityMap(new WebStorageAdapter(), getConfig().rpId).upsert({
      credentialId: "alice-credential",
      l2Address: `0x${"a1".repeat(32)}`,
      pubkey: "ff".repeat(64),
      isMskRoot: true,
    })
    localStorage.setItem("obsidion.marker", "untouched")

    expect(await seed("recovery")).toBe(false)

    expect(error).toHaveBeenCalledWith(expect.stringContaining("refusing to seed"))
    expect(localStorage.getItem("obsidion.marker")).toBe("untouched")
    expect(isDemoMode()).toBe(false)
  })

  it("reseeds over its own identity from a prior visit", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await seed("fresh")).toBe(true)
    vi.resetModules()
    await seed("recovery")
    const { loadOnboardedIdentity } = await import("../../src/features/identity/walletIdentity")
    expect(loadOnboardedIdentity()?.handle).toBe("demo")
    expect(error).not.toHaveBeenCalled()
  })
})

describe("recovery scenario", () => {
  /** Fixture order — the seeds sort the same way the addresses do. */
  const bySeed = <T>(records: { sipaAddress: string }[], read: (r: never) => T): T[] =>
    records
      .slice()
      .sort((a, b) => a.sipaAddress.localeCompare(b.sipaAddress))
      .map((r) => read(r as never))

  it("covers every branch of the recovery affordance", async () => {
    await seed("recovery")
    const { SIPADepositStore } = await import("@obsidion/front-core")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const { recoveryReasonFor } = await import("@obsidion/front-core")
    await SIPADepositStore.get(new WebStorageAdapter()).load()
    const records = SIPADepositStore.get().list()
    expect(records).toHaveLength(7)
    // d1 under the fee floor, d2 stuck, d3 too young, d4 recovered, d5 claimed, d7 has a self-sweep
    // already in flight, d8 is over the per-transaction cap.
    expect(bySeed(records, (r) => recoveryReasonFor(r, Date.now()))).toEqual([
      "unsweepable",
      "stuck",
      null,
      null,
      null,
      null,
      "unsweepable",
    ])
  })

  it("stamps the fee on every funded deposit, as the sync writes it", async () => {
    await seed("recovery")
    const { SIPADepositStore, depositAmounts } = await import("@obsidion/front-core")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const { DEMO_DEPOSIT_FEE } = await import("../../src/dev/fakeL1Rpc")
    await SIPADepositStore.get(new WebStorageAdapter()).load()
    // The gross amount and the fee are written together the moment the funding read lands, so a
    // funded record carrying only one of them is a shape the sync cannot produce.
    const funded = SIPADepositStore.get()
      .list()
      .filter((r) => Number(r.amount) > 0)
    expect(funded.length).toBeGreaterThan(0)
    expect(funded.every((r) => r.fee === DEMO_DEPOSIT_FEE.toString())).toBe(true)
    expect(funded.every((r) => depositAmounts(r).feeAtomic === DEMO_DEPOSIT_FEE)).toBe(true)
  })

  it("offers the self-sweep exactly where the sweep can still land", async () => {
    await seed("recovery")
    const { SIPADepositStore } = await import("@obsidion/front-core")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const { canSelfSweep } = await import("@obsidion/front-core")
    await SIPADepositStore.get(new WebStorageAdapter()).load()
    // Only d2: d1/d8 are unsweepable, d3 is young, d4/d5 are settled, d7 is submitted.
    expect(bySeed(SIPADepositStore.get().list(), (r) => canSelfSweep(r, Date.now()))).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ])
  })

  it("carries the manifest surface the sweep binds its CREATE2 args to", async () => {
    await seed("recovery")
    const { getConfig } = await import("../../src/config/env")
    const { getOxideTuple } = await import("../../src/config/oxideTuple")
    const { sweepManifestFrom } = await import("../../src/features/deposit/sipaSweep")
    const tuple = await getOxideTuple(getConfig())
    // Thin fixtures would fail here, naming the field — not at the wallet prompt.
    expect(sweepManifestFrom(tuple).sipaFactory).toBe(tuple.sipaFactory)
  })

  it("derives each recovery address from the record's own secret", async () => {
    await seed("recovery")
    const { Fr } = await import("@aztec-labs/aztec.js/fields")
    const { deriveRecoveryAddress } = await import("@obsidion/sdk")
    const { SIPADepositStore } = await import("@obsidion/front-core")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const { demoStealthKey } = await import("../../src/dev/demoFixtures")
    await SIPADepositStore.get(new WebStorageAdapter()).load()

    const records = SIPADepositStore.get().list()
    // Discovery derives the secret and the address together, so every record carries both.
    expect(records.every((record) => record.messageSecret)).toBe(true)
    for (const record of records) {
      // The equality runSipaRecovery fails closed on before it ever asks for a signature.
      const derived = deriveRecoveryAddress(
        demoStealthKey().publicKey,
        Fr.fromHexString(record.messageSecret),
      )
      expect(derived.toString()).toBe(record.recoveryAddress.toLowerCase())
    }
  })

  it("routes recovery through the injected wallet rather than the desktop bridge", async () => {
    await seed("recovery")
    const { isDesktopL1SubmitActive } = await import("../../src/platform/desktopBridge")
    expect(isDesktopL1SubmitActive()).toBe(false)
  })
})

describe("activity scenario", () => {
  it("seeds a mixed feed across every source the activity list reads", async () => {
    await seed("activity")
    const { ContactStorage, SIPADepositStore, SEND_SUBMIT_TIMEOUT_MS } = await import(
      "@obsidion/front-core"
    )
    const { session } = await import("../../src/platform/session")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const adapter = new WebStorageAdapter()
    await SIPADepositStore.get(adapter).load()

    const transactions = (await session().activity.all())
    expect(transactions.map((tx) => tx.status)).toContain("pending")
    expect(transactions.map((tx) => tx.status)).toContain("failed")
    // One pre-submit send is two hours old: the load-time sweep fails it and leaves the live one.
    const failed = await session().activity.failInterrupted(Date.now(), SEND_SUBMIT_TIMEOUT_MS)
    expect(failed.map((tx) => tx.operationId)).toEqual(["demo-send-interrupted"])
    const { walletStorage } = await import("../../src/platform/storage/walletStorage")
    await walletStorage.flush()
    expect(
      (await session().activity.all()).filter(
        (tx) => tx.status === "pending" && !tx.txHash,
      ),
    ).toHaveLength(1)
    expect((await withdrawalStore()).list.get().records.length).toBeGreaterThan(0)
    expect(SIPADepositStore.get().list().length).toBeGreaterThan(0)
    expect(await ContactStorage.get(adapter).getEntries()).toHaveLength(6)

    const requests = session().requests.view.get()
    expect(
      new Set(
        requests.filter((r) => r.status === "pending").map((r) => `${r.direction}:${r.kind}`),
      ),
    ).toEqual(new Set(["incoming:contact", "outgoing:contact", "outgoing:link"]))
    // Settled requests (fulfilled + declined), which the pending filter drops from the list.
    expect(requests.filter((r) => r.status !== "pending")).toHaveLength(2)
    // The announce carries the token trio and the network with every row, so no row lacks them.
    const { getConfig } = await import("../../src/config/env")
    for (const request of requests) {
      expect(request.networkId).toBe(getConfig().network)
      expect(request.tokenDecimals).toBe(18)
      expect(BigInt(request.amountAtomic!)).toBe(BigInt(request.amount) * 10n ** 18n)
    }
  })

  it("writes a sender tag, never an address, on every receive", async () => {
    await seed("activity")
    const { validateAddress } = await import("@obsidion/front-core")
    const rows = (await (await import("../../src/platform/session")).session().activity.all()).filter(
      (tx) => tx.action === "receive",
    ) as { from?: string; senderL2Address?: string }[]

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // The receiver resolves a display name and persists that; the proven sender rides along
      // separately. An address in `from` would draw as "Unknown sender".
      expect(validateAddress(row.from!)).toBe(false)
      expect(row.senderL2Address).toMatch(/^0x[0-9a-f]{64}$/)
    }
    // Including the one whose sender is a stranger to this device's contacts, whose address would
    // otherwise parse — the row draws the tag, not the "Unknown sender" fallback.
    const { STRANGER_ADDRESS, STRANGER_TAG } = await import("../../src/dev/demoFixtures")
    const stranger = rows.find((row) => row.senderL2Address === STRANGER_ADDRESS)!
    expect(validateAddress(STRANGER_ADDRESS)).toBe(true)
    expect(stranger.from).toBe(STRANGER_TAG)
  })

  it("seeds a creator link row for every recovery the detail modal can offer", async () => {
    await seed("activity")
    const { paylinkStatusFor } = await import("@obsidion/front-core")
    const { creatorLinkAction } = await import("@obsidion/front-core")
    const { DEMO_L2_ADDRESS } = await import("../../src/dev/demoFixtures")

    const rows = (await (await import("../../src/platform/session")).session().activity.all()).filter(
      (tx) => tx.action === "Pay To Email",
    ) as PaylinkTransaction[]
    const nowSec = Math.floor(Date.now() / 1000)
    const offered = rows.map((row) =>
      creatorLinkAction(row, {
        nowSec,
        liveStatus: paylinkStatusFor(row, nowSec),
        account: DEMO_L2_ADDRESS,
      }),
    )
    // Cancel inside the window, Reclaim past it for both flavors, and the two settled rows offer
    // neither.
    expect(offered.filter((a) => a === "cancel")).toHaveLength(1)
    expect(offered.filter((a) => a === "reclaim")).toHaveLength(2)
    expect(
      rows
        .filter((_, i) => offered[i] === "reclaim")
        .map((r) => r.flavor)
        .sort(),
    ).toEqual(["direct", "email"])
    expect(offered.filter((a) => a === null)).toHaveLength(2)
    // The two that offer nothing are settled rather than merely outside a window.
    expect(rows.filter((r) => r.isClaimed)).toHaveLength(1)
    expect(rows.filter((r) => r.isRefunded)).toHaveLength(1)
    // Settling scrubs the claim URL off the creator's row; a live one still carries it.
    expect(rows.filter((r) => r.paylink)).toHaveLength(3)
    expect(rows.every((r) => (r.isClaimed || r.isRefunded ? !r.paylink : !!r.paylink))).toBe(true)
    // Every status pill the modal can draw over a creator row, bar the migration-only one.
    expect(new Set(rows.map((r) => paylinkStatusFor(r, nowSec)))).toEqual(
      new Set(["awaitingClaim", "expired", "claimed", "refunded"]),
    )
  })

  it("seeds a deposit for every phase and exit affordance the feed can show", async () => {
    await seed("activity")
    const { SIPADepositStore, depositAmounts, isSettledSipaPhase, isUnfundedSipaDeposit } =
      await import("@obsidion/front-core")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const { recoveryReasonFor } = await import("@obsidion/front-core")
    const { canSelfSweep } = await import("@obsidion/front-core")
    const { DEMO_TX_AMOUNT_CAP } = await import("../../src/dev/fakeL1Rpc")
    await SIPADepositStore.get(new WebStorageAdapter()).load()
    const records = SIPADepositStore.get().list()

    // The published-but-never-paid address is the one record the feed drops.
    const visible = records.filter((r) => !isUnfundedSipaDeposit(r))
    expect(records.length - visible.length).toBe(1)
    // `failed` (a reverted funding tx) is never written on web, so the feed never draws it.
    expect(new Set(visible.map((r) => r.phase))).toEqual(
      new Set(["claimed", "pendingClaim", "sweeping", "recoverable", "recovered"]),
    )
    // One row per exit affordance: the stuck sweep offers both exits, each unsweepable deposit
    // recovery alone — and the two of those sit at opposite ends of the sweep window.
    expect(visible.filter((r) => canSelfSweep(r, Date.now()))).toHaveLength(1)
    expect(visible.filter((r) => recoveryReasonFor(r, Date.now()) === "stuck")).toHaveLength(1)
    const unsweepable = visible
      .filter((r) => recoveryReasonFor(r, Date.now()) === "unsweepable")
      .map((r) => depositAmounts(r))
    expect(unsweepable.filter((a) => a.grossAtomic <= a.feeAtomic)).toHaveLength(1)
    // The cap meets the amount the pool would forward, so the fee comes off before the comparison.
    const overCap = unsweepable.filter((a) => a.grossAtomic - a.feeAtomic > DEMO_TX_AMOUNT_CAP)
    expect(overCap).toHaveLength(1)
    // The over-cap deposit's net is nonzero — the one record carrying a net it will never be paid.
    expect(overCap[0].netAtomic).toBeGreaterThan(0n)
    // Settled with no exit left to offer.
    const recovered = visible.find((r) => r.phase === "recovered")!
    expect(isSettledSipaPhase(recovered.phase)).toBe(true)
    expect(recoveryReasonFor(recovered, Date.now())).toBeNull()
    // Unsettled, and still no exit: the sweep has landed, so there is nothing left to push or pull.
    const pending = visible.find((r) => r.phase === "pendingClaim")!
    expect(isSettledSipaPhase(pending.phase)).toBe(false)
    expect(recoveryReasonFor(pending, Date.now())).toBeNull()
    expect(canSelfSweep(pending, Date.now())).toBe(false)
    // The claim scan stamps the net, the fee and the sweep's inbox index together.
    expect(depositAmounts(pending).netAtomic).toBeGreaterThan(0n)
    expect(depositAmounts(pending).grossAtomic - depositAmounts(pending).netAtomic).toBe(
      depositAmounts(pending).feeAtomic,
    )
    expect(pending.inboxIndex).toBeTruthy()
    // Every conditional row of the detail modal is on at least one record.
    expect(visible.some((r) => r.endTime)).toBe(true)
    expect(visible.some((r) => r.fundingTxHash)).toBe(true)
    expect(visible.some((r) => r.sweepTxHash)).toBe(true)
    expect(visible.some((r) => r.claimTxHash)).toBe(true)
    expect(visible.some((r) => r.recoveryTxHash)).toBe(true)
  })

  it("seeds a withdrawal for every phase the feed can show", async () => {
    await seed("activity")
    const records = (await withdrawalStore()).list.get().records

    expect(new Set(records.map((r) => r.phase))).toEqual(
      new Set(["submitting", "l2_mined", "awaiting_proven", "finalizing_l1", "done", "failed"]),
    )
    // A release the user has already submitted is a wait of its own, so the phase carries records
    // both with and without a finalization in flight.
    const finalizing = records.filter((r) => r.phase === "finalizing_l1")
    expect(finalizing.filter((r) => r.finalizeTxHash)).toHaveLength(1)
    expect(finalizing.filter((r) => !r.finalizeTxHash)).toHaveLength(2)
    expect(records.filter((r) => r.phase === "failed" && r.failure)).toHaveLength(1)
    // Two pre-mine rows: one still proving, one a closed tab left behind two hours ago.
    expect(records.filter((r) => r.phase === "submitting")).toHaveLength(2)
    // Every conditional row of the detail modal is on at least one record. `recipientAlias` is
    // absent by design: the web withdraw flow never writes it.
    expect(records.some((r) => r.endTime)).toBe(true)
    expect(records.some((r) => r.l2TxHash)).toBe(true)
    expect(records.some((r) => r.l1TxHash)).toBe(true)
    // `cancelReason` and `walletProvider` are never set on web: no cancel affordance and no
    // wallet-provider attribution on the destination.
    expect(records.some((r) => r.cancelReason || r.walletProvider)).toBe(false)
  })

  it("completes every post-mine withdrawal with what the mined event and the tracker write", async () => {
    await seed("activity")
    const { getAddress, parseUnits } = await import("viem")
    const { WITHDRAW_RELAYER_TIP } = await import("@obsidion/core/constants")
    const records = (await withdrawalStore()).list.get().records

    // The burn's gross and its relayer tip are fixed when it is built, so a pre-mine row carries
    // them too — and the detail sheet's breakdown renders on every phase.
    for (const record of records) {
      expect(record.rawAmount).toBe(parseUnits(record.amount, 18).toString())
      expect(record.relayerTip).toBe(WITHDRAW_RELAYER_TIP.toString())
    }
    const postMine = records.filter((r) => r.phase !== "submitting" && r.phase !== "failed")
    expect(postMine.length).toBeGreaterThan(0)
    for (const record of postMine) {
      // The mined event stamps the hash and the block together; one without the other is a shape no
      // writer produces.
      expect(record.l2TxHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(typeof record.blockNumber).toBe("number")
      // The tracker cannot advance past `l2_mined` without deriving the finalization key.
      if (record.phase !== "l2_mined") expect(record.withdrawalId).toMatch(/^0x[0-9a-f]{64}$/)
    }
    // Recipients are stored as the withdraw screen checksums them.
    expect(records.every((r) => r.recipient === getAddress(r.recipient))).toBe(true)
  })

  it("offers each stalled-withdrawal action exactly where it applies", async () => {
    await seed("activity")
    const { canSelfFinalizeWithdrawal, isWithdrawalDelayed } = await import("@obsidion/front-core")
    const records = (await withdrawalStore()).list.get().records

    // wdraw_demo_7 alone: proven on L2, past the delay threshold, nothing submitted for it.
    expect(records.filter((r) => canSelfFinalizeWithdrawal(r)).map((r) => r.localId)).toEqual([
      "wdraw_demo_7",
    ])
    // Check-again-only carriers: wdraw_demo_3's L2 leg is still unfinished, wdraw_demo_8 already
    // has a finalization in flight.
    expect(
      new Set(
        records
          .filter((r) => isWithdrawalDelayed(r) && !canSelfFinalizeWithdrawal(r))
          .map((r) => r.localId),
      ),
    ).toEqual(new Set(["wdraw_demo_3", "wdraw_demo_8"]))
  })

  it("fails the interrupted submission on hydration and leaves the live one proving", async () => {
    await seed("activity")
    const { WITHDRAWAL_SUBMIT_TIMEOUT_MS } = await import("@obsidion/front-core")
    const store = await withdrawalStore()

    const failed = await store.failInterrupted(Date.now(), WITHDRAWAL_SUBMIT_TIMEOUT_MS)
    expect(failed.map((r) => r.localId)).toEqual(["wdraw_demo_9"])
    expect(failed[0].failure).toEqual({ code: "withdrawal.interrupted" })
    expect((await store.get("wdraw_demo_1"))?.phase).toBe("submitting")
  })
})

describe("fake L1", () => {
  it("answers every method the recovery channel calls", async () => {
    await seed("recovery")
    const provider = injected()
    const { DEMO_L1_ACCOUNT, DEMO_RECEIPT_DELAY_MS } = await import("../../src/dev/fakeL1Rpc")
    const { getConfig } = await import("../../src/config/env")
    const chainId = getConfig().l1ChainId

    expect(await provider.request({ method: "eth_chainId" })).toBe(`0x${chainId.toString(16)}`)
    expect(await provider.request({ method: "eth_accounts" })).toEqual([DEMO_L1_ACCOUNT])
    expect(await provider.request({ method: "eth_requestAccounts" })).toEqual([DEMO_L1_ACCOUNT])
    expect(
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      }),
    ).toBe(null)
    expect(await provider.request({ method: "wallet_requestPermissions" })).toEqual([
      { parentCapability: "eth_accounts" },
    ])
    const hash = (await provider.request({ method: "eth_sendTransaction" })) as string
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
    const receipt = () =>
      provider.request({ method: "eth_getTransactionReceipt", params: [hash] }) as Promise<{
        status: string
        transactionHash: string
      } | null>
    expect(await receipt()).toBe(null)
    travel(DEMO_RECEIPT_DELAY_MS)
    expect(await receipt()).toMatchObject({ status: "0x1", transactionHash: hash })
    expect(await provider.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/)
  })

  /**
   * What makes the exits' "Waiting for Ethereum confirmation" stage visible. viem re-reads a
   * receipt only on a block number it has not seen, so the demo head has to advance too — a still
   * head leaves the flow polling forever.
   */
  it("holds a submitted transaction pending until viem polls it up", async () => {
    await seed("recovery")
    const { createPublicClient, custom } = await import("viem")
    const { DEMO_RECEIPT_DELAY_MS } = await import("../../src/dev/fakeL1Rpc")
    const client = createPublicClient({ transport: custom(window.ethereum!) })

    const hash = (await injected().request({ method: "eth_sendTransaction" })) as Hex
    const started = Date.now()
    const receipt = await client.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe("success")
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEMO_RECEIPT_DELAY_MS)
  })

  /** The deposit screens read the token's metadata off L1 before they can format a balance. */
  it("answers the deposit token's ERC-20 metadata", async () => {
    await seed("recovery")
    const { createPublicClient, custom, erc20Abi } = await import("viem")
    const { DEMO_L1_TOKEN } = await import("../../src/dev/demoFixtures")
    const { DEMO_L1_ACCOUNT, DEMO_SIPA_BALANCE } = await import("../../src/dev/fakeL1Rpc")
    const client = createPublicClient({ transport: custom(window.ethereum!) })
    const read = (functionName: "decimals" | "symbol" | "balanceOf") =>
      client.readContract({
        address: DEMO_L1_TOKEN,
        abi: erc20Abi,
        functionName,
        args: functionName === "balanceOf" ? [DEMO_L1_ACCOUNT] : [],
      } as never)

    expect(await read("decimals")).toBe(18)
    expect(await read("symbol")).toBe("DAI")
    // The bare-uint256 default still answers the balance beside them.
    expect(await read("balanceOf")).toBe(DEMO_SIPA_BALANCE)
  })

  /** Each picker token reads as itself, so a USDC row cannot show DAI's decimals, symbol or balance. */
  it("answers each picker token's own ERC-20 metadata and balance", async () => {
    window.history.replaceState({}, "", "/?demo=fresh")
    await seed("fresh")
    const { createPublicClient, custom, erc20Abi } = await import("viem")
    const { loadDepositTokens } = await import("../../src/features/deposit/loadDepositFacts")
    const { DEMO_L1_ACCOUNT, DEMO_L1_TOKENS } = await import("../../src/dev/fakeL1Rpc")
    const { getConfig } = await import("../../src/config/env")
    const client = createPublicClient({ transport: custom(window.ethereum!) })

    const picked = (await loadDepositTokens(getConfig())).options.filter((t) => t.swapped)
    expect(picked.map((t) => t.symbol)).toEqual(["USDC", "USDT"])

    for (const option of picked) {
      const address = option.address
      const read = (functionName: "decimals" | "symbol" | "balanceOf") =>
        client.readContract({
          address,
          abi: erc20Abi,
          functionName,
          args: functionName === "balanceOf" ? [DEMO_L1_ACCOUNT] : [],
        } as never)
      const expected = DEMO_L1_TOKENS[address.toLowerCase()]

      expect(await read("decimals")).toBe(option.decimals)
      expect(await read("decimals")).toBe(expected.decimals)
      expect(await read("symbol")).toBe(option.symbol)
      expect(await read("balanceOf")).toBe(expected.balance)
    }
  })

  it("answers every read behind the deposit quote, so the screen's affordances light up", async () => {
    window.history.replaceState({}, "", "/?demo=fresh")
    await seed("fresh")
    const { decodeAbiParameters, encodeFunctionData, parseAbi } = await import("viem")
    const { loadDepositTokens } = await import("../../src/features/deposit/loadDepositFacts")
    const { DEMO_DEPOSIT_FEE, DEMO_TX_AMOUNT_CAP, DEMO_TOKEN_DECIMALS } = await import(
      "../../src/dev/fakeL1Rpc"
    )
    const { DEMO_L1_TOKEN, DEMO_OXIDE_TUPLE } = await import("../../src/dev/demoFixtures")
    const { getConfig } = await import("../../src/config/env")

    const call = async (to: string, data: string) => {
      const response = await fetch(getConfig().l1RpcUrl, {
        method: "POST",
        body: JSON.stringify({ id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      })
      return (await response.json()).result as `0x${string}`
    }
    // One function per ABI, so viem picks it without being named.
    const read = async (to: string, signature: string, type: string, args: unknown[] = []) => {
      const data = encodeFunctionData({ abi: parseAbi([signature]), args } as never)
      return decodeAbiParameters([{ type }], await call(to, data))[0]
    }

    // The three the quote reads, in the order it reads them off the manifest.
    expect(await read(DEMO_L1_TOKEN, "function decimals() view returns (uint8)", "uint8")).toBe(
      DEMO_TOKEN_DECIMALS,
    )
    expect(
      await read(
        DEMO_OXIDE_TUPLE.sipaFactory!,
        "function implementationFor(uint8 intent) view returns (address)",
        "address",
        [1],
      ),
    ).not.toBe(`0x${"00".repeat(20)}`)
    const row = decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }],
      await call(
        DEMO_OXIDE_TUPLE.forwardingTable!,
        encodeFunctionData({
          abi: parseAbi([
            "function rowFor(address token, uint8 intent) view returns (address, address, uint128, uint128)",
          ]),
          args: [DEMO_L1_TOKEN, 1],
        }),
      ),
    )
    // The deposit row routes to the demo portal at the deposit fee, with no beneficiary fee.
    expect(row[0].toLowerCase()).toBe(DEMO_OXIDE_TUPLE.portal.toLowerCase())
    expect(row[2] + row[3]).toBe(DEMO_DEPOSIT_FEE)
    expect(
      await read(
        DEMO_OXIDE_TUPLE.portal!,
        "function TX_AMOUNT_CAP() view returns (uint256)",
        "uint256",
      ),
    ).toBe(DEMO_TX_AMOUNT_CAP)

    // The picker shows the mainnet tokens whatever network the demo booted on.
    expect((await loadDepositTokens(getConfig())).options.map((t) => t.symbol)).toEqual([
      "DAI",
      "USDC",
      "USDT",
    ])
  })

  it("never throws on a method it does not model", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await seed("fresh")
    expect(await injected().request({ method: "eth_unheardOf" })).toBe(null)
    expect(warn).toHaveBeenCalled()
  })

  /**
   * Exercised at the transport boundary rather than through viem: jsdom's `Request` rejects Node's
   * `AbortSignal`, so viem's HTTP transport cannot run in this environment at all.
   */
  it("answers the balance read on the app's own L1 endpoint", async () => {
    await seed("recovery")
    const { decodeAbiParameters } = await import("viem")
    const { getConfig } = await import("../../src/config/env")
    const { DEMO_SIPA_BALANCE } = await import("../../src/dev/fakeL1Rpc")

    const post = async (body: unknown) => {
      const response = await fetch(getConfig().l1RpcUrl, {
        method: "POST",
        body: JSON.stringify(body),
      })
      return response.json()
    }
    const single = await post({ id: 1, method: "eth_call", params: [{}, "latest"] })
    expect(single.id).toBe(1)
    expect(decodeAbiParameters([{ type: "uint256" }], single.result)[0]).toBe(DEMO_SIPA_BALANCE)

    // `l1Transport` batches same-tick reads into one array request.
    const batched = await post([
      { id: 7, method: "eth_call", params: [{}, "latest"] },
      { id: 8, method: "eth_chainId" },
    ])
    expect(batched.map((entry: { id: number }) => entry.id)).toEqual([7, 8])
  })

  /**
   * The self-sweep's three reads. Exercised at the transport boundary for the same reason as the
   * balance read above: viem's HTTP transport cannot run under jsdom.
   */
  it("answers the reads the self-sweep makes before it signs", async () => {
    await seed("recovery")
    const { decodeAbiParameters, encodeFunctionData, parseAbi } = await import("viem")
    const { SIPADepositStore } = await import("@obsidion/front-core")
    const { WebStorageAdapter } = await import("../../src/platform/storage/WebStorageAdapter")
    const { getConfig } = await import("../../src/config/env")
    const { DEMO_DEPOSIT_FEE, DEMO_L1_TOKEN, DEMO_SIPA_BALANCE } = await import(
      "../../src/dev/fakeL1Rpc"
    )
    await SIPADepositStore.get(new WebStorageAdapter()).load()
    const stuck = SIPADepositStore.get()
      .list()
      .find((r) => r.phase === "sweeping" && !r.sweepTxHash && r.amount === "18")!

    const call = async (data: string) => {
      const response = await fetch(getConfig().l1RpcUrl, {
        method: "POST",
        body: JSON.stringify({ id: 1, method: "eth_call", params: [{ data }, "latest"] }),
      })
      return (await response.json()).result as `0x${string}`
    }
    const uint = (hex: `0x${string}`) => decodeAbiParameters([{ type: "uint256" }], hex)[0]

    const rowAbi = parseAbi([
      "function rowFor(address token, uint8 intent) view returns (address, address, uint128, uint128)",
    ])
    const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"])
    const predictAbi = parseAbi([
      "function predictSIPA(address implementation, bytes32 intentHash, address recoveryAddress, uint256 rollupVersion, bool resweepable) view returns (address)",
    ])

    // Balance strictly above the sweep fee — the funding guard reads the deposit as sweepable.
    const [, , beneficiaryFee, sweepTip] = decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }],
      await call(encodeFunctionData({ abi: rowAbi, args: [DEMO_L1_TOKEN, 1] })),
    )
    const fee = beneficiaryFee + sweepTip
    const balance = uint(
      await call(encodeFunctionData({ abi: balanceAbi, args: [stuck.sipaAddress] })),
    )
    expect(fee).toBe(DEMO_DEPOSIT_FEE)
    expect(balance).toBe(DEMO_SIPA_BALANCE)
    expect(balance > fee).toBe(true)
    // What the chain charges is what the seeded records carry, so the Deposit screen's quote and
    // the rows can never disagree.
    expect(BigInt(stuck.fee!)).toBe(fee)

    // The SIPAFactory reproduces the fixture's own address, so the deploy guard passes.
    const predicted = await call(
      encodeFunctionData({
        abi: predictAbi,
        args: [
          "0xde9050000000000000000000000000000000117e",
          stuck.recipientHash as `0x${string}`,
          stuck.recoveryAddress as `0x${string}`,
          1n,
          true,
        ],
      }),
    )
    expect(decodeAbiParameters([{ type: "address" }], predicted)[0].toLowerCase()).toBe(
      stuck.sipaAddress,
    )

    // Counterfactual, so the sweep takes the deploy-and-sweep branch.
    const code = await fetch(getConfig().l1RpcUrl, {
      method: "POST",
      body: JSON.stringify({ id: 2, method: "eth_getCode", params: [stuck.sipaAddress, "latest"] }),
    })
    expect((await code.json()).result).toBe("0x")
  })

  it("passes every other request through to the real fetch", async () => {
    await seed("fresh")
    await expect(fetch("http://demo.invalid/elsewhere")).rejects.toThrow()
  })
})

/**
 * The one flow that cannot run for real offline: the finalization calldata comes from a node and an
 * enclave signature. The stubbed builder is the only substitution — the pre-flight read, the
 * channel, the receipt and the record patch are all the app's own path.
 */
describe("withdrawal self-finalize", () => {
  const BURN_TX = `0x${"c7".repeat(32)}` as Hex

  const wiring = async () => {
    const { resolveWithdrawalWiring } = await import("@obsidion/front-core")
    const { getOxideTuple } = await import("../../src/config/oxideTuple")
    const { getConfig } = await import("../../src/config/env")
    return resolveWithdrawalWiring(await getOxideTuple(getConfig()))
  }

  it("resolves the withdrawal rails from the fixture manifest", async () => {
    await seed("activity")
    const { DEMO_OXIDE_TUPLE } = await import("../../src/dev/demoFixtures")
    // Null here — a fixture missing a portal field — is what refuses the flow before it starts.
    expect(await wiring()).toMatchObject({
      portal: DEMO_OXIDE_TUPLE.portal,
      l2Token: DEMO_OXIDE_TUPLE.l2Token,
      plainWithdrawalExecutor: DEMO_OXIDE_TUPLE.plainWithdrawalExecutor,
    })
  })

  it("answers the pre-flight already-released read with false", async () => {
    await seed("activity")
    const { createPublicClient, custom } = await import("viem")
    const { isWithdrawalSpent } = await import("@obsidion/sdk")
    const { DEMO_OXIDE_TUPLE } = await import("../../src/dev/demoFixtures")
    const client = createPublicClient({ transport: custom(window.ethereum!) })
    // No relayer in the demo. The unknown-selector default decodes as `true`, which would abort
    // the flow as already released, so this read has to be dispatched by selector.
    expect(
      await isWithdrawalSpent(client, DEMO_OXIDE_TUPLE.portal as Hex, `0x${"c8".repeat(32)}`),
    ).toBe(false)
  })

  it("builds a submittable call with no node and no enclave", async () => {
    await seed("activity")
    const { demoFinalizationBuilder } = await import("../../src/dev/demoFinalization")
    const { DEMO_L1_FUNDER, DEMO_OXIDE_TUPLE } = await import("../../src/dev/demoFixtures")
    const portal = DEMO_OXIDE_TUPLE.portal as `0x${string}`
    const call = await demoFinalizationBuilder(portal)(BURN_TX, DEMO_L1_FUNDER)

    // The portal, where a real self-finalize submits its `withdraw` call.
    expect(call.to).toBe(portal)
    expect(call.withdrawalId).toMatch(/^0x[0-9a-f]{64}$/)
    const hash = await injected().request({
      method: "eth_sendTransaction",
      params: [{ to: call.to, data: call.data }],
    })
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("drives the delayed record to a finalization hash without advancing its phase", async () => {
    await seed("activity")
    const { getConfig } = await import("../../src/config/env")
    const { injectedWalletChannel } = await import("../../src/features/deposit/sipaRecovery")
    const { selfFinalizeWithdrawal } = await import("../../src/features/withdraw/selfFinalize")
    const { demoFinalizationBuilder } = await import("../../src/dev/demoFinalization")
    const { DEMO_OXIDE_TUPLE } = await import("../../src/dev/demoFixtures")
    const { DEMO_RECEIPT_DELAY_MS } = await import("../../src/dev/fakeL1Rpc")
    const { createPublicClient, custom } = await import("viem")

    const store = await withdrawalStore()
    const record = store.list.get().records.find((r) => r.localId === "wdraw_demo_7")!

    const stages: string[] = []
    // viem's HTTP transport cannot run under jsdom, so the receipt poll reads through the
    // injected demo wallet rather than the app's RPC.
    const base = await injectedWalletChannel(getConfig(), {
      onStage: (s) => stages.push(s),
      readClient: createPublicClient({ transport: custom(window.ethereum!) }),
    })
    const channel = {
      ...base,
      // The demo holds a receipt back so the confirming stage is seen; the test skips that wait.
      sendTransaction: async (to: `0x${string}`, data: Hex) => {
        const hash = await base.sendTransaction(to, data)
        travel(DEMO_RECEIPT_DELAY_MS)
        return hash
      },
    }

    const hash = await selfFinalizeWithdrawal(record, {
      channel,
      build: demoFinalizationBuilder(DEMO_OXIDE_TUPLE.portal as `0x${string}`),
      portal: (await wiring())!.portal,
      l1: createPublicClient({ transport: custom(window.ethereum!) }),
      store,
    })

    expect(stages).toEqual(["signing", "confirming"])
    const patched = (await store.get("wdraw_demo_7"))!
    expect(patched.finalizeTxHash).toBe(hash)
    // Only the tracker's own release read may write `done`.
    expect(patched.phase).toBe("finalizing_l1")
    // The affordance withdraws the moment the finalization is in flight.
    const { canSelfFinalizeWithdrawal } = await import("@obsidion/front-core")
    expect(canSelfFinalizeWithdrawal(patched)).toBe(false)
  })
})

describe("demo profile", () => {
  it("boots with no profile pair in the environment", async () => {
    await bootConfig()
    const { getConfig } = await import("../../src/config/env")
    expect(getConfig().l1RpcUrl).toBe("http://demo.invalid/l1")
  })

  it("boots on sandbox whatever network the shell names", async () => {
    const { resolveBootConfig, getConfig } = await import("../../src/config/env")
    const { demoBootInput } = await import("../../src/dev/demoProfile")
    await resolveBootConfig(demoBootInput({ VITE_NETWORK: "testnet" }))
    expect(getConfig().network).toBe("sandbox")
  })

  it("boots from the fixture even when the shell holds a profile pair", async () => {
    const { resolveBootConfig, getConfig } = await import("../../src/config/env")
    const { demoBootInput, DEMO_PROFILE_ID } = await import("../../src/dev/demoProfile")
    await resolveBootConfig(
      demoBootInput({
        VITE_NETWORK: "testnet",
        VITE_CONFIG_PROFILE_URL: "http://localhost:8083/profiles/sandbox.json",
        VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox",
      }),
    )
    expect(getConfig().network).toBe("sandbox")
    expect(getConfig().oxideProfile?.manifestUrl).toBe("http://demo.invalid/oxide/sandbox.json")
    expect(DEMO_PROFILE_ID).toBe("demo")
  })

  it("leaves the capture harness's own profile alone under its vite mode", async () => {
    const { demoBootInput } = await import("../../src/dev/demoProfile")
    const env = {
      MODE: "ui-capture",
      VITE_CONFIG_PROFILE_URL: "http://127.0.0.1:5499/__ui-capture/profile.json",
      VITE_CONFIG_EXPECTED_PROFILE_ID: "ui-capture",
    }
    expect(demoBootInput(env)).toEqual({ env, demoStorage: true })
  })
})
