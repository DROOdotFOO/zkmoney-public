import { describe, expect, it } from "vitest"
import {
  ConfigProfileError,
  fetchConfigProfile,
  parseServedProfile,
  pinnedProfileUrl,
  resolveVersion,
  retiredRollupNodes,
  retiredRollupVersions,
} from "../src/client.js"
import { isSupportedVersion, parseConfigProfile } from "../src/schema.js"
import { stagingDoc, withVersions } from "./fixture.js"

const PROFILE_URL = "https://config.example/profiles/staging-v5.json"

function fetchDoc(doc: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    throw new Error("expected rejection")
  } catch (e) {
    if (e instanceof ConfigProfileError) return e.code
    throw e
  }
}

describe("fetchConfigProfile", () => {
  it("fetches + validates a profile and resolves versions", async () => {
    const profile = await fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(stagingDoc()) })
    expect(profile.profileId).toBe("staging-v5")
    expect(profile.network).toBe("testnet")

    expect(resolveVersion(profile).versionId).toBe("0.0.2")
    expect(resolveVersion(profile, "0.0.1").versionId).toBe("0.0.1")
    expect(() => resolveVersion(profile, "0.0.9")).toThrow(ConfigProfileError)
    // An override must not reach the prototype chain and hand back `Object` as a version.
    expect(() => resolveVersion(profile, "constructor")).toThrow(ConfigProfileError)
  })

  it("resolves the version `current` names, not the greatest id", async () => {
    const doc = withVersions("0.0.2", "0.1.0", "0.0.9")
    doc.current = "0.0.2"
    const profile = await fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) })
    expect(resolveVersion(profile).versionId).toBe("0.0.2")
    expect(resolveVersion(profile, "0.1.0").versionId).toBe("0.1.0")
  })

  it("guards the default path against a hand-built object with a dangling current", () => {
    const doc = withVersions("0.0.2")
    doc.current = "9.9.9"
    expect(() => resolveVersion(doc)).toThrow(ConfigProfileError)
  })

  it("a malformed document is fatal, not degraded", async () => {
    const doc = stagingDoc()
    delete doc.versions["0.0.2"].l1RpcUrl
    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) }))).toBe(
      "INVALID_PROFILE",
    )
  })

  it("an expired profile is fatal", async () => {
    const doc = stagingDoc()
    doc.expiresAt = "2030-01-01T00:00:00Z"
    expect(
      await errorCode(
        fetchConfigProfile(PROFILE_URL, {
          fetchImpl: fetchDoc(doc),
          now: () => new Date("2031-01-01T00:00:00Z"),
        }),
      ),
    ).toBe("EXPIRED")
  })
})

describe("pinnedProfileUrl", () => {
  it("rewrites current.json to the validated sibling version", () => {
    expect(pinnedProfileUrl("https://cdn.example/profiles/v5/current.json", "0.3.0")).toBe(
      "https://cdn.example/profiles/v5/0.3.0.json",
    )
  })

  it.each(["../v4/current", "a/b", "%2e%2e/secret", "0.01.0", "?x=y", "#fragment"])(
    "rejects malformed override %j before resolving a profile URL",
    (versionId) => {
      for (const profileUrl of [
        "https://cdn.example/profiles/v5/current.json",
        "http://localhost:8083/profiles/sandbox.json",
      ]) {
        expect(() => pinnedProfileUrl(profileUrl, versionId)).toThrow(
          expect.objectContaining({ code: "INVALID_VERSION" }),
        )
      }
    },
  )

  it("rejects a malformed override before resolving a combined document", () => {
    expect(() => resolveVersion(stagingDoc(), "../v4/current")).toThrow(
      expect.objectContaining({ code: "INVALID_VERSION" }),
    )
  })
})

