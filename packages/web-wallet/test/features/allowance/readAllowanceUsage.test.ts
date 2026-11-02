/**
 * The allowance split reads the payer's notes and the broadcasts of every account that spent them:
 * the payer's own before a rotation, the acting account's after it.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { readClaimFpcSubscriptionNotes, broadcastTxHashes } = vi.hoisted(() => ({
  readClaimFpcSubscriptionNotes: vi.fn(),
  broadcastTxHashes: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readClaimFpcSubscriptionNotes,
}))
vi.mock("../../../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => ({ broadcastTxHashes }),
}))

const { readAllowanceUsage } = await import("../../../src/features/allowance/readAllowanceUsage")

const acting = AztecAddress.fromNumberUnsafe(0x11)
const payer = AztecAddress.fromNumberUnsafe(0x22)
const deps = {
  wallet: {},
  account: { getAddress: () => acting },
  contractService: { getArtifactForContract: async () => ({}) },
} as never
const note = (uses: number, txHash: string, blockNumber = 10) => ({
  uses,
  txHash,
  blockNumber,
  refilledAt: 1n,
})
const read = (payerAddress: AztecAddress) => ({
  fpcAddress: AztecAddress.fromNumberUnsafe(0x33).toString(),
  railId: 1,
  payer: payerAddress.toString(),
  allowance: { subscribed: true, uses: 97, maxTx: 100, refillPeriod: 86_400 },
})

describe("readAllowanceUsage", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reads the broadcasts of the one account that pays and acts", async () => {
    readClaimFpcSubscriptionNotes.mockResolvedValueOnce([note(99, "0xa"), note(98, "0xb")])
    broadcastTxHashes.mockResolvedValueOnce(new Set(["0xb"]))
    expect(await readAllowanceUsage(deps, read(acting))).toEqual({ yours: 1, depositAddresses: 1 })
    expect(broadcastTxHashes).toHaveBeenCalledTimes(1)
    expect(broadcastTxHashes).toHaveBeenCalledWith({}, acting, 10)
  })

  it("counts the payer's broadcasts from before a rotation beside the acting account's", async () => {
    readClaimFpcSubscriptionNotes.mockResolvedValueOnce([
      note(99, "0xa", 5),
      note(98, "0xb"),
      note(97, "0xc"),
    ])
    broadcastTxHashes.mockImplementation(async (_wallet: unknown, account: AztecAddress) =>
      account.equals(payer) ? new Set(["0xa"]) : new Set(["0xc"]),
    )
    expect(await readAllowanceUsage(deps, read(payer))).toEqual({ yours: 1, depositAddresses: 2 })
    expect(broadcastTxHashes).toHaveBeenCalledTimes(2)
    expect(broadcastTxHashes).toHaveBeenCalledWith({}, payer, 5)
    expect(broadcastTxHashes).toHaveBeenCalledWith({}, acting, 5)
  })
})
