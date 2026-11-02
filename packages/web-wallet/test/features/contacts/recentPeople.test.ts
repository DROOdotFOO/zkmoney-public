import { describe, expect, it } from "vitest"
import type { ContactRow, PaymentRequest, Transaction } from "@obsidion/front-core"
import { recentPeople } from "../../../src/features/contacts/recentPeople"

const addr = (byte: string) => `0x${byte.repeat(32)}`
const contact = (tag: string, byte: string): ContactRow => ({
  id: tag,
  name: tag,
  tag,
  address: addr(byte),
  addressKind: "aztec-l2",
})
const token = { name: "Dai", symbol: "DAI", amount: 1, price: 1 }
const send = (to: string, timestamp: number, toTag?: string): Transaction =>
  ({ action: "send", token, to, toTag, timestamp, status: "success" } as Transaction)
const request = (contactTag: string, createdAt: number): PaymentRequest =>
  ({
    id: contactTag,
    kind: "contact",
    contactTag,
    createdAt,
    status: "pending",
  } as unknown as PaymentRequest)

const ada = contact("ada", "0a")
const bob = contact("bob", "0b")

describe("recentPeople", () => {
  it("puts someone paid without saving among saved contacts by when they were last paid", () => {
    const rows = recentPeople(
      [ada, bob],
      {
        transactions: [
          send(ada.address, 100),
          send(addr("0c"), 300, "pleaswork"),
          send(bob.address, 200),
        ],
      },
      4,
    )
    expect(rows.map((r) => r.tag)).toEqual(["pleaswork", "bob", "ada"])
  })

  it("counts a request to an unsaved tag, and fills spare slots with saved contacts", () => {
    const rows = recentPeople([ada, bob], { requests: [request("grace", 500)] }, 3)
    expect(rows.map((r) => r.tag)).toEqual(["grace", "ada", "bob"])
  })

  it("lists a saved person once, however their activity was recorded", () => {
    const rows = recentPeople(
      [ada],
      { transactions: [send(ada.address, 100, "ada")], requests: [request("ada", 50)] },
      4,
    )
    expect(rows.map((r) => r.id)).toEqual(["ada"])
  })

  it("leaves out an unsaved person who requested funds", () => {
    const incoming = { ...request("mina", 500), direction: "incoming" } as PaymentRequest
    const rows = recentPeople([ada], { requests: [incoming] }, 3)
    expect(rows.map((r) => r.tag)).toEqual(["ada"])
  })

  it("keeps to the limit", () => {
    const rows = recentPeople([ada, bob], { requests: [request("grace", 1), request("hal", 2)] }, 2)
    expect(rows.map((r) => r.tag)).toEqual(["hal", "grace"])
  })
})
