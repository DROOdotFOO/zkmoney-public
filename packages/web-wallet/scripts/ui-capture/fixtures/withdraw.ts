import * as actual from "../../../src/features/withdraw/withdrawGateway"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { parseUnits, type Address } from "viem"
import { session } from "../../../src/platform/session"
import { fixtureState, inOperation, operation } from "./control"
import { ROLLUP, TX_HASH, SIPA } from "./data"
export * from "../../../src/features/withdraw/withdrawGateway"
let sequence = 0
/** `extra.rawAmount` carries the burn's gross where it is not the typed amount — a paylink cash-out
 *  types the net and burns the link's whole escrow. */
export async function captureWithdrawal(
  recipient: Address,
  amount: string,
  onStage?: (stage: "building" | "proving" | "submitting") => void,
  extra: Partial<WithdrawalRecord> = {},
  signing = true,
  flow: "withdraw" | "paylink-claim-l1" = "withdraw",
) {
  const store = session().withdrawals
  const localId = `capture-withdraw-${++sequence}`
  const rawAmount = extra.rawAmount ?? parseUnits(amount, 18).toString()
  await store.create({
    localId,
    networkId: ROLLUP,
    recipient,
    amount,
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    recipientProvenance: "saved-recipient",
    phase: "submitting",
    startTime: Date.now(),
    relayerTip: WITHDRAW_RELAYER_TIP.toString(),
    ...extra,
    rawAmount,
  })
  onStage?.("building")
  return inOperation(
    flow,
    `$${amount} to ${extra.recipientAlias?.trim() || "Ethereum"}`,
    async () => {
      try {
        await operation("withdraw", onStage, signing)
        const mined = await store.apply(localId, {
          type: "mined",
          l2TxHash: TX_HASH,
          blockNumber: 4212,
          rawAmount,
          relayerTip: WITHDRAW_RELAYER_TIP.toString(),
        })
        if (!mined) throw new Error(`no withdrawal record ${localId}`)
        return mined
      } catch (error) {
        const failed = { phase: "failed", error: String(error) } as const
        await store.apply(localId, { type: "patch", fields: failed })
        throw error
      }
    },
  )
}
export const submitSponsoredWithdrawal: typeof actual.submitSponsoredWithdrawal = async (
  ...args
) => {
  if (!fixtureState()) return actual.submitSponsoredWithdrawal(...args)
  const [deps, recipient, amount, onStage, recipientAlias, receiveAsset, quote] = args
  const verdict = await deps.screener.screen(recipient)
  if (!verdict.compliant) throw new Error("This address cannot receive withdrawals")
  return captureWithdrawal(recipient, amount, onStage, {
    recipientAlias,
    ...(receiveAsset && receiveAsset !== "DAI"
      ? {
          swapOutput: receiveAsset,
          swapEscrow: SIPA,
          swapEstimatedOut: quote?.amountOut.toString(),
          swapOutputDecimals: quote?.decimals,
        }
      : {}),
  })
}
