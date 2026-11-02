import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ERR_INVALID,
  ERR_TAG_MISMATCH,
  PendingConnectBackStorage,
  decodeInline,
  encodeInline,
  type Contact,
  type IStorageAdapter,
} from "@obsidion/front-core"
import {
  CONNECT_STASH_KEY,
  captureConnectStash,
  confirmConnect,
  hasConnectStash,
  previewConnect,
  stashToPayload,
  takeConnectStash,
  type ConnectStash,
} from "../../../src/features/contacts/connectReceive"

/* ----------------------------- fixtures / fakes ---------------------------- */

const UUID = "a1b2c3d4-e5f6-4a7b-89ab-cdef01234567"
const PEER_XMTP = "0x" + "ab".repeat(20)
const PEER_L2 = "0x" + "2".repeat(64)
const OWN_L2 = "0x" + "3".repeat(64)

function packet(overrides: object = {}): string {
  return encodeInline({
    version: "1.0:testnet",
    kind: "handshake",
    xmtpHandle: PEER_XMTP,
    uuid: UUID,
    l2Address: PEER_L2,
    tag: "alice",
    ...overrides,
  })
}

/** sessionStorage-shaped store. */
function memoryStore() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

class MemoryAdapter implements IStorageAdapter {
  private map = new Map<string, string>()
  async getItem(key: string) {
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  async removeItem(key: string) {
    this.map.delete(key)
  }
  async clear() {
    this.map.clear()
  }
}

const loc = (over: object = {}) => ({
  pathname: "/connect",
  hash: `#${packet()}`,
  ...over,
})

const previewDeps = (over: object = {}) => ({
  decodeInline,
  verifyTag: async () => ({ l2Address: PEER_L2, xmtpAddress: PEER_XMTP }),
  ownTag: "bob",
  ownL2Address: OWN_L2,
  ...over,
})

async function previewOf(payload: string, over: object = {}) {
  const result = await previewConnect(payload, previewDeps(over))
  if (result.kind !== "confirm") throw new Error(`expected confirm, got ${result.kind}`)
  return result.preview
}

/* --------------------------------- stash ---------------------------------- */

describe("connect stash (AE6)", () => {
  it("captures the fragment pre-gate and is consumed once", () => {
    const store = memoryStore()
    expect(captureConnectStash(loc(), store)).toBe(true)
    expect(hasConnectStash(store)).toBe(true)

    // Simulated gate redirect: nothing else touches the store; the stash survives.
    const stash = takeConnectStash(store)
    expect(stash).toEqual({ hash: `#${packet()}` })
    // Consume-once: a second read finds nothing.
    expect(takeConnectStash(store)).toBeNull()
    expect(hasConnectStash(store)).toBe(false)
  })

  it("does not capture without a fragment or off the /connect path", () => {
    const store = memoryStore()
    expect(captureConnectStash(loc({ hash: "" }), store)).toBe(false)
    expect(captureConnectStash(loc({ pathname: "/contacts" }), store)).toBe(false)
    expect(store.getItem(CONNECT_STASH_KEY)).toBeNull()
  })

  it("stashes only the fragment — no host label can be mistaken for the sharer's tag", () => {
    const store = memoryStore()
    captureConnectStash(loc(), store)
    expect(takeConnectStash(store)).toEqual({ hash: `#${packet()}` })
  })

  it("rebuilds a scan payload the shared parser re-validates", () => {
    const stash: ConnectStash = { hash: "#pkt" }
    expect(stashToPayload(stash)).toBe("https://zk.money/connect#pkt")
  })
})

/* -------------------------------- preview ---------------------------------- */

describe("previewConnect", () => {
  const payload = () => stashToPayload({ hash: `#${packet()}` })

  it("decodes and verifies without writing anything", async () => {
    const preview = await previewOf(payload())
    expect(preview.verified).toBe(true)
    expect(preview.pending).toBe(false)
    expect(preview.contact).toMatchObject({ tag: "alice", address: PEER_L2, provenance: "qr-scan" })
    expect(preview.packet.uuid).toBe(UUID)
  })

  it("rejects a registry mismatch as unsafe", async () => {
    const result = await previewConnect(payload(), {
      ...previewDeps(),
      verifyTag: async () => ({ l2Address: "0x" + "9".repeat(64) }),
    })
    expect(result).toEqual({ kind: "error", message: ERR_TAG_MISMATCH })
  })

  it("an unregistered tag proceeds unverified", async () => {
    const preview = await previewOf(payload(), { verifyTag: async () => null })
    expect(preview.verified).toBe(false)
  })

  it("a transient registry failure fails open (unverified)", async () => {
    const preview = await previewOf(payload(), {
      verifyTag: async () => {
        throw new Error("network")
      },
    })
    expect(preview.verified).toBe(false)
  })

  it("a tag-less packet stays unverified with no tag", async () => {
    const verifyTag = vi.fn()
    const preview = await previewOf(stashToPayload({ hash: `#${packet({ tag: undefined })}` }), {
      verifyTag,
    })
    expect(verifyTag).not.toHaveBeenCalled()
    expect(preview.verified).toBe(false)
    expect(preview.contact.tag).toBeUndefined()
  })

  it("detects a self-scan by own L2 address or own tag", async () => {
    expect(await previewConnect(payload(), previewDeps({ ownL2Address: PEER_L2 }))).toEqual({
      kind: "self-scan",
    })
    expect(await previewConnect(payload(), previewDeps({ ownTag: "Alice" }))).toEqual({
      kind: "self-scan",
    })
  })

  it("maps garbage payloads and packets to the invalid error", async () => {
    expect(await previewConnect("https://example.com/nope", previewDeps())).toEqual({
      kind: "error",
      message: ERR_INVALID,
    })
    expect(await previewConnect(stashToPayload({ hash: "#AAAA" }), previewDeps())).toEqual({
      kind: "error",
      message: ERR_INVALID,
    })
  })

  it("a packet with no L2 address anywhere previews as pending-handshake", async () => {
    const preview = await previewOf(
      stashToPayload({ hash: `#${packet({ l2Address: undefined })}` }),
      { verifyTag: async () => null },
    )
    expect(preview.pending).toBe(true)
    expect(preview.contact.addressKind).toBe("pending-handshake")
  })
})

/* ------------------------------ confirm (AE10) ------------------------------ */

describe("confirmConnect", () => {
  let contacts: Contact[]
  let queue: PendingConnectBackStorage

  beforeEach(() => {
    contacts = []
    PendingConnectBackStorage.resetForTests()
    queue = PendingConnectBackStorage.get(new MemoryAdapter())
  })

  const confirmDeps = (over: object = {}) => ({
    addOrMergeContact: async (entry: Contact) => {
      contacts.push(entry)
      return entry
    },
    queueConnectBack: (entry: { uuid: string; peerXmtp: string; content: object }) =>
      queue.enqueue(entry as never),
    connectBackVersion: 1,
    ...over,
  })

  it("dismissal writes no contact and queues no connect-back (AE10)", async () => {
    // The full pre-confirm flow: stash → take → preview. Dismiss = simply never confirming.
    const store = memoryStore()
    captureConnectStash(loc(), store)
    const stash = takeConnectStash(store)!
    await previewOf(stashToPayload(stash))

    expect(contacts).toEqual([])
    expect(await queue.list()).toEqual([])
    expect(takeConnectStash(store)).toBeNull() // stash gone — a re-render can't replay it
  })

  it("confirm writes the contact and queues the connect-back", async () => {
    const preview = await previewOf(stashToPayload({ hash: `#${packet()}` }))
    const result = await confirmConnect(preview, confirmDeps())

    expect(result).toMatchObject({ kind: "added", navigateId: "alice", pending: false })
    expect(contacts).toHaveLength(1)
    const queued = await queue.list()
    expect(queued).toMatchObject([{ uuid: UUID, content: { version: 1, uuid: UUID } }])
    // The codec re-checksums the EVM address; the send target is the same account.
    expect(queued[0].peerXmtp.toLowerCase()).toBe(PEER_XMTP)
  })

  it("a live sender delivers the connect-back; only an undeliverable send is queued", async () => {
    const preview = await previewOf(stashToPayload({ hash: `#${packet()}` }))
    const sent: string[] = []
    await confirmConnect(
      preview,
      confirmDeps({
        sendConnectBack: async (peer: string) => {
          sent.push(peer)
          return { ok: true }
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent.map((p) => p.toLowerCase())).toEqual([PEER_XMTP])
    expect(await queue.list()).toEqual([])

    await confirmConnect(
      preview,
      confirmDeps({
        sendConnectBack: async () => ({ ok: false, reason: "recipient-not-reachable" }),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await queue.list()).toMatchObject([{ uuid: UUID }])
  })

  it("confirm stamps the scanner's ownTag onto the queued connect-back", async () => {
    const preview = await previewOf(stashToPayload({ hash: `#${packet()}` }))
    await confirmConnect(preview, confirmDeps({ ownTag: "@Bob" }))
    const queued = await queue.list()
    expect(queued).toMatchObject([{ content: { version: 1, uuid: UUID, tag: "bob" } }])
  })

  it("a failed add reports an error and queues nothing", async () => {
    const preview = await previewOf(stashToPayload({ hash: `#${packet()}` }))
    const result = await confirmConnect(
      preview,
      confirmDeps({
        addOrMergeContact: async () => {
          throw new Error("storage down")
        },
      }),
    )
    expect(result).toEqual({ kind: "error", message: ERR_INVALID })
    expect(await queue.list()).toEqual([])
  })

  it("a stored contact under another tag is a conflict: nothing added, nothing queued", async () => {
    const preview = await previewOf(stashToPayload({ hash: `#${packet()}` }))
    const existing: Contact = { name: "old-tag", tag: "old-tag", address: PEER_L2, autoAdded: true }
    const result = await confirmConnect(
      preview,
      confirmDeps({ addOrMergeContact: async () => existing }),
    )
    expect(result).toEqual({ kind: "conflict", contact: existing })
    expect(await queue.list()).toEqual([])
  })

  it("a failed queue still reports the contact as added", async () => {
    const preview = await previewOf(stashToPayload({ hash: `#${packet()}` }))
    const result = await confirmConnect(
      preview,
      confirmDeps({
        queueConnectBack: async () => {
          throw new Error("storage down")
        },
      }),
    )
    expect(result.kind).toBe("added")
    expect(contacts).toHaveLength(1)
  })

  it("a pending-handshake confirm navigates by the pending row's id", async () => {
    const preview = await previewOf(
      stashToPayload({ hash: `#${packet({ l2Address: undefined })}` }),
      { verifyTag: async () => null },
    )
    const result = await confirmConnect(preview, confirmDeps())
    expect(result).toMatchObject({ kind: "added", pending: true, navigateId: "alice" })
  })
})
