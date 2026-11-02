/**
 * A creator refund runs through the deployment that holds the escrow's token: the live deps for
 * the current token (or an unknown/delisted one), the retired generation's token service, TEE
 * signer and tuple for a historic token.
 */
import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  findHistoricTuple: vi.fn(),
  historicTokenContext: vi.fn(),
}))
vi.mock("../../../src/features/migration/historicTokenContext", () => ({
  findHistoricTuple: h.findHistoricTuple,
  historicTokenContext: h.historicTokenContext,
}))

const { refundDepsForRow } = await import("../../../src/features/paylink/sponsoredPaylink")
type SponsoredPaylinkDeps = Parameters<typeof refundDepsForRow>[0]

const CURRENT = "0x" + "02".repeat(32)
const HISTORIC = "0x" + "01".repeat(32)
const liveDeps = {
  wallet: {},
  account: {},
  tokenService: { tokenAddressOrNull: { toString: () => CURRENT } },
  contractService: {},
  teeSigner: { live: true },
  rollupAddress: "0xrollup",
} as unknown as SponsoredPaylinkDeps
const row = (tokenAddress?: string) => ({ tokenAddress } as never)

describe("refundDepsForRow", () => {
  it("swaps in the retired generation's token service, signer, and tuple for a historic token", async () => {
    const tuple = { l2Token: HISTORIC, portal: "0xportal" }
    const context = { tokenService: { historic: true }, teeSigner: { historic: true } }
    h.findHistoricTuple.mockResolvedValueOnce(tuple)
    h.historicTokenContext.mockResolvedValueOnce(context)
    const out = await refundDepsForRow(liveDeps, row(HISTORIC))
    expect(h.findHistoricTuple).toHaveBeenCalledWith(HISTORIC)
    expect(h.historicTokenContext).toHaveBeenCalledWith(liveDeps.wallet, liveDeps.account, tuple)
    expect(out.deps).toMatchObject({ ...context, contractService: liveDeps.contractService })
    expect(out.tuple).toBe(tuple)
  })

  it("refuses a token that is not a listed deployment", async () => {
    h.findHistoricTuple.mockResolvedValueOnce(null)
    await expect(refundDepsForRow(liveDeps, row("0x" + "03".repeat(32)))).rejects.toThrow(
      "no available deployment",
    )
  })
})
