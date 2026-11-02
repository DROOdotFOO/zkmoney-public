// @vitest-environment jsdom
/**
 * The deposit rail learns of a registration's sweep from the wallet, ahead of its own scan, so the
 * deposit flow's surfaces (the bell's live row first) carry the registration from the sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  SIPADepositStore,
  depositPhaseCopy,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"

vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1ChainId: 11155111 }),
}))

const { syncRegistrationRail } = await import(
  "../../../../src/features/onboarding/registrationRailSync"
)
const { webStorage } = await import("../../../../src/platform/storage/WebStorageAdapter")
const { walletStorage } = await import("../../../../src/platform/storage/walletStorage")

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const SIPA = "0x00000000000000000000000000000000000000c3"
const HASH = `0x${"5e".repeat(32)}` as const
const DAI = 10n ** 18n

const record = (over: Partial<PendingRegistrationRecord> = {}): PendingRegistrationRecord =>
  ({
    account: ACCOUNT,
    tag: "taga",
    nameHash: `0x${"77".repeat(32)}`,
    l2Address: `0x${"cd".repeat(32)}`,
    l1ChainId: 11155111,
    sipaAddress: SIPA,
    depositToken: "0x00000000000000000000000000000000000000d4",
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    ...over,
  } as PendingRegistrationRecord)

const rail = () => SIPADepositStore.get(webStorage)
const deposit = () => rail().get(SIPA as never)!

/** The seeder's record: a registration SIPA the scan has not seen funded. */
async function seedRail(over: Record<string, unknown> = {}) {
  await rail().load()
  await rail().upsert(
    SIPA as never,
    { phase: "broadcast" } as never,
    {
      networkId: "0xnet",
      amount: "0",
      startTime: Date.now(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      intent: "registration",
      registrationFee: String(DAI / 2n),
      ...over,
    } as never,
  )
}

function resetRail() {
  for (const key of walletStorage.keys()) walletStorage.removeItem(key)
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
}

beforeEach(resetRail)

describe("the tick's stamps reach the rail", () => {
  it("a swept record moves the rail to sweeping with the sweep's hash, once", async () => {
    await seedRail({ amount: "15" })
    const swept = record({ fundedAt: 1, sweptAt: 2, sweepTxHash: HASH, phase: "funded" })
    await syncRegistrationRail([swept])
    expect(deposit()).toMatchObject({ phase: "sweeping", sweepTxHash: HASH })
    expect(depositPhaseCopy(deposit()).live).toBe("Receiving")
    const listener = vi.fn()
    rail().onListChanged(listener)
    await syncRegistrationRail([swept])
    expect(listener).not.toHaveBeenCalled()
  })
})

// The tick and the rail's own scan report on the same deposit independently.
describe("observations that land together", () => {
  const swept = () => record({ fundedAt: 1, sweptAt: 2, sweepTxHash: HASH, phase: "funded" })

  // The scan's write lands anywhere inside the observations' own reads and writes.
  it("never undo a phase the scan moves the deposit to meanwhile", async () => {
    for (const phase of ["pendingClaim", "claimed", "recovered"] as const) {
      for (let ticks = 0; ticks < 4; ticks++) {
        resetRail()
        await seedRail()
        const seen = [syncRegistrationRail([swept()])]
        for (let i = 0; i < ticks; i++) await Promise.resolve()
        await Promise.all([...seen, rail().upsert(SIPA as never, { phase })])
        expect(deposit()).toMatchObject({ phase, sweepTxHash: HASH })
      }
    }
  })
})
