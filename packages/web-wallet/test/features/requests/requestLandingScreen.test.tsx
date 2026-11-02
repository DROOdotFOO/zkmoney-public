import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { ChainIdentity } from "@obsidion/core/types"
import { encodeRequestInline, type RequestInlinePacket } from "@obsidion/front-core"
import { mockLoadDepositFacts, singleToken } from "../../support/depositTokens"

const SIPA = `0x${"aa".repeat(20)}`
const L1_TOKEN = `0x${"22".repeat(20)}`
const L2_TOKEN = `0x${"1b".repeat(32)}`
const ROLLUP = "0xrollup"
const PORTAL = `0x${"c".repeat(40)}`
const CHAIN_ID = 31337

function fragmentFor(over: Partial<RequestInlinePacket> = {}): string {
  return encodeRequestInline({
    requestId: `0x${"0a".repeat(32)}`,
    requesterTag: "alice",
    requesterAddress: `0x${"2c".repeat(32)}`,
    amountAtomic: 1_000_000n,
    tokenAddress: L2_TOKEN,
    tokenDecimals: 6,
    tokenSymbol: "DAI",
    networkId: ROLLUP,
    sipaAddress: SIPA,
    note: "Pizza dinner",
    ...over,
  })
}

const { resolve, tagLookup, identity, portal, nodeIsDefault, fireEvent } = vi.hoisted(() => ({
  fireEvent: vi.fn(),
  resolve: vi.fn(),
  tagLookup: vi.fn(),
  identity: { value: null as object | null },
  portal: vi.fn(),
  nodeIsDefault: { value: true },
}))

vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent,
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagForCommit: (tag: string) => tagLookup(tag),
}))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadOnboardedIdentity: () => identity.value,
}))
vi.mock("../../../src/config/env", async () => {
  const { http } = await import("viem")
  const { foundry } = await import("viem/chains")
  return {
    getConfig: () => ({
      network: "sandbox",
      nodeUrl: "http://127.0.0.1:8080",
      l1ChainId: CHAIN_ID,
      l1Chain: foundry,
      oxideProfile: { portal: PORTAL },
      profileRollupVersion: "1",
      endpoints: {
        node: { isDefault: nodeIsDefault.value },
        l1Rpc: { isDefault: true },
        enclave: { isDefault: true },
      },
    }),
    l1Transport: () => http("http://127.0.0.1:8545"),
  }
})
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ token: L1_TOKEN, l2Token: L2_TOKEN }),
  requireTupleField: (tuple: Record<string, unknown>, key: string) => tuple[key],
  l1PublicClient: () => "l1-client",
}))
vi.mock("../../../src/features/deposit/loadDepositFacts", (importOriginal) =>
  mockLoadDepositFacts(importOriginal, () => singleToken(L1_TOKEN as Address)),
)
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readPortalChainIdentity: portal,
}))
vi.mock("../../../src/features/requests/accountlessRequest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/requests/accountlessRequest")>()),
  resolveAccountlessRequest: resolve,
}))
// The sheet pulls wagmi/RainbowKit; the landing is what these cover.
vi.mock("../../../src/features/requests/ExternalWalletPayModal", () => ({
  ExternalWalletPayModal: ({ onPaid }: { onPaid?: () => void }) => (
    <button onClick={onPaid}>pay-sheet</button>
  ),
}))
vi.mock("@obsidion/web-ds", () => ({
  AuroraBackground: () => null,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  ScreenNavBar: ({ title }: { title: string }) => <div>{title}</div>,
  Spinner: () => <div>spinner</div>,
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { RequestLandingScreen } = await import("../../../src/features/requests/RequestLandingScreen")
const { L1IdentityUnavailableError } = await import("@obsidion/front-core")

/** The node's answer, agreeing with the portal; only the default node's L1-outage fallback boots on it. */
const getNodeInfo = vi.fn(async () => ({
  l1ChainId: CHAIN_ID,
  rollupVersion: 1,
  l1ContractAddresses: {
    rollupAddress: { toString: () => ROLLUP },
    inboxAddress: { toString: () => `0x${"b".repeat(40)}` },
  },
}))
const node = { getNodeInfo } as never

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("RequestLandingScreen accountless landing", () => {
  let container: HTMLDivElement
  let root: Root
  let navigate: NavigateFunction
  function RouterControls() {
    navigate = useNavigate()
    return null
  }
  function SendProbe() {
    const { state } = useLocation()
    const request = (
      state as { request?: { amount: number; link?: string; standing?: boolean } } | null
    )?.request
    return (
      <div data-testid="send">{`send-sheet ${request?.amount} ${request?.link}${
        request?.standing ? " standing" : ""
      }`}</div>
    )
  }
  function EnterProbe() {
    const { state } = useLocation()
    return <div data-testid="enter-next">{(state as { next?: string } | null)?.next}</div>
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resolve.mockReset()
    fireEvent.mockReset()
    tagLookup.mockReset()
    tagLookup.mockImplementation(async (tag: string) => ({
      status: tag === "nobody" ? "notFound" : "resolved",
    }))
    portal.mockReset()
    portal.mockResolvedValue({
      l1ChainId: CHAIN_ID,
      rollupVersion: "1",
      rollupAddress: ROLLUP,
      inboxAddress: `0x${"b".repeat(40)}`,
    })
    identity.value = null
    nodeIsDefault.value = true
    getNodeInfo.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function render(
    fragment: string,
    strict = false,
    state?: object,
    pathname = "/request",
    chainIdentity?: ChainIdentity,
  ) {
    await act(async () => {
      const tree = (
        <MemoryRouter initialEntries={[{ pathname, hash: fragment ? `#${fragment}` : "", state }]}>
          <RouterControls />
          <Routes>
            {["/request", "/pay/:tag"].map((path) => (
              <Route
                key={path}
                path={path}
                element={<RequestLandingScreen node={node} chainIdentity={chainIdentity} />}
              >
                <Route index element={<div>signup</div>} />
              </Route>
            ))}
            <Route path="/contacts/:tag/send" element={<SendProbe />} />
            <Route path="/enter" element={<EnterProbe />} />
          </Routes>
        </MemoryRouter>
      )
      root.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
    })
  }

  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!
  const click = async (text: string) => {
    await act(async () => {
      button(text).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  }

  it("refuses a link whose declared decimals the token does not have", async () => {
    const { RequestDecimalsMismatchError } = await import(
      "../../../src/features/requests/accountlessRequest"
    )
    resolve.mockRejectedValue(new RequestDecimalsMismatchError(6, 18))
    await render(fragmentFor())
    expect(container.textContent).toContain("for a token this wallet doesn't support")
    expect(container.textContent).not.toContain("Try again")
  })

  it("tells the payer a requester who hasn't upgraded can be paid once they do", async () => {
    const { RequesterNotUpgradedError } = await import(
      "../../../src/features/requests/accountlessRequest"
    )
    resolve.mockRejectedValue(new RequesterNotUpgradedError("alice"))
    await render(fragmentFor())
    expect(container.textContent).toContain("You can pay them once they upgrade")
    expect(container.textContent).not.toContain("Try again")
  })

  it("validates the packet against the portal's rollup, with no identity pinned", async () => {
    // No wallet has booted, so no network id is known yet.
    resolve.mockReturnValue(new Promise(() => {}))
    await render(fragmentFor())

    expect(portal).toHaveBeenCalledWith("l1-client", PORTAL, CHAIN_ID)
    expect(container.textContent).toContain("Choose how to pay")
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("takes the rollup the boot verified and reads no identity of its own", async () => {
    resolve.mockReturnValue(new Promise(() => {}))
    const verified = {
      l1ChainId: CHAIN_ID,
      rollupVersion: "1",
      rollupAddress: ROLLUP,
      inboxAddress: "0xb",
    }
    await render(fragmentFor(), false, undefined, "/request", verified)
    expect(portal).not.toHaveBeenCalled()
    expect(getNodeInfo).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("refuses a packet stamped for another rollup", async () => {
    await render(fragmentFor({ networkId: "0xother" }))

    expect(container.textContent).toContain("This payment request is for a different network.")
    expect(resolve).not.toHaveBeenCalled()
  })

  it("hands a signed-in payer to the send sheet once the portal's rollup matches", async () => {
    identity.value = {}
    await render(fragmentFor())

    expect(portal).toHaveBeenCalledWith("l1-client", PORTAL, CHAIN_ID)
    expect(container.textContent).toContain("send-sheet")
  })

  it("falls back to the default node when L1 gives no answer, as boot does", async () => {
    identity.value = {}
    portal.mockRejectedValue(
      new L1IdentityUnavailableError({ call: "ROLLUP", cause: new TypeError("Failed to fetch") }),
    )
    await render(fragmentFor())

    expect(getNodeInfo).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("send-sheet")
  })

  it("refuses a default node on another chain when L1 gives no answer, as boot does", async () => {
    identity.value = {}
    portal.mockRejectedValue(
      new L1IdentityUnavailableError({ call: "ROLLUP", cause: new TypeError("Failed to fetch") }),
    )
    getNodeInfo.mockResolvedValueOnce({
      ...(await getNodeInfo()),
      l1ChainId: CHAIN_ID + 1,
    })
    await render(fragmentFor())

    expect(container.textContent).not.toContain("send-sheet")
  })

  it("never takes a custom node's word when L1 gives no answer", async () => {
    identity.value = {}
    nodeIsDefault.value = false
    portal.mockRejectedValue(
      new L1IdentityUnavailableError({ call: "ROLLUP", cause: new TypeError("Failed to fetch") }),
    )
    await render(fragmentFor())

    expect(container.textContent).not.toContain("send-sheet")
  })

  it("holds the external-wallet row until the address and fee resolve", async () => {
    resolve.mockReturnValue(new Promise(() => {}))
    await render(fragmentFor())

    expect(container.textContent).toContain("Pay @alice")
    expect(container.textContent).toContain("$1")
    expect(container.textContent).toContain("Pizza dinner")
    // Signing up never waits on the L1 legs; quoting an onchain payment does.
    expect(button("Pay with zk.money").disabled).toBe(false)
    expect(button("Pay with an Ethereum wallet").disabled).toBe(true)
  })

  it("quotes amount plus fee and opens the pay sheet once resolved", async () => {
    resolve.mockResolvedValue({
      sipaAddress: SIPA,
      decimals: 6,
      feeAtomic: 500_000n,
      grossAtomic: 1_500_000n,
      paymentUri: `ethereum:${L1_TOKEN}@${CHAIN_ID}/transfer?address=${SIPA}&uint256=1500000`,
    })
    await render(fragmentFor())

    expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $1.50 with fee")
    await click("Pay with an Ethereum wallet")
    expect(container.textContent).toContain("pay-sheet")
  })

  it("reuses one resolve across StrictMode replay and lets the live subscriber finish", async () => {
    let finish!: (result: unknown) => void
    resolve.mockReturnValue(
      new Promise((done) => {
        finish = done
      }),
    )
    await render(fragmentFor(), true)
    expect(resolve).toHaveBeenCalledTimes(1)
    await act(async () =>
      finish({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: `ethereum:${L1_TOKEN}@${CHAIN_ID}/transfer?address=${SIPA}&uint256=1500000`,
      }),
    )
    expect(button("Pay with an Ethereum wallet").disabled).toBe(false)
    expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $1.50 with fee")
  })

  it("starts one new operation for retry after failure under StrictMode", async () => {
    resolve.mockRejectedValueOnce(new Error("RPC unavailable"))
    let finish!: (result: unknown) => void
    resolve.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done
        }),
    )
    await render(fragmentFor(), true)
    expect(resolve).toHaveBeenCalledTimes(1)
    // The raw failure goes to the console, never the page.
    expect(container.textContent).not.toContain("RPC unavailable")
    expect(container.textContent).toContain("Couldn't prepare a payment address.")
    await click("Try again")
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(button("Pay with an Ethereum wallet").disabled).toBe(true)
    await act(async () =>
      finish({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: "ethereum:capture",
      }),
    )
    expect(button("Pay with an Ethereum wallet").disabled).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it.each(["resolve", "reject"])(
    "ignores a stale %s after an in-flight fragment replacement",
    async (outcome) => {
      let finishOld!: (result: unknown) => void
      let rejectOld!: (error: Error) => void
      resolve.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            finishOld = done
            rejectOld = fail
          }),
      )
      resolve.mockResolvedValueOnce({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 2_500_000n,
        paymentUri: "ethereum:new",
      })
      await render(fragmentFor(), true)
      const nextId = `0x${"0b".repeat(32)}`
      await act(async () =>
        navigate(`/request#${fragmentFor({ requestId: nextId, amountAtomic: 2_000_000n })}`),
      )
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(resolve.mock.calls[1][0].requestId).toBe(nextId)
      expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $2.50 with fee")
      await act(async () => {
        if (outcome === "reject") rejectOld(new Error("stale failure"))
        else
          finishOld({
            sipaAddress: SIPA,
            decimals: 6,
            feeAtomic: 500_000n,
            grossAtomic: 1_500_000n,
            paymentUri: "ethereum:old",
          })
      })
      expect(container.textContent).not.toContain("stale failure")
      expect(button("Pay with an Ethereum wallet").textContent).toContain("Pay $2.50 with fee")
      expect(resolve).toHaveBeenCalledTimes(2)
    },
  )

  it("does not reopen a previous packet's payment sheet after the fragment changes", async () => {
    resolve.mockResolvedValue({
      sipaAddress: SIPA,
      decimals: 6,
      feeAtomic: 500_000n,
      grossAtomic: 1_500_000n,
      paymentUri: "ethereum:capture",
    })
    await render(fragmentFor(), true)
    await click("Pay with an Ethereum wallet")
    expect(container.textContent).toContain("pay-sheet")
    await act(async () =>
      navigate(`/request#${fragmentFor({ requestId: `0x${"0c".repeat(32)}` })}`),
    )
    expect(container.textContent).not.toContain("pay-sheet")
    expect(button("Pay with an Ethereum wallet").disabled).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it("leaves an unmounted landing untouched when its resolution settles", async () => {
    let finish!: (result: unknown) => void
    resolve.mockImplementation(
      () =>
        new Promise((done) => {
          finish = done
        }),
    )
    await render(fragmentFor(), true)
    await act(async () => root.render(<div>Left the request</div>))
    await act(async () =>
      finish({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: "ethereum:capture",
      }),
    )
    expect(container.textContent).toBe("Left the request")
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("keeps packet guards ahead of address resolution under StrictMode", async () => {
    await render(fragmentFor({ expiresAt: Date.now() - 1000 }), true)
    expect(container.textContent).toContain("This payment request has expired")
    expect(resolve).not.toHaveBeenCalled()
  })

  it("hands the fragment to the signup outlet, to be replayed once there is an identity", async () => {
    resolve.mockReturnValue(new Promise(() => {}))
    await render(fragmentFor())

    await click("Pay with zk.money")
    // Log in leads; the signup outlet is one more choice away.
    expect(button("Log in")).toBeDefined()
    expect(container.textContent).not.toContain("Choose how to pay")
    await click("Create account")
    expect(container.textContent).toContain("signup")
  })

  it.each([
    ["the footer's", async () => {}],
    ["the payment options'", () => click("Pay with zk.money")],
  ])("%s Log in carries the request through sign-in", async (_name, open) => {
    resolve.mockReturnValue(new Promise(() => {}))
    const fragment = fragmentFor()
    await render(fragment)
    await open()
    await click("Log in")
    expect(container.querySelector('[data-testid="enter-next"]')?.textContent).toBe(
      `/request#${fragment}`,
    )
  })

  it("offers a signed-in payer the send sheet back instead of a log-in prompt", async () => {
    identity.value = {}
    resolve.mockReturnValue(new Promise(() => {}))
    await render(fragmentFor(), false, { external: true })

    expect(container.textContent).toContain("Pay with an Ethereum wallet")
    expect(container.textContent).not.toContain("Log in")
    expect(container.textContent).not.toContain("Your payment stays private")

    await click("Pay with zk.money instead")
    expect(container.textContent).toContain("send-sheet")
  })

  describe("pay page", () => {
    it("opens a request link minted at /pay/<tag>", async () => {
      resolve.mockReturnValue(new Promise(() => {}))
      await render(fragmentFor(), false, undefined, "/pay/alice")
      expect(container.textContent).toContain("Pay @alice")
      expect(container.textContent).toContain("$1")
      expect(resolve.mock.calls[0][0].requestId).toBe(`0x${"0a".repeat(32)}`)
    })

    it("says the payee hasn't upgraded rather than that there is no account", async () => {
      tagLookup.mockResolvedValue({ status: "staleRollup" })
      resolve.mockReturnValue(new Promise(() => {}))
      await render("", false, undefined, "/pay/alice")
      expect(container.textContent).toContain("You can pay them once they upgrade")
      expect(container.textContent).not.toContain("no zk.money account")
    })

    it("refuses a request whose payee is not the page's", async () => {
      await render(fragmentFor(), false, undefined, "/pay/bob")
      expect(container.textContent).toContain("could not be read")
      expect(resolve).not.toHaveBeenCalled()
    })

    it("asks for any amount to the tag when the link carries no request", async () => {
      resolve.mockReturnValue(new Promise(() => {}))
      await render("", false, undefined, "/pay/River")
      expect(container.textContent).toContain("Pay @river")
      expect(container.textContent).toContain("Any amount")
      const packet = resolve.mock.calls[0][0] as RequestInlinePacket
      expect(packet).toMatchObject({ requesterTag: "river", amountAtomic: 0n })
      expect(packet.sipaAddress).toBeUndefined()
    })

    it("drops the last payee's quote and sheet when the page moves to another tag", async () => {
      resolve.mockResolvedValueOnce({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 1_500_000n,
        paymentUri: "ethereum:alice",
      })
      await render("", false, undefined, "/pay/alice")
      await click("Pay with an Ethereum wallet")
      expect(container.textContent).toContain("pay-sheet")
      resolve.mockReturnValue(new Promise(() => {}))
      await act(async () => navigate("/pay/bob"))
      expect(container.textContent).toContain("Pay @bob")
      expect(container.textContent).not.toContain("pay-sheet")
      expect(button("Pay with an Ethereum wallet").disabled).toBe(true)
    })

    it("carries the page through sign-in", async () => {
      resolve.mockReturnValue(new Promise(() => {}))
      await render("", false, undefined, "/pay/river")
      await click("Log in")
      expect(container.querySelector('[data-testid="enter-next"]')?.textContent).toBe("/pay/river")
    })

    it.each([
      ["a visitor", null],
      ["a signed-in payer", {}],
    ])("tells %s when nobody holds the tag", async (_who, id) => {
      identity.value = id
      await render("", false, undefined, "/pay/nobody")
      expect(container.textContent).toContain("Pay @nobody")
      expect(container.textContent).toContain("no zk.money account with this name")
      expect(container.textContent).not.toContain("send-sheet")
      expect(container.textContent).not.toContain("Pay with an Ethereum wallet")
    })

    it("looks the payee up once, while the payment address resolves", async () => {
      tagLookup.mockReturnValue(new Promise(() => {}))
      resolve.mockReturnValue(new Promise(() => {}))
      await render("", false, undefined, "/pay/river")
      expect(resolve).toHaveBeenCalledTimes(1)
      void resolve.mock.calls[0][1].resolveRequester("river")
      expect(tagLookup).toHaveBeenCalledTimes(1)
    })

    it("shows the payee their own page as payers see it, with a share link", async () => {
      identity.value = { handle: "River" }
      await render("", false, undefined, "/pay/river")
      expect(container.textContent).toContain("Choose how to pay")
      expect(container.textContent).toContain("Share link")
      expect(container.textContent).toContain("preview of your pay page")
      expect(container.querySelector('[aria-label="Back"]')).not.toBeNull()
      expect(container.textContent).not.toContain("send-sheet")
      expect(container.textContent).not.toContain("Log in")
    })

    it("hands a signed-in payer to the send sheet with the page to come back to", async () => {
      identity.value = {}
      await render("", false, undefined, "/pay/river")
      expect(container.querySelector('[data-testid="send"]')?.textContent).toBe(
        "send-sheet 0 /pay/river standing",
      )
    })

    const opens = () => fireEvent.mock.calls.filter(([name]) => name === "request_opened")

    it("reports its open once per page load, and its Ethereum payment, as pay_page", async () => {
      resolve.mockResolvedValue({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 500_000n,
        paymentUri: "ethereum:zoe",
      })
      await render("", false, undefined, "/pay/zoe")
      act(() => root.unmount())
      root = createRoot(container)
      await render("", false, undefined, "/pay/zoe")
      expect(opens()).toEqual([["request_opened", { source: "pay_page", amount_bucket: "any" }]])

      await click("Pay with an Ethereum wallet")
      await click("pay-sheet")
      expect(fireEvent).toHaveBeenCalledWith("request_paid", {
        source: "pay_page",
        route: "ethereum",
        amount_bucket: "any",
      })
    })

    it("reports nothing to the payee on their own page", async () => {
      identity.value = { handle: "yan" }
      resolve.mockResolvedValue({
        sipaAddress: SIPA,
        decimals: 6,
        feeAtomic: 500_000n,
        grossAtomic: 500_000n,
        paymentUri: "ethereum:yan",
      })
      await render("", false, undefined, "/pay/yan")
      await click("Pay with an Ethereum wallet")
      await click("pay-sheet")
      expect(fireEvent).not.toHaveBeenCalledWith("request_opened", expect.anything())
      expect(fireEvent).not.toHaveBeenCalledWith("request_paid", expect.anything())
    })
  })
})
