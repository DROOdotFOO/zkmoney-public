/**
 * The fresh-address verdict on the paste sheet: what the L1 reads and this wallet's own records say
 * about a destination, which of them wins when several apply, and how the hook keeps a verdict
 * pinned to the address still in the field. Nothing here blocks; the screener does that.
 */
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAddress, type Address } from "viem"
import type { Contact, WithdrawalRecord } from "@obsidion/front-core"
import type { FreshAddressVerdict } from "../../../../src/features/withdraw/freshAddressCheck"

const h = vi.hoisted(() => ({
  client: { getTransactionCount: vi.fn(), getBalance: vi.fn(), getCode: vi.fn() },
  getEntries: vi.fn(),
}))

vi.mock("../../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../../src/config/oxideTuple", () => ({ l1PublicClient: () => h.client }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ getEntries: h.getEntries }) },
}))

const { checkFreshAddress, useFreshAddressVerdict } = await import(
  "../../../../src/features/withdraw/freshAddressCheck"
)
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)

const TARGET = getAddress(`0x${"dd".repeat(20)}`)
const LOWER = TARGET.toLowerCase() as Address
const OTHER = getAddress(`0x${"ee".repeat(20)}`)
const LOCKED = new Error("store locked")

const cl = (nonce = 0, balance = 0n, code = "0x") => ({
  getTransactionCount: vi.fn().mockResolvedValue(nonce),
  getBalance: vi.fn().mockResolvedValue(balance),
  getCode: vi.fn().mockResolvedValue(code),
})
const down = () => vi.fn().mockRejectedValue(new Error("rpc down"))
const allDown = () => ({ getTransactionCount: down(), getBalance: down(), getCode: down() })

const rec = (extra: Partial<WithdrawalRecord> = {}) =>
  ({ recipient: TARGET, phase: "done", ...extra } as WithdrawalRecord)

type ContactExtra = Partial<Pick<Contact, "address" | "addressKind">> & {
  deletedAt?: number
  lastUsedAt?: number
}
const contact =
  (provenance: "deposit-attested" | "saved-recipient") =>
  ({ address = TARGET, addressKind = "ethereum-l1", ...l1 }: ContactExtra = {}): Contact => ({
    name: "wallet",
    address,
    addressKind,
    l1Wallet: { provider: "manual", provenance, ...l1 },
  })
const att = contact("deposit-attested")
const sav = contact("saved-recipient")

/** An Error in place of a list is a store that will not load. */
const rows =
  <T>(list: T[] | Error) =>
  () =>
    list instanceof Error ? Promise.reject(list) : Promise.resolve(list)
const deps = (client = cl(), w: WithdrawalRecord[] | Error = [], c: Contact[] | Error = []) => ({
  client,
  withdrawals: rows(w),
  contacts: rows(c),
})

describe("checkFreshAddress", () => {
  it.each<[string, FreshAddressVerdict["kind"], ReturnType<typeof deps>]>([
    ["balance", "history", deps(cl(0, 1n))],
    ["saved-recipient contact", "withdrew-before", deps(cl(), [], [sav()])],
    // precedence
    ["everything at once", "contract", deps(cl(3, 5n, "0x6000"), [rec()], [att(), sav()])],
    ["everything but code", "linked-deposit", deps(cl(3, 5n), [rec()], [att(), sav()])],
    ["saved contact, record and nonce", "withdrew-before", deps(cl(3, 5n), [rec()], [sav()])],
    // failed reads
    ["every read down, nothing local", "unknown", deps(allDown())],
    ["one read down, nothing local", "unknown", deps({ ...cl(), getBalance: down() })],
    ["every read down, attested contact", "linked-deposit", deps(allDown(), [], [att()])],
    ["getCode down, nonce 2", "history", deps({ ...cl(2), getCode: down() })],
    ["a store throws, nothing else", "unknown", deps(cl(), [], LOCKED)],
    ["records throw, attested contact", "linked-deposit", deps(cl(), LOCKED, [att()])],
    // local filters
    ["tombstoned contact", "fresh", deps(cl(), [], [att({ deletedAt: 10 })])],
    ["revived contact", "linked-deposit", deps(cl(), [], [att({ deletedAt: 10, lastUsedAt: 20 })])],
    ["removed after last use", "fresh", deps(cl(), [], [sav({ deletedAt: 30, lastUsedAt: 20 })])],
    ["aztec-l2 contact, same string", "fresh", deps(cl(), [], [sav({ addressKind: "aztec-l2" })])],
    ["failed record", "fresh", deps(cl(), [rec({ phase: "failed" })])],
    ["registration burn", "fresh", deps(cl(), [rec({ intent: "registration" })])],
    ["in-flight record", "withdrew-before", deps(cl(), [rec({ phase: "submitting" })])],
    [
      "another address",
      "fresh",
      deps(cl(), [rec({ recipient: OTHER })], [att({ address: OTHER })]),
    ],
    ["lowercase record", "withdrew-before", deps(cl(), [rec({ recipient: LOWER })])],
    ["lowercase contact", "linked-deposit", deps(cl(), [], [att({ address: LOWER })])],
  ])("%s -> %s", async (_, kind, d) => {
    expect(await checkFreshAddress(TARGET, d)).toEqual({ kind })
  })
})

