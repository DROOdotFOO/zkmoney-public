// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deriveBootstrapKey, type FieldLike, type IStorageAdapter } from "@obsidion/front-core"
import { Fr } from "@aztec-labs/aztec.js/fields"

const {
  build,
  constructed,
  create,
  createBackend,
  fetchInboxStates,
  getInboxIdForIdentifier,
  revokeInstallations,
} = vi.hoisted(() => ({
  build: vi.fn(),
  constructed: [] as { close: () => void }[],
  create: vi.fn(),
  createBackend: vi.fn(),
  fetchInboxStates: vi.fn(),
  getInboxIdForIdentifier: vi.fn(),
  revokeInstallations: vi.fn(),
}))

/**
 * A warm start constructs a client and initializes it. `build` stands for that pair: once it
 * resolves, the constructed client takes on the fake it returned.
 */
function FakeClient(options: unknown) {
  const client = {
    close: vi.fn(),
    async init(identifier: unknown) {
      Object.assign(client, await build(identifier, options))
    },
  }
  constructed.push(client)
  return client
}

vi.mock("@xmtp/browser-sdk", () => ({
  Client: Object.assign(FakeClient, { create, fetchInboxStates, revokeInstallations }),
  createBackend,
  getInboxIdForIdentifier,
  ConsentState: { Allowed: 0, Denied: 1, Unknown: 2 },
  IdentifierKind: { Ethereum: 0 },
  LogLevel: { Off: "off" },
  SortDirection: { Ascending: 0 },
  Opfs: { create: vi.fn() },
}))

import {
  WebXmtpClient,
  XMTP_BUILD_RETRY_MS,
  XMTP_INBOX_ID_STORAGE_KEY,
  xmtpInboxIdStorageKey,
} from "../../../src/platform/xmtp/WebXmtpClient"

const MSK = new Fr(0x1d2e6d495f21b28eb37e21e0dbbbd45dc18ed2eb2785be076d1c1d18c9c0efbbn)
const MSK_B = new Fr(2n)
const BOOTSTRAP_ADDRESS = deriveBootstrapKey(MSK).address
const CACHE_KEY = xmtpInboxIdStorageKey(BOOTSTRAP_ADDRESS)
const BACKEND = { kind: "backend" }
const INBOX_ID = "inbox-full"
const REVOKED_AT_KEY = `xmtp.v2.revokedAt.${INBOX_ID}`

const CAP_ERROR = new Error(
  "Cannot register a new installation because the InboxID 81e13de9204a0 has already registered 10/10 installations. Please revoke existing installations first.",
)

function memoryStorage(
  seed: Record<string, string> = {},
): IStorageAdapter & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => void map.set(key, value),
    removeItem: async (key) => void map.delete(key),
    clear: async () => void map.clear(),
  } as IStorageAdapter & { map: Map<string, string> }
}

interface FakeClientOptions {
  inboxId?: string
  registered?: boolean
  register?: () => Promise<void>
  close?: () => void
}

function fakeClient(overrides: FakeClientOptions = {}) {
  return {
    inboxId: "inboxId" in overrides ? overrides.inboxId : "inbox-fresh",
    isRegistered: vi.fn(async () => overrides.registered ?? true),
    register: vi.fn(overrides.register ?? (async () => {})),
    close: vi.fn(overrides.close ?? (() => {})),
  }
}

/** `count` installations with distinct timestamps; `oldest` gets the smallest one. */
function installations(count: number, oldest = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `inst-${i}`,
    bytes: Uint8Array.of(i),
    clientTimestampNs: i === oldest ? 1n : BigInt(100 + i),
  }))
}

/** Put the account's inbox on the network with the given installations. */
function inboxWith(list: ReturnType<typeof installations>) {
  getInboxIdForIdentifier.mockResolvedValue(INBOX_ID)
  fetchInboxStates.mockResolvedValue([{ inboxId: INBOX_ID, installations: list }])
}

