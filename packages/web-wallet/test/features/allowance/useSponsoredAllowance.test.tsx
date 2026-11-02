/**
 * The allowance belongs to the signed-in account on the current deployment. Switching account shows
 * nothing of the previous one's, even for the render before the new read starts.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { readSponsoredAllowance } = vi.hoisted(() => ({
  readSponsoredAllowance: vi.fn(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({
    network: "sandbox",
    oxideProfile: { portal: "0xportal" },
    claimFpcAddress: "0xfpc",
  }),
}))
vi.mock("../../../src/features/allowance/readAllowance", () => ({ readSponsoredAllowance }))
vi.mock("../../../src/features/allowance/readAllowanceUsage", () => ({
  readAllowanceUsage: vi.fn(async () => undefined),
}))

const { useSponsoredAllowance } = await import(
  "../../../src/features/allowance/useSponsoredAllowance"
)
const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")

/** The session `account` is signed in to; none is signed out. */
const signIn = (account?: { getAddress: () => { toString: () => string } }) => {
  closeSession()
  openTestSession({ wallet: {}, account })
}

const account = (address: string) => ({ getAddress: () => ({ toString: () => address }) })
const legacy = (uses: number) => ({
  fpcAddress: "0xfpc",
  railId: 1,
  allowance: { subscribed: true, uses, maxTx: 100, refillPeriod: 86_400 },
})

const seen: string[] = []
function Probe({ active = true }: { active?: boolean }) {
  const { snapshot } = useSponsoredAllowance(active)
  seen.push(
    snapshot.status === "ready" && snapshot.state.kind === "available"
      ? `${snapshot.scope}:${snapshot.state.available}`
      : snapshot.status,
  )
  return null
}

let root: Root
beforeEach(() => {
  seen.length = 0
  root = createRoot(document.createElement("div"))
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe("useSponsoredAllowance", () => {
  it("never renders one account's allowance under another", async () => {
    signIn(account("0xalice"))
    readSponsoredAllowance.mockResolvedValueOnce(legacy(7))
    await act(async () => root.render(<Probe />))
    expect(seen.at(-1)).toBe("0xalice|sandbox|0xportal|0xfpc:7")

    seen.length = 0
    signIn(account("0xbob"))
    readSponsoredAllowance.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => root.render(<Probe />))
    expect(seen).not.toContain("0xalice|sandbox|0xportal|0xfpc:7")
    expect(seen.at(-1)).toBe("loading")
  })

  it("reads as signed out without an account", async () => {
    signIn()
    await act(async () => root.render(<Probe />))
    expect(seen.at(-1)).toBe("signed-out")
  })

  it("starts no read for an inactive consumer", async () => {
    signIn(account("0xcarol"))
    readSponsoredAllowance.mockClear()
    await act(async () => root.render(<Probe active={false} />))
    expect(readSponsoredAllowance).not.toHaveBeenCalled()
    readSponsoredAllowance.mockResolvedValueOnce(legacy(3))
    await act(async () => root.render(<Probe active />))
    expect(readSponsoredAllowance).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toBe("0xcarol|sandbox|0xportal|0xfpc:3")
  })
})
