import { describe, expect, it } from "vitest"
import { getAddress, zeroAddress, type Abi, type Address } from "viem"
import { SkyWithdrawalExecutorAbi } from "@oxide/experiments/sky/sky_savings.js"
import { PlainWithdrawalExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import {
  assertExecutorServesPortal,
  readExecutorSubsidy,
  readWithdrawalExecutor,
} from "../../../src/oxide/withdrawal/withdrawalExecutor.js"

const EXECUTOR = getAddress(`0x${"44".repeat(20)}`)
const PORTAL = getAddress(`0x${"55".repeat(20)}`)
const BENEFICIARY = getAddress(`0x${"66".repeat(20)}`)

function client(values: Record<string, unknown>) {
  const reads: string[] = []
  return {
    reads,
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      expect(getAddress(address)).toBe(EXECUTOR)
      reads.push(functionName)
      if (!(functionName in values)) throw new Error(`execution reverted: ${functionName}`)
      return values[functionName]
    },
  }
}

describe("readWithdrawalExecutor", () => {
  it("reads a plain executor's portal, fee and beneficiary", async () => {
    const l1 = client({ PORTAL, FEE: 7n, BENEFICIARY })
    expect(await readWithdrawalExecutor(l1 as never, EXECUTOR, "plain")).toEqual({
      address: EXECUTOR,
      kind: "plain",
      portal: PORTAL,
      fee: 7n,
      beneficiary: BENEFICIARY,
    })
  })

  it("leaves out a zero beneficiary", async () => {
    const l1 = client({ PORTAL, FEE: 0n, BENEFICIARY: zeroAddress })
    expect(await readWithdrawalExecutor(l1 as never, EXECUTOR, "plain")).not.toHaveProperty(
      "beneficiary",
    )
  })

  it("reads only the portal of a Sky executor, which charges no fee", async () => {
    const l1 = client({ PORTAL })
    expect(await readWithdrawalExecutor(l1 as never, EXECUTOR, "sky")).toEqual({
      address: EXECUTOR,
      kind: "sky",
      portal: PORTAL,
      fee: 0n,
    })
    expect(l1.reads).toEqual(["PORTAL"])
  })
})

describe("readExecutorSubsidy", () => {
  it("reads the subsidy the executor created", async () => {
    const l1 = client({ SUBSIDY: BENEFICIARY.toLowerCase() })
    expect(await readExecutorSubsidy(l1 as never, EXECUTOR)).toBe(BENEFICIARY)
  })
})

describe("executor kinds", () => {
  const functions = (abi: Abi) =>
    abi.flatMap((item) => (item.type === "function" ? [item.name] : []))

  // The model gives a Sky executor no fee. Any change to its interface fails here, so a fee under any name is caught.
  it("pin the Sky executor's whole interface", () => {
    expect(functions(SkyWithdrawalExecutorAbi).sort()).toEqual([
      "ASSET",
      "DAI_USDS",
      "PORTAL",
      "SUBSIDY",
      "SUSDS",
      "USDS",
      "execute",
      "withdrawInShares",
    ])
  })

  it("match the fee and subsidy terms oxide's contracts expose", () => {
    expect(functions(PlainWithdrawalExecutorAbi)).toEqual(
      expect.arrayContaining(["PORTAL", "FEE", "BENEFICIARY"]),
    )
    expect(functions(SkyWithdrawalExecutorAbi)).toEqual(
      expect.arrayContaining(["PORTAL", "SUBSIDY"]),
    )
    expect(functions(PlainWithdrawalExecutorAbi)).toContain("SUBSIDY")
    expect(functions(SkyWithdrawalExecutorAbi)).not.toContain("FEE")
    expect(functions(SkyWithdrawalExecutorAbi)).not.toContain("BENEFICIARY")
  })
})

describe("assertExecutorServesPortal", () => {
  const executor = { address: EXECUTOR, kind: "plain" as const, portal: PORTAL, fee: 0n }

  it("accepts the executor's own portal in any case", () => {
    expect(() =>
      assertExecutorServesPortal(executor, PORTAL.toLowerCase() as Address),
    ).not.toThrow()
  })

  it("refuses another portal", () => {
    expect(() => assertExecutorServesPortal(executor, BENEFICIARY)).toThrow(/serves portal/)
  })
})
