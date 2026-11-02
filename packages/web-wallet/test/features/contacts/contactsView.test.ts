import { describe, expect, it } from "vitest"
import type { Contact, ContactRow, InlineResolveResult } from "@obsidion/front-core"
import {
  addressKindLabel,
  filterContacts,
  findContactEntry,
  freshResolutionConfirms,
  inlinePanelState,
  l1AliasDraft,
  l1ContactHeader,
  l2ContactHeader,
  l2ContactLabel,
  removeIdentityOf,
  shouldResolveInline,
} from "../../../src/features/contacts/contactsView"

const ADDR_A = "0x" + "a".repeat(64)
const ADDR_B = "0x" + "b".repeat(64)
const ETH_ADDR = "0x" + "1".repeat(40)

const row = (tag: string, overrides: Partial<ContactRow> = {}): ContactRow => ({
  id: tag,
  name: tag,
  tag,
  address: ADDR_A,
  addressKind: "aztec-l2",
  ...overrides,
})

describe("filterContacts", () => {
  it("matches name or tag, case-insensitive, and strips a leading @", () => {
    const rows = [row("alice"), row("bob", { name: "Robert" })]
    expect(filterContacts(rows, "")).toEqual(rows)
    expect(filterContacts(rows, "@ALI").map((r) => r.tag)).toEqual(["alice"])
    expect(filterContacts(rows, "robe").map((r) => r.tag)).toEqual(["bob"])
    expect(filterContacts(rows, "zzz")).toEqual([])
  })
})

describe("inline resolution gating", () => {
  it("an already-saved tag never resolves inline — it surfaces as its directory row", () => {
    const rows = [row("alice")]
    expect(shouldResolveInline(rows, "alice")).toBe(false)
    expect(shouldResolveInline(rows, "@alice.zk.money")).toBe(false)
    expect(inlinePanelState(rows, "alice", null)).toEqual({ kind: "none" })
    // The saved row is still shown, so nothing invites a duplicate add.
    expect(filterContacts(rows, "alice").map((r) => r.tag)).toEqual(["alice"])
  })

  it("an unsaved tag resolves; empty input does not", () => {
    expect(shouldResolveInline([row("alice")], "bob")).toBe(true)
    expect(shouldResolveInline([], "  ")).toBe(false)
  })

  it("the user's own tag never resolves or surfaces", () => {
    expect(shouldResolveInline([], "me", "me")).toBe(false)
    expect(shouldResolveInline([], "@me.zk.money", "me")).toBe(false)
    expect(
      inlinePanelState([], "me", { tag: "me", status: "found", address: ADDR_B }, "me"),
    ).toEqual({ kind: "none" })
  })
})

describe("inlinePanelState", () => {
  const resolved = (status: InlineResolveResult["status"], tag = "bob"): InlineResolveResult => ({
    tag,
    status,
    address: status === "found" ? ADDR_B : undefined,
  })

  it.each([
    ["no resolution yet", null, false, "looking-up"],
    ["a resolution in flight", resolved("resolving"), false, "looking-up"],
    ["a registry hit", resolved("found"), false, "add-offer"],
    ["a miss", resolved("not_found"), false, "no-user-found"],
    ["a miss the claim server is still asked about", resolved("not_found"), null, "looking-up"],
    ["a miss the claim server holds", resolved("not_found"), true, "reserved"],
    ["a hit the claim server also holds", resolved("found"), true, "add-offer"],
    ["a tag on a retired rollup", resolved("not_upgraded"), false, "not-upgraded"],
    [
      "a tag on a retired rollup the claim server holds",
      resolved("not_upgraded"),
      true,
      "not-upgraded",
    ],
  ] as const)("names the panel for %s", (_, resolution, held, kind) => {
    expect(inlinePanelState([], "bob", resolution, undefined, held)).toEqual({
      kind,
      tag: "bob",
    })
  })

  it("ignores a stale resolution for a different tag", () => {
    expect(inlinePanelState([], "carol", resolved("found", "bob"))).toEqual({
      kind: "looking-up",
      tag: "carol",
    })
  })
})

