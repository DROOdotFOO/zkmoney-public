import { describe, expect, it, vi } from "vitest"
import { ContractFunctionRevertedError, type PublicClient } from "viem"
import { SipaIntent } from "@oxide/l1-contracts"

import { readSipaPortalTerms } from "../../../src/oxide/portal/sipaPortalTerms.js"

const forwardingTable = `0x${"aa".repeat(20)}` as const
const portal = `0x${"11".repeat(20)}` as const
const token = `0x${"22".repeat(20)}` as const
const route = { forwardingTable, token, intent: SipaIntent.Deposit }

function client(values: Record<string, unknown>) {
  const readContract = vi.fn(
    async ({ address, functionName }: { address: string; functionName: string }) => {
      const value = values[`${address.toLowerCase()}.${functionName}`]
      if (value === undefined) throw new Error(`unexpected read ${address}.${functionName}`)
      if (value instanceof Error) throw value
      return value
    },
  )
  return { client: { readContract } as unknown as PublicClient, readContract }
}

describe("readSipaPortalTerms", () => {
  it("reads the portal and fee off the table's row and the cap off that portal", async () => {
    const { client: c, readContract } = client({
      [`${forwardingTable}.rowFor`]: [portal, `0x${"33".repeat(20)}`, 2n, 5n],
      [`${portal}.TX_AMOUNT_CAP`]: 9n,
    })

    await expect(readSipaPortalTerms(c, route)).resolves.toEqual({
      portal,
      token,
      depositFee: 7n,
      txAmountCap: 9n,
    })
    const row = readContract.mock.calls.find(([call]) => call.functionName === "rowFor")
    expect((row?.[0] as unknown as { args: unknown[] }).args).toEqual([token, SipaIntent.Deposit])
  })

  it("refuses a token or intent the table does not route", async () => {
    const { client: c } = client({
      [`${forwardingTable}.rowFor`]: new ContractFunctionRevertedError({
        abi: [],
        functionName: "rowFor",
      }),
    })
    await expect(readSipaPortalTerms(c, route)).rejects.toThrow("routes no sweep")
  })

  it("rejects when a read fails", async () => {
    const { client: c } = client({
      [`${forwardingTable}.rowFor`]: [portal, `0x${"33".repeat(20)}`, 0n, 5n],
      [`${portal}.TX_AMOUNT_CAP`]: new Error("rpc down"),
    })
    await expect(readSipaPortalTerms(c, route)).rejects.toThrow("rpc down")
  })
})
