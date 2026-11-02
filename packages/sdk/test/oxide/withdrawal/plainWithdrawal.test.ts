import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"

import type { Operation } from "../../../src/oxide/token/l2_operations.js"
import { declaredWithdrawals } from "../../../src/oxide/withdrawal/plainWithdrawal.js"

const withdraw = (amount: bigint) => ({
  kind: "withdraw" as const,
  from: AztecAddress.fromBigIntUnsafe(1n),
  executor: EthAddress.fromNumber(2),
  userPayload: Buffer.alloc(64, Number(amount)),
  amount,
  proverTip: 0n,
})

describe("declaredWithdrawals", () => {
  it("collects direct withdrawals and the ones outer calls declare, in batch order", () => {
    const [a, b, c] = [withdraw(1n), withdraw(2n), withdraw(3n)]
    const operations = [
      { kind: "transfer", from: a.from, to: a.from, amount: 1n },
      a,
      { kind: "outerCall", interaction: {} as never, withdrawals: [b, c] },
      { kind: "outerCall", interaction: {} as never },
    ] as Operation[]

    expect(declaredWithdrawals(operations)).toEqual([a, b, c])
  })
})
