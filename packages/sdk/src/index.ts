// Re-export everything from @obsidion/contracts so existing consumers don't break
export * from "@obsidion/contracts"

// SDK-specific exports
export * from "./oxide/token/publishDaLogs.js"
export * from "./oxide/withdrawal/burnWithdrawals.js"
export * from "./oxide/withdrawal/withdrawalFinalization.js"
export * from "./oxide/portal/portalIdentity.js"
export * from "./oxide/withdrawal/withdrawFinalizationCall.js"
export * from "./oxide/withdrawal/withdrawalExecutor.js"
export * from "./oxide/escrow/swapOnWithdrawSimulator.js"
export * from "./oxide/escrow/swapOnWithdraw.js"
export * from "./oxide/escrow/skySavings.js"
export * from "./oxide/escrow/swapEscrowReader.js"
export * from "./oxide/portal/portalCapacity.js"
export * from "./oxide/portal/portalFreeze.js"
export * from "./oxide/token/tokenRegistration.js"
export * from "./oxide/portal/portalCapError.js"
export * from "./oxide/portal/sipaPortalTerms.js"
export * from "./oxide/portal/deploymentTable.js"
export * from "./oxide/tip/proverTipQuote.js"
export * from "./oxide/tip/tipQuote.js"
export {
  assertBackupSweepProfitable,
  quoteBackupSweep,
  UnprofitableSweepError,
  type BackupSweepQuote,
} from "./oxide/tip/l1OperationQuote.js"
export type { PlainWithdrawalContext } from "./oxide/withdrawal/plainWithdrawal.js"
export { readPlainWithdrawalFee } from "@oxide/oxide-client/executors/plain_withdrawal_executor.js"
export * from "./email/index.js"
export * from "./feePaymentMethod/index.js"
export * from "./obsidion/index.js"
export * from "./services/index.js"
export * from "./utils/index.js"
export * from "./xmtp/index.js"
export * from "./node/createNode.js"

// RegistrationIntent + K1PointArg surface from both @obsidion/contracts (core's
// registration-by-deposit mirror) and services/sipaIntents (oxide's intent type). Both carry the
// identity record plus the routing; oxide's is canonical, so re-export it explicitly to resolve
// the star-export ambiguity.
export type { RegistrationIntent, K1PointArg } from "./services/sipa/sipaIntents.js"
