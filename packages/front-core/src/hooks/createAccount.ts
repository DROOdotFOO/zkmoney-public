import type { SignInRoute } from "@obsidion/core/types"
import { AccountStorage, NetworkStorage, selectRecoveredMsk } from "../core"
import {
  TESTNET_TIMEOUT,
  type ObsidionAccount,
  type ObsidionWallet,
  type AUTH_TYPE,
  type AlphaAuthService,
} from "@obsidion/sdk"
import { WalletError } from "../engine/errors"
import { logger } from "../utils/logger"

/**
 * Creates the passkey and its account, or recovers both from an existing passkey, then commits the
 * master key and stores the account. The caller hands the returned account to the session.
 */
export async function createAccount(
  {
    wallet: obsidionWallet,
    authService,
  }: { wallet: ObsidionWallet; authService: AlphaAuthService },
  isImport: boolean,
  _authType: AUTH_TYPE,
  updateStatus: (status: string) => void,
  accountName?: string,
  credentialId?: string,
  opts?: {
    /** CREATE dispatch: "combined" presents both (iOS 26.4+), the forced variants
     * back the fallback button. Default platform. */
    mode?: "combined" | "platform" | "security-key"
    /** The device the user picked on the laptop steps, so the browser opens on it. */
    route?: SignInRoute
    /** Ends the passkey prompt when the caller abandons the attempt. */
    signal?: AbortSignal
    replaceCurrentWallet?: boolean
    /** Post-detect/pre-deploy hook: when a fresh CREATE resolves to a security
     * key, await acknowledgement of the no-backup warning before any on-chain
     * deploy. Returning false aborts (only an orphan passkey remains). */
    onSecurityKeyDetected?: () => Promise<boolean>
    /** Persist caller-owned recovery state before the new session is committed. */
    onAccountCreated?: (account: {
      credentialId: string
      l2Address: string
    }) => Promise<void> | void
  },
): Promise<ObsidionAccount> {
  updateStatus(`${isImport ? "Recovering" : "Creating"} passkey...`)

  logger.log("createAccount...")
  if (!accountName) accountName = "Account 1"

  let obsidionAccount: ObsidionAccount
  if (isImport) {
    const recovered = await authService.recoverPasskey(credentialId)

    // R10 verify-before-commit: pick the candidate whose derived account
    // address matches the stored one (fail closed otherwise), then commit —
    // the ONLY Keychain reseed point. `deriveAccountAddress` is the pure,
    // side-effect-free derivation from the master key and the recovered
    // signing key, so it never registers a wrong account.
    updateStatus(`Verifying recovered key...`)
    const secretKey = await selectRecoveredMsk(recovered, async (msk) =>
      (await obsidionWallet.deriveAccountAddress(msk, [recovered.pubkey])).toString(),
    )

    // No-anchor guard: a security-key recover with no expected address commits
    // "the wallet this key roots" and OVERWRITES the single MSK Keychain slot.
    // Only allow it when the device has no current wallet (or with an explicit
    // replace flag from the UI), so it can't silently switch the active wallet.
    if (recovered.authenticatorType === "security-key" && !recovered.expectedAddress) {
      const deviceHasWallet = await AccountStorage.get().hasAccount()
      if (deviceHasWallet && !opts?.replaceCurrentWallet) {
        throw new WalletError("account.replaceUnconfirmed")
      }
    }

    await authService.commitSecret({ secretKey, authProvider: recovered.authProvider })

    updateStatus(`Creating imported account...`)

    obsidionAccount = await obsidionWallet.getObsidionAccountWallet(
      secretKey,
      recovered.authProvider,
      { register: true },
    )

    await storeAccount(
      obsidionAccount,
      accountName,
      recovered.credentialId,
      recovered.pubkey,
      recovered.authenticatorType,
    )
    return obsidionAccount
  } else {
    try {
      // The MSK comes out of credential creation, never in: it derives from
      // the passkey's PRF output (regenerable at login from the credential
      // itself).
      const {
        authProvider,
        credentialId,
        pubkey,
        secretKey,
        prfSlot,
        prfAaguid,
        authenticatorType,
        transports,
      } = await authService.createPasskey(accountName, updateStatus, {
        mode: opts?.mode,
        route: opts?.route,
        signal: opts?.signal,
      })

      // No-backup acknowledgement gate: a security-key wallet has no iCloud
      // backup. Fire AFTER the class is detected and BEFORE the on-chain deploy,
      // so a decline leaves only an orphan passkey — no on-chain account, no
      // recovery record, no committed MSK. (Below 26.4 a security key is never
      // offered, so this never triggers there; a caller with no callback proceeds.)
      if (authenticatorType === "security-key") {
        const acknowledged = (await opts?.onSecurityKeyDetected?.()) ?? true
        if (!acknowledged) throw new WalletError("account.creationCancelled")
      }

      obsidionAccount = await obsidionWallet.createObsidionAccount(secretKey, authProvider, {
        timeout: (await NetworkStorage.get().isProd()) ? TESTNET_TIMEOUT : undefined,
        updateStatus,
      })

      const l2Address = obsidionAccount.getAddress().toString()
      logger.log("Account created at:", l2Address)

      // REQUIRED before committing the MSK: persist the recovery record so a
      // fresh-device recover has an address to verify against. A failure
      // aborts onboarding (retryable) — never an account without a record.
      updateStatus("Securing recovery info...")
      await authService.recordRecoveryMetadata({
        credentialId,
        pubkey,
        l2Address,
        prfSlot,
        prfAaguid,
        isMskRoot: true,
        authenticatorType,
        transports,
      })
      await opts?.onAccountCreated?.({ credentialId, l2Address })
      updateStatus("Securing your master key...")
      await authService.commitSecret({ secretKey, authProvider })

      await storeAccount(obsidionAccount, accountName, credentialId, pubkey, authenticatorType)
      return obsidionAccount
    } catch (error) {
      logger.error("Failed to create obsidion account:", error)
      throw error
    }
  }
}

async function storeAccount(
  obsidionAccount: ObsidionAccount,
  accountName: string,
  credentialId: string,
  pubkey: string,
  authenticatorType?: "platform" | "security-key",
) {
  logger.log("addWebauthnAccount...")
  await AccountStorage.get().addWebauthnAccount(
    accountName,
    obsidionAccount.getCompleteAddress().toString(),
    { credentialId, pubkey, ...(authenticatorType ? { authenticatorType } : {}) },
  )
}
