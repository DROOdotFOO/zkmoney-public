import { describe, expect, it } from "vitest"
import { ErrorsAbi, OxidePortalAbi, SIPAAbi } from "@oxide/l1-contracts"
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  encodeErrorResult,
  HttpRequestError,
  toFunctionSelector,
  type Hex,
} from "viem"

import { classifyPortalCapError } from "../../../src/oxide/portal/portalCapError.js"

const GLOBAL = encodeErrorResult({ abi: OxidePortalAbi, errorName: "Caps__GlobalLimitSurpassed" })
const TX = encodeErrorResult({ abi: OxidePortalAbi, errorName: "Caps__TxLimitSurpassed" })
const FROZEN = encodeErrorResult({ abi: OxidePortalAbi, errorName: "OxidePortal__FrozenPortal" })

/** Solidity's built-in `Error(string)` revert. */
const REASON_ABI = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
] as const

const ACCOUNT = "0x0000000000000000000000000000000000000001"
const SIPA = "0x0000000000000000000000000000000000000002"

/** A client whose provider rejects every request with `error`, the way a node or wallet does. */
function rejectingClient(error: unknown) {
  return createPublicClient({
    transport: custom(
      {
        async request() {
          throw error
        },
      },
      { retryCount: 0 },
    ),
  })
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error("expected a rejection")
}

const estimate = (error: unknown) =>
  rejection(rejectingClient(error).estimateGas({ account: ACCOUNT, to: SIPA, data: "0x" }))

