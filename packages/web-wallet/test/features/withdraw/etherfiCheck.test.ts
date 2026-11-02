/**
 * The ether.fi verdict: the factory's top-up registry on Ethereum mainnet (the wallet's own L1
 * client on mainnet, a public mainnet RPC elsewhere) and its safe registry on Optimism, and a hook
 * that keeps the verdict pinned to the address still in the field.
 */
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAddress } from "viem"
import { Network } from "@obsidion/core/constants"

const h = vi.hoisted(() => ({
  readContract: vi.fn(),
  publicRead: vi.fn(),
  optimismRead: vi.fn(),
  network: "mainnet" as string,
}))

vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ network: h.network }) }))
vi.mock("../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ readContract: h.readContract }),
}))
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: ({ chain }: { chain: { id: number } }) => ({
    readContract: chain.id === 10 ? h.optimismRead : h.publicRead,
  }),
}))

const { checkEtherfiAddress, ETHERFI_FACTORY, useEtherfiAddressVerdict } = await import(
  "../../../src/features/withdraw/etherfiCheck"
)

const TARGET = getAddress(`0x${"dd".repeat(20)}`)
const FACTORY = ETHERFI_FACTORY

describe("checkEtherfiAddress", () => {
  const reader = (answer: boolean | Error) => ({
    readContract:
      answer instanceof Error
        ? vi.fn().mockRejectedValue(answer)
        : vi.fn().mockResolvedValue(answer),
  })
  const check = (mainnet: boolean | Error, optimism: boolean | Error) =>
    checkEtherfiAddress(TARGET, { mainnet: reader(mainnet), optimism: reader(optimism) })
  const down = new Error("rpc down")

  it("asks the mainnet factory for a top-up contract and the Optimism factory for a safe", async () => {
    const mainnet = reader(false)
    const optimism = reader(false)
    await checkEtherfiAddress(TARGET, { mainnet, optimism })
    expect(mainnet.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FACTORY,
        functionName: "isTopUpContract",
        args: [TARGET],
      }),
    )
    expect(optimism.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: FACTORY, functionName: "isEtherFiSafe", args: [TARGET] }),
    )
  })

  it.each([
    [true, false, "confirmed"],
    [true, down, "confirmed"],
    [false, true, "account"],
    [down, true, "account"],
    [false, false, "rejected"],
    [false, down, "unknown"],
    [down, false, "unknown"],
  ] as const)("mainnet %s, Optimism %s: %s", async (mainnet, optimism, kind) => {
    await expect(check(mainnet, optimism)).resolves.toEqual({ kind })
  })
})

describe("useEtherfiAddressVerdict", () => {
  let container: HTMLDivElement
  let root: Root
  const kind = () => container.textContent
  const Probe = ({ address, waitMs }: { address: typeof TARGET | null; waitMs?: number }) =>
    createElement("span", null, useEtherfiAddressVerdict(address, waitMs).kind)
  const render = (address: typeof TARGET | null, waitMs?: number) =>
    act(async () => root.render(createElement(Probe, { address, waitMs })))
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(() => {
    vi.useFakeTimers()
    h.network = Network.MAINNET
    h.readContract.mockReset()
    h.publicRead.mockReset()
    h.optimismRead.mockReset().mockResolvedValue(false)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it("is idle with no address, checks through the debounce, then lands the read", async () => {
    h.readContract.mockResolvedValue(true)
    await render(null)
    expect(kind()).toBe("idle")
    await render(TARGET)
    expect(kind()).toBe("checking")
    expect(h.readContract).not.toHaveBeenCalled()
    await pass(300)
    expect(kind()).toBe("confirmed")
  })

  it("reads unknown when the factory does not answer", async () => {
    h.readContract.mockRejectedValue(new Error("rpc down"))
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("unknown")
  })

  it("reads unknown once the wait passes, then takes a late answer", async () => {
    let answer!: (value: boolean) => void
    h.readContract.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)))
    await render(TARGET, 1_000)
    await pass(300)
    expect(kind()).toBe("checking")
    await pass(700)
    expect(kind()).toBe("unknown")
    await act(async () => answer(false))
    expect(kind()).toBe("rejected")
  })

  it("asks mainnet from a testnet build", async () => {
    h.network = Network.TESTNET
    h.publicRead.mockResolvedValue(false)
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("rejected")
    expect(h.readContract).not.toHaveBeenCalled()
  })

  it("confirms an Optimism safe whose mainnet top-up contract is not deployed", async () => {
    h.readContract.mockResolvedValue(false)
    h.optimismRead.mockResolvedValue(true)
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("account")
  })
})
