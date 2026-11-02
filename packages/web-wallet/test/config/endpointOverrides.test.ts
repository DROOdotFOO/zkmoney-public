import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearAllEndpointOverrides,
  endpointDigest,
  normalizeEndpoint,
  readEndpointOverrides,
  tryNormalizeEndpoint,
  writeEndpointOverrides,
  type EndpointKind,
  type EndpointValues,
} from "../../src/config/endpointOverrides"

const KEY = "webwallet.endpoints"
const KINDS: EndpointKind[] = ["node", "l1Rpc", "enclave"]
const NONE = { node: "", l1Rpc: "", enclave: "" }
/** A write from the current record, as an editor opened just now would make it. */
const write = (next: EndpointValues, seen = readEndpointOverrides()) =>
  writeEndpointOverrides(next, seen)

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("normalizeEndpoint", () => {
  it("keeps scheme, host, port, path and query; drops the fragment", () => {
    expect(normalizeEndpoint("https://n.example")).toBe("https://n.example/")
    expect(normalizeEndpoint("https://n.example:8443/rpc?tenant=A#frag")).toBe(
      "https://n.example:8443/rpc?tenant=A",
    )
  })

  it("lets the parser lower-case the host, drop an implicit port and punycode an IDN", () => {
    expect(normalizeEndpoint("https://N.example:443/rpc")).toBe("https://n.example/rpc")
    expect(normalizeEndpoint("HTTPS://n.example/rpc")).toBe("https://n.example/rpc")
    expect(normalizeEndpoint("https://bücher.example/rpc")).toBe(
      "https://xn--bcher-kva.example/rpc",
    )
  })

  it("refuses anything but a credential-free http(s) URL", () => {
    expect(() => normalizeEndpoint("ftp://x")).toThrow(/http/)
    expect(() => normalizeEndpoint("not a url")).toThrow()
    expect(() => normalizeEndpoint("https://user:pw@n.example")).toThrow(/credentials/)
    expect(tryNormalizeEndpoint("")).toBeUndefined()
    expect(tryNormalizeEndpoint("/svc/enclave")).toBeUndefined()
  })

  it("refuses a scheme without its //: the parser reads an authority, fetch reads a path", () => {
    expect(() => normalizeEndpoint("https:n.example/rpc")).toThrow(/http/)
    expect(() => normalizeEndpoint("https:/n.example/rpc")).toThrow(/http/)
  })

  it("keeps an empty query's ?, which the request keeps too", () => {
    expect(normalizeEndpoint("https://n.example/rpc?")).toBe("https://n.example/rpc?")
    expect(normalizeEndpoint("https://n.example/rpc?#x")).toBe("https://n.example/rpc?")
    expect(normalizeEndpoint("https://n.example/rpc?")).not.toBe(
      normalizeEndpoint("https://n.example/rpc"),
    )
  })
})

describe("endpointDigest", () => {
  const digest = (url: string) => endpointDigest(normalizeEndpoint(url))

  it("is a pinned 128-bit truncation — the store suffix must never drift", () => {
    expect(digest("https://n.example")).toBe("fda13571234d242bfb7620098b81f10b")
    expect(digest("https://n.example/rpc")).toBe("f77b6003b50d014e0fadcf99869260a3")
  })

  it("separates paths that route differently", () => {
    const digests = new Set(
      [
        "https://n.example/rpc",
        "https://n.example/rpc/",
        "https://n.example/rpc//",
        "https://n.example/rpc?",
      ].map(digest),
    )
    expect(digests.size).toBe(4)
    expect(digest("http://n.example/rpc")).not.toBe(digest("https://n.example/rpc"))
  })

  it("joins spellings that route the same", () => {
    expect(digest("https://N.example:443/rpc")).toBe(digest("https://n.example/rpc"))
    expect(digest("https://bücher.example/rpc")).toBe(digest("https://xn--bcher-kva.example/rpc"))
    expect(digest("https://n.example/rpc#a")).toBe(digest("https://n.example/rpc#b"))
  })
})