describe("classifyPortalCapError", () => {
  it("decodes the selectors the portal reverts with", () => {
    expect(GLOBAL).toBe(toFunctionSelector("Caps__GlobalLimitSurpassed()"))
    expect(GLOBAL).toBe("0x3b178ae3")
    expect(TX).toBe(toFunctionSelector("Caps__TxLimitSurpassed()"))
    expect(TX).toBe("0x31800425")
    expect(FROZEN).toBe(toFunctionSelector("OxidePortal__FrozenPortal()"))
  })

  it.each([
    [GLOBAL, "global-limit"],
    [TX, "tx-limit"],
    [FROZEN, "frozen"],
  ] as const)("classifies raw revert data %s", (data, kind) => {
    expect(classifyPortalCapError(data)).toBe(kind)
    expect(classifyPortalCapError({ data })).toBe(kind)
    expect(classifyPortalCapError({ data: `0x${data.slice(2).toUpperCase()}` })).toBe(kind)
  })

  it("reads a node's revert data through viem's gas-estimation error", async () => {
    const err = await estimate({ code: 3, message: "execution reverted", data: GLOBAL })
    expect(err).toBeInstanceOf(Error)
    expect(classifyPortalCapError(err)).toBe("global-limit")
  })

  it("reads revert data through viem's call error", async () => {
    const err = await rejection(
      rejectingClient({ code: 3, message: "execution reverted", data: TX }).call({
        account: ACCOUNT,
        to: SIPA,
        data: "0x",
      }),
    )
    expect(classifyPortalCapError(err)).toBe("tx-limit")
  })

  it("reads revert data a wallet nests inside its own error", async () => {
    const nested = await estimate({
      code: -32603,
      message: "Internal JSON-RPC error.",
      data: { code: 3, message: "execution reverted", data: GLOBAL },
    })
    expect(classifyPortalCapError(nested)).toBe("global-limit")

    const original = await estimate({
      code: -32603,
      message: "Internal JSON-RPC error.",
      data: { originalError: { code: 3, message: "execution reverted", data: FROZEN } },
    })
    expect(classifyPortalCapError(original)).toBe("frozen")
  })

  it("reads the raw data of a revert the calling ABI could not decode", async () => {
    // A deployed SIPA is swept directly, through the SIPA ABI, which lacks the portal's errors.
    const err = await rejection(
      rejectingClient({ code: 3, message: "execution reverted", data: GLOBAL }).simulateContract({
        account: ACCOUNT,
        address: SIPA,
        abi: SIPAAbi,
        functionName: "sweep",
        args: [SIPA, ACCOUNT, "0x", "0x"],
      }),
    )
    expect(err).toBeInstanceOf(ContractFunctionExecutionError)
    const reverted = (err as ContractFunctionExecutionError).walk(
      (e) => e instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError
    expect(reverted.data).toBeUndefined()
    expect(classifyPortalCapError(err)).toBe("global-limit")
    expect(classifyPortalCapError(new Error("sweep failed", { cause: err }))).toBe("global-limit")
  })

  it("reads a revert the calling ABI did decode", () => {
    const reverted = new ContractFunctionRevertedError({
      abi: OxidePortalAbi,
      data: TX,
      functionName: "deposit",
    })
    expect(reverted.data?.errorName).toBe("Caps__TxLimitSurpassed")
    expect(classifyPortalCapError(reverted)).toBe("tx-limit")
  })

  it("leaves other portal and SIPA reverts unclassified", () => {
    const unknownDeposit = encodeErrorResult({
      abi: OxidePortalAbi,
      errorName: "OxidePortal__UnknownDepositMessage",
    })
    const belowCharges = encodeErrorResult({
      abi: ErrorsAbi,
      errorName: "SIPA__SweepBelowCharges",
      args: [1n, 2n],
    })
    expect(classifyPortalCapError(unknownDeposit)).toBeUndefined()
    expect(classifyPortalCapError(belowCharges)).toBeUndefined()
  })

  it("leaves the Multicall3 revert of an undeployed SIPA's deploy-and-sweep unclassified", async () => {
    // Multicall3 drops the failing sweep's data and reverts with its own reason string.
    const batch = encodeErrorResult({
      abi: REASON_ABI,
      errorName: "Error",
      args: ["Multicall3: call failed"],
    })
    expect(
      classifyPortalCapError(
        await estimate({ code: 3, message: "execution reverted", data: batch }),
      ),
    ).toBeUndefined()
  })

  it("does not classify a revert reason string that names a cap", () => {
    const reason = encodeErrorResult({
      abi: REASON_ABI,
      errorName: "Error",
      args: ["Caps__GlobalLimitSurpassed"],
    })
    expect(classifyPortalCapError({ data: reason })).toBeUndefined()
  })

  it("leaves RPC failures without revert data unclassified", async () => {
    const limited = await estimate({ code: -32005, message: "limit exceeded" })
    expect(limited).toBeInstanceOf(Error)
    expect(classifyPortalCapError(limited)).toBeUndefined()
    expect(
      classifyPortalCapError(await estimate({ code: 3, message: "execution reverted" })),
    ).toBeUndefined()
    expect(
      classifyPortalCapError(new HttpRequestError({ url: "http://127.0.0.1:8545", status: 502 })),
    ).toBeUndefined()
  })

  it("reads structured data only, never message text", () => {
    expect(classifyPortalCapError(new Error(`execution reverted: ${GLOBAL}`))).toBeUndefined()
    expect(classifyPortalCapError({ message: GLOBAL })).toBeUndefined()
  })

  it.each([
    undefined,
    null,
    42,
    "boom",
    "0x",
    "0x3b178a",
    `${GLOBAL}0`,
    `${GLOBAL}zz`,
    "0x3b178ae3".toUpperCase(),
    { data: 1n },
    { data: [GLOBAL] },
  ] as unknown[])("returns undefined for %s", (value) => {
    expect(classifyPortalCapError(value)).toBeUndefined()
  })

  it("stops on a cyclic error chain", () => {
    const self = new Error("loop") as Error & { cause?: unknown; data?: Hex }
    self.cause = self
    expect(classifyPortalCapError(self)).toBeUndefined()

    const outer = new Error("outer") as Error & { cause?: unknown }
    const inner = new Error("inner", { cause: outer }) as Error & { data?: Hex }
    inner.data = FROZEN
    outer.cause = inner
    expect(classifyPortalCapError(outer)).toBe("frozen")
  })
})
