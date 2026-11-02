import type { AlphaAuthProvider, ObsidionAccount, RecoveryMetadata } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import {
  rerootToPasskeySet,
  type RerootDeps,
} from "../../../src/features/backupPasskey/rerootToPasskeySet"
import { OWNER, PLAN, TWO_KEY, signedRecord } from "../../support/backupAdd"

const ROOT = "aa".repeat(64)
const ROOT_RECORD: RecoveryMetadata = {
  credentialId: "root-credential",
  l2Address: OWNER,
  pubkey: ROOT,
  isMskRoot: true,
  prfSlot: "first",
  authenticatorType: "platform",
}

function harness(stored: RecoveryMetadata | undefined = ROOT_RECORD) {
  const session = { held: true }
  const calls: string[] = []
  const written: (RecoveryMetadata & { userHandle?: string })[] = []
  const provider = { id: "two-key" } as unknown as AlphaAuthProvider
  const account = {
    getAddress: () => ({ toString: () => TWO_KEY }),
    getCompleteAddress: () => ({ toString: () => `${TWO_KEY}:complete` }),
  } as unknown as ObsidionAccount
  const deps: RerootDeps = {
    derive: vi.fn(async (set: readonly string[]) => (set.length === 2 ? TWO_KEY : OWNER)),
    root: { credentialId: "root-credential", pubkeyHex: ROOT },
    rootRecord: vi.fn(async () => stored),
    writeRecord: vi.fn(async (meta) => {
      written.push(meta)
      calls.push(`write:${meta.credentialId}`)
    }),
    providerFor: vi.fn(() => provider),
    commit: vi.fn(async () => {
      calls.push("commit")
      return () => session.held
    }),
    account: vi.fn(async () => account),
    persist: vi.fn(async () => {
      calls.push("persist")
    }),
    switchAccount: vi.fn(() => {
      calls.push("switch")
    }),
  }
  const checkpoints: unknown[] = []
  const checkpoint = async (fields: unknown) => {
    checkpoints.push(fields)
    calls.push("checkpoint")
  }
  return { deps, calls, written, checkpoints, checkpoint, provider, account, session }
}

describe("rerootToPasskeySet", () => {
  it("names the set under both passkeys, signs over it, saves the two-key account and switches", async () => {
    const h = harness()
    const record = signedRecord({ phase: "swept" })
    const result = await rerootToPasskeySet(h.deps, record, h.checkpoint)

    expect(result).toEqual({ switched: true, rebound: true })
    expect(h.calls).toEqual([
      "write:root-credential",
      `write:${record.backup.credentialId}`,
      "commit",
      "persist",
      "switch",
      "checkpoint",
    ])
    expect(h.checkpoints).toEqual([{ switched: true }])
    const set = [ROOT, record.backup.pubkeyHex]
    expect(h.written[0]).toEqual({
      ...ROOT_RECORD,
      l2Address: TWO_KEY,
      passkeySet: set,
    })
    expect(h.written[1]).toMatchObject({
      credentialId: record.backup.credentialId,
      l2Address: TWO_KEY,
      pubkey: record.backup.pubkeyHex,
      isMskRoot: false,
      backup: { account: OWNER, envelope: `0x${record.backup.envelopeHex}` },
      passkeySet: set,
      prfSlot: record.backup.prfSlot,
      authenticatorType: "platform",
      userHandle: record.backup.userHandle,
    })
    expect(h.deps.providerFor).toHaveBeenCalledWith(set)
    expect(h.deps.commit).toHaveBeenCalledWith(h.provider)
    expect(h.deps.account).toHaveBeenCalledWith(h.provider)
    expect(h.deps.persist).toHaveBeenCalledWith(h.account)
    expect(h.deps.switchAccount).toHaveBeenCalledWith(h.account)
  })

  it("refuses a two-key address that is not the signed one, writing nothing", async () => {
    const h = harness()
    const record = signedRecord({ phase: "swept", plan: { ...PLAN, address: OWNER } })
    await expect(rerootToPasskeySet(h.deps, record, h.checkpoint)).rejects.toThrow("does not match")
    expect(h.calls).toEqual([])
  })

  it("refuses a record whose envelope is gone", async () => {
    const h = harness()
    const record = signedRecord({ phase: "swept" })
    const { envelopeHex: _, ...backup } = record.backup
    await expect(rerootToPasskeySet(h.deps, { ...record, backup }, h.checkpoint)).rejects.toThrow(
      "nothing signed",
    )
    expect(h.calls).toEqual([])
  })

  it("carries the root's stored fields over, never a backup another record may hold", async () => {
    const h = harness({ ...ROOT_RECORD, backup: { account: OWNER, envelope: "0x01" } })
    await rerootToPasskeySet(h.deps, signedRecord({ phase: "swept" }), h.checkpoint)
    expect(h.written[0]).not.toHaveProperty("backup")
    expect(h.written[0]).toMatchObject({ isMskRoot: true, prfSlot: "first" })
  })

  it("saves and shows nothing once the session ended under the commit", async () => {
    const h = harness()
    h.session.held = false
    await expect(
      rerootToPasskeySet(h.deps, signedRecord({ phase: "swept" }), h.checkpoint),
    ).rejects.toThrow("session changed")
    expect(h.deps.persist).not.toHaveBeenCalled()
    expect(h.deps.switchAccount).not.toHaveBeenCalled()
    expect(h.checkpoints).toEqual([])
  })

  it("marks a security key's record as one", async () => {
    const h = harness()
    const record = signedRecord({ phase: "swept" })
    await rerootToPasskeySet(
      h.deps,
      { ...record, backup: { ...record.backup, securityKey: true, transports: ["usb"] } },
      h.checkpoint,
    )
    expect(h.written[1]).toMatchObject({ authenticatorType: "security-key", transports: ["usb"] })
  })
})
