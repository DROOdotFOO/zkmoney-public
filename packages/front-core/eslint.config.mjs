import { migrated } from "@obsidion/lint-config"

export default migrated({
  tsconfigRootDir: import.meta.dirname,
  copyFreeTests: true,
  engine: [
    "src/engine/**/*.ts",
    "src/core/paymentRequest/requestLinkMint.ts",
    "src/types/networkStamp.ts",
    "src/core/services/transactions/TransferEventScanner.ts",
    "src/core/services/transactions/WalletSyncCoordinator.ts",
    "src/core/services/paylink/paylinkRescan.ts",
    "src/core/services/bridge/withdrawalPhases.ts",
  ],
  react: [
    "src/hooks/useStore.ts",
    "src/hooks/useResource.ts",
    "src/hooks/createAccount.ts",
    "src/hooks/useAfter.ts",
    "src/contexts/useSavingsContext.tsx",
  ],
  tests: [
    "test/engine/**/*.ts",
    "test/hooks/useStore.test.tsx",
    "test/core/failureReason.test.ts",
    "test/types/networkStamp.test.ts",
    "test/paymentRequest/requestLinkMint.test.ts",
    "test/services/transactions/transferScanCommit.test.ts",
    "test/services/transactions/TransferEventScanner.test.ts",
    "test/services/transactions/WalletSyncCoordinator.test.ts",
    "test/services/transactions/balanceReadBeforeClaim.test.ts",
    "test/services/paylinkRescan.test.ts",
    "test/hooks/useSavings.test.tsx",
    "test/utils/activityFixture.ts",
    "test/services/pendingPaylinkMigration.test.ts",
  ],
})