async function createWith(storage: IStorageAdapter, msk: FieldLike = MSK, signal?: AbortSignal) {
  return WebXmtpClient.create({
    msk,
    dbEncryptionKey: new Uint8Array(32),
    env: "local",
    storage,
    signal,
  })
}

/** Runs a cold start on fake timers so the cap-check backoff elapses instantly. */
async function createThroughBackoff(storage: IStorageAdapter, signal?: AbortSignal) {
  vi.useFakeTimers()
  try {
    const pending = createWith(storage, MSK, signal)
    pending.catch(() => {})
    await vi.runAllTimersAsync()
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

function expectNoCapCheck() {
  expect(createBackend).not.toHaveBeenCalled()
  expect(fetchInboxStates).not.toHaveBeenCalled()
  expect(revokeInstallations).not.toHaveBeenCalled()
}

beforeEach(() => {
  for (const mock of [
    build,
    create,
    createBackend,
    fetchInboxStates,
    getInboxIdForIdentifier,
    revokeInstallations,
  ]) {
    mock.mockReset()
  }
  constructed.length = 0
  createBackend.mockResolvedValue(BACKEND)
  getInboxIdForIdentifier.mockResolvedValue(undefined)
  fetchInboxStates.mockResolvedValue([])
  revokeInstallations.mockResolvedValue(undefined)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("WebXmtpClient warm-start registration guard", () => {
  it("cold-starts via Client.create when no inboxId is cached for this account", async () => {
    const storage = memoryStorage()
    const fresh = fakeClient()
    create.mockResolvedValue(fresh)
    const client = await createWith(storage)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ disableAutoRegister: true }),
    )
    expect(fresh.register).toHaveBeenCalledTimes(1)
    expect(build).not.toHaveBeenCalled()
    expect(client.isFirstInstallation).toBe(true)
    expect(storage.map.get(CACHE_KEY)).toBe("inbox-fresh")
    expect(storage.map.has(XMTP_INBOX_ID_STORAGE_KEY)).toBe(false)
    client.close()
    expect(fresh.close).toHaveBeenCalledTimes(1)
  })

  it("warm-starts via Client.build when this account's cached client is registered", async () => {
    const storage = memoryStorage({ [CACHE_KEY]: "inbox-cached" })
    const cached = fakeClient({ inboxId: "inbox-cached" })
    build.mockResolvedValue(cached)
    const client = await createWith(storage)
    expect(build).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(cached.register).not.toHaveBeenCalled()
    expectNoCapCheck()
    expect(client.isFirstInstallation).toBe(false)
  })

  it("ignores a leftover unkeyed inboxId from a previous account", async () => {
    const storage = memoryStorage({ [XMTP_INBOX_ID_STORAGE_KEY]: "inbox-stale-global" })
    create.mockResolvedValue(fakeClient())
    await createWith(storage)
    expect(build).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(storage.map.has(XMTP_INBOX_ID_STORAGE_KEY)).toBe(false)
    expect(storage.map.get(CACHE_KEY)).toBe("inbox-fresh")
  })

  it("does not warm-start from another account's cached inboxId", async () => {
    const storage = memoryStorage({ [CACHE_KEY]: "inbox-a" })
    create.mockResolvedValue(fakeClient({ inboxId: "inbox-b" }))
    const client = await createWith(storage, MSK_B)
    expect(build).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(client.isFirstInstallation).toBe(true)
    expect(storage.map.get(CACHE_KEY)).toBe("inbox-a")
    expect(storage.map.get(xmtpInboxIdStorageKey(deriveBootstrapKey(MSK_B).address))).toBe(
      "inbox-b",
    )
  })

  it("falls back to Client.create when the warm-started client is unregistered", async () => {
    const storage = memoryStorage({ [CACHE_KEY]: "inbox-stale" })
    const unregistered = fakeClient({ inboxId: "inbox-stale", registered: false })
    build.mockResolvedValue(unregistered)
    create.mockResolvedValue(fakeClient({ inboxId: "inbox-new" }))
    const client = await createWith(storage)
    expect(unregistered.close).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(client.isFirstInstallation).toBe(true)
    expect(storage.map.get(CACHE_KEY)).toBe("inbox-new")
  })

  it("retries a build that throws, closing the failed one, and warm-starts once it opens", async () => {
    const storage = memoryStorage({ [CACHE_KEY]: "inbox-cached" })
    const cached = fakeClient({ inboxId: "inbox-cached" })
    build.mockRejectedValueOnce(new Error("database busy")).mockResolvedValue(cached)
    const client = await createThroughBackoff(storage)
    expect(build).toHaveBeenCalledTimes(2)
    expect(constructed[0].close).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expectNoCapCheck()
    expect(client.isFirstInstallation).toBe(false)
  })

  it("cold-starts once every build throws, freeing a slot in a full inbox", async () => {
    build.mockRejectedValue(CAP_ERROR)
    create.mockResolvedValue(fakeClient({ inboxId: INBOX_ID }))
    inboxWith(installations(10))
    const client = await createThroughBackoff(memoryStorage({ [CACHE_KEY]: INBOX_ID }))
    expect(build).toHaveBeenCalledTimes(XMTP_BUILD_RETRY_MS.length + 1)
    for (const failed of constructed) expect(failed.close).toHaveBeenCalledTimes(1)
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(client.isFirstInstallation).toBe(true)
  })
})

describe("WebXmtpClient cold-start registration failure", () => {
  it("closes the client and rethrows the registration error", async () => {
    const err = new Error("network down")
    const failed = fakeClient({ register: async () => Promise.reject(err) })
    create.mockResolvedValue(failed)
    await expect(createWith(memoryStorage())).rejects.toBe(err)
    expect(failed.close).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("passes a non-Error rejection through unchanged", async () => {
    const failed = fakeClient({ register: async () => Promise.reject("weird") })
    create.mockResolvedValue(failed)
    await expect(createWith(memoryStorage())).rejects.toBe("weird")
    expect(failed.close).toHaveBeenCalledTimes(1)
  })

  it("keeps the registration error when close itself throws", async () => {
    const err = new Error("network down")
    const failed = fakeClient({
      register: async () => Promise.reject(err),
      close: () => {
        throw new Error("close failed")
      },
    })
    create.mockResolvedValue(failed)
    await expect(createWith(memoryStorage())).rejects.toBe(err)
  })
})

describe("WebXmtpClient installation cap preflight", () => {
  it("revokes the oldest of ten installations before building the client", async () => {
    const storage = memoryStorage()
    const fresh = fakeClient({ inboxId: INBOX_ID })
    create.mockResolvedValue(fresh)
    inboxWith(installations(10, 6))
    let reservedBeforeRevoke = false
    revokeInstallations.mockImplementation(async () => {
      reservedBeforeRevoke = storage.map.has(REVOKED_AT_KEY)
    })

    const client = await createWith(storage)

    expect(reservedBeforeRevoke).toBe(true)
    expect(console.warn).not.toHaveBeenCalledWith(
      "[xmtp] installation cap check failed",
      expect.anything(),
    )
    expect(createBackend).toHaveBeenCalledWith({ env: "local" })
    expect(getInboxIdForIdentifier).toHaveBeenCalledWith(
      BACKEND,
      expect.objectContaining({ identifier: BOOTSTRAP_ADDRESS }),
    )
    expect(fetchInboxStates).toHaveBeenCalledWith([INBOX_ID], BACKEND)
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
    const [signer, inboxId, ids, backend] = revokeInstallations.mock.calls[0]!
    expect(signer.getIdentifier().identifier).toBe(BOOTSTRAP_ADDRESS)
    expect(inboxId).toBe(INBOX_ID)
    expect(ids).toEqual([Uint8Array.of(6)])
    expect(backend).toBe(BACKEND)
    expect(revokeInstallations.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0]!,
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(fresh.register).toHaveBeenCalledTimes(1)
    expect(client.isFirstInstallation).toBe(true)
    expect(storage.map.get(CACHE_KEY)).toBe(INBOX_ID)
    expect(storage.map.has(REVOKED_AT_KEY)).toBe(true)
  })

  it("waits for the revoke to settle before building", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(10))
    let settleRevoke: (() => void) | undefined
    revokeInstallations.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleRevoke = resolve
        }),
    )
    const pending = createWith(memoryStorage())
    await new Promise((r) => setTimeout(r, 0))
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    settleRevoke!()
    await pending
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("treats an installation without a timestamp as the oldest", async () => {
    create.mockResolvedValue(fakeClient())
    const list = installations(10, 0)
    delete (list[3] as { clientTimestampNs?: bigint }).clientTimestampNs
    inboxWith(list)
    await createWith(memoryStorage())
    expect(revokeInstallations.mock.calls[0]![2]).toEqual([Uint8Array.of(3)])
  })

  it("does not revoke when the inbox is below the cap", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(9))
    await createWith(memoryStorage())
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("does not revoke when the inbox reports no installations", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith([])
    await createWith(memoryStorage())
    expect(revokeInstallations).not.toHaveBeenCalled()
  })

  it("does not revoke above the cap, where one revoke would not free a slot", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(11))
    await createWith(memoryStorage())
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("skips the check for an identity that has no inbox yet", async () => {
    create.mockResolvedValue(fakeClient())
    await createWith(memoryStorage())
    expect(getInboxIdForIdentifier).toHaveBeenCalledTimes(1)
    expect(fetchInboxStates).not.toHaveBeenCalled()
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("does not revoke again within the cooldown", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(10))
    const storage = memoryStorage({ [REVOKED_AT_KEY]: String(Date.now() - 60_000) })
    await createWith(storage)
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("revokes again once the cooldown has passed", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(10, 2))
    const storage = memoryStorage({ [REVOKED_AT_KEY]: String(Date.now() - 11 * 60_000) })
    await createWith(storage)
    expect(revokeInstallations.mock.calls[0]![2]).toEqual([Uint8Array.of(2)])
    expect(Number(storage.map.get(REVOKED_AT_KEY))).toBeGreaterThan(Date.now() - 5_000)
  })

  it("ignores a revoke marker that is unreadable or in the future", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(10))
    await createWith(memoryStorage({ [REVOKED_AT_KEY]: "Infinity" }))
    await createWith(memoryStorage({ [REVOKED_AT_KEY]: String(Date.now() + 60 * 60_000) }))
    await createWith(memoryStorage({ [REVOKED_AT_KEY]: "not a number" }))
    expect(revokeInstallations).toHaveBeenCalledTimes(3)
  })

  it("retries the check after a transient backend failure and still revokes", async () => {
    create.mockResolvedValue(fakeClient())
    createBackend.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(BACKEND)
    inboxWith(installations(10))
    await createThroughBackoff(memoryStorage())
    expect(createBackend).toHaveBeenCalledTimes(2)
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalledWith(
      "[xmtp] installation cap check failed",
      expect.anything(),
    )
  })

  it("backs off before retrying the check", async () => {
    create.mockResolvedValue(fakeClient())
    createBackend.mockRejectedValue(new Error("offline"))
    vi.useFakeTimers()
    try {
      const pending = createWith(memoryStorage())
      await vi.advanceTimersByTimeAsync(0)
      expect(createBackend).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(499)
      expect(createBackend).toHaveBeenCalledTimes(1)
      expect(create).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(createBackend).toHaveBeenCalledTimes(2)
      await vi.runAllTimersAsync()
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it("builds the client anyway when the backend cannot be created", async () => {
    create.mockResolvedValue(fakeClient())
    createBackend.mockRejectedValue(new Error("offline"))
    await createThroughBackoff(memoryStorage())
    expect(createBackend).toHaveBeenCalledTimes(3)
    expect(create).toHaveBeenCalledTimes(1)
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      "[xmtp] installation cap check failed",
      expect.any(Error),
    )
  })

  it("builds the client anyway when the inbox state fetch fails", async () => {
    create.mockResolvedValue(fakeClient())
    getInboxIdForIdentifier.mockResolvedValue(INBOX_ID)
    fetchInboxStates.mockRejectedValue(new Error("offline"))
    await createThroughBackoff(memoryStorage())
    expect(fetchInboxStates).toHaveBeenCalledTimes(3)
    expect(create).toHaveBeenCalledTimes(1)
    expect(revokeInstallations).not.toHaveBeenCalled()
  })

  it("builds the client anyway when the revoke keeps failing, releasing the cooldown", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(10))
    revokeInstallations.mockRejectedValue(new Error("signature rejected"))
    const storage = memoryStorage()
    await createThroughBackoff(storage)
    expect(revokeInstallations).toHaveBeenCalledTimes(3)
    expect(create).toHaveBeenCalledTimes(1)
    expect(storage.map.has(REVOKED_AT_KEY)).toBe(false)
  })

  it("retries the revoke within the same cold start after a transient failure", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(10))
    revokeInstallations.mockRejectedValueOnce(new Error("network down"))
    const storage = memoryStorage()
    await createThroughBackoff(storage)
    expect(revokeInstallations).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
    expect(storage.map.has(REVOKED_AT_KEY)).toBe(true)
  })

  it("skips the retry revoke when the failed one had landed", async () => {
    create.mockResolvedValue(fakeClient())
    getInboxIdForIdentifier.mockResolvedValue(INBOX_ID)
    fetchInboxStates
      .mockResolvedValueOnce([{ inboxId: INBOX_ID, installations: installations(10) }])
      .mockResolvedValue([{ inboxId: INBOX_ID, installations: installations(9) }])
    revokeInstallations.mockRejectedValueOnce(new Error("timeout"))
    const storage = memoryStorage()
    await createThroughBackoff(storage)
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(storage.map.has(REVOKED_AT_KEY)).toBe(false)
  })

  it("does not revoke when the cooldown cannot be reserved", async () => {
    create.mockResolvedValue(fakeClient())
    inboxWith(installations(10))
    const storage = memoryStorage()
    const setItem = storage.setItem
    storage.setItem = async (key, value) => {
      if (key === REVOKED_AT_KEY) throw new Error("quota")
      return setItem(key, value)
    }
    await createThroughBackoff(storage)
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("propagates the build error when libxmtp still refuses at the cap", async () => {
    create.mockRejectedValue(CAP_ERROR)
    inboxWith(installations(10))
    await expect(createWith(memoryStorage())).rejects.toBe(CAP_ERROR)
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("propagates the registration error after a successful revoke", async () => {
    const failed = fakeClient({ register: async () => Promise.reject(CAP_ERROR) })
    create.mockResolvedValue(failed)
    inboxWith(installations(10))
    await expect(createWith(memoryStorage())).rejects.toBe(CAP_ERROR)
    expect(failed.close).toHaveBeenCalledTimes(1)
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
  })
})

describe("WebXmtpClient abandoned cold start", () => {
  it("throws before any SDK call when already abandoned", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      createWith(memoryStorage({ [CACHE_KEY]: "inbox-cached" }), MSK, ac.signal),
    ).rejects.toThrow("abandoned")
    expect(build).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expectNoCapCheck()
  })

  it("never builds when abandoned during a failing warm start", async () => {
    const ac = new AbortController()
    build.mockImplementation(async () => {
      ac.abort()
      throw new Error("stale db")
    })
    await expect(
      createWith(memoryStorage({ [CACHE_KEY]: "inbox-cached" }), MSK, ac.signal),
    ).rejects.toThrow("abandoned")
    expect(create).not.toHaveBeenCalled()
    expectNoCapCheck()
  })

  it("closes a warm-built client when abandoned during the build", async () => {
    const ac = new AbortController()
    const built = fakeClient({ inboxId: "inbox-cached" })
    build.mockImplementation(async () => {
      ac.abort()
      return built
    })
    await expect(
      createWith(memoryStorage({ [CACHE_KEY]: "inbox-cached" }), MSK, ac.signal),
    ).rejects.toThrow("abandoned")
    expect(built.isRegistered).not.toHaveBeenCalled()
    expect(built.close).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  it("does not look up the inbox when abandoned during backend creation", async () => {
    const ac = new AbortController()
    createBackend.mockImplementation(async () => {
      ac.abort()
      return BACKEND
    })
    await expect(createWith(memoryStorage(), MSK, ac.signal)).rejects.toThrow("abandoned")
    expect(getInboxIdForIdentifier).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("does not fetch state when abandoned during the inbox lookup", async () => {
    const ac = new AbortController()
    getInboxIdForIdentifier.mockImplementation(async () => {
      ac.abort()
      return INBOX_ID
    })
    await expect(createWith(memoryStorage(), MSK, ac.signal)).rejects.toThrow("abandoned")
    expect(fetchInboxStates).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("does not revoke when abandoned during the inbox state fetch", async () => {
    const ac = new AbortController()
    getInboxIdForIdentifier.mockResolvedValue(INBOX_ID)
    fetchInboxStates.mockImplementation(async () => {
      ac.abort()
      return [{ inboxId: INBOX_ID, installations: installations(10) }]
    })
    await expect(createWith(memoryStorage(), MSK, ac.signal)).rejects.toThrow("abandoned")
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("releases the reservation when abandoned while reserving the cooldown", async () => {
    const ac = new AbortController()
    inboxWith(installations(10))
    const storage = memoryStorage()
    const setItem = storage.setItem
    storage.setItem = async (key, value) => {
      if (key === REVOKED_AT_KEY) ac.abort()
      return setItem(key, value)
    }
    await expect(createWith(storage, MSK, ac.signal)).rejects.toThrow("abandoned")
    expect(revokeInstallations).not.toHaveBeenCalled()
    expect(storage.map.has(REVOKED_AT_KEY)).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it("does not build when abandoned during the revoke", async () => {
    const ac = new AbortController()
    inboxWith(installations(10))
    revokeInstallations.mockImplementation(async () => {
      ac.abort()
    })
    const storage = memoryStorage()
    await expect(createWith(storage, MSK, ac.signal)).rejects.toThrow("abandoned")
    expect(revokeInstallations).toHaveBeenCalledTimes(1)
    expect(storage.map.has(REVOKED_AT_KEY)).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it("does not register a client built for an abandoned attempt", async () => {
    const ac = new AbortController()
    const built = fakeClient()
    create.mockImplementation(async () => {
      ac.abort()
      return built
    })
    await expect(createWith(memoryStorage(), MSK, ac.signal)).rejects.toThrow("abandoned")
    expect(built.close).toHaveBeenCalledTimes(1)
    expect(built.register).not.toHaveBeenCalled()
  })

  it("closes a client that registered after the attempt was abandoned, but keeps the cache", async () => {
    const ac = new AbortController()
    const built = fakeClient({
      register: async () => {
        ac.abort()
      },
    })
    create.mockResolvedValue(built)
    const storage = memoryStorage()
    await expect(createWith(storage, MSK, ac.signal)).rejects.toThrow("abandoned")
    expect(built.close).toHaveBeenCalledTimes(1)
    expect(storage.map.get(CACHE_KEY)).toBe("inbox-fresh")
  })

  it("stops retrying the check when abandoned during the backoff", async () => {
    const ac = new AbortController()
    createBackend.mockRejectedValue(new Error("offline"))
    vi.useFakeTimers()
    try {
      const pending = createWith(memoryStorage(), MSK, ac.signal)
      pending.catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      expect(createBackend).toHaveBeenCalledTimes(1)
      ac.abort()
      await expect(pending).rejects.toThrow("abandoned")
      expect(createBackend).toHaveBeenCalledTimes(1)
      expect(create).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
