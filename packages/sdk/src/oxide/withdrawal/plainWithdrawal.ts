// Every wallet withdrawal settles into its deployment's PlainWithdrawalExecutor: the executor takes its fee, pays the
// relayer tip named in the user payload and forwards the rest to the payload's recipient.
import type { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { WithdrawOperation } from "@oxide/oxide-client/l2_operations.js"
import {
  assertPlainWithdrawalTip,
  decodePlainWithdrawalPayload,
} from "@oxide/oxide-lib/plain_withdrawal_executor.js"

import type { Operation } from "../token/l2_operations.js"

export type { WithdrawOperation }

/** What a TEE batch needs to check its plain withdrawals. */
export interface PlainWithdrawalContext {
  executor: EthAddress
  /** The executor's `FEE()`, taken from each withdrawal. */
  fee: bigint
}

/** The withdrawals a batch declares, in the order the token emits them: its withdraw operations and
 *  the withdrawals nested in its outer calls. */
export function declaredWithdrawals(operations: Operation[]): WithdrawOperation[] {
  return operations.flatMap((op) => {
    if (op.kind === "withdraw") return [op]
    if (op.kind === "outerCall") return op.withdrawals ?? []
    return []
  })
}

/**
 * Throw unless every withdrawal broadcasts its finalization request, so a relayer can finalize it, and a
 * plain withdrawal leaves the executor its relayer tip after the fee. The executor call reverts on L1 otherwise, and
 * nobody can release the burn.
 */
export function assertWalletWithdrawals(
  withdrawals: WithdrawOperation[],
  plainWithdrawal: PlainWithdrawalContext | undefined,
): void {
  if (withdrawals.length > 0 && !plainWithdrawal) {
    throw new Error("A withdrawal needs the deployment's plain withdrawal executor")
  }
  for (const withdrawal of withdrawals) {
    if (!withdrawal.finalizationRequestBroadcastParams) {
      throw new Error("A wallet withdrawal must broadcast its finalization request")
    }
    if (withdrawal.executor.equals(plainWithdrawal!.executor)) {
      const { relayerTip } = decodePlainWithdrawalPayload(withdrawal.userPayload)
      assertPlainWithdrawalTip(
        withdrawal.amount,
        withdrawal.proverTip,
        relayerTip,
        plainWithdrawal!.fee,
      )
    }
  }
}
