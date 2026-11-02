import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TRANSFER_META_LEN, emptyTransferMeta } from "@obsidion/core/constants"
import {
  buildTransferMeta,
  buildTransferMetaForSend,
  decodeTransferMeta,
  truncateUtf8,
  TRANSFER_MEMO_MAX_BYTES,
  PAYLINK_MEMO_MAX_BYTES,
} from "../../../src/services/token/transferMeta.js"

const CAPACITY = TRANSFER_META_LEN * 31

/** Test-local mirror of the codec's flatten: 31 bytes per field, big-endian in the low bytes. */
const packRaw = (bytes: Uint8Array): Fr[] => {
  const meta: Fr[] = []
  for (let i = 0; i < TRANSFER_META_LEN; i++) {
    const chunk = Buffer.from(bytes.subarray(i * 31, (i + 1) * 31))
    meta.push(Fr.fromBuffer(Buffer.concat([Buffer.alloc(1), chunk])))
  }
  return meta
}

/** [version, ...entries, terminator] laid into a zeroed 217-byte stream. */
const stream = (...entries: number[][]): Fr[] => {
  const buf = new Uint8Array(CAPACITY)
  buf[0] = 0x01
  let pos = 1
  for (const entry of entries) {
    buf.set(entry, pos)
    pos += entry.length
  }
  return packRaw(buf)
}

const ascii = (s: string): number[] => [...Buffer.from(s, "ascii")]

