import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OnNetwork, Transaction } from "@obsidion/front-core"

const m = vi.hoisted(() => ({
  entries: [] as { tag?: string; address: string; autoAdded?: boolean }[],
  typeAhead: vi.fn(),
  commit: vi.fn(),
  addContact: vi.fn(),
  ownHandle: "me" as string | undefined,
}))

vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ getEntries: async () => m.entries }) },
}))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => (m.ownHandle ? { handle: m.ownHandle } : null),
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: m.typeAhead,
  resolveTagForCommit: m.commit,
}))
vi.mock("../../../src/features/contacts/useInlineContactSearch", () => ({
  addContact: m.addContact,
}))

const { TagValidationError } = await import("@obsidion/front-core")
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/platform/session"
)
const { lookUpUnsavedContact, pastAddressOf, saveUnsavedContact, unsavedContact } = await import(
  "../../../src/features/contacts/unsavedContact"
)

const ADDRESS = `0x${"2c".repeat(32)}`
const resolved = (l2Address = ADDRESS) => ({ status: "resolved", l2Address })

beforeEach(() => {
  vi.clearAllMocks()
  m.entries = []
  m.ownHandle = "me"
  m.addContact.mockResolvedValue({ success: true })
  switchSession(activeNamespace())
})
afterEach(closeSession)

describe("lookUpUnsavedContact", () => {
  it("opens a registered tag as an unsaved L2 contact", async () => {
    m.typeAhead.mockResolvedValue(resolved())
    expect(await lookUpUnsavedContact("Grace")).toEqual(unsavedContact("grace", ADDRESS))
    expect(m.typeAhead).toHaveBeenCalledWith("grace")
  })

  it("finds nothing for an unregistered tag, an invalid tag, or the user's own tag", async () => {
    m.typeAhead.mockResolvedValue({ status: "notFound" })
    expect(await lookUpUnsavedContact("nobody")).toBeNull()

    m.typeAhead.mockRejectedValue(new TagValidationError("bad tag"))
    expect(await lookUpUnsavedContact("bad-tag")).toBeNull()

    m.typeAhead.mockClear()
    expect(await lookUpUnsavedContact("me")).toBeNull()
    expect(m.typeAhead).not.toHaveBeenCalled()
  })

  it("opens a tag still on an older zk.money at the address its past transfers used", async () => {
    m.typeAhead.mockResolvedValue({ status: "staleRollup" })
    const sent = { action: "send", token: { amount: 5 }, toTag: "Grace", to: ADDRESS }
    await session().activity.insertPending({
      ...sent,
      id: "row",
      timestamp: 1,
      networkId: "0xnet",
    } as OnNetwork<Transaction>)
    expect(await lookUpUnsavedContact("grace")).toEqual(unsavedContact("grace", ADDRESS))

    await session().activity.remove("row")
    expect(await lookUpUnsavedContact("grace")).toEqual(unsavedContact("grace", ""))
  })

  it("lets a network failure through so the page can say so", async () => {
    m.typeAhead.mockRejectedValue(new Error("rpc down"))
    await expect(lookUpUnsavedContact("grace")).rejects.toThrow("rpc down")
  })
})

describe("pastAddressOf", () => {
  const OTHER = `0x${"4e".repeat(32)}`
  const token = { amount: 5 }

  it("reads a send's recipient and a receive's sender for the tag", () => {
    const send = { action: "send", token, toTag: "grace", to: ADDRESS }
    const receive = { action: "receive", token, from: "grace", senderL2Address: ADDRESS }
    expect(pastAddressOf("grace", [send] as never)).toBe(ADDRESS)
    expect(pastAddressOf("grace", [receive] as never)).toBe(ADDRESS)
  })

  it("ignores other people and rows that are not token transfers", () => {
    const transactions = [
      { action: "send", token, toTag: "bob", to: OTHER },
      { action: "receive", token, from: "bob", senderL2Address: OTHER },
      { action: "send", toTag: "grace", to: OTHER },
    ]
    expect(pastAddressOf("grace", transactions as never)).toBeUndefined()
  })
})

describe("saveUnsavedContact", () => {
  it("saves the address the page showed once a fresh read confirms it", async () => {
    m.commit.mockResolvedValue(resolved())
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("added")
    expect(m.commit).toHaveBeenCalledWith("grace")
    expect(m.addContact).toHaveBeenCalledWith("grace", ADDRESS, undefined, undefined, "grace")
  })

  it("refuses when the registry moved on since the page resolved it", async () => {
    m.commit.mockResolvedValue(resolved(`0x${"3d".repeat(32)}`))
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("changed")
    m.commit.mockResolvedValue({ status: "notFound" })
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("changed")
    expect(m.addContact).not.toHaveBeenCalled()
  })

  it("does not duplicate a tag saved elsewhere meanwhile", async () => {
    m.commit.mockResolvedValue(resolved())
    m.entries = [{ tag: "grace", address: ADDRESS }]
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("added")
    expect(m.addContact).not.toHaveBeenCalled()
  })

  it("approves the row the wallet added for the tag", async () => {
    m.commit.mockResolvedValue(resolved())
    m.entries = [{ tag: "grace", address: ADDRESS, autoAdded: true }]
    expect(await saveUnsavedContact(unsavedContact("grace", ADDRESS))).toBe("added")
    expect(m.addContact).toHaveBeenCalledWith("grace", ADDRESS, undefined, undefined, "grace")
  })

  it("throws when storage refuses the write", async () => {
    m.commit.mockResolvedValue(resolved())
    m.addContact.mockResolvedValue({ success: false, errors: "quota" })
    await expect(saveUnsavedContact(unsavedContact("grace", ADDRESS))).rejects.toThrow("quota")
  })
})