describe("stored overrides", () => {
  it("stores the trimmed values in one record and reads them back verbatim", () => {
    expect(write({ ...NONE, node: "  https://n.example  " })).toEqual({ ok: true })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ node: "https://n.example" })
    expect(readEndpointOverrides()).toEqual({ node: "https://n.example" })
    expect(readEndpointOverrides().node).toBe("https://n.example")
    expect(readEndpointOverrides().l1Rpc).toBeUndefined()
  })

  it.each([
    "ftp://x",
    "not a url",
    "https://user:pw@n.example",
    "https:n.example/rpc",
    "https:/n.example/rpc",
  ])("%s: refused on write and ignored on read, for every kind", (bad) => {
    for (const kind of KINDS) {
      expect(write({ ...NONE, [kind]: bad })).toEqual({
        ok: false,
        reason: "invalid",
        kind,
      })
      expect(localStorage.getItem(KEY)).toBeNull()

      localStorage.setItem(KEY, JSON.stringify({ [kind]: bad }))
      expect(readEndpointOverrides()[kind]).toBeUndefined()
      localStorage.clear()
    }
  })

  it("a record that does not parse, or is not an object, reads as none", () => {
    localStorage.setItem(KEY, "not json")
    expect(readEndpointOverrides()).toEqual({})
    localStorage.setItem(KEY, JSON.stringify("https://n.example"))
    expect(readEndpointOverrides()).toEqual({})
    localStorage.setItem(KEY, JSON.stringify({ node: 7 }))
    expect(readEndpointOverrides()).toEqual({})
  })

  it("the enclave drops trailing slashes, since the wallet appends /rpc", () => {
    expect(write({ ...NONE, enclave: "https://e.example/" })).toEqual({ ok: true })
    expect(readEndpointOverrides().enclave).toBe("https://e.example")
    expect(write({ ...NONE, enclave: "https://e.example/tee//" })).toEqual({
      ok: true,
    })
    expect(readEndpointOverrides().enclave).toBe("https://e.example/tee")
  })

  it("the enclave refuses a query, a fragment or the /rpc path; the node keeps its query", () => {
    for (const bad of [
      "https://e.example/?x=1",
      "https://e.example/#x",
      "https://e.example/rpc",
      "https://e.example/RPC/",
    ]) {
      expect(write({ ...NONE, enclave: bad })).toEqual({
        ok: false,
        reason: "invalid",
        kind: "enclave",
      })
      localStorage.setItem(KEY, JSON.stringify({ enclave: bad }))
      expect(readEndpointOverrides().enclave).toBeUndefined()
    }
    expect(write({ ...NONE, node: "https://n.example/?tenant=B" })).toEqual({
      ok: true,
    })
  })

  it("a write the storage refused changes nothing", () => {
    write({ ...NONE, node: "https://old.example" })
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    expect(write({ ...NONE, node: "https://n.example", l1Rpc: "https://l1.example" })).toEqual({
      ok: false,
      reason: "storage",
    })
    setItem.mockRestore()
    expect(readEndpointOverrides()).toEqual({ node: "https://old.example" })
  })

  it("a write from a stale record is refused; one from the current record goes through", () => {
    write({ ...NONE, l1Rpc: "https://l1.example" })
    expect(write({ ...NONE, node: "https://n.example" }, {})).toEqual({
      ok: false,
      reason: "changed",
    })
    expect(readEndpointOverrides()).toEqual({ l1Rpc: "https://l1.example" })
    expect(write({ ...NONE, node: "https://n.example" }, { l1Rpc: "https://l1.example" })).toEqual({
      ok: true,
    })
    expect(readEndpointOverrides()).toEqual({ node: "https://n.example" })
  })

  it("a write that did not stick", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {})
    expect(write({ ...NONE, node: "https://n.example" })).toEqual({
      ok: false,
      reason: "storage",
    })
  })

  it("a storage failure reads as no override", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })
    expect(readEndpointOverrides()).toEqual({})
  })

  it("an all-default save removes the record; clearing all confirms the removal", () => {
    write({
      node: "https://n.example",
      l1Rpc: "https://l1.example",
      enclave: "https://e.example",
    })
    expect(write({ ...NONE, l1Rpc: "https://l1.example" })).toEqual({ ok: true })
    expect(readEndpointOverrides()).toEqual({ l1Rpc: "https://l1.example" })
    expect(write(NONE)).toEqual({ ok: true })
    expect(localStorage.getItem(KEY)).toBeNull()

    write({ ...NONE, node: "https://n.example" })
    expect(clearAllEndpointOverrides()).toEqual({ ok: true })
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("a removal that did not stick reports ok: false", () => {
    localStorage.setItem(KEY, JSON.stringify({ node: "https://n.example" }))
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {})
    expect(clearAllEndpointOverrides()).toEqual({ ok: false })
  })
})

