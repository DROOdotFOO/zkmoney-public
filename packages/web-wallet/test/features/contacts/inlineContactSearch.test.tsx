import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RegistryTagResolution } from "@obsidion/front-core"

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  fresh: vi.fn(),
  add: vi.fn(),
  entries: vi.fn(),
  probe: vi.fn(),
}))
vi.mock("../../../src/features/onboarding/nameAvailability", () => ({
  probeNameAvailability: mocks.probe,
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: mocks.resolve,
  resolveTagForCommit: mocks.fresh,
}))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "me" }),
}))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ addEntry: mocks.add, getEntries: mocks.entries }) },
}))
import { useInlineContactSearch } from "../../../src/features/contacts/useInlineContactSearch"

const hit = (address = "0xalice"): RegistryTagResolution => ({
  status: "resolved",
  account: "0x00000000000000000000000000000000000000aa",
  l2Address: address,
  rollupId: "r1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let current: ReturnType<typeof useInlineContactSearch>
const contacts: [] = []
const refresh = vi.fn(async () => {})
function Probe({ query }: { query: string }) {
  current = useInlineContactSearch(contacts, query, refresh)
  return (
    <p>
      {current.panel.kind} {current.isSaving ? "busy" : "ready"} {current.saveError}
    </p>
  )
}

describe("shared inline contact verification", () => {
  let root: Root
  let container: HTMLDivElement
  const render = async (query: string) => {
    await act(async () => root.render(<Probe query={query} />))
  }
  const resolveQuery = async (query = "alice") => {
    await render(query)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(hit())
    mocks.fresh.mockResolvedValue(hit())
    mocks.add.mockResolvedValue(undefined)
    mocks.entries.mockResolvedValue([])
    mocks.probe.mockResolvedValue({ status: "unknown", grantValid: false, grantBound: false })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it.each([
    ["reserved", "reserved"],
    ["available", "no-user-found"],
  ])(
    "keeps a miss looking up until the claim server answers: %s reads %s",
    async (status, kind) => {
      mocks.resolve.mockResolvedValue({ status: "notFound" })
      const answer = deferred<{ status: string; grantValid: boolean; grantBound: boolean }>()
      mocks.probe.mockReturnValueOnce(answer.promise)
      await resolveQuery("bob")
      expect(current.panel).toEqual({ kind: "looking-up", tag: "bob" })
      await act(async () => answer.resolve({ status, grantValid: false, grantBound: false }))
      expect(current.panel).toEqual({ kind, tag: "bob" })
      await render("bob")
      expect(mocks.probe).toHaveBeenCalledTimes(1)
    },
  )

  it("asks again on a later search, so an unknown answer does not stick", async () => {
    mocks.resolve.mockResolvedValue({ status: "notFound" })
    await resolveQuery("bob")
    await act(async () => {})
    expect(current.panel).toEqual({ kind: "no-user-found", tag: "bob" })
    mocks.probe.mockResolvedValue({ status: "reserved", grantValid: false, grantBound: false })
    await resolveQuery("bo")
    await resolveQuery("bob")
    await act(async () => {})
    expect(current.panel).toEqual({ kind: "reserved", tag: "bob" })
  })

  it("shows busy and prevents repeat Add while fresh verification is pending", async () => {
    await resolveQuery()
    const fresh = deferred<RegistryTagResolution>()
    mocks.fresh.mockReturnValue(fresh.promise)
    let first!: Promise<unknown>
    act(() => {
      first = current.save("alice")
    })
    expect(current.isSaving).toBe(true)
    expect(mocks.add).not.toHaveBeenCalled()
    expect(await current.save("alice")).toBeNull()
    expect(mocks.fresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      fresh.resolve(hit())
      await first
    })
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "alice", address: "0xalice" }),
    )
    expect(current.isSaving).toBe(false)
  })

  it("shows a recoverable fresh-verification failure and allows another Add", async () => {
    await resolveQuery()
    mocks.fresh.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      expect(await current.save("alice")).toBeNull()
    })
    expect(current.saveError).toContain("Couldn't verify")
    expect(current.isSaving).toBe(false)
    expect(mocks.add).not.toHaveBeenCalled()
    await act(async () => {
      await current.save("alice")
    })
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(current.saveError).toBe("")
  })

  it("never saves a cached address that fresh verification changed", async () => {
    await resolveQuery()
    mocks.fresh.mockResolvedValue(hit("0xrotated"))
    await act(async () => {
      await current.save("alice")
    })
    expect(mocks.add).not.toHaveBeenCalled()
    expect(current.saveError).toContain("Contact details changed")
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it.each(["edit", "dismiss", "unmount"])(
    "does not persist when %s cancels pending verification",
    async (operation) => {
      await resolveQuery()
      const fresh = deferred<RegistryTagResolution>()
      mocks.fresh.mockReturnValue(fresh.promise)
      let saving!: Promise<unknown>
      act(() => {
        saving = current.save("alice")
      })
      if (operation === "edit") await render("bob")
      if (operation === "dismiss") current.cancel()
      if (operation === "unmount") await act(async () => root.render(null))
      await act(async () => {
        fresh.resolve(hit())
        await saving
      })
      expect(mocks.add).not.toHaveBeenCalled()
    },
  )

  it("keeps the latest result across repeated edits with an earlier lookup in flight", async () => {
    const earlier = deferred<RegistryTagResolution>()
    mocks.resolve.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(hit("0xbob"))
    await resolveQuery("alice")
    expect(current.panel).toEqual({ kind: "looking-up", tag: "alice" })
    await resolveQuery("bob")
    await act(async () => earlier.resolve(hit()))
    expect(current.panel).toEqual({ kind: "add-offer", tag: "bob" })
  })

  it("retains persistence errors in the shared result state", async () => {
    await resolveQuery()
    mocks.add.mockRejectedValue(new Error("Storage unavailable"))
    await act(async () => {
      await current.save("alice")
    })
    expect(current.saveError).toBe("Storage unavailable")
    expect(current.isSaving).toBe(false)
  })
})