describe("transferMeta", () => {
  it("decodes a memo without direction overrides or stacked marks", () => {
    expect(
      decodeTransferMeta(
        buildTransferMeta({
          memo:
            "ko " +
            String.fromCharCode(0x202e) +
            "olleh" +
            "q" +
            String.fromCharCode(0x301, 0x302, 0x303, 0x304, 0x305),
        }),
      ).memo,
    ).toBe("ko olleh" + "q" + String.fromCharCode(0x301, 0x302, 0x303))
  })

  it("round-trips every subset of requestId, tags and memo, from Fr[] and bigint[]", () => {
    const requestId = Fr.random().toString()
    const full = { requestId, senderTag: "honk-goose", recipientTag: "timon", memo: "lunch ✓" }
    for (const keys of [
      ["requestId"],
      ["senderTag"],
      ["recipientTag"],
      ["memo"],
      ["requestId", "senderTag"],
      ["requestId", "memo"],
      ["senderTag", "memo"],
      ["senderTag", "recipientTag"],
      ["requestId", "senderTag", "memo"],
      ["requestId", "senderTag", "recipientTag", "memo"],
    ] as (keyof typeof full)[][]) {
      const input = Object.fromEntries(keys.map((k) => [k, full[k]]))
      const meta = buildTransferMeta(input)
      expect(meta).toHaveLength(TRANSFER_META_LEN)
      const expected = {
        ...input,
        ...(input.requestId ? { requestId: requestId.toLowerCase() } : {}),
      }
      expect(decodeTransferMeta(meta)).toEqual(expected)
      expect(decodeTransferMeta(meta.map((f) => f.toBigInt()))).toEqual(expected)
    }
  })

  it("clamps the memo to 111 bytes at a codepoint boundary regardless of other entries", () => {
    const max = "m".repeat(TRANSFER_MEMO_MAX_BYTES)
    expect(decodeTransferMeta(buildTransferMeta({ memo: max + "overflow" })).memo).toBe(max)
    // A 3-byte codepoint straddling the cut is dropped whole.
    const straddle = "a".repeat(TRANSFER_MEMO_MAX_BYTES - 1) + "✓"
    expect(decodeTransferMeta(buildTransferMeta({ memo: straddle })).memo).toBe(
      "a".repeat(TRANSFER_MEMO_MAX_BYTES - 1),
    )
    // Two max tags + reference + max memo fills the buffer with the terminator intact.
    const packed = buildTransferMeta({
      requestId: Fr.random().toString(),
      senderTag: "t".repeat(32),
      recipientTag: "r".repeat(32),
      memo: max,
    })
    expect(decodeTransferMeta(packed)).toMatchObject({
      memo: max,
      senderTag: "t".repeat(32),
      recipientTag: "r".repeat(32),
    })
  })

  it("truncateUtf8 keeps in-budget strings intact", () => {
    expect(truncateUtf8("héllo", 6)).toBe("héllo")
    expect(truncateUtf8("héllo", 5)).toBe("héll")
  })

  it("decodes an all-zero meta and an unknown version to {}", () => {
    expect(decodeTransferMeta(emptyTransferMeta())).toEqual({})
    const wrongVersion = new Uint8Array(CAPACITY)
    wrongVersion[0] = 0x02
    wrongVersion.set([0x01, 2, 0x68, 0x69], 1)
    expect(decodeTransferMeta(packRaw(wrongVersion))).toEqual({})
    expect(decodeTransferMeta(undefined)).toEqual({})
  })

  it("skips unknown entry types and still decodes later entries", () => {
    const meta = stream([0x7f, 3, 1, 2, 3], [0x01, ...[2, 0x68, 0x69]])
    expect(decodeTransferMeta(meta)).toEqual({ memo: "hi" })
  })

  it("stops at a len overrun, keeping earlier entries", () => {
    const meta = stream([0x01, 2, 0x68, 0x69], [0x02, 255, 1, 2, 3])
    expect(decodeTransferMeta(meta)).toEqual({ memo: "hi" })
  })

  it("never reads past a terminator", () => {
    const meta = stream([0x00], [0x01, 2, 0x68, 0x69])
    expect(decodeTransferMeta(meta)).toEqual({})
  })

  it("takes the first of duplicate entries", () => {
    const meta = stream([0x01, 3, ...ascii("one")], [0x01, 3, ...ascii("two")])
    expect(decodeTransferMeta(meta)).toEqual({ memo: "one" })
  })

  it("drops zero-length and malformed values", () => {
    expect(decodeTransferMeta(stream([0x01, 0]))).toEqual({})
    // A reference with len !== 32 is skipped, never zero-padded into a joinable id.
    expect(decodeTransferMeta(stream([0x02, 31, ...new Array(31).fill(7)]))).toEqual({})
    // Invalid UTF-8 memo decodes to absent.
    expect(decodeTransferMeta(stream([0x01, 2, 0xff, 0xfe]))).toEqual({})
    // A tag failing the charset regex decodes to absent.
    expect(decodeTransferMeta(stream([0x03, 3, ...ascii("Bad")]))).toEqual({})
  })

  it("decodes a short or malformed field array to {}", () => {
    expect(decodeTransferMeta(new Array(TRANSFER_META_LEN - 1).fill(0n))).toEqual({})
    expect(decodeTransferMeta([])).toEqual({})
    // An out-of-range element fails toFr coercion; the whole decode returns {} rather than throwing.
    expect(decodeTransferMeta([2n ** 255n, ...new Array(TRANSFER_META_LEN - 1).fill(0n)])).toEqual(
      {},
    )
  })

  it("treats an all-zero reference as absent on both sides", () => {
    const zeroId = Fr.ZERO.toString()
    expect(decodeTransferMeta(buildTransferMeta({ requestId: zeroId, memo: "hi" }))).toEqual({
      memo: "hi",
    })
    expect(decodeTransferMeta(stream([0x02, 32, ...new Array(32).fill(0)]))).toEqual({})
  })

  it("send path drops an invalid tag but keeps memo and requestId", () => {
    const requestId = Fr.random().toString()
    expect(
      decodeTransferMeta(
        buildTransferMetaForSend({ requestId, senderTag: "t".repeat(33), memo: "still pay" }),
      ),
    ).toEqual({ requestId: requestId.toLowerCase(), memo: "still pay" })
    expect(
      decodeTransferMeta(buildTransferMetaForSend({ senderTag: "no spaces!", memo: "m" })),
    ).toEqual({ memo: "m" })
  })

  it("send path lowercases and trims tags before validating", () => {
    expect(
      decodeTransferMeta(
        buildTransferMetaForSend({ senderTag: " Honk-Goose ", recipientTag: " Timon " }),
      ),
    ).toEqual({ senderTag: "honk-goose", recipientTag: "timon" })
  })

  it("strict builder throws on an oversize tag; a charset-invalid tag encodes and drops on decode", () => {
    expect(() => buildTransferMeta({ senderTag: "t".repeat(33) })).toThrow()
    expect(
      decodeTransferMeta(buildTransferMeta({ senderTag: "Bad Tag" })).senderTag,
    ).toBeUndefined()
  })

  it("drops a legacy non-field request id on the send path only", () => {
    expect(() => buildTransferMeta({ requestId: "req-123-abc" })).toThrow()
    expect(
      decodeTransferMeta(
        buildTransferMetaForSend({ requestId: "req-123-abc", senderTag: "honk-goose", memo: "m" }),
      ),
    ).toEqual({ senderTag: "honk-goose", memo: "m" })
  })

  it("fuzz: any version-0x01 stream decodes without throwing, to shape-valid fields", () => {
    // mulberry32 — deterministic seed so a failure reproduces.
    let s = 0x9e3779b9
    const rand = () => {
      s |= 0
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let round = 0; round < 200; round++) {
      const buf = new Uint8Array(CAPACITY)
      for (let i = 0; i < CAPACITY; i++) buf[i] = Math.floor(rand() * 256)
      buf[0] = 0x01
      const out = decodeTransferMeta(packRaw(buf))
      for (const tag of [out.senderTag, out.recipientTag]) {
        if (tag === undefined) continue
        expect(tag).toMatch(/^[a-z0-9_-]+$/)
        expect(tag.length).toBeLessThanOrEqual(32)
      }
      if (out.requestId !== undefined) expect(out.requestId).toMatch(/^0x[0-9a-f]{64}$/)
      if (out.memo !== undefined) expect(out.memo.length).toBeGreaterThan(0)
    }
  })
})