describe("fetch tolerates keys a build predates", () => {
  it("ignores an unknown key at any depth, keeping the rest of the document", async () => {
    const doc = stagingDoc()
    doc.somethingLater = { added: true }
    doc.shared.laterShared = "x"
    doc.versions["0.0.2"].laterVersion = 1
    doc.versions["0.0.2"].oxide.laterPointer = "z"
    // Contract entries are closed shapes: their extension point is `meta`, which passes verbatim.
    doc.versions["0.0.2"].contracts.claimFpc.meta.laterField = "y"

    const profile = await fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) })
    expect(profile.profileId).toBe("staging-v5")
    const live = resolveVersion(profile, "0.0.2").version
    expect(live.nodeUrl).toBe("https://node.example")
    expect(live.contracts.sponsorFPC?.address).toBeDefined()
    expect(live.oxide.manifestUrl).toBe("https://manifest.example/staging.v4.json")
    const claimFpc = live.contracts.claimFpc!
    expect("meta" in claimFpc && claimFpc.meta?.laterField).toBe("y")
    expect("somethingLater" in profile).toBe(false)
  })

  it("still rejects a real violation that arrives alongside an unknown key", async () => {
    const doc = stagingDoc()
    doc.somethingLater = true
    doc.shared.l1ChainId = 1

    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) }))).toBe(
      "INVALID_PROFILE",
    )
  })

  it("prunes a field this build does not know from an otherwise current-shape document", async () => {
    // `canonical` shipped in no published document, but the shape it represents — a field this
    // build no longer knows — is exactly what an already-published profile may grow.
    const doc = stagingDoc()
    doc.canonical = "0.0.2"

    const profile = await fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) })
    expect("canonical" in profile).toBe(false)
  })

  it("a document missing required fields is fatal — pruning tolerates additions, not omissions", async () => {
    const doc = stagingDoc()
    delete doc.current
    for (const version of Object.values<any>(doc.versions)) delete version.deployedAt
    doc.somethingLater = true

    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) }))).toBe(
      "INVALID_PROFILE",
    )
  })

  it("an addressed per-instance row stays fatal through the wire-tolerant path", async () => {
    const doc = stagingDoc()
    doc.versions["0.0.2"].contracts.paylinkDirect = {
      address: "0x" + "1".repeat(64),
      classId: "0x" + "2".repeat(64),
    }
    // An unknown key alongside the violation forces the prune-and-reparse to actually run —
    // the violation must survive the second parse, not just the first.
    doc.futureField = true
    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) }))).toBe(
      "INVALID_PROFILE",
    )
  })

  it("a field added inside a contract entry stays fatal — entries extend through meta", async () => {
    const doc = stagingDoc()
    doc.versions["0.0.2"].contracts.sponsorFPC.futureField = true

    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) }))).toBe(
      "INVALID_PROFILE",
    )
  })
})

describe("fetchConfigProfile timeout", () => {
  it("gives up on a connection that is accepted and never answered", async () => {
    const hangs: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })

    expect(
      await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: hangs, timeoutMs: 5 })),
    ).toBe("UNREACHABLE")
  })

  it("names the timeout so the retry screen says why", async () => {
    const hangs: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })

    await expect(
      fetchConfigProfile(PROFILE_URL, { fetchImpl: hangs, timeoutMs: 5 }),
    ).rejects.toThrow(/no complete response within 5ms/)
  })
})

/**
 * One rule: a 4xx is the server answering, everything else non-OK is silence. `Response` refuses
 * statuses outside 200–599, so the out-of-range rows use a bare object shaped like one.
 */
describe("fetchConfigProfile classifies how the server failed", () => {
  const answering = (status: number, json: () => Promise<unknown> = async () => ({})) =>
    (async () => ({ ok: status >= 200 && status <= 299, status, json })) as unknown as typeof fetch

  it.each([
    [404, "NOT_FOUND"],
    [400, "HTTP_ERROR"],
    [403, "HTTP_ERROR"],
    [499, "HTTP_ERROR"],
    [500, "UNREACHABLE"],
    [599, "UNREACHABLE"],
    [600, "UNREACHABLE"],
    [0, "UNREACHABLE"],
  ])("status %i → %s", async (status, code) => {
    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: answering(status) }))).toBe(
      code,
    )
  })

  it("a fetch that throws is unreachable", async () => {
    const refused: typeof fetch = async () => {
      throw new TypeError("fetch failed")
    }
    await expect(fetchConfigProfile(PROFILE_URL, { fetchImpl: refused })).rejects.toMatchObject({
      code: "UNREACHABLE",
      message: expect.stringContaining("fetch failed"),
    })
  })

  it("a body whose stream terminates is unreachable, not invalid", async () => {
    const dropped = answering(200, async () => {
      throw new TypeError("terminated")
    })
    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: dropped }))).toBe(
      "UNREACHABLE",
    )
  })

  it("a fully received body that is not JSON is invalid", async () => {
    const garbage = answering(200, async () => {
      throw new SyntaxError("Unexpected token <")
    })
    await expect(fetchConfigProfile(PROFILE_URL, { fetchImpl: garbage })).rejects.toMatchObject({
      code: "INVALID_PROFILE",
      message: expect.stringContaining("not JSON"),
    })
  })

  it("a body cut off by the deadline is unreachable even when it surfaces as a SyntaxError", async () => {
    const stalls: typeof fetch = async (_url, init) => {
      const json = () =>
        new Promise<unknown>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new SyntaxError("Unexpected end")))
        })
      return { ok: true, status: 200, json } as unknown as Response
    }
    await expect(
      fetchConfigProfile(PROFILE_URL, { fetchImpl: stalls, timeoutMs: 5 }),
    ).rejects.toMatchObject({
      code: "UNREACHABLE",
      message: expect.stringContaining("no complete response within 5ms"),
    })
  })
})

