/**
 * `requireTupleField` is the guard that turns a thin manifest into a named failure instead of a
 * TypeError deep inside a rail. Pinned here because the tests that depend on it used to mock a
 * STRICTER version than shipped, so a blank manifest field was "covered" by semantics production
 * did not have.
 */
import { describe, expect, it } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { requireTupleField } from "../../src/config/oxideTuple"

const tuple = (fields: Partial<OxideEnvTuple>) => fields as OxideEnvTuple

describe("requireTupleField", () => {
  it("returns a present value", () => {
    expect(requireTupleField(tuple({ portal: "0xabc" }), "portal")).toBe("0xabc")
  })

  it("names the missing field, so a thin manifest is diagnosable", () => {
    expect(() => requireTupleField(tuple({}), "swapEscrowFactoryV2")).toThrow(
      /lacks swapEscrowFactoryV2/,
    )
  })

  it("treats a blank field as absent — it is just as unusable", () => {
    expect(() => requireTupleField(tuple({ l2Broadcaster: "" }), "l2Broadcaster")).toThrow(
      /lacks l2Broadcaster/,
    )
    expect(() => requireTupleField(tuple({ portal: "   " }), "portal")).toThrow(/lacks portal/)
  })

  it("keeps a value that is present but falsy-looking", () => {
    expect(requireTupleField(tuple({ rollupVersion: "0" }), "rollupVersion")).toBe("0")
  })
})