describe("paylink payout lane (claim payout Transfer.meta)", () => {
  const secret = Fr.random()
  const fallbackKeyHash = Fr.random()
  const lane = (value: number[]): number[] => [0x11, value.length, ...value]
  const bytes = (fr: Fr): number[] => [...fr.toBuffer()]
  const good = [0x01, ...bytes(secret), ...bytes(fallbackKeyHash)]

  it("round-trips beside a full tag and a full memo", () => {
    const input = {
      memo: "m".repeat(TRANSFER_MEMO_MAX_BYTES),
      senderTag: "t".repeat(32),
      paylinkPayout: { flavor: "email" as const, secret, fallbackKeyHash },
    }
    expect(decodeTransferMeta(buildTransferMetaForSend(input))).toEqual(input)
    expect(decodeTransferMeta(buildTransferMeta(input).map((f) => f.toBigInt()))).toEqual(input)
  })

  it("drops a lane of the wrong length, an unknown flavor, or a zero secret", () => {
    expect(decodeTransferMeta(stream(lane(good))).paylinkPayout).toEqual({
      flavor: "email",
      secret,
      fallbackKeyHash,
    })
    expect(decodeTransferMeta(stream(lane([...good, 0x00]))).paylinkPayout).toBeUndefined()
    expect(decodeTransferMeta(stream(lane(good.slice(0, -1)))).paylinkPayout).toBeUndefined()
    expect(decodeTransferMeta(stream(lane([0x02, ...good.slice(1)]))).paylinkPayout).toBeUndefined()
    expect(
      decodeTransferMeta(stream(lane([0x01, ...bytes(Fr.ZERO), ...bytes(fallbackKeyHash)])))
        .paylinkPayout,
    ).toBeUndefined()
  })
})

