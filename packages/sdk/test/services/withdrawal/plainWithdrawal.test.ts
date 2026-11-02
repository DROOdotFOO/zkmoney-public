import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { decodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  planPayout,
  plainUserPayload,
  type WithdrawalOptions,
} from "../../../src/services/withdrawal/plainWithdrawal.js"

const token = AztecAddress.fromBigIntUnsafe(10n)
const from = AztecAddress.fromBigIntUnsafe(20n)
const recipient = EthAddress.fromString(`0x${"66".repeat(20)}`)
const tuple = {
  l2Token: token.toString(),
  portal: `0x${"11".repeat(20)}`,
  token: `0x${"33".repeat(20)}`,
  plainWithdrawalExecutor: `0x${"44".repeat(20)}`,
  l2Broadcaster: AztecAddress.fromBigIntUnsafe(11n).toString(),
  swapEscrowFactoryV2: `0x${"55".repeat(20)}`,
} as OxideEnvTuple
const wallet = { pxe: {}, node: {} } as never
const service = { getOxideClient: () => null, getArtifactForInstance: async () => ({}) } as never
/** Answers the executor's `FEE()`. */
const l1 = { readContract: async () => 7n }
const options: WithdrawalOptions = { tuple, l1: l1 as never }
const burn = { from, recipient, amount: 1_000n * 10n ** 18n }

describe("plainUserPayload", () => {
  it("pays the recipient and offers the wallet's relayer tip", () => {
    const payload = decodePlainWithdrawalPayload(plainUserPayload(recipient))
    expect(payload.recipient.equals(recipient)).toBe(true)
    expect(payload.relayerTip).toBe(WITHDRAW_RELAYER_TIP)
  })
})

describe("planPayout", () => {
  it("refuses an unknown or incomplete source deployment before registering anything", async () => {
    await expect(planPayout(wallet, service, token, burn, { l1: l1 as never })).rejects.toThrow(
      "source deployment tuple",
    )
    const unavailable = {
      ...(service as object),
      getOxideClient: () => ({ initialize: async () => {}, getCurrentTuple: () => null }),
    } as never
    await expect(planPayout(wallet, unavailable, token, burn, { l1: l1 as never })).rejects.toThrow(
      "deployment is unavailable",
    )
    await expect(
      planPayout(wallet, service, AztecAddress.fromBigIntUnsafe(12n), burn, options),
    ).rejects.toThrow("differs from its source deployment")
    for (const missing of ["plainWithdrawalExecutor", "l2Broadcaster"] as const) {
      await expect(
        planPayout(wallet, service, token, burn, {
          ...options,
          tuple: { ...tuple, [missing]: undefined },
        }),
      ).rejects.toThrow("no plain withdrawal executor or broadcaster")
    }
  })
})