describe("findContactEntry / addressKindLabel", () => {
  const l2: Contact = { name: "alice", address: ADDR_A, tag: "alice" }
  const pending: Contact = {
    name: "carol",
    address: ETH_ADDR,
    tag: "carol",
    addressKind: "pending-handshake",
    provenance: "qr-scan",
  }
  const l1: Contact = {
    name: "Cold wallet",
    address: ETH_ADDR,
    addressKind: "ethereum-l1",
    l1Wallet: { provider: "rainbow", provenance: "saved-recipient" },
  }

  it("resolves by tag, by address, and by L1 directory row id", () => {
    const entries = [l2, pending, l1]
    expect(findContactEntry(entries, "alice")).toBe(l2)
    expect(findContactEntry(entries, ADDR_A.toUpperCase())).toBe(l2)
    expect(findContactEntry(entries, `l1:rainbow:${ETH_ADDR}`)).toBe(l1)
    expect(findContactEntry(entries, "carol")).toBe(pending)
    expect(findContactEntry(entries, "nobody")).toBeUndefined()
  })

  it("labels routable L2, pending-handshake, and L1 kinds distinctly", () => {
    expect(addressKindLabel(l2)).toBe("zk.money (Aztec L2)")
    expect(addressKindLabel(pending)).toBe("Handshake pending — not yet payable")
    expect(addressKindLabel(l1)).toBe("Ethereum wallet (L1)")
  })

  it("removeIdentityOf keeps the address kind so non-L2 rows delete correctly", () => {
    expect(removeIdentityOf(pending)).toEqual({
      address: ETH_ADDR,
      addressKind: "pending-handshake",
      provider: undefined,
    })
    expect(removeIdentityOf(l1)).toEqual({
      address: ETH_ADDR,
      addressKind: "ethereum-l1",
      provider: "rainbow",
    })
  })

  it("l1ContactHeader uses the saved label, else the truncated address", () => {
    expect(l1ContactHeader(l1)).toEqual({
      title: "Cold wallet",
      subtitle: "0x1111...1111",
    })
    expect(
      l1ContactHeader({
        ...l1,
        name: "External Wallet",
      }),
    ).toEqual({
      title: "0x1111...1111",
      subtitle: "Ethereum wallet",
    })
  })

  it("l1AliasDraft prefills a real label and blanks the placeholder", () => {
    expect(l1AliasDraft(l1)).toBe("Cold wallet")
    expect(l1AliasDraft({ ...l1, name: "External Wallet" })).toBe("")
    expect(l1AliasDraft({ ...l1, name: "  " })).toBe("")
  })
})

describe("renamed zk.money contacts", () => {
  const l2 = (name: string): Contact => ({
    name,
    address: ADDR_A,
    addressKind: "aztec-l2",
    tag: "harry",
  })

  it("treats a name other than the tag as the user's own label", () => {
    expect(l2ContactLabel(l2("Harry B"))).toBe("Harry B")
    expect(l2ContactHeader(l2("Harry B"))).toEqual({
      title: "Harry B",
      subtitle: "@harry.zk.money",
    })
  })

  it("counts a case-only change as a rename", () => {
    expect(l2ContactHeader(l2("Harry"))).toEqual({ title: "Harry", subtitle: "@harry.zk.money" })
  })

  it("reads the tag, a blank name, or a messaging address as no rename", () => {
    for (const name of ["harry", " harry ", "  ", "0x" + "c".repeat(40)]) {
      expect(l2ContactLabel(l2(name))).toBeUndefined()
      expect(l2ContactHeader(l2(name))).toEqual({ title: "@harry", subtitle: ".zk.money" })
    }
  })
})

describe("freshResolutionConfirms", () => {
  const resolved = (l2Address: string) =>
    ({
      status: "resolved",
      account: "0x00000000000000000000000000000000000000aa",
      l2Address,
      rollupId: "r1",
      sipaStealthPublicKey: { x: 1n, y: 2n },
      xmtpAddress: "0x00000000000000000000000000000000000000b0",
    } as const)

  const cached = { tag: "alice", status: "found", address: "0xabc" } as const

  it("confirms when the fresh resolution matches the cached address", () => {
    expect(freshResolutionConfirms(cached, "alice", resolved("0xabc"))).toBe(true)
  })

  it("rejects when the fresh address differs (rotated manifest)", () => {
    expect(freshResolutionConfirms(cached, "alice", resolved("0xdef"))).toBe(false)
  })

  it("rejects when the fresh resolution is notFound or staleRollup", () => {
    expect(freshResolutionConfirms(cached, "alice", { status: "notFound" })).toBe(false)
    expect(
      freshResolutionConfirms(cached, "alice", { status: "staleRollup", rollupId: "r0" } as never),
    ).toBe(false)
  })

  it("rejects when there is no cached resolution for the tag", () => {
    expect(freshResolutionConfirms(null, "alice", resolved("0xabc"))).toBe(false)
    expect(freshResolutionConfirms(cached, "bob", resolved("0xabc"))).toBe(false)
  })
})
