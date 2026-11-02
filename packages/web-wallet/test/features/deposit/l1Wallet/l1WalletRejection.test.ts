import { describe, expect, it, vi } from "vitest"
import { ContractFunctionExecutionError, UserRejectedRequestError, erc20Abi, type Hex } from "viem"

vi.mock("wagmi/actions", () => ({ getAccount: () => ({}), switchChain: vi.fn() }))
vi.mock("../../../../src/features/deposit/wagmi", () => ({ wagmiConfig: () => ({}) }))

const { getL1Clients, isWalletRejection, isWrongNetwork } = await import(
  "../../../../src/features/deposit/l1Wallet"
)

describe("isWalletRejection", () => {
  it("sees a rejection wrapped by writeContract", () => {
    const inner = new UserRejectedRequestError(new Error("User denied transaction signature."))
    const wrapped = new ContractFunctionExecutionError(inner, { abi: [], functionName: "transfer" })
    expect(isWalletRejection(wrapped)).toBe(true)
  })

  it("sees a dismissal worded without the 4001 code", () => {
    for (const message of [
      "User rejected the request",
      "User has rejected the request",
      "User denied transaction signature.",
      "Transaction cancelled by the user",
    ]) {
      expect(isWalletRejection({ code: -32000, message })).toBe(true)
    }
  })

  it("sees a bare EIP-1193 4001", () => {
    expect(isWalletRejection({ code: 4001, message: "User rejected the request." })).toBe(true)
  })

  it("ignores other errors", () => {
    expect(isWalletRejection(new Error("insufficient funds"))).toBe(false)
    expect(isWalletRejection(undefined)).toBe(false)
    expect(
      isWalletRejection({
        code: -32000,
        message: "User transaction rejected by network: insufficient funds",
      }),
    ).toBe(false)
  })
})

describe("isWrongNetwork", () => {
  it("sees viem refuse a transfer from a wallet that stays on another chain after the switch", async () => {
    const account = `0x${"11".repeat(20)}` as Hex
    const sent = vi.fn()
    window.ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x38"
        if (method === "eth_requestAccounts") return [account]
        if (method === "wallet_switchEthereumChain") return null
        if (method === "eth_sendTransaction") sent()
        throw new Error(`unexpected request: ${method}`)
      },
    } as never
    const { walletClient, chain } = await getL1Clients(1)
    const err = await walletClient
      .writeContract({
        address: account,
        abi: erc20Abi,
        functionName: "transfer",
        args: [account, 1n],
        account,
        chain,
      })
      .catch((e: unknown) => e)
    delete (window as { ethereum?: unknown }).ethereum
    expect(isWrongNetwork(err)).toBe(true)
    expect(sent).not.toHaveBeenCalled()
  })

  it("ignores rejections and other errors", () => {
    const rejection = new UserRejectedRequestError(new Error("User denied transaction signature."))
    expect(
      isWrongNetwork(
        new ContractFunctionExecutionError(rejection, { abi: [], functionName: "transfer" }),
      ),
    ).toBe(false)
    expect(
      isWrongNetwork(new Error("The current chain of the wallet (id: 56) does not match")),
    ).toBe(false)
    expect(isWrongNetwork(undefined)).toBe(false)
  })
})

describe("a WalletConnect cancel", () => {
  it("surfaces the wallet's rejection, not the relay RPC's answer to viem's wallet_ retry", async () => {
    const account = `0x${"11".repeat(20)}` as Hex
    window.ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1"
        if (method === "eth_requestAccounts") return [account]
        if (method === "eth_sendTransaction")
          throw { code: -32000, message: "User rejected the request" }
        throw { code: -32600, message: "JSON is not a valid request object." }
      },
    } as never
    const { walletClient, chain } = await getL1Clients(1)
    const err = await walletClient
      .sendTransaction({
        account,
        chain,
        to: account,
        gas: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        nonce: 0,
      })
      .catch((e: unknown) => e)
    delete (window as { ethereum?: unknown }).ethereum
    expect(isWalletRejection(err)).toBe(true)
  })
})
