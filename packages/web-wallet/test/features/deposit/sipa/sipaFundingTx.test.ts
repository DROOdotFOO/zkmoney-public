/**
 * Stamping the funding transfer RACES the deposit record's own creation, and normally loses: the L1
 * receipt lands seconds after the transfer, while only the sync loop's event discovery may create
 * the record, on its next tick. So the ordering these cover is the common one — hash first, record
 * second — and the hash has to survive the gap.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { formatUnits, parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  depositWindowError,
  drainFundingTxStash,
  getSipaDepositGateway,
  stampFundingTx,
  type FundingStamp,
} from "../../../../src/features/deposit/sipaGateway"
import { seedBootConfig } from "../../../support/seedBootConfig"

const { TX_AMOUNT_CAP, ROW_TOKEN } = vi.hoisted(() => ({
  TX_AMOUNT_CAP: 5166n * 10n ** 18n,
  ROW_TOKEN: `0x${"ee".repeat(20)}` as Address,
}))
vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: ROW_TOKEN, portal: `0x${"70".repeat(20)}` }),
}))
// The row quotes a 0.25 DAI fee.
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../../support/depositTokens")
  return mockLoadDepositFacts(
    importOriginal,
    () => singleToken(ROW_TOKEN),
    async () => ({
      fee: "0.25",
      token: ROW_TOKEN,
      sweepFeeAtomic: 250_000_000_000_000_000n,
      txAmountCap: TX_AMOUNT_CAP,
    }),
  )
})

const SIPA = `0x${"ab".repeat(20)}` as Address
/** The same address as a wallet or an explorer hands it back. */
const OTHER = `0x${"cd".repeat(20)}` as Address
const HASH = `0x${"11".repeat(32)}` as Hex
const OTHER_HASH = `0x${"22".repeat(32)}` as Hex

function makeStore() {
  const records = new Map<string, Record<string, unknown>>()
  /** The addresses upsert was called with, before the store lowercases them into keys. */
  const upsertKeys: Address[] = []
  return {
    records,
    upsertKeys,
    load: async () => {},
    get: (address: Address) => records.get(address.toLowerCase()) ?? null,
    upsert: async (address: Address, patch: Record<string, unknown>) => {
      upsertKeys.push(address)
      const key = address.toLowerCase()
      const next = { ...(records.get(key) ?? {}), ...patch }
      records.set(key, next)
      return next
    },
    /** What event discovery does on a sync pass. */
    discover: (address: Address, phase: string) => {
      records.set(address.toLowerCase(), { sipaAddress: address, phase })
    },
  }
}

describe("stampFundingTx", () => {
  let pending: Map<string, FundingStamp>

  beforeEach(() => {
    pending = new Map()
  })

  it("never blanks a stored field with an undefined stamp value", async () => {
    const store = makeStore()
    store.records.set(SIPA, { sipaAddress: SIPA, phase: "sweeping", tokenSymbol: "DAI" })

    await stampFundingTx(store as never, pending, SIPA, {
      fundingTxHash: HASH,
      tokenSymbol: undefined,
    })

    expect(store.records.get(SIPA)).toMatchObject({ tokenSymbol: "DAI", fundingTxHash: HASH })
  })

  it("holds a hash whose record is still undiscovered for a later pass", async () => {
    const store = makeStore()
    await stampFundingTx(store as never, pending, SIPA, { fundingTxHash: HASH })
    await stampFundingTx(store as never, pending, OTHER, { fundingTxHash: OTHER_HASH })

    store.discover(OTHER, "broadcast")
    await drainFundingTxStash(store as never, pending)

    expect(store.records.get(OTHER)).toMatchObject({ fundingTxHash: OTHER_HASH })
    expect([...pending]).toEqual([[SIPA, { fundingTxHash: HASH }]])
  })
})

/**
 * The gate every funding path runs through, including the desktop bridge. The bridge has no form of
 * its own, so this gate is all that stands between a browser-approved transfer and a stranded
 * deposit.
 */
describe("depositWindowError", () => {
  const CAP = formatUnits(TX_AMOUNT_CAP, DEFAULT_DECIMALS)
  const dai = (display: string) => parseUnits(display, 18)
  const FEE = dai("0.25")

  it("refuses a send at or below the quoted fee", () => {
    expect(depositWindowError(FEE, FEE, 18, "DAI", TX_AMOUNT_CAP, 18)).toContain(
      "must exceed the deposit fee (0.25 DAI)",
    )
    expect(depositWindowError(dai("0.24"), FEE, 18, "DAI", TX_AMOUNT_CAP, 18)).toBeDefined()
  })

  it("measures a send to a 6-decimal row against that row's own cap", () => {
    const usdc = (display: string) => parseUnits(display, 6)
    const fee = usdc("0.25")
    const cap = usdc("1000")
    expect(depositWindowError(usdc("1000") + fee, fee, 6, "USDC", cap, 6)).toBeUndefined()
    expect(depositWindowError(usdc("1000") + fee + 1n, fee, 6, "USDC", cap, 6)).toBe(
      "This amount is over the network's maximum per deposit",
    )
  })

  it("measures a 6-decimal token swapped into an 18-decimal row in its own units", () => {
    const usdc = (display: string) => parseUnits(display, 6)
    const fee = usdc("0.25")
    expect(depositWindowError(usdc("100"), fee, 6, "USDC", TX_AMOUNT_CAP, 18)).toBeUndefined()
    expect(depositWindowError(usdc(CAP) + fee, fee, 6, "USDC", TX_AMOUNT_CAP, 18)).toBeUndefined()
    expect(depositWindowError(usdc(CAP) + fee + 1n, fee, 6, "USDC", TX_AMOUNT_CAP, 18)).toBe(
      "This amount is over the network's maximum per deposit",
    )
  })
})

/** The refusal names what the user actually sent, not the token the pool settles in. */
describe("the deposit window gate, over a send in another token", () => {
  beforeAll(seedBootConfig)

  it("names the sent token in the refusal", async () => {
    const gateway = getSipaDepositGateway() as unknown as {
      tokenMeta: () => Promise<{ address: Address; symbol: string; decimals: number }>
      deposit: (params: Record<string, unknown>) => Promise<unknown>
    }
    gateway.tokenMeta = async () => ({ address: OTHER, symbol: "DAI", decimals: 18 })

    await expect(
      gateway.deposit({
        target: { address: SIPA, name: "alice.oxide.eth" },
        amountDisplay: "0.1",
        tokenSymbol: "USDC",
        token: { address: OTHER, decimals: 6 },
      }),
    ).rejects.toThrow("Amount must exceed the deposit fee (0.25 USDC)")
  })

  it("sends nothing to an address whose broadcast could not be owed", async () => {
    const gateway = getSipaDepositGateway() as unknown as {
      tokenMeta: () => Promise<{ address: Address; symbol: string; decimals: number }>
      deposit: (params: Record<string, unknown>) => Promise<unknown>
    }
    gateway.tokenMeta = async () => ({ address: OTHER, symbol: "DAI", decimals: 18 })
    const publish = vi.fn(async () => {})

    await expect(
      gateway.deposit({
        target: {
          address: SIPA,
          name: "alice.oxide.eth",
          publish,
          owe: async () => {
            throw new Error("storage full")
          },
        },
        amountDisplay: "5",
        tokenSymbol: "DAI",
        token: { address: OTHER, decimals: 18 },
      }),
    ).rejects.toThrow("storage full")
    expect(publish).not.toHaveBeenCalled()
  })
})
