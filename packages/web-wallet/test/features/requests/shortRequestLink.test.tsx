import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const h = vi.hoisted(() => ({
  sendTx: vi.fn(),
  enabled: true,
  announced: [] as string[],
}))
const wallet = { sendTx: h.sendTx }
const account = { getAddress: () => "0xuser" }

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  buildClaimSponsorPayload: async () => ({}),
  claimFpcSponsoredFee: () => ({}),
  shortLinksEnabled: async () => h.enabled,
  linkAnnounceInteraction: async (
    _wallet: unknown,
    _contractService: unknown,
    _kind: number,
    key: { seed: Uint8Array },
  ) => {
    h.announced.push(hex(key.seed))
    return { request: async () => ({ calls: [] }) }
  },
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ fpcAddress: "0xfpc", railId: 1, policy: {} }),
  noteSubscribed: () => {},
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: () => {} }))
vi.mock("../../../src/features/requests/requestLinkCreation", () => ({
  requestLinkOrigin: () => "https://wallet.zk.money",
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ network: "mainnet" }) }))

const { decodeLinkFragment } = await import("@obsidion/sdk")
const { useShortRequestLink } = await import("../../../src/features/requests/shortRequestLink")
const { getOperationStore } = await import("../../../src/features/operations/operations")
const { operationEntry } = await import("../../support/operations")
const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")

/** The bell's record of the latest publish. */
const lastPublish = () =>
  getOperationStore()
    .list()
    .filter((r) => r.flow === "request-link")
    .sort((a, b) => b.startedAt - a.startedAt)[0]

let CODE = {
  requestId: "0x0a1b",
  url: "https://wallet.zk.money/pay/someone#oWFhAQ",
  amount: 0,
  expiresAt: 0,
}
let requests = 0
let setShortLink: MockInstance

/** The seed a short URL carries, as the announce sees it. */
function seedOf(url: string): string {
  return hex(decodeLinkFragment(url.slice(url.indexOf("#") + 1))!.seed)
}

/** Every mounted probe: each unmounts before its session closes. */
const roots: ReturnType<typeof createRoot>[] = []

async function mount() {
  let seen: ReturnType<typeof useShortRequestLink> | undefined
  const Probe = () => {
    seen = useShortRequestLink(CODE)
    return null
  }
  const root = createRoot(document.createElement("div"))
  roots.push(root)
  await act(async () => root.render(<Probe />))
  const hook = () => seen!
  hook.unmount = () => act(async () => root.unmount())
  return hook
}

describe("useShortRequestLink", () => {
  beforeEach(() => {
    // Links are kept per request for the session, so each case shares a request of its own.
    CODE = { ...CODE, requestId: `0x0a1b${++requests}` }
    h.announced.length = 0
    h.sendTx.mockReset()
    h.enabled = true
    setShortLink = vi.spyOn(openTestSession({ wallet, account }).requests, "setShortLink")
  })
  afterEach(async () => {
    setShortLink.mockRestore()
    await act(async () => roots.splice(0).forEach((root) => root.unmount()))
    closeSession()
  })

  it("shares the code's own link, and publishes nothing, on a deployment with no locator", async () => {
    h.enabled = false
    const hook = await mount()
    expect(hook().url).toBe(CODE.url)
    await act(async () => hook().publish())
    expect(h.announced).toEqual([])
    expect(h.sendTx).not.toHaveBeenCalled()
  })

  it("publishes the link it shares, once", async () => {
    h.sendTx.mockResolvedValue({})
    const hook = await mount()
    const url = hook().url!
    expect(url).toMatch(/^https:\/\/wallet\.zk\.money\/request#/)
    await act(async () => hook().publish())
    await act(async () => hook().publish())
    expect(h.announced).toEqual([seedOf(url)])
  })

  it("a tap on a remounted or second sheet joins the publish in flight", async () => {
    let land!: () => void
    h.sendTx.mockReturnValue(new Promise((resolve) => (land = () => resolve({}))))
    const first = await mount()
    const url = first().url!
    await act(async () => first().publish())
    await first.unmount()
    const again = await mount()
    const beside = await mount()
    expect(again().url).toBe(url)
    expect(again().status).toBe("publishing")
    await act(async () => again().publish())
    await act(async () => beside().publish())
    await act(async () => land())
    expect(h.announced).toEqual([seedOf(url)])
    expect(h.sendTx).toHaveBeenCalledTimes(1)
    expect(again().status).toBe("ready")
    expect(beside().status).toBe("ready")
  })

  it("after a failed publish, shares a fresh link and publishes that one", async () => {
    h.sendTx.mockRejectedValueOnce(new Error("rejected")).mockResolvedValue({})
    const hook = await mount()
    const first = hook().url!
    await act(async () => hook().publish())
    const second = hook().url!
    expect(second).not.toBe(first)
    await act(async () => hook().publish())
    expect(h.announced).toEqual([seedOf(first), seedOf(second)])
  })

  it("puts the short link in the QR only once its tx landed, and the bell says so", async () => {
    let land!: () => void
    h.sendTx.mockReturnValue(new Promise((resolve) => (land = () => resolve({}))))
    const hook = await mount()
    expect(hook().status).toBe("idle")
    expect(hook().qrUrl).toBe(CODE.url)
    await act(async () => hook().publish())
    expect(hook().status).toBe("publishing")
    expect(hook().qrUrl).toBe(CODE.url)
    expect(lastPublish()).toMatchObject({ state: "local", summary: "Request for any amount" })
    await act(async () => land())
    expect(hook().status).toBe("ready")
    expect(hook().qrUrl).toBe(hook().url)
    expect(hook().qrUrl).not.toBe(CODE.url)
    expect(setShortLink).toHaveBeenLastCalledWith(CODE.requestId, hook().url)
    expect(operationEntry(lastPublish())).toMatchObject({
      title: "Request link ready",
      description: "Request for any amount",
      severity: "success",
      target: { type: "request.share", requestId: CODE.requestId },
    })
  })

  it("a failed publish keeps the code's link in the QR, and the bell reports it", async () => {
    h.sendTx.mockRejectedValue(new Error("rejected"))
    const hook = await mount()
    await act(async () => hook().publish())
    expect(hook().status).toBe("failed")
    expect(hook().qrUrl).toBe(CODE.url)
    expect(operationEntry(lastPublish())).toMatchObject({
      title: "Request link not published",
      description: "Request for any amount. It didn't go through. Share again for a new link.",
      severity: "error",
      target: { type: "request.share", requestId: CODE.requestId },
    })
  })
})