describe("useFreshAddressVerdict", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: FreshAddressVerdict | undefined

  const Probe = ({ address, waitMs }: { address: Address | null; waitMs?: number }) => {
    seen = useFreshAddressVerdict(address, waitMs)
    return null
  }
  const render = (address: Address | null, waitMs?: number) =>
    act(async () => {
      root.render(createElement(Probe, { address, waitMs }))
    })
  const elapse = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    seen = undefined
    h.client.getTransactionCount.mockReset().mockResolvedValue(0)
    h.client.getBalance.mockReset().mockResolvedValue(0n)
    h.client.getCode.mockReset().mockResolvedValue("0x")
    h.getEntries.mockReset().mockResolvedValue([])
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it("is idle without an address, before and after one was checked", async () => {
    await render(null)
    await elapse(1000)
    expect(seen).toEqual({ kind: "idle" })
    expect(h.client.getCode).not.toHaveBeenCalled()
    await render(TARGET)
    await elapse(300)
    expect(seen).toEqual({ kind: "fresh" })
    await render(null)
    expect(seen).toEqual({ kind: "idle" })
  })

  it("checks after the debounce through the store and the contacts", async () => {
    await session().withdrawals.create({
      ...rec({ localId: "w1", startTime: 1 }),
      networkId: "0xnet",
    })
    await render(TARGET)
    expect(seen).toEqual({ kind: "checking" })
    await elapse(299)
    expect(h.client.getCode).not.toHaveBeenCalled()
    await elapse(1)
    expect(seen).toEqual({ kind: "withdrew-before" })
    expect(h.getEntries).toHaveBeenCalled()
  })

  it("drops a result for an address no longer in the field", async () => {
    let releaseFirst!: (code: string) => void
    h.client.getCode.mockImplementation(({ address }: { address: string }) =>
      address === TARGET
        ? new Promise<string>((resolve) => {
            releaseFirst = resolve
          })
        : Promise.resolve("0x"),
    )
    h.client.getTransactionCount.mockImplementation(async ({ address }: { address: string }) =>
      address === OTHER ? 4 : 0,
    )
    await render(TARGET)
    await elapse(300)
    expect(seen).toEqual({ kind: "checking" })
    await render(OTHER)
    await elapse(300)
    expect(seen).toEqual({ kind: "history" })
    await act(async () => {
      releaseFirst("0x6000")
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(seen).toEqual({ kind: "history" })
  })

  it("reads unknown from the end of the wait to the answer, and leaves a verdict alone", async () => {
    await render(OTHER, 5000)
    await elapse(5000)
    expect(seen).toEqual({ kind: "fresh" })
    let release!: (code: string) => void
    h.client.getCode.mockReturnValue(new Promise<string>((resolve) => (release = resolve)))
    await render(TARGET, 5000)
    await elapse(4999)
    expect(seen).toEqual({ kind: "checking" })
    await elapse(1)
    expect(seen).toEqual({ kind: "unknown" })
    await act(async () => {
      release("0x6000")
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(seen).toEqual({ kind: "contract" })
  })
})
