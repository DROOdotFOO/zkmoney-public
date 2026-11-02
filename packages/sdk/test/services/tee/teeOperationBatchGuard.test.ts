import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { ACCOUNT_MAX_CALLS, buildTeeOperation } from "../../../src/services/tee/teeOperation.js"

// Guard math: [...ops, publish_da] + 1 wallet-merged fee call must fit ACCOUNT_MAX_CALLS.
const MAX_OPS = ACCOUNT_MAX_CALLS - 2

function build(opCount: number) {
  return buildTeeOperation({} as never, {} as never, {
    tokenContract: { address: AztecAddress.fromNumberUnsafe(3) } as never,
    signer: {} as never,
    operations: Array(opCount).fill({ kind: "transfer" }),
    buildOperationCall: () => ({} as never),
  })
}

describe("buildTeeOperation payload-capacity guard", () => {
  it("rejects a batch that overflows the entrypoint AppPayload", async () => {
    await expect(build(MAX_OPS + 1)).rejects.toThrow(/ACCOUNT_MAX_CALLS/)
  })

  it("lets the largest fitting batch past the guard", async () => {
    await expect(build(MAX_OPS)).resolves.toHaveProperty("batchCall")
  })
})
