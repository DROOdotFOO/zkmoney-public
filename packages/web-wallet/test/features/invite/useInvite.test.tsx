import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  secretKey: "sk" as string | null,
  inviteCode: vi.fn(async () => "k7q2m9x"),
  inviteStatus: vi.fn(async () => ({ pending: 1, credited: 0 })),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => h.secretKey }),
}))
vi.mock("../../../src/features/onboarding/oxideOnboarding", () => ({
  accountServiceFor: () => ({ inviteCode: h.inviteCode, inviteStatus: h.inviteStatus }),
}))

const { useInvite, inviteLink } = await import("../../../src/features/invite/useInvite")

describe("inviteLink", () => {
  it("names the invite host beside the wallet's own, and production's anywhere else", () => {
    vi.stubGlobal("location", { hostname: "wallet.staging.zk.money" })
    expect(inviteLink("k7q2m9x")).toBe("invite.staging.zk.money/k7q2m9x")
    vi.stubGlobal("location", { hostname: "localhost" })
    expect(inviteLink("k7q2m9x")).toBe("invite.zk.money/k7q2m9x")
    vi.unstubAllGlobals()
  })
})

async function mount() {
  let seen: ReturnType<typeof useInvite> | undefined
  const Probe = () => {
    seen = useInvite()
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(<Probe />))
  return { value: () => seen, unmount: () => root.unmount() }
}

async function read() {
  const probe = await mount()
  probe.unmount()
  return probe.value()
}

describe("useInvite", () => {
  beforeEach(() => {
    h.secretKey = "sk"
    vi.clearAllMocks()
  })

  it("reads the code and a pending referral", async () => {
    expect(await read()).toEqual({ code: "k7q2m9x", credited: false })
  })

  it("reports a credited referral", async () => {
    h.inviteStatus.mockResolvedValueOnce({ pending: 0, credited: 1 })
    expect(await read()).toEqual({ code: "k7q2m9x", credited: true })
  })

  it("reads again when the tab is shown, so a friend's deposit lands as the free claim", async () => {
    const probe = await mount()
    expect(probe.value()).toEqual({ code: "k7q2m9x", credited: false })
    h.inviteStatus.mockResolvedValueOnce({ pending: 0, credited: 1 })
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    expect(probe.value()).toEqual({ code: "k7q2m9x", credited: true })
    probe.unmount()
  })

  it("has no code while the wallet is locked", async () => {
    h.secretKey = null
    expect(await read()).toEqual({ credited: false })
    expect(h.inviteCode).not.toHaveBeenCalled()
  })
})
