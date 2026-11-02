import { TxHash } from "@aztec-labs/stdlib/tx"
import type { ObsidionWallet } from "@obsidion/sdk"
import type { ReorgNodeLike } from "../core/services/chain/receiptTypes"
import {
  ReorgMonitor,
  type ConfirmationListener,
  type ReorgSipaStore,
  type ReorgTransactionStore,
  type ReorgWithdrawalStore,
} from "../core/services/coordination/ReorgMonitor"
import type { Resource } from "./resource"
import { task, within, type Task } from "./runtime"

export interface ReorgDeps {
  wallet: Resource<Pick<ObsidionWallet, "node" | "pxe" | "networkId">>
  activity: ReorgTransactionStore
  withdrawals: ReorgWithdrawalStore
  sipaDeposits: ReorgSipaStore
  /** The withdrawal tracker: it re-reads each burn's receipt and `$isWithdrawalSpent`. */
  tracker: Task
  onOutcome: ConfirmationListener
}

/** Status and executionResult pass through as the @aztec enums; block fields become plain values. */
const receipts = (node: ObsidionWallet["node"]): ReorgNodeLike => ({
  getTxReceipt: async (txHash) => {
    const receipt = await node.getTxReceipt(TxHash.fromString(txHash))
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber !== undefined ? Number(receipt.blockNumber) : undefined,
      blockHash: receipt.blockHash?.toString(),
      executionResult: receipt.executionResult,
    }
  },
})

/**
 * Rewrites the session's unfinalized records from their receipts every 30 s while the page is shown.
 * A woken pass then wakes the withdrawal tracker without waiting for it and, once the first balance is in,
 * syncs the PXE.
 */
export function reorg({
  wallet,
  activity,
  withdrawals,
  sipaDeposits,
  tracker,
  onOutcome,
}: ReorgDeps): Task {
  const monitor = new ReorgMonitor({
    transactionStorage: activity,
    withdrawalStorage: withdrawals,
    sipaDepositStore: sipaDeposits,
    onOutcome,
  })
  return task("reorg", {
    needs: { wallet },
    every: 30_000,
    async run({ wallet, signal, woken, wake, reached }) {
      // Awaited whole, so passes over the monitor's grace state never overlap.
      await monitor.runPass({ node: receipts(wallet.node), networkId: wallet.networkId })
      if (!woken || signal.aborted) return
      void wake(tracker)
      // Before it, the balance read syncs note state itself, and a sync here would move its anchor.
      if (reached("firstBalance")) await within(wallet.pxe.sync(), "PXE sync", { signal })
    },
  })
}