describe("paylink created lane (funding Transfer.meta)", () => {
  const secret = Fr.random()
  const fallbackKeyHash = Fr.random()
  const day = 20_000
  const dayBytes = [0x4e, 0x20]
  const lane = (value: number[]): number[] => [0x10, value.length, ...value]
  const bytes = (fr: Fr): number[] => [...fr.toBuffer()]

  it("fits a full funding memo beside a full tag lane and a full created lane", () => {
    const email = "e".repeat(64)
    const meta = buildTransferMetaForSend({
      memo: "m".repeat(PAYLINK_MEMO_MAX_BYTES),
      senderTag: "t".repeat(32),
      paylinkCreated: { flavor: "email", day, secret, fallbackKeyHash, email },
    })
    expect(decodeTransferMeta(meta)).toEqual({
      memo: "m".repeat(PAYLINK_MEMO_MAX_BYTES),
      senderTag: "t".repeat(32),
      paylinkCreated: { flavor: "email", day, secret, fallbackKeyHash, email },
    })
  })

  it("round-trips a direct lane and an email lane, from Fr[] and bigint[]", () => {
    for (const created of [
      { flavor: "direct" as const, day, secret, fallbackKeyHash },
      { flavor: "email" as const, day: 65_535, secret, fallbackKeyHash, email: "pay@example.com" },
    ]) {
      const meta = buildTransferMeta({ paylinkCreated: created })
      expect(decodeTransferMeta(meta).paylinkCreated).toEqual(created)
      expect(decodeTransferMeta(meta.map((f) => f.toBigInt())).paylinkCreated).toEqual(created)
    }
  })

  it("drops a lane with an unknown flavor, a zero or non-field secret, a short value, or bad email bytes", () => {
    const good = [0x00, ...dayBytes, ...bytes(secret), ...bytes(fallbackKeyHash)]
    expect(decodeTransferMeta(stream(lane(good))).paylinkCreated).toMatchObject({ day })
    expect(
      decodeTransferMeta(stream(lane([0x02, ...good.slice(1)]))).paylinkCreated,
    ).toBeUndefined()
    expect(
      decodeTransferMeta(
        stream(lane([0x00, ...dayBytes, ...bytes(Fr.ZERO), ...bytes(fallbackKeyHash)])),
      ).paylinkCreated,
    ).toBeUndefined()
    expect(
      decodeTransferMeta(stream(lane([0x00, ...dayBytes, ...bytes(secret), ...bytes(Fr.ZERO)])))
        .paylinkCreated,
    ).toBeUndefined()
    expect(
      decodeTransferMeta(
        stream(lane([0x00, ...dayBytes, ...new Array(32).fill(0xff), ...bytes(fallbackKeyHash)])),
      ).paylinkCreated,
    ).toBeUndefined()
    expect(decodeTransferMeta(stream(lane(good.slice(0, -1)))).paylinkCreated).toBeUndefined()
    expect(decodeTransferMeta(stream(lane([...good, 0xff]))).paylinkCreated).toBeUndefined()
  })

  it("first lane wins; a later stray lane is ignored", () => {
    const first = [0x00, ...dayBytes, ...bytes(secret), ...bytes(fallbackKeyHash)]
    const second = [0x01, ...dayBytes, ...bytes(fallbackKeyHash), ...bytes(secret)]
    expect(decodeTransferMeta(stream(lane(first), lane(second))).paylinkCreated).toEqual({
      flavor: "direct",
      day,
      secret,
      fallbackKeyHash,
    })
  })

  it("throws instead of truncating an email that cannot fit", () => {
    expect(() =>
      buildTransferMeta({
        paylinkCreated: { flavor: "email", day, secret, fallbackKeyHash, email: "a".repeat(200) },
      }),
    ).toThrow(/does not fit/)
  })
})
