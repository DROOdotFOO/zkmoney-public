/**
 * The wallet picker's Popular group: RainbowKit's stock list plus Rabby, listed by name because
 * people look for it there. The Rabby entry is the extension when it is injected and the app over
 * WalletConnect otherwise.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

// Shared with the hoisted mocks: the stock extension's installed flag and connector sentinels.
const stock = vi.hoisted(() => ({
  installed: undefined as boolean | undefined,
  extensionConnector: () => "extension",
  wcConnector: () => "walletconnect",
}))

vi.mock("@rainbow-me/rainbowkit", () => ({
  darkTheme: () => ({ colors: {}, radii: {} }),
  getDefaultConfig: vi.fn((args: unknown) => ({ args })),
  getWalletConnectConnector: () => stock.wcConnector,
}))
vi.mock("@rainbow-me/rainbowkit/wallets", () => {
  const stub = (id: string) => () => ({ id })
  return {
    base: stub("base"),
    coinbaseWallet: stub("coinbase"),
    ledgerWallet: stub("ledger"),
    metaMaskWallet: stub("metaMask"),
    rabbyWallet: () => ({
      id: "rabby",
      name: "Rabby Wallet",
      rdns: "io.rabby",
      iconUrl: "",
      iconBackground: "#8697ff",
      installed: stock.installed,
      downloadUrls: { chrome: "https://rabby.io/" },
      extension: { instructions: { learnMoreUrl: "https://rabby.io/", steps: [] } },
      createConnector: stock.extensionConnector,
    }),
    rainbowWallet: stub("rainbow"),
    readyWallet: stub("ready"),
    safeWallet: stub("safe"),
    trustWallet: stub("trust"),
    uniswapWallet: stub("uniswap"),
    walletConnectWallet: stub("walletConnect"),
    zerionWallet: stub("zerion"),
  }
})
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ l1ChainId: 1 }),
  l1ChainFor: () => ({ id: 1 }),
  l1Transport: () => ({}),
}))
vi.mock("../../../../src/dev/demoFlag", () => ({ isDemoMode: () => false }))

const { getDefaultConfig } = await import("@rainbow-me/rainbowkit")
const { wagmiConfig } = await import("../../../../src/features/deposit/wagmi")
const { rabbyWallet } = await import("../../../../src/features/deposit/rabbyWallet")

type Params = { projectId: string }
type Group = { groupName: string; wallets: Array<(params: Params) => { id: string }> }
type Args = { wallets: Group[]; storage: unknown }

const params: Params = { projectId: "project" }

describe("wagmiConfig wallet groups", () => {
  it("lists Rabby by name in Popular, between MetaMask and WalletConnect", () => {
    wagmiConfig()
    expect(getDefaultConfig).toHaveBeenCalledTimes(1)
    const args = vi.mocked(getDefaultConfig).mock.calls[0][0] as unknown as Args
    const popular = args.wallets.find((g) => g.groupName === "Popular")
    expect(popular?.wallets.map((w) => w(params).id)).toEqual([
      "safe",
      "rainbow",
      "base",
      "metaMask",
      "rabby",
      "walletConnect",
    ])
    expect(args.storage).toBeNull()
  })
})

describe("rabbyWallet", () => {
  afterEach(() => {
    stock.installed = undefined
  })

  it("is the injected extension when Rabby is installed", () => {
    stock.installed = true
    const wallet = rabbyWallet(params)
    expect(wallet.installed).toBe(true)
    expect(wallet.createConnector).toBe(stock.extensionConnector)
    expect(wallet.mobile?.getUri).toBeUndefined()
    expect(wallet.qrCode).toBeUndefined()
  })

  it("pairs the app over WalletConnect through the rabby:// deep link on every phone", () => {
    const wallet = rabbyWallet(params)
    expect(wallet.installed).toBeUndefined()
    expect(wallet.createConnector).toBe(stock.wcConnector)
    expect(wallet.mobile?.getUri?.("wc:abc")).toBe("rabby://wc?uri=wc%3Aabc")
    expect(wallet.qrCode?.getUri("wc:abc")).toBe("wc:abc")
  })

  it("keeps the rdns that dedupes it with the EIP-6963 announcement", () => {
    expect(rabbyWallet(params).rdns).toBe("io.rabby")
  })
})
