import { Fr } from "@aztec-labs/aztec.js/fields"
import { describe, expect, it } from "vitest"
import {
  BACKUP_ROTATION_ATTENTIONS,
  BACKUP_ROTATION_PHASES,
  BACKUP_ROTATION_STORAGE_KEY,
  BackupRotationStore,
  BackupRotationUnreadableError,
  RotationStrippedError,
  fundingLocalId,
  moveProgress,
  movesBalance,
  persistedRotation,
  rerootAhead,
  storeRotation,
  stripSettled,
  type BackupFunding,
  type BackupRotationPhase,
  type BackupRotationRecord,
  type BackupRotationStored,
  type IStorageAdapter,
} from "../../src/index.js"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const OWNER = "0xAbCdEf0000000000000000000000000000001234"
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`

const stored = (over: Partial<BackupRotationStored> = {}): BackupRotationStored => ({
  owner: addr(1),
  intent: {
    rollupVersion: "6",
    precondition: { target: addr(2), data: "0x1234", resultHash: word(3) },
    postcondition: { target: addr(2), data: "0x1234", resultHash: word(4) },
    recipientCommitment: word(5),
    owner: addr(1),
    nonce: "7",
    callData: "0xabcd",
    accountGasLimits: word(8),
  },
  sharedSecretSalt: word(9),
  nonce: "7",
  builtOver: {
    l2Address: word(10),
    rollupVersion: "6",
    publicKey: { x: "11", y: "12" },
    resolverOperator: addr(13),
  },
  expectedKeys: [{ key: { qx: word(14), qy: word(15) }, metadata: "0x" }],
  implementation: addr(16),
  deployArgs: {
    implementation: addr(16),
    intentHash: word(17),
    recoveryCommitment: word(18),
    rollupVersion: "6",
    resweepable: false,
    forwardingTable: addr(19),
  },
  sipa: addr(20),
  add: { pubkey: { qx: word(21), qy: word(22) }, credentialId: "0x2324", envelope: "0x25" },
  signature: "0x26",
  ...over,
})

const funding = (over: Partial<BackupFunding> = {}): BackupFunding => ({
  attemptId: "attempt-1",
  localId: fundingLocalId("attempt-1"),
  sentAt: 5,
  session: "life-1",
  txHash: word(30),
  expiresAtMs: 99,
  outcome: "pending",
  ...over,
})

const record = (over: Partial<BackupRotationRecord> = {}): BackupRotationRecord => ({
  owner: OWNER,
  attemptId: "attempt-1",
  phase: "created",
  backup: {
    credentialId: "backup-credential",
    pubkeyHex: "ab".repeat(64),
    envelopeHex: "01".repeat(62),
    userHandle: "YnJhdmUtb3R0ZXI",
    prfSlot: "first",
    securityKey: false,
  },
  plan: {
    address: "0x22",
    fundingAmount: "2000",
    deposited: "1800",
    credited: "1400",
    approvals: 1,
    moves: 2,
  },
  rotation: stored(),
  fundings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const blob = (key: string, value: unknown) => JSON.stringify({ [key]: value })

class FailingStorage extends InMemoryStorageAdapter {
  override async setItem(): Promise<void> {
    throw new Error("disk full")
  }
}

class FlakyStorage extends InMemoryStorageAdapter {
  unreadable = false
  refuseWrites = false
  override async getItem(key: string): Promise<string | null> {
    if (this.unreadable) throw new Error("locked")
    return super.getItem(key)
  }
  override async setItem(key: string, value: string): Promise<void> {
    if (this.refuseWrites) throw new Error("disk full")
    return super.setItem(key, value)
  }
}

describe("BackupRotationStore", () => {
  it("keeps one record per owner, whatever the owner's case", async () => {
    const storage: IStorageAdapter = new InMemoryStorageAdapter()
    const store = new BackupRotationStore(storage)
    await store.put(record())
    await store.put(record({ phase: "signed", owner: OWNER.toLowerCase() }))
    expect((await store.get(OWNER.toUpperCase().replace("0X", "0x")))?.phase).toBe("signed")
    expect(await store.list()).toHaveLength(1)
    await store.remove(OWNER)
    expect(await store.get(OWNER)).toBeNull()
  })

  it("reads a saved record back after a reload", async () => {
    const storage = new InMemoryStorageAdapter()
    await new BackupRotationStore(storage).put(record({ phase: "published" }))
    const reloaded = new BackupRotationStore(storage)
    expect((await reloaded.get(OWNER))?.phase).toBe("published")
    expect(await storage.getItem(BACKUP_ROTATION_STORAGE_KEY)).toContain("published")
  })

  it("reads a plan with no deposited amount", async () => {
    const storage = new InMemoryStorageAdapter()
    await new BackupRotationStore(storage).put(
      record({ plan: { ...record().plan!, deposited: undefined } }),
    )
    const plan = (await new BackupRotationStore(storage).get(OWNER))?.plan
    expect(plan?.fundingAmount).toBe("2000")
    expect(plan?.deposited).toBeUndefined()
  })

  it("round-trips every phase and every attention reason with its fields", async () => {
    const full = (phase: BackupRotationPhase): BackupRotationRecord =>
      record({
        phase,
        fromBlock: 100,
        publish: {
          txHash: word(40),
          l2Block: 12,
          count: 2,
          lastAt: 50,
          history: [{ txHash: word(40), l2Block: 12, at: 50 }],
        },
        fundings: [
          funding({ outcome: "never-sent", txHash: undefined, expiresAtMs: undefined }),
          funding({ attemptId: "attempt-2", localId: fundingLocalId("attempt-2") }),
          funding({
            attemptId: "attempt-3",
            localId: fundingLocalId("attempt-3"),
            outcome: "swept",
          }),
        ],
        installed: { blockHash: word(41) },
        sweep: { index: "3", blockHash: word(42), credited: "1400" },
        unswept: true,
        recovery: { txHash: word(43) },
        reroot: { batch: word(44), switched: true, rebound: true, receiveCode: false },
        move: {
          runs: [
            {
              plannedAt: 60,
              m: 2,
              depositBound: true,
              declined: true,
              chunks: [
                {
                  token: addr(50),
                  amount: "700",
                  state: "included",
                  txHash: word(45),
                  expiresAtMs: 70,
                  inclusion: { blockNumber: 9, blockHash: "0x99" },
                  effect: "reverted",
                },
                {
                  token: addr(50),
                  amount: "700",
                  state: "claimed",
                  claim: { id: "send-1", session: "life-1" },
                },
                { token: addr(50), amount: "700", state: "planned" },
              ],
            },
          ],
        },
      })
    for (const phase of BACKUP_ROTATION_PHASES) {
      const saved =
        phase === "attention"
          ? BACKUP_ROTATION_ATTENTIONS.map((attention) => ({
              ...full(phase),
              attention,
              suspended: "funded" as const,
            }))
          : [full(phase)]
      for (const r of saved) {
        const storage = new InMemoryStorageAdapter()
        await new BackupRotationStore(storage).put(r)
        expect(await new BackupRotationStore(storage).get(OWNER)).toEqual(r)
      }
    }
  })

  it("reads an empty store as absent", async () => {
    expect(await new BackupRotationStore(new InMemoryStorageAdapter()).get(OWNER)).toBeNull()
  })

  it("rejects a write storage refuses, so nothing acts on an unsaved record", async () => {
    const store = new BackupRotationStore(new FailingStorage())
    await expect(store.put(record())).rejects.toThrow("disk full")
    expect(await store.get(OWNER)).toBeNull()
  })

  it("fails closed while storage cannot be read, and serves the saved record once it can", async () => {
    const storage = new FlakyStorage()
    await new BackupRotationStore(storage).put(record({ phase: "published" }))
    storage.unreadable = true
    const store = new BackupRotationStore(storage)
    await expect(store.get(OWNER)).rejects.toThrow(BackupRotationUnreadableError)
    await expect(store.list()).rejects.toThrow(BackupRotationUnreadableError)
    await expect(store.put(record())).rejects.toThrow(BackupRotationUnreadableError)
    storage.unreadable = false
    expect((await store.get(OWNER))?.phase).toBe("published")
  })

  it("fails closed over saved records that do not parse, and keeps them", async () => {
    const storage = new InMemoryStorageAdapter()
    const truncated = '{"0x11": {"owner": "0x11", "attemptId": "a'
    await storage.setItem(BACKUP_ROTATION_STORAGE_KEY, truncated)
    const store = new BackupRotationStore(storage)
    await expect(store.get(OWNER)).rejects.toThrow(BackupRotationUnreadableError)
    await expect(store.put(record())).rejects.toThrow(BackupRotationUnreadableError)
    expect(await storage.getItem(BACKUP_ROTATION_STORAGE_KEY)).toBe(truncated)
  })

  it("fails closed over saved text that is empty or holds a value of the wrong shape", async () => {
    const key = OWNER.toLowerCase()
    const saved = record()
    const signed = record({ phase: "signed" })
    for (const text of [
      "",
      "[]",
      blob(key, null),
      blob(key, { owner: 5 }),
      blob("0x99", saved),
      blob(key, { ...saved, phase: "typo" }),
      blob(key, { ...saved, phase: "attention" }),
      blob(key, { ...saved, fundings: undefined }),
      blob(key, { ...saved, fundings: [{ ...funding(), outcome: "lost" }] }),
      blob(key, { ...saved, fundings: [{ ...funding(), session: undefined }] }),
      blob(key, { ...saved, fundings: [{ ...funding(), txHash: "0x30" }] }),
      blob(key, { ...signed, plan: undefined }),
      blob(key, { ...signed, rotation: undefined }),
      blob(key, { ...signed, rotation: stored({ signature: undefined }) }),
      blob(key, { ...signed, rotation: stored({ sharedSecretSalt: undefined }) }),
      blob(key, { ...signed, rotation: stored({ sharedSecretSalt: `0x${"ff".repeat(32)}` }) }),
      blob(key, { ...signed, rotation: stored({ add: { ...stored().add, envelope: undefined } }) }),
      blob(key, { ...signed, rotation: stored({ sipa: "0x20" }) }),
      blob(key, { ...signed, rotation: stored({ nonce: "seven" }) }),
      blob(key, {
        ...signed,
        rotation: stored({ intent: { ...stored().intent, callData: "0xabc" } }),
      }),
      blob(key, { ...saved, plan: { ...saved.plan, fundingAmount: "oops" } }),
      blob(key, { ...saved, plan: { ...saved.plan, deposited: "oops" } }),
      blob(key, { ...saved, publish: { count: 1, history: [{ txHash: word(1) }] } }),
      blob(key, { ...saved, sweep: { index: 3, blockHash: word(1), credited: "1" } }),
      blob(key, { ...saved, move: { runs: [{ plannedAt: 1, m: 1, depositBound: false }] } }),
      blob(key, {
        ...saved,
        move: { runs: [{ plannedAt: 1, m: 1, depositBound: false, declined: false, chunks: [] }] },
      }),
      blob(key, {
        ...saved,
        move: {
          runs: [
            {
              plannedAt: 1,
              m: 1,
              depositBound: false,
              chunks: [{ token: "t", amount: "1", state: "sent" }],
            },
          ],
        },
      }),
      blob(key, { ...saved, backup: { ...saved.backup, prfSlot: "third" } }),
      blob(key, { ...saved, backup: { ...saved.backup, envelopeHex: undefined } }),
      blob(key, { ...signed, backup: { ...saved.backup, envelopeHex: "zz" } }),
      blob(key, { ...saved, backup: { ...saved.backup, envelopeHex: "01".repeat(61) } }),
    ]) {
      const storage = new InMemoryStorageAdapter()
      await storage.setItem(BACKUP_ROTATION_STORAGE_KEY, text)
      const store = new BackupRotationStore(storage)
      await expect(store.list()).rejects.toThrow(BackupRotationUnreadableError)
      expect(await storage.getItem(BACKUP_ROTATION_STORAGE_KEY)).toBe(text)
    }
  })

  it("reads a finished record back without its envelope, signature and salt", async () => {
    const key = OWNER.toLowerCase()
    const storage = new InMemoryStorageAdapter()
    const finished = stripSettled(
      record({ phase: "done", fundings: [funding({ outcome: "swept" })] }),
    )
    await storage.setItem(BACKUP_ROTATION_STORAGE_KEY, blob(key, finished))
    expect(await new BackupRotationStore(storage).get(OWNER)).toEqual(finished)
  })

  it("keeps nothing from a load it rejected, so a repaired blob is read whole", async () => {
    const key = OWNER.toLowerCase()
    const storage = new InMemoryStorageAdapter()
    await storage.setItem(
      BACKUP_ROTATION_STORAGE_KEY,
      JSON.stringify({ [key]: record({ phase: "signed" }), "0x22": null }),
    )
    const store = new BackupRotationStore(storage)
    await expect(store.get(OWNER)).rejects.toThrow(BackupRotationUnreadableError)
    const repaired = record({ phase: "published", fundings: [funding()] })
    await storage.setItem(
      BACKUP_ROTATION_STORAGE_KEY,
      JSON.stringify({
        [key]: repaired,
        "0x22": record({ owner: "0x22", plan: undefined, rotation: undefined }),
      }),
    )
    expect(await store.get(OWNER)).toEqual(repaired)
    expect((await store.list()).length).toBe(2)
    const text = (await storage.getItem(BACKUP_ROTATION_STORAGE_KEY))!
    expect(JSON.parse(text)[key].phase).toBe("published")
  })

  it("drops a record only while it still passes the check", async () => {
    const store = new BackupRotationStore(new InMemoryStorageAdapter())
    await store.put(record())
    expect(await store.removeIf(OWNER, (current) => current.phase === "signed")).toBe(false)
    expect((await store.get(OWNER))?.attemptId).toBe("attempt-1")
    expect(await store.removeIf(OWNER, (current) => current.phase === "created")).toBe(true)
    expect(await store.get(OWNER)).toBeNull()
    expect(await store.removeIf(OWNER, () => true)).toBe(false)
  })

  it("keeps a record whose removal storage refused, so a retry still removes it", async () => {
    const storage = new FlakyStorage()
    const store = new BackupRotationStore(storage)
    await store.put(record())
    storage.refuseWrites = true
    await expect(store.remove(OWNER)).rejects.toThrow("disk full")
    expect((await store.get(OWNER))?.attemptId).toBe("attempt-1")
    storage.refuseWrites = false
    await store.remove(OWNER)
    expect(await store.get(OWNER)).toBeNull()
    expect(await storage.getItem(BACKUP_ROTATION_STORAGE_KEY)).not.toContain("attempt-1")
  })

  it("changes a record over what it holds, in one step", async () => {
    const store = new BackupRotationStore(new InMemoryStorageAdapter())
    await store.put(record())
    const next = await store.update(OWNER.toLowerCase(), (current) =>
      current ? { ...current, phase: "signed" } : null,
    )
    expect(next?.phase).toBe("signed")
    expect((await store.get(OWNER))?.phase).toBe("signed")
    expect(await store.update(`0x${"99".repeat(20)}`, (current) => current)).toBeNull()
  })

  it("tells listeners when the list changes", async () => {
    const store = new BackupRotationStore(new InMemoryStorageAdapter())
    await store.list()
    const seen: number[] = []
    store.onChanged((records) => seen.push(records.length))
    await store.put(record())
    await store.remove(OWNER)
    expect(seen).toEqual([1, 0])
  })
})

describe("stripSettled", () => {
  it("drops the signature and the envelope, and the salt once every funding was swept or lost", () => {
    const done = stripSettled(record({ phase: "done", fundings: [funding({ outcome: "swept" })] }))
    expect(done.backup.envelopeHex).toBeUndefined()
    expect(done.rotation?.signature).toBeUndefined()
    expect(done.rotation?.add.envelope).toBeUndefined()
    expect(done.rotation?.sharedSecretSalt).toBeUndefined()
    expect(done.rotation?.sipa).toBe(addr(20))
    expect(done.rotation?.deployArgs.intentHash).toBe(word(17))
    expect(done.fromBlock).toBe(record().fromBlock)
  })

  it("keeps the salt while a funding is final with no sweep to take it", () => {
    const landing = stripSettled(
      record({ phase: "done", fundings: [funding({ outcome: "mined" })] }),
    )
    expect(landing.rotation?.sharedSecretSalt).toBe(word(9))
    expect(landing.rotation?.signature).toBeUndefined()
  })

  it("keeps the salt while a listed funding is still pending, and drops it once it resolves", () => {
    const open = stripSettled(
      record({
        phase: "done",
        fundings: [funding({ outcome: "mined" }), funding({ attemptId: "attempt-2" })],
      }),
    )
    expect(open.rotation?.sharedSecretSalt).toBe(word(9))
    expect(open.rotation?.signature).toBeUndefined()
    const resolved = stripSettled({
      ...open,
      fundings: open.fundings.map((f) => ({ ...f, outcome: "dead" as const })),
    })
    expect(resolved.rotation?.sharedSecretSalt).toBeUndefined()
  })

  it("keeps the salt while money sits unswept at the deposit address", () => {
    const parked = stripSettled(
      record({
        phase: "attention",
        attention: "stranded",
        suspended: "done",
        unswept: true,
        fundings: [funding({ outcome: "swept" })],
      }),
    )
    expect(parked.rotation?.sharedSecretSalt).toBe(word(9))
    expect(parked.rotation?.signature).toBeUndefined()
    expect(
      stripSettled({ ...parked, unswept: undefined }).rotation?.sharedSecretSalt,
    ).toBeUndefined()
  })

  it("leaves a record with no rotation as it is, minus the envelope", () => {
    const r = record({ phase: "created", rotation: undefined, plan: undefined })
    expect(stripSettled(r)).toEqual({ ...r, backup: { ...r.backup, envelopeHex: undefined } })
  })
})

describe("the stored rotation", () => {
  it("round-trips the sdk's rotation through JSON", () => {
    const persisted = persistedRotation(stored())
    expect(persisted.nonce).toBe(7n)
    expect(persisted.intent.rollupVersion).toBe(6n)
    expect(persisted.builtOver.publicKey).toEqual({ x: 11n, y: 12n })
    expect(persisted.sharedSecretSalt).toBeInstanceOf(Fr)
    expect(persisted.sharedSecretSalt.toString()).toBe(word(9))
    expect(persisted.deployArgs.rollupVersion).toBe(6n)
    expect(JSON.parse(JSON.stringify(storeRotation(persisted)))).toEqual(stored())
  })

  it("refuses to rebuild a rotation whose salt, signature or envelope left the record", () => {
    expect(() => persistedRotation(stored({ sharedSecretSalt: undefined }))).toThrow(
      RotationStrippedError,
    )
    expect(() => persistedRotation(stored({ signature: undefined }))).toThrow("signature")
    expect(() =>
      persistedRotation(stored({ add: { ...stored().add, envelope: undefined } })),
    ).toThrow("envelope")
  })
})

describe("moveProgress", () => {
  it("counts the latest run's included or mined chunks over its plan", () => {
    const chunk = (state: "planned" | "submitted" | "included" | "mined") => ({
      token: "t",
      amount: "1",
      state,
    })
    expect(moveProgress({ move: undefined })).toBeUndefined()
    expect(
      moveProgress({
        move: {
          runs: [
            { plannedAt: 1, m: 1, depositBound: false, chunks: [chunk("mined")] },
            {
              plannedAt: 2,
              m: 3,
              depositBound: true,
              chunks: [chunk("mined"), chunk("included"), chunk("submitted")],
            },
          ],
        },
      }),
    ).toEqual({ included: 2, total: 3, depositBound: true })
  })

  it("counts an included chunk whose transfer reverted as nothing moved", () => {
    const chunk = { token: "t", amount: "1", state: "included" as const }
    expect(
      moveProgress({
        move: {
          runs: [
            {
              plannedAt: 1,
              m: 2,
              depositBound: false,
              chunks: [chunk, { ...chunk, effect: "reverted" }],
            },
          ],
        },
      }),
    ).toEqual({ included: 1, total: 2, depositBound: false })
  })
})

describe("rerootAhead", () => {
  const at = (phase: BackupRotationPhase, over: Partial<BackupRotationRecord> = {}) =>
    rerootAhead({ phase, ...over })

  it("holds from the backup's creation until the re-root switches the wallet", () => {
    for (const phase of ["created", "signed", "published", "funded"] as const) {
      expect(at(phase)).toBe(true)
    }
    expect(at("swept")).toBe(true)
    expect(at("installed", { reroot: { batch: "0x01" } })).toBe(true)
    expect(at("swept", { reroot: { switched: true } })).toBe(false)
    expect(at("installed", { reroot: { switched: true } })).toBe(false)
  })

  it("ends once the wallet runs on the two-key account, or the rotation will not run", () => {
    for (const phase of ["rerooted", "moved", "done", "conflict", "recovered"] as const) {
      expect(at(phase)).toBe(false)
    }
  })

  it("reads an attention by the phase it interrupted", () => {
    expect(at("attention", { attention: "route", suspended: "published" })).toBe(true)
    expect(at("attention", { attention: "move", suspended: "rerooted" })).toBe(false)
    expect(at("attention", { attention: "corrupt" })).toBe(false)
  })
})

describe("movesBalance", () => {
  it("holds from the re-root's switch until the move ends", () => {
    for (const phase of ["created", "signed", "published", "funded", "swept", "installed"] as const)
      expect(movesBalance({ phase })).toBe(false)
    for (const phase of ["swept", "installed"] as const) {
      expect(movesBalance({ phase, reroot: { batch: word(1) } })).toBe(false)
      expect(movesBalance({ phase, reroot: { switched: true } })).toBe(true)
    }
    expect(movesBalance({ phase: "rerooted" })).toBe(true)
    expect(movesBalance({ phase: "moved" })).toBe(true)
    for (const phase of ["done", "recovered", "conflict"] as const)
      expect(movesBalance({ phase, reroot: { switched: true } })).toBe(false)
  })

  it("lets a move parked for the user hold nothing", () => {
    expect(movesBalance({ phase: "attention", reroot: { switched: true } })).toBe(false)
  })
})
