// @vitest-environment node
import { describe, expect, it } from "vitest"
import { decodePaylinkInline } from "@obsidion/sdk"
import type { Contact } from "@obsidion/front-core"
import { scanPayload } from "../../../src/features/scan/scanPayload"
import {
  CONNECT_LINK,
  CONNECT_FRAGMENT,
  PAYLINK_FRAGMENT,
  PREPARED_PAYLINK_FRAGMENTS,
  REQUEST_FRAGMENT,
  PEER_L1,
  PEER_L2,
} from "../../fixtures/scanPayloads"

const identity = { ownTag: "bob", ownL2Address: `0x${"25".repeat(32)}`, contacts: [] as Contact[] }
const destination = (to: string, state?: object) => ({
  kind: "destination",
  destination: { to, ...(state ? { state } : {}) },
})

describe("scanPayload", () => {
  it("preserves the entire connect packet for explicit destination confirmation", async () => {
    expect(await scanPayload(CONNECT_LINK, identity)).toEqual(
      destination(`/connect#${CONNECT_FRAGMENT}`),
    )
  })
  it.each([
    "https://wallet.zk.money/connect#broken!",
    "https://wallet.zk.money/connect",
    "https://evil.example/connect#AAAA",
    "https://wallet.zk.money/connect#AA",
    `https://wallet.zk.money/connect#${PAYLINK_FRAGMENT}`,
    `https://wallet.zk.money/connect#${REQUEST_FRAGMENT}`,
  ])("does not downgrade malformed connect input: %s", async (payload) => {
    expect(await scanPayload(payload, identity)).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/connect code|connect link/),
    })
  })
  it.each([
    [`https://paylink.zk.money/claim#${PAYLINK_FRAGMENT}`, `/link#${PAYLINK_FRAGMENT}`],
    [PAYLINK_FRAGMENT, `/link#${PAYLINK_FRAGMENT}`],
    [`https://wallet.zk.money/request#${REQUEST_FRAGMENT}`, `/request#${REQUEST_FRAGMENT}`],
    [REQUEST_FRAGMENT, `/request#${REQUEST_FRAGMENT}`],
  ])("uses existing validated link routing for %s", async (payload, route) => {
    expect(await scanPayload(payload, identity)).toEqual(destination(route))
  })
  it.each(Object.entries(PREPARED_PAYLINK_FRAGMENTS))(
    "preserves a prepared %s paylink",
    async (flavor, fragment) => {
      const decoded = decodePaylinkInline(fragment)
      expect(decoded.paylinkType).toBe(flavor === "email" ? "paylinkEmail" : "paylinkDirect")
      for (const payload of [fragment, `https://paylink.zk.money/claim#${fragment}`]) {
        expect(await scanPayload(payload, identity)).toEqual(destination(`/link#${fragment}`))
      }
      expect(identity.contacts).toEqual([])
    },
  )
  it.each([
    ["https://wallet.zk.money/pay/alice", "/pay/alice"],
    ["https://wallet.staging.zk.money/pay/Alice/", "/pay/alice"],
    [`https://wallet.zk.money/pay/alice#${REQUEST_FRAGMENT}`, `/pay/alice#${REQUEST_FRAGMENT}`],
    ["https://alice.zk.money", "/pay/alice"],
    ["https://alice.zk.money/", "/pay/alice"],
  ])("opens the pay page for %s", async (payload, route) => {
    expect(await scanPayload(payload, identity)).toEqual(destination(route))
  })
  it.each([
    "https://wallet.zk.money/pay/",
    "https://wallet.zk.money/pay/alice/x",
    "https://wallet.zk.money/pay/alice?amount=5",
    `https://wallet.zk.money/pay/alice#${PAYLINK_FRAGMENT}`,
    "https://wallet.zk.money/pay/-alice",
  ])("refuses a malformed pay link: %s", async (payload) => {
    expect(await scanPayload(payload, identity)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("pay link"),
    })
  })
  it.each(["@ALICE", "alice.zk.money", "zkmoney/pay/me/alice"])(
    "seeds existing search for an unsaved tag without writing: %s",
    async (payload) => {
      expect(await scanPayload(payload, identity)).toEqual(
        destination("/contacts", { searchTag: "alice" }),
      )
      expect(identity.contacts).toEqual([])
    },
  )
  it("opens a saved tag's existing contact actions", async () => {
    const contact = { name: "Alice", tag: "alice", address: PEER_L2 }
    expect(await scanPayload("@alice", { ...identity, contacts: [contact] })).toEqual(
      destination("/contacts/alice"),
    )
  })
  it.each([PEER_L1, PEER_L2])(
    "rejects an unknown raw recipient before tag fallback: %s",
    async (payload) => {
      expect(await scanPayload(payload, identity)).toMatchObject({
        kind: "error",
        message: expect.stringContaining("not a saved contact"),
      })
    },
  )
  it("routes a saved L1 address to address-kind-aware detail, never send", async () => {
    const contact: Contact = { name: "Wallet", address: PEER_L1, addressKind: "ethereum-l1" }
    const result = await scanPayload(PEER_L1, { ...identity, contacts: [contact] })
    expect(result).toMatchObject({
      kind: "destination",
      destination: { to: expect.stringMatching(/^\/contacts\//) },
    })
    expect(JSON.stringify(result)).not.toContain("/send")
  })
  it.each([
    { name: "Deleted wallet", address: PEER_L1, addressKind: "ethereum-l1", l1Wallet: { provider: "manual", deletedAt: 123 } },
    { name: "Mint", tag: "alice", address: `0x${"00".repeat(32)}` },
    { name: "Pending", tag: "alice", address: PEER_L2, addressKind: "pending-handshake" },
  ] as Contact[])("does not treat hidden directory entry $name as a saved recipient", async (contact) => {
    expect(await scanPayload(contact.address, { ...identity, contacts: [contact] })).toMatchObject({ kind: "error" })
    if (contact.tag) {
      expect(await scanPayload(`@${contact.tag}`, { ...identity, contacts: [contact] })).toEqual(destination("/contacts", { searchTag: contact.tag }))
    }
  })
  it.each([
    "@bob",
    identity.ownL2Address,
    CONNECT_LINK,
    "https://wallet.zk.money/pay/bob",
    "https://bob.zk.money",
  ])("rejects self scans", async (payload) => {
    expect(
      await scanPayload(payload, {
        ...identity,
        ...(payload === CONNECT_LINK ? { ownL2Address: PEER_L2 } : {}),
      }),
    ).toMatchObject({ kind: "error", message: expect.stringContaining("your own") })
  })
  it.each([
    "",
    "https://example.com",
    "javascript:alert(1)",
    "https://wallet.zk.money/not-connect#invalid",
    "0x1234",
    "not a payload",
    "@bad.tag",
  ])("keeps unsupported input recoverable: %s", async (payload) => {
    expect(await scanPayload(payload, identity)).toMatchObject({ kind: "error" })
  })
})