describe("parseServedProfile — the rulebook a baked document shares with a fetched one", () => {
  it("accepts a valid document", () => {
    expect(parseServedProfile(stagingDoc()).profileId).toBe("staging-v5")
  })

  it("prunes keys this build predates", () => {
    const doc = stagingDoc()
    doc.futureKey = true
    expect(parseServedProfile(doc)).not.toHaveProperty("futureKey")
  })

  it("rejects an expired document against the caller's clock", () => {
    const doc = stagingDoc()
    doc.expiresAt = "2026-08-12T00:00:00.000Z"
    expect(() => parseServedProfile(doc, { now: () => new Date("2026-09-01T00:00:00Z") })).toThrow(
      expect.objectContaining({ code: "EXPIRED" }),
    )
    expect(parseServedProfile(doc, { now: () => new Date("2026-08-11T12:00:00Z") }).profileId).toBe(
      "staging-v5",
    )
  })

  it("rejects a malformed document", () => {
    expect(() => parseServedProfile({ profileId: "x" })).toThrow(
      expect.objectContaining({ code: "INVALID_PROFILE" }),
    )
  })
})

describe("an entry schema this build does not speak", () => {
  function withFutureCurrent() {
    const doc = stagingDoc()
    doc.versions["0.0.3"] = { schemaVersion: "2", somethingNew: true }
    doc.current = "0.0.3"
    return doc
  }

  it("refuses resolution with the typed app-update code, naming both schemas", async () => {
    const profile = await fetchConfigProfile(PROFILE_URL, {
      fetchImpl: fetchDoc(withFutureCurrent()),
    })
    try {
      resolveVersion(profile)
      throw new Error("expected rejection")
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigProfileError)
      expect((e as ConfigProfileError).code).toBe("UNSUPPORTED_VERSION_SCHEMA")
      expect((e as ConfigProfileError).message).toContain('"2"')
      expect((e as ConfigProfileError).message).toContain('"1"')
      expect((e as ConfigProfileError).message).toContain("app update")
    }
  })

  it("keeps a pinned older entry resolvable after current moves past this build", async () => {
    const profile = await fetchConfigProfile(PROFILE_URL, {
      fetchImpl: fetchDoc(withFutureCurrent()),
    })
    const pinned = resolveVersion(profile, "0.0.2")
    expect(pinned.versionId).toBe("0.0.2")
    expect(pinned.version.nodeUrl).toBe("https://node.example")
  })

  it("refuses to certify a hand-built entry the marker alone vouches for", () => {
    // The parser never produces this; the resolver supports hand-built profiles, so the marker
    // must not be the only thing standing between a bare object and a certified ConfigVersion.
    const doc = withVersions("0.0.2")
    doc.versions["0.0.2"] = { schemaVersion: "1" }
    try {
      resolveVersion(doc)
      throw new Error("expected rejection")
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigProfileError)
      expect((e as ConfigProfileError).code).toBe("INVALID_PROFILE")
    }
    expect(isSupportedVersion(doc.versions["0.0.2"])).toBe(false)
  })

  it("classifies a present-but-junk slot as invalid, not missing", () => {
    for (const junk of [null, undefined, 0, "", false]) {
      const doc = withVersions("0.0.2")
      doc.versions["0.0.2"] = junk
      try {
        resolveVersion(doc)
        throw new Error(`expected rejection for slot ${JSON.stringify(junk)}`)
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigProfileError)
        expect((e as ConfigProfileError).code, `slot ${JSON.stringify(junk)}`).toBe(
          "INVALID_PROFILE",
        )
      }
      expect(isSupportedVersion(junk)).toBe(false)
    }
  })

  it("classifies a malformed marker as invalid, never as an app-update ask", () => {
    // Only a well-formed marker this build does not know earns "app update required" — junk a
    // hand-built object can carry (the wire never produces it) must not wear that message.
    for (const marker of [undefined, 1, "", "0", "01", "v2"]) {
      const doc = withVersions("0.0.2")
      doc.versions["0.0.2"] = { ...doc.versions["0.0.2"], schemaVersion: marker }
      try {
        resolveVersion(doc)
        throw new Error(`expected rejection for marker ${JSON.stringify(marker)}`)
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigProfileError)
        expect((e as ConfigProfileError).code, `marker ${JSON.stringify(marker)}`).toBe(
          "INVALID_PROFILE",
        )
      }
    }
  })

  it("an unknown key in one entry cannot mask a violation in another", async () => {
    const doc = stagingDoc()
    doc.versions["0.0.1"].futureField = true
    delete doc.versions["0.0.2"].l1RpcUrl
    expect(await errorCode(fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) }))).toBe(
      "INVALID_PROFILE",
    )
  })

  it("prunes a legacy top-level schemaVersion — the envelope carries no marker", async () => {
    const doc = stagingDoc()
    doc.schemaVersion = "1"
    const profile = await fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) })
    expect("schemaVersion" in profile).toBe(false)
    expect(resolveVersion(profile).versionId).toBe("0.0.2")
  })

  it("still prunes keys a build predates elsewhere in the document", async () => {
    const doc = withFutureCurrent()
    doc.somethingLater = true
    const profile = await fetchConfigProfile(PROFILE_URL, { fetchImpl: fetchDoc(doc) })
    expect("somethingLater" in profile).toBe(false)
    expect(resolveVersion(profile, "0.0.2").versionId).toBe("0.0.2")
  })
})