describe("the node's API key", () => {
  const NODE = "https://n.example"

  it("is stored trimmed beside its node and read back", () => {
    expect(write({ ...NONE, node: NODE, nodeApiKey: "  k-1_A.b  " })).toEqual({ ok: true })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ node: NODE, nodeApiKey: "k-1_A.b" })
    expect(readEndpointOverrides()).toEqual({ node: NODE, nodeApiKey: "k-1_A.b" })
  })

  it("without a node it is refused on write and ignored on read", () => {
    expect(write({ ...NONE, nodeApiKey: "k" })).toEqual({
      ok: false,
      reason: "invalid",
      kind: "nodeApiKey",
    })
    expect(localStorage.getItem(KEY)).toBeNull()
    localStorage.setItem(KEY, JSON.stringify({ l1Rpc: "https://l1.example", nodeApiKey: "k" }))
    expect(readEndpointOverrides()).toEqual({ l1Rpc: "https://l1.example" })
    // A node that no longer validates takes its key with it.
    localStorage.setItem(KEY, JSON.stringify({ node: "ftp://x", nodeApiKey: "k" }))
    expect(readEndpointOverrides()).toEqual({})
  })

  it.each([
    ["a space", "a b"],
    ["a newline", "a\nb"],
    ["a non-ASCII character", "ключ"],
    ["over 512 characters", "x".repeat(513)],
  ])("with %s it is refused on write and ignored on read", (_label, bad) => {
    expect(write({ ...NONE, node: NODE, nodeApiKey: bad })).toEqual({
      ok: false,
      reason: "invalid",
      kind: "nodeApiKey",
    })
    expect(localStorage.getItem(KEY)).toBeNull()
    localStorage.setItem(KEY, JSON.stringify({ node: NODE, nodeApiKey: bad }))
    expect(readEndpointOverrides()).toEqual({ node: NODE })
  })

  it("a key another tab changed since the editor opened refuses the save", () => {
    write({ ...NONE, node: NODE, nodeApiKey: "old" })
    expect(write({ ...NONE, node: NODE, nodeApiKey: "new" }, { node: NODE })).toEqual({
      ok: false,
      reason: "changed",
    })
    expect(readEndpointOverrides()).toEqual({ node: NODE, nodeApiKey: "old" })
  })

  it("an empty key removes it; clearing all removes it with the URLs", () => {
    write({ ...NONE, node: NODE, nodeApiKey: "k" })
    expect(write({ ...NONE, node: NODE, nodeApiKey: "" })).toEqual({ ok: true })
    expect(readEndpointOverrides()).toEqual({ node: NODE })
    write({ ...NONE, node: NODE, nodeApiKey: "k" })
    expect(clearAllEndpointOverrides()).toEqual({ ok: true })
    expect(readEndpointOverrides()).toEqual({})
  })
})
