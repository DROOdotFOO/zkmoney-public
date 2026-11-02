import { describe, expect, it, vi } from "vitest"
import { ContractFunctionRevertedError, type PublicClient } from "viem"
import { SipaIntent } from "@oxide/l1-contracts"
import { pinnedOxideDeployment, SIPA_INTENT_NAMES, sipaIntentRow } from "@obsidion/core/oxide"

import { readDeploymentTable } from "../../../src/oxide/portal/deploymentTable.js"

const TABLE = `0x${"fb".repeat(20)}`
const DAI = `0x${"da".repeat(20)}`
const USDC = `0x${"c0".repeat(20)}`
const DAI_PORTAL = `0x${"a1".repeat(20)}`
const USDC_PORTAL = `0x${"b2".repeat(20)}`
const BENEFICIARY = `0x${"be".repeat(20)}`

const bridge = (key: string, token: string, portal: string, byte: string) => ({
  key,
  token,
  underlying: token,
  portal,
  l2Token: `0x${byte.repeat(32)}`,
})

const manifest = (bridges: ReturnType<typeof bridge>[]) => ({
  schemaVersion: "5",
  deployments: [
    {
      label: "v6.0.0",
      deployedAt: "2026-10-13T20:24:20.754Z",
      updatedAt: "2026-10-14T20:24:20.754Z",
      chainId: "31337",
      rollupVersion: "1",
      enclaveUrl: "https://enclave.example/rpc",
      forwardingTable: TABLE,
      feeToken: DAI,
      bridges,
    },
  ],
})

const reverted = () => new ContractFunctionRevertedError({ abi: [], functionName: "rowFor" })

/** `rows[token][intent]` is `[portal, beneficiaryFee, sweepTip]`; anything absent reverts. */
function client(rows: Record<string, Partial<Record<SipaIntent, [string, bigint, bigint]>>>) {
  return {
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string
      functionName: string
      args?: [string, SipaIntent]
    }) => {
      if (functionName === "TX_AMOUNT_CAP") return address === DAI_PORTAL ? 100n : 200n
      if (functionName !== "rowFor" || address !== TABLE) throw new Error(`read ${functionName}`)
      const [token, intent] = args!
      const row = rows[token.toLowerCase()]?.[intent]
      if (!row) throw reverted()
      return [row[0], BENEFICIARY, row[1], row[2]]
    },
  } as unknown as PublicClient
}

const twoBridges = pinnedOxideDeployment(
  manifest([bridge("dai", DAI, DAI_PORTAL, "a1"), bridge("usdc", USDC, USDC_PORTAL, "b2")]),
  { portal: DAI_PORTAL },
).deployment

describe("readDeploymentTable", () => {
  it("reads each bridge's intents and cap off a two-bridge table", async () => {
    const table = await readDeploymentTable(
      client({
        [DAI]: {
          [SipaIntent.Deposit]: [DAI_PORTAL, 1n, 2n],
          [SipaIntent.Registration]: [DAI_PORTAL, 3n, 4n],
          [SipaIntent.UserOp]: [DAI_PORTAL, 5n, 6n],
        },
        [USDC]: { [SipaIntent.Deposit]: [USDC_PORTAL, 0n, 7n] },
      }),
      twoBridges,
    )

    expect(table.beneficiary).toBe(BENEFICIARY)
    expect(table.rows.map((row) => [row.bridge.key, row.txAmountCap])).toEqual([
      ["dai", 100n],
      ["usdc", 200n],
    ])
    expect(table.rows[0]!.intents.registration).toEqual({ sweepTip: 4n, beneficiaryFee: 3n })
    expect(table.rows[1]!.intents).toEqual({ deposit: { sweepTip: 7n, beneficiaryFee: 0n } })
    expect(sipaIntentRow(table, "registration", USDC)?.bridge.key).toBe("dai")
  })

  it("reads a one-bridge table", async () => {
    const deployment = pinnedOxideDeployment(manifest([bridge("dai", DAI, DAI_PORTAL, "a1")]), {
      portal: DAI_PORTAL,
    }).deployment
    const table = await readDeploymentTable(
      client({ [DAI]: { [SipaIntent.Deposit]: [DAI_PORTAL, 0n, 2n] } }),
      deployment,
    )

    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]!.intents).toEqual({ deposit: { sweepTip: 2n, beneficiaryFee: 0n } })
  })

  it("leaves out a bridge the table lists for no intent", async () => {
    const table = await readDeploymentTable(
      client({ [DAI]: { [SipaIntent.Deposit]: [DAI_PORTAL, 0n, 2n] } }),
      twoBridges,
    )

    expect(table.rows.map((row) => row.bridge.key)).toEqual(["dai"])
  })

  it("leaves out a bridge whose token the table routes to another portal, keeping the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const table = await readDeploymentTable(
      client({
        [DAI]: { [SipaIntent.Deposit]: [USDC_PORTAL, 0n, 2n] },
        [USDC]: { [SipaIntent.Deposit]: [USDC_PORTAL, 0n, 7n] },
      }),
      twoBridges,
    )

    expect(table.rows.map((row) => row.bridge.key)).toEqual(["usdc"])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not to bridge dai"))
    warn.mockRestore()
  })

  it("reads a token's row once and keeps the bridge whose portal the row names", async () => {
    const replaced = { ...twoBridges.bridges[1]!, key: "usdc-old", portal: `0x${"b0".repeat(20)}` }
    const reads = vi.fn()
    const base = client({
      [DAI]: { [SipaIntent.Deposit]: [DAI_PORTAL, 0n, 2n] },
      [USDC]: { [SipaIntent.Deposit]: [replaced.portal, 0n, 7n] },
    })
    const counting = {
      readContract: (args: { functionName: string }) => {
        reads(args.functionName)
        return base.readContract(args as never)
      },
    } as unknown as PublicClient
    const table = await readDeploymentTable(counting, {
      ...twoBridges,
      bridges: [...twoBridges.bridges, replaced],
    })

    expect(table.rows.map((row) => row.bridge.key)).toEqual(["dai", "usdc-old"])
    // One read per token and intent, however many bridges share the token.
    expect(reads.mock.calls.filter(([name]) => name === "rowFor")).toHaveLength(
      2 * SIPA_INTENT_NAMES.length,
    )
  })

  it("refuses a deployment without a table", async () => {
    await expect(
      readDeploymentTable(client({}), { ...twoBridges, forwardingTable: undefined }),
    ).rejects.toThrow("publishes no forwarding table")
  })
})