describe("pinnedProfileUrl", () => {
  it("pins current.json, preserves combined documents, and leaves an unpinned URL alone", () => {
    expect(pinnedProfileUrl("https://cdn.example/profiles/v5/current.json", "0.3.0")).toBe(
      "https://cdn.example/profiles/v5/0.3.0.json",
    )
    expect(pinnedProfileUrl("http://localhost:8083/profiles/sandbox.json", "0.0.1")).toBe(
      "http://localhost:8083/profiles/sandbox.json",
    )
    expect(pinnedProfileUrl("https://cdn.example/profiles/v5/current.json")).toBe(
      "https://cdn.example/profiles/v5/current.json",
    )
  })
})

describe("retiredRollupNodes", () => {
  it("names only profile-selected portals, including sources on the current node", () => {
    const doc = withVersions("0.0.3", "0.0.2", "0.0.1")
    doc.versions["0.0.2"].nodeUrl = "https://old.rpc.example"
    doc.versions["0.0.2"].oxide.portal = "0x" + "AB".repeat(20)
    doc.versions["0.0.1"].oxide.portal = "0x" + "cd".repeat(20)
    const nodes = retiredRollupNodes(parseConfigProfile(doc))
    expect([...nodes]).toEqual([
      ["0x" + "ab".repeat(20), "https://old.rpc.example"],
      ["0x" + "cd".repeat(20), doc.versions["0.0.1"].nodeUrl],
    ])
  })

  it("names nothing when the profile has no supported history", () => {
    expect(retiredRollupNodes(parseConfigProfile(withVersions("0.0.1"))).size).toBe(0)
  })
})

describe("retiredRollupVersions", () => {
  it("lists each version on another node with its manifest and every deployment it pins", () => {
    const doc = withVersions("0.0.3", "0.0.2", "0.0.1")
    const old = doc.versions["0.0.2"]
    old.nodeUrl = "https://v5.rpc.example"
    old.oxide.manifestUrl = "https://manifests.example/staging.v4.json"
    old.oxide.portal = "0x" + "ab".repeat(20)
    old.assets = [
      { symbol: "DAI", portal: "0x" + "AB".repeat(20), expectedGitSha: old.oxide.expectedGitSha },
      {
        symbol: "sUSDS",
        portal: "0x" + "ef".repeat(20),
      },
    ]
    expect(retiredRollupVersions(parseConfigProfile(doc))).toEqual([
      {
        versionId: "0.0.2",
        nodeUrl: "https://v5.rpc.example",
        manifestUrl: "https://manifests.example/staging.v4.json",
        pins: [
          {
            portal: "0x" + "ab".repeat(20),
            expectedGitSha: old.oxide.expectedGitSha,
          },
          { portal: "0x" + "ef".repeat(20) },
        ],
      },
    ])
  })
})
