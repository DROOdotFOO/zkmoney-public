import { describe, expect, it } from "vitest"
import { notElsewhere, stampedOn } from "../../src/types/networkStamp"

const NET = "0xabcdef"

describe.each([
  ["stampedOn", stampedOn, { same: true, mixedCase: true, other: false, unstamped: false }],
  ["notElsewhere", notElsewhere, { same: true, mixedCase: true, other: false, unstamped: true }],
] as const)("%s", (_, predicate, expected) => {
  it.each([
    ["same", { networkId: NET }, NET],
    ["mixedCase", { networkId: "0xABCdef" }, "0xabCDEF"],
    ["other", { networkId: "0x123456" }, NET],
    ["unstamped", {}, NET],
  ] as const)("%s", (name, row, networkId) => {
    expect(predicate(row, networkId)).toBe(expected[name])
  })
})
