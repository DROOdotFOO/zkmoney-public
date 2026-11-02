import { describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import type { AuthKeyEntry } from "@oxide/l1-contracts"

import { passkeyMetadata } from "@oxide/oxide-client/passkey_rotation.js"

import { credentialIdToMetadata } from "../../src/oxide/oxideWebAuthn"
import { metadataToCredentialId } from "../../src/oxide/oxideWebAuthn"
import { credentialIdHash, parseKeyMetadata } from "../../src/oxide/passkeyEnvelope"
import {
  answeringKey,
  candidateCredentialIds,
  installedCredentials,
  readPasskeyCredentialsByTag,
  type InstalledPasskey,
} from "../../src/oxide/passkeyCredentialByTag"
import {
  TagValidationError,
  type RegistryTagResolution,
} from "../../src/core/services/RegistryTagResolver"

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
const L2 = `0x${"11".repeat(32)}`
const QX = `0x${"ab".repeat(32)}` as Hex
const QY = `0x${"cd".repeat(32)}` as Hex

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function bytesOf(len: number, seed = 7): Uint8Array {
  return new Uint8Array(len).map((_, i) => (i * 131 + seed) & 0xff)
}

function key(metadata: Hex, over: Partial<AuthKeyEntry["key"]> = {}): AuthKeyEntry {
  return { key: { qx: QX, qy: QY, ...over }, metadata }
}

const resolved: RegistryTagResolution = {
  status: "resolved",
  account: ACCOUNT,
  l2Address: L2,
  rollupId: "1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
}

function reader(opts: {
  resolve?: RegistryTagResolution | Error
  keys?: readonly AuthKeyEntry[] | Error
  /** The account's total key count, when the read is truncated (defaults to the entries' length). */
  authKeyCount?: number
}) {
  const resolveTag = vi.fn(async () => {
    if (opts.resolve instanceof Error) throw opts.resolve
    return opts.resolve ?? resolved
  })
  const readAuthKeys = vi.fn(async () => {
    if (opts.keys instanceof Error) throw opts.keys
    const entries = opts.keys ?? []
    return { entries, authKeyCount: opts.authKeyCount ?? entries.length }
  })
  return { resolveTag, readAuthKeys }
}

describe("metadataToCredentialId", () => {
  it("is the byte inverse of credentialIdToMetadata on the encoder's own vectors", () => {
    const eleven = toBase64Url(new TextEncoder().encode("cred-id-001"))
    expect(metadataToCredentialId(credentialIdToMetadata(eleven))).toBe(eleven)
    for (let len = 1; len <= 64; len++) {
      const id = toBase64Url(bytesOf(len))
      expect(metadataToCredentialId(credentialIdToMetadata(id))).toBe(id)
    }
  })

  it("round-trips a 64-byte id and one whose alphabet needs - and _", () => {
    const wide = toBase64Url(bytesOf(64, 3))
    expect(metadataToCredentialId(credentialIdToMetadata(wide))).toBe(wide)
    const url = toBase64Url(Uint8Array.from([0xfb, 0xff, 0xbf]))
    expect(url).toContain("-")
    expect(url).toContain("_")
    expect(metadataToCredentialId(credentialIdToMetadata(url))).toBe(url)
  })

  it("throws on empty, unprefixed or malformed hex", () => {
    expect(() => metadataToCredentialId("0x")).toThrow(/hex/)
    expect(() => metadataToCredentialId("0xabc")).toThrow(/hex/)
    expect(() => metadataToCredentialId("abcd" as Hex)).toThrow(/hex/)
    expect(() => metadataToCredentialId("zz" as Hex)).toThrow(/hex/)
  })
})

describe("parseKeyMetadata on a raw credential id", () => {
  it("reads a 16..1023-byte id back; empty, too-short and too-long metadata is unknown", () => {
    const id = toBase64Url(bytesOf(16))
    expect(parseKeyMetadata(credentialIdToMetadata(id))).toEqual({
      kind: "credential-id",
      credentialId: id,
    })
    expect(parseKeyMetadata("0x")).toEqual({ kind: "unknown" })
    expect(parseKeyMetadata(credentialIdToMetadata(toBase64Url(bytesOf(11))))).toEqual({
      kind: "unknown",
    })
    expect(parseKeyMetadata(credentialIdToMetadata(toBase64Url(bytesOf(1024))))).toEqual({
      kind: "unknown",
    })
    expect(parseKeyMetadata(credentialIdToMetadata(toBase64Url(bytesOf(1023)))).kind).toBe(
      "credential-id",
    )
  })
})

describe("readPasskeyCredentialsByTag", () => {
  const eligible = (seed: number) => key(credentialIdToMetadata(toBase64Url(bytesOf(16, seed))))

  it("one eligible key → resolved with the key, account and L2 address", async () => {
    const deps = reader({ keys: [eligible(1)] })
    const out = await readPasskeyCredentialsByTag("Alice", deps)
    expect(out).toEqual({
      kind: "resolved",
      account: ACCOUNT,
      l2Address: L2,
      keys: [
        {
          pubkeyHex: `${"ab".repeat(32)}${"cd".repeat(32)}`,
          metadata: credentialIdToMetadata(toBase64Url(bytesOf(16, 1))),
          parsed: { kind: "credential-id", credentialId: toBase64Url(bytesOf(16, 1)) },
        },
      ],
      complete: true,
      authKeyCount: 1,
    })
    expect(deps.resolveTag).toHaveBeenCalledWith("Alice")
    expect(deps.readAuthKeys).toHaveBeenCalledWith(ACCOUNT)
  })

  it("two keys → two keys in on-chain order", async () => {
    const out = await readPasskeyCredentialsByTag(
      "alice",
      reader({ keys: [eligible(1), eligible(2)] }),
    )
    expect(out.kind).toBe("resolved")
    if (out.kind !== "resolved") return
    expect(out.keys.map((k) => metadataToCredentialId(k.metadata))).toEqual([
      toBase64Url(bytesOf(16, 1)),
      toBase64Url(bytesOf(16, 2)),
    ])
  })

  it("lists an entry with unknown metadata beside the eligible one", async () => {
    const out = await readPasskeyCredentialsByTag(
      "alice",
      reader({ keys: [key("0x"), eligible(1)] }),
    )
    expect(out.kind).toBe("resolved")
    if (out.kind !== "resolved") return
    expect(out.keys.map((k) => k.parsed.kind)).toEqual(["unknown", "credential-id"])
    expect(out.authKeyCount).toBe(2)
  })

  it("only ineligible entries → unreadable", async () => {
    const short = key(credentialIdToMetadata(toBase64Url(bytesOf(11))))
    const out = await readPasskeyCredentialsByTag("alice", reader({ keys: [key("0x"), short] }))
    expect(out).toEqual({ kind: "unreadable", account: ACCOUNT, complete: true })
  })

  it("a read the account's count outruns is marked incomplete", async () => {
    // Eight ineligible entries read, but nine keys installed: the ninth went unread.
    const eight = Array.from({ length: 8 }, () => key("0x"))
    const out = await readPasskeyCredentialsByTag("alice", reader({ keys: eight, authKeyCount: 9 }))
    expect(out).toEqual({ kind: "unreadable", account: ACCOUNT, complete: false })

    // One eligible key read but more installed than fit: resolved, but not the full set.
    const resolvedOut = await readPasskeyCredentialsByTag(
      "alice",
      reader({ keys: [eligible(1)], authKeyCount: 9 }),
    )
    expect(resolvedOut.kind).toBe("resolved")
    if (resolvedOut.kind === "resolved") expect(resolvedOut.complete).toBe(false)
  })

  it("caps at eight keys; an entry past the cap is not read, and the set is not whole", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => eligible(i + 1))
    const capped = await readPasskeyCredentialsByTag("alice", reader({ keys: nine }))
    expect(capped.kind).toBe("resolved")
    if (capped.kind === "resolved") {
      expect(capped.keys.map((k) => k.metadata)).toEqual(nine.slice(0, 8).map((k) => k.metadata))
      expect(capped.complete).toBe(false)
    }
    const late = [...Array.from({ length: 8 }, () => key("0x")), eligible(1)]
    const found = await readPasskeyCredentialsByTag("alice", reader({ keys: late }))
    expect(found).toEqual({ kind: "unreadable", account: ACCOUNT, complete: false })
  })

  it("no keys → noKeyInstalled", async () => {
    expect(await readPasskeyCredentialsByTag("alice", reader({ keys: [] }))).toEqual({
      kind: "noKeyInstalled",
      account: ACCOUNT,
    })
  })

  it("notFound and staleRollup pass through; an invalid tag is notFound", async () => {
    expect(
      await readPasskeyCredentialsByTag("alice", reader({ resolve: { status: "notFound" } })),
    ).toEqual({ kind: "notFound" })
    expect(
      await readPasskeyCredentialsByTag("alice", reader({ resolve: { status: "staleRollup" } })),
    ).toEqual({ kind: "staleRollup" })
    const deps = reader({ resolve: new TagValidationError("Invalid tag: !!") })
    expect(await readPasskeyCredentialsByTag("!!", deps)).toEqual({ kind: "notFound" })
    expect(deps.readAuthKeys).not.toHaveBeenCalled()
  })

  it("transport failures from either read propagate", async () => {
    await expect(
      readPasskeyCredentialsByTag("alice", reader({ resolve: new Error("RPC down") })),
    ).rejects.toThrow(/RPC down/)
    await expect(
      readPasskeyCredentialsByTag("alice", reader({ keys: new Error("RPC down") })),
    ).rejects.toThrow(/RPC down/)
  })

  describe("every key with its kind", () => {
    const ROOT_ID = toBase64Url(bytesOf(16, 1))
    const BACKUP_ID = toBase64Url(bytesOf(20, 2))
    /** A well-formed envelope header (version 1, slot `first`) over an opaque body. */
    const ENVELOPE = `0x0100${"ee".repeat(60)}` as Hex
    const BQX = `0x${"5a".repeat(32)}` as Hex
    const root = key(credentialIdToMetadata(ROOT_ID))
    /** An envelope entry with no appended id: the prefix and the envelope alone. */
    const backup = key(passkeyMetadata(credentialIdToMetadata(BACKUP_ID), ENVELOPE), { qx: BQX })
    /** A backup entry as the wallet writes it: the raw id behind the envelope. */
    const backupNamed = key(
      passkeyMetadata(
        credentialIdToMetadata(BACKUP_ID),
        `${ENVELOPE}${credentialIdToMetadata(BACKUP_ID).slice(2)}` as Hex,
      ),
      { qx: BQX },
    )
    const installed = (entry: AuthKeyEntry): InstalledPasskey => ({
      pubkeyHex: "11".repeat(64),
      metadata: entry.metadata,
      parsed: parseKeyMetadata(entry.metadata),
    })

    it("lists a raw-id key and an envelope key in on-chain order, with their kinds", async () => {
      const out = await readPasskeyCredentialsByTag("alice", reader({ keys: [root, backup] }))
      expect(out.kind).toBe("resolved")
      if (out.kind !== "resolved") return
      expect(out.complete).toBe(true)
      expect(out.keys).toEqual([
        {
          pubkeyHex: `${"ab".repeat(32)}${"cd".repeat(32)}`,
          metadata: root.metadata,
          parsed: { kind: "credential-id", credentialId: ROOT_ID },
        },
        {
          pubkeyHex: `${"5a".repeat(32)}${"cd".repeat(32)}`,
          metadata: backup.metadata,
          parsed: {
            kind: "envelope-prefixed",
            credentialIdHash: credentialIdHash(BACKUP_ID),
            envelope: expect.any(Uint8Array),
          },
        },
      ])
    })

    it("a backup entry carrying its id lists the id with the envelope", async () => {
      const out = await readPasskeyCredentialsByTag("alice", reader({ keys: [root, backupNamed] }))
      if (out.kind !== "resolved") throw new Error(out.kind)
      expect(out.keys[1]!.parsed).toEqual({
        kind: "envelope-prefixed",
        credentialIdHash: credentialIdHash(BACKUP_ID),
        envelope: expect.any(Uint8Array),
        credentialId: BACKUP_ID,
      })
      expect(answeringKey(out.keys, BACKUP_ID)).toEqual({ key: out.keys[1], by: "hash" })
    })

    describe("candidateCredentialIds", () => {
      const raw40 = bytesOf(40, 5)
      raw40[0] = 0x01
      const raw40Id = toBase64Url(raw40)
      const root40 = key(credentialIdToMetadata(raw40Id))

      it("names a root's raw id and a backup's appended id", () => {
        expect(candidateCredentialIds([installed(root), installed(backupNamed)])).toEqual([
          ROOT_ID,
          BACKUP_ID,
        ])
      })

      it("names an envelope entry with no appended id by its whole metadata, as a root", () => {
        const whole = metadataToCredentialId(backup.metadata)
        expect(candidateCredentialIds([installed(root), installed(backup)])).toEqual([
          ROOT_ID,
          whole,
        ])
        expect(candidateCredentialIds([installed(backup)])).toEqual([whole])
      })

      it("names a root whose raw id begins with 0x01 by its whole metadata, alone and beside a backup", () => {
        expect(candidateCredentialIds([installed(root40)])).toEqual([raw40Id])
        expect(candidateCredentialIds([installed(root40), installed(backupNamed)])).toEqual([
          raw40Id,
          BACKUP_ID,
        ])
        expect(answeringKey([installed(root40), installed(backupNamed)], raw40Id)).toEqual({
          key: installed(root40),
          by: "raw",
        })
      })

      it("skips an unknown entry, which nothing can answer for", () => {
        const tiny = key(`0x${"07".repeat(8)}`)
        expect(candidateCredentialIds([installed(root), installed(tiny)])).toEqual([ROOT_ID])
      })
    })

    describe("installedCredentials", () => {
      it("marks only an id behind an envelope as a backup", () => {
        const whole = metadataToCredentialId(backup.metadata)
        const listed = installedCredentials([
          installed(backupNamed),
          installed(root),
          installed(backup),
          installed(key(`0x${"07".repeat(8)}`)),
        ])
        expect(listed.map(({ credentialId, backup }) => ({ credentialId, backup }))).toEqual([
          { credentialId: BACKUP_ID, backup: true },
          { credentialId: ROOT_ID, backup: false },
          // An envelope entry with no appended id is a root whose raw id begins with 0x01.
          { credentialId: whole, backup: false },
        ])
        expect(listed[0]!.key).toEqual(installed(backupNamed))
      })
    })

    it("a 94-byte prefixed entry is envelope-prefixed; an 8-byte one is unknown and still listed", async () => {
      const short = key(passkeyMetadata(credentialIdToMetadata(BACKUP_ID), `0x${"ee".repeat(61)}`))
      const tiny = key(`0x${"07".repeat(8)}`)
      const out = await readPasskeyCredentialsByTag("alice", reader({ keys: [root, short, tiny] }))
      expect(out.kind).toBe("resolved")
      if (out.kind !== "resolved") return
      expect(out.keys.map((k) => k.parsed.kind)).toEqual([
        "credential-id",
        "envelope-prefixed",
        "unknown",
      ])
      expect(out.keys[2]!.pubkeyHex).toHaveLength(128)
      expect(out.complete).toBe(true)
    })

    it("a key that is not 64 bytes is left out and marks the set read incomplete", async () => {
      const out = await readPasskeyCredentialsByTag(
        "alice",
        reader({ keys: [root, key(root.metadata, { qy: "0xcd" as Hex })] }),
      )
      expect(out.kind).toBe("resolved")
      if (out.kind !== "resolved") return
      expect(out.keys).toHaveLength(1)
      expect(out.complete).toBe(false)
    })

    it("answeringKey: the raw id names the root, the hashed id the envelope entry", async () => {
      const out = await readPasskeyCredentialsByTag("alice", reader({ keys: [root, backup] }))
      if (out.kind !== "resolved") throw new Error(out.kind)
      expect(answeringKey(out.keys, ROOT_ID)).toEqual({ key: out.keys[0], by: "raw" })
      expect(answeringKey(out.keys, BACKUP_ID)).toEqual({ key: out.keys[1], by: "hash" })
      expect(answeringKey(out.keys, toBase64Url(bytesOf(16, 9)))).toBeUndefined()
    })

    it("answeringKey: a raw id that looks prefixed answers raw, before any hash match", () => {
      const raw40 = bytesOf(40, 5)
      raw40[0] = 0x01
      const raw40Id = toBase64Url(raw40)
      const looksPrefixed: InstalledPasskey = {
        pubkeyHex: "11".repeat(64),
        metadata: credentialIdToMetadata(raw40Id),
        parsed: {
          kind: "envelope-prefixed",
          credentialIdHash: `0x${"00".repeat(32)}`,
          envelope: new Uint8Array(7),
        },
      }
      const hashed: InstalledPasskey = {
        pubkeyHex: "22".repeat(64),
        metadata: passkeyMetadata(credentialIdToMetadata(raw40Id), ENVELOPE),
        parsed: {
          kind: "envelope-prefixed",
          credentialIdHash: credentialIdHash(raw40Id),
          envelope: new Uint8Array(62),
        },
      }
      expect(answeringKey([hashed, looksPrefixed], raw40Id)).toEqual({
        key: looksPrefixed,
        by: "raw",
      })
      expect(answeringKey([hashed], raw40Id)).toEqual({ key: hashed, by: "hash" })
    })
  })
})
