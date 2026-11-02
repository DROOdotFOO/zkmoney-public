/**
 * A claims pass for another account of the session's MSK runs on the gateway's one chain of passes,
 * apart from the session's loop, and a deposit address's broadcast lands by its own recipient's
 * events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  OperationStore,
  SIPADepositStore,
  type SipaDepositSyncDeps,
  type SipaDepositSyncResult,
} from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  pass: vi.fn(),
  events: vi.fn(),
  sent: [] as string[],
  tuple: {
    portal: "0x00000000000000000000000000000000000000a0",
    forwardingTable: "0x00000000000000000000000000000000000000fb",
    accountFactory: "0x00000000000000000000000000000000000000af",
    l2Token: `0x${"01".repeat(32)}`,
  },
}))

vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => h.tuple,
  l1PublicClient: () => ({}),
}))
vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  syncSipaDeposits: h.pass,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  fetchSipaEvents: h.events,
  ContractService: { getInstance: () => ({}) },
}))
vi.mock("../../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({}),
  noteSubscribed: () => {},
}))
vi.mock("../../../../src/features/broadcasts/broadcastState", () => ({
  broadcastState: async () => "included",
}))

const { getSipaDepositGateway, resetSipaDepositGatewayForTests } = await import(
  "../../../../src/features/deposit/sipaGateway"
)
const { getBroadcastLedger, resetBroadcastsForTests, startBroadcasts } = await import(
  "../../../../src/features/broadcasts/broadcasts"
)
const { getActiveStorageId } = await import("../../../../src/platform/storage/activeStorage")
const { webStorage } = await import("../../../../src/platform/storage/WebStorageAdapter")

const SESSION = `0x${"0e".repeat(32)}`
const PREVIOUS = `0x${"0d".repeat(32)}`
const SALT = `0x${"5a".repeat(32)}`
const wallet = { networkId: "0xnet", node: { getBlockNumber: async () => 40 } } as never
const session = {
  account: { getAddress: () => AztecAddress.fromStringUnsafe(SESSION) },
  msk: new Fr(0x5e55n),
}
const sipa = (n: number) => `0x${(0xe00 + n).toString(16).padStart(40, "0")}` as Address

const passResult = (complete: boolean): SipaDepositSyncResult => ({
  discovered: 0,
  active: 0,
  claimed: 0,
  pendingSettlement: 0,
  recoverable: 0,
  reconciled: 0,
  failed: 0,
  complete,
})

/** A deposit record for `recipient`, its address published with `SALT`. */
const recordFor = (recipient?: string) =>
  ({
    ...(recipient ? { recipientL2Address: recipient } : {}),
    messageSecret: SALT,
    recipientHash: "0x02",
    recoveryAddress: "",
    l1ChainId: 31337,
    networkId: "0xnet",
    tokenAddress: h.tuple.portal,
    amount: "5",
    tokenSymbol: "DAI",
    startTime: 1,
  } as never)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** The gateway with its unlock, discovery, rows and prover replaced at their boundaries. */
function gateway(keys: unknown = session) {
  const gw = getSipaDepositGateway() as never as Record<string, (...args: never[]) => unknown>
  vi.spyOn(gw, "unlockedKeys").mockImplementation(async () => keys as never)
  vi.spyOn(gw, "ensureDiscovery").mockImplementation(async () => undefined as never)
  vi.spyOn(gw, "syncRows").mockImplementation(async () => [] as never)
  vi.spyOn(gw, "broadcastSipa").mockImplementation(async (...args: never[]) => {
    h.sent.push((args[4] as unknown as { address: string }).address.toLowerCase())
    return `0x${"bb".repeat(32)}` as never
  })
  const serial = vi.spyOn(gw, "serial")
  return { gw: getSipaDepositGateway(), serial }
}

const depsOf = (call: number) => h.pass.mock.calls[call]![0] as SipaDepositSyncDeps
const previous = () => AztecAddress.fromStringUnsafe(PREVIOUS)

/** A landed broadcast job for `address`, as this device holds once it published the address. */
async function landedJob(address: Address) {
  const ledger = getBroadcastLedger()
  await ledger.enqueue({
    address,
    kind: "deposit",
    scope: getActiveStorageId(),
    source: { type: "slot", cacheKey: "webwallet.sipa.address.test", day: 1, nonce: 0 },
  })
  await ledger.markLanded(address)
  return ledger
}

let stop: (() => void) | undefined

beforeEach(() => {
  localStorage.clear()
  resetSipaDepositGatewayForTests()
  resetBroadcastsForTests()
  OperationStore.reset()
  h.pass.mockReset()
  h.events.mockReset()
  h.sent.length = 0
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.restoreAllMocks()
})

