import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("reviews openPooledStore's Safari text match on each @aztec-labs/kv-store version change", () => {
  const { version } = JSON.parse(
    readFileSync("node_modules/@aztec-labs/kv-store/package.json", "utf8"),
  )
  const removal =
    "if it contains AztecProtocol/aztec-packages PR 25554, delete the match; else update"
  expect(version, removal).toBe("6.0.0")
})
