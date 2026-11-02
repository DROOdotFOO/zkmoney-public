import path from "node:path"

// These replacements exist only in the server started by pnpm ui:capture.
export function flowFixturePlugin(walletDir) {
  const fixtures = path.join(walletDir, "scripts/ui-capture/fixtures")
  const modules = new Map([
    ["dev/seedDemo.ts", "seed.ts"],
    ["dev/demoDeposit.ts", "demo-deposit.ts"],
    ["features/contacts/contactPay.ts", "contact-pay.ts"],
    ["features/paylink/sponsoredPaylink.ts", "paylinks.ts"],
    ["features/paylink/paylinkExit.ts", "paylink-exit.ts"],
    ["features/withdraw/withdrawGateway.ts", "withdraw.ts"],
    ["features/deposit/sipaGateway.ts", "deposits.ts"],
    ["features/deposit/l1Wallet.ts", "l1-wallet.ts"],
    ["features/deposit/l1DepositTokenBalance.ts", "deposit-balance.ts"],
    ["features/deposit/capacityStore.ts", "capacity.ts"],
    ["features/deposit/sipaProcessingObserver.ts", "deposit-processing.ts"],
    ["features/allowance/readAllowance.ts", "allowance.ts"],
    ["features/withdraw/withdrawQuote.tsx", "withdraw-quote.ts"],
    ["features/withdraw/useFasterWithdrawal.ts", "faster-withdrawal.ts"],
    ["features/requests/accountlessRequest.ts", "request-landing.ts"],
    ["lib/feedback.ts", "feedback.ts"],
    ["features/onboarding/webRegistration.ts", "registration.ts"],
    ["features/onboarding/useDepositWatch.ts", "registration-deposit.ts"],
    ["features/onboarding/oxideOnboarding.ts", "registration-account.ts"],
    ["features/onboarding/nameAvailability.ts", "name-availability.ts"],
    ["features/invite/useInvite.ts", "invite.ts"],
  ].map(([source, fixture]) => [path.join(walletDir, "src", source), path.join(fixtures, fixture)]))
  const contextConsumers = new Set([
    "features/allowance/useSponsoredAllowance.ts",
    "features/contacts/ContactPayScreen/ContactPayScreen.tsx",
    "features/onboarding/OnboardingScreen.tsx",
    "features/receive/useReceiveCode.ts",
    "features/paylink/usePaylinkDeps.ts",
    "features/paylink/LinkViewScreen.tsx",
    "features/withdraw/WithdrawToWalletModal/WithdrawToWalletModal.tsx",
    "features/deposit/DepositScreen.tsx",
    "features/deposit/DepositFromWalletModal.tsx",
  ].map((file) => path.join(walletDir, "src", file)))
  return {
    name: "wallet-ui-flow-fixtures",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || source.includes("capture-original")) return null
      if (importer.startsWith(fixtures + path.sep)) {
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        return resolved && modules.has(resolved.id) ? `${resolved.id}?capture-original` : null
      }
      const owner = importer.split("?")[0]
      if (source === "@obsidion/front-core" && contextConsumers.has(owner)) {
        return path.join(fixtures, "contexts.ts")
      }
      // The registration funding panel reads a recorded SIPA's terms from the processing observer's source.
      if (source === "@obsidion/sdk" && owner === path.join(walletDir, "src/features/deposit/addressCapacity.ts")) {
        return path.join(fixtures, "sipa-terms.ts")
      }
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      // The pay page reads its rollup through the boot's identity check.
      if (owner === path.join(walletDir, "src/features/requests/RequestLandingScreen.tsx") && resolved?.id === path.join(walletDir, "src/ui/PxeBoot.tsx")) {
        return path.join(fixtures, "request-identity.ts")
      }
      return resolved ? modules.get(resolved.id.split("?")[0]) ?? null : null
    },
  }
}