describe("syncRecipient", () => {
  it("runs after the session pass already queued, for the recipient, adopting no cursor and outside the catch-up", async () => {
    const { gw, serial } = gateway()
    const sessionPass = deferred()
    h.pass.mockImplementation(async (deps: SipaDepositSyncDeps) => {
      if (deps.recipient.toString() === SESSION) await sessionPass.promise
      return passResult(true)
    })
    const tokenServiceFor = vi.fn()

    const syncing = gw.sync(wallet, {} as never)
    await vi.waitFor(() => expect(h.pass).toHaveBeenCalledTimes(1))
    const pass = gw.syncRecipient(wallet, previous(), tokenServiceFor)
    await vi.waitFor(() => expect(serial).toHaveBeenCalledTimes(2))
    expect(h.pass).toHaveBeenCalledTimes(1)

    sessionPass.resolve()
    await syncing
    expect(await pass).toEqual({ completed: true, result: passResult(true) })

    expect(h.pass).toHaveBeenCalledTimes(2)
    expect(depsOf(0).recipient.toString()).toBe(SESSION)
    expect(depsOf(0)).toMatchObject({ adoptLegacyCursor: true })
    expect(depsOf(0).skipCatchUp).toBeUndefined()
    const deps = depsOf(1)
    expect(deps.recipient.toString()).toBe(PREVIOUS)
    expect(deps).toMatchObject({
      adoptLegacyCursor: false,
      skipCatchUp: true,
      tokenServiceFor,
      store: SIPADepositStore.get(webStorage),
      onSweptAddressFunded: expect.any(Function),
      onSweepOverdue: expect.any(Function),
    })
    expect(deps.refreshBalance).toBeUndefined()
  })

  it("reports a pass that fell short as not completed", async () => {
    const { gw } = gateway()
    h.pass.mockResolvedValue(passResult(false))

    expect(await gw.syncRecipient(wallet, previous(), vi.fn())).toEqual({
      completed: false,
      result: passResult(false),
    })
  })

  it("reports a throwing pass as not completed, logs it, and leaves the session's records and chain intact", async () => {
    const { gw } = gateway()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const store = SIPADepositStore.get(webStorage)
    await store.load()
    await store.upsert(sipa(1), { phase: "claimed" }, recordFor(SESSION))
    h.pass.mockRejectedValueOnce(new Error("node down")).mockResolvedValue(passResult(true))

    expect(await gw.syncRecipient(wallet, previous(), vi.fn())).toEqual({ completed: false })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("claims pass"), expect.any(Error))
    expect(store.get(sipa(1))).toMatchObject({ phase: "claimed", recipientL2Address: SESSION })
    expect(await gw.sync(wallet, {} as never)).toEqual(passResult(true))
  })

  it("runs no pass while locked", async () => {
    const { gw } = gateway(null)

    expect(await gw.syncRecipient(wallet, previous(), vi.fn())).toEqual({ completed: false })
    expect(h.pass).not.toHaveBeenCalled()
  })

  it("republishes a paid-again address of the recipient whose landed broadcast this device holds", async () => {
    const { gw } = gateway()
    const ledger = await landedJob(sipa(2))
    h.pass.mockImplementation(async (deps: SipaDepositSyncDeps) => {
      await deps.onSweptAddressFunded!(sipa(2))
      return passResult(true)
    })

    await gw.syncRecipient(wallet, previous(), vi.fn())

    expect(ledger.get(sipa(2))).toMatchObject({ state: "queued", republishSince: 40 })
  })
})

describe("a deposit address's broadcast", () => {
  const eventsOf = (recipient: string) =>
    h.events.mockImplementation(
      async (_wallet: unknown, _token: unknown, to: { toString(): string }) =>
        to.toString() === recipient ? [{ sharedSecretSalt: { toString: () => SALT } }] : [],
    )

  it("lands by its record's recipient, so a queued republish for a previous-account address is not sent again", async () => {
    const { gw } = gateway()
    const store = SIPADepositStore.get(webStorage)
    await store.load()
    await store.upsert(sipa(3), { phase: "sweeping" }, recordFor(PREVIOUS))
    const ledger = await landedJob(sipa(3))
    expect(await ledger.republish(sipa(3), 40)).toBe(true)
    eventsOf(PREVIOUS)

    stop = startBroadcasts(wallet, { slot: gw.slotExecutor(wallet) })

    await vi.waitFor(() => expect(ledger.get(sipa(3))?.state).toBe("landed"))
    expect(h.sent).toEqual([])
    const [, , recipient, range] = h.events.mock.calls[0]!
    expect(String(recipient)).toBe(PREVIOUS)
    expect(range).toEqual({ fromBlock: 40 })
  })

  it("lands by the session's account for a record with no recipient", async () => {
    const { gw } = gateway()
    const store = SIPADepositStore.get(webStorage)
    await store.load()
    await store.upsert(sipa(4), { phase: "sweeping" }, recordFor())
    eventsOf(SESSION)

    expect(await gw.slotExecutor(wallet).landed({ address: sipa(4) } as never)).toBe(true)
    expect(String(h.events.mock.calls[0]![2])).toBe(SESSION)
  })
})
