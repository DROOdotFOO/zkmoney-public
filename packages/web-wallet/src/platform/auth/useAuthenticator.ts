import {
  AccountStorage,
  compAddrToAztecAddrStr,
  valueOf,
  type Resource,
  type WebAuthnData,
  WalletError,
} from "@obsidion/front-core"
import { Network } from "@obsidion/core/constants"
import {
  BrowserPasskeyCeremony,
  CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
  DEFAULT_CEREMONY_TIMING,
  type PasskeyCeremony,
} from "@obsidion/passkey-web"
import { AUTH_TYPE, type ObsidionWallet } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import { followSavedSession } from "../session"
import { walletStorage } from "../storage/walletStorage"
import { webStorage } from "../storage/WebStorageAdapter"
import { WebAlphaAuthService, type StoredAccountSnapshot } from "./WebAlphaAuthService"

let singleton: WebAlphaAuthService | undefined

/**
 * The e2e build writes each create request's device ask, hints and timeout into the wallet
 * database, where the specs read them: the browser's credential list only proves a credential
 * exists, not what the wallet asked for.
 */
function recordingCreateRequests(ceremony: PasskeyCeremony): PasskeyCeremony {
  return {
    create: (request) => {
      try {
        walletStorage.setItem(
          "webwallet.e2e.lastCreateRequest",
          JSON.stringify({
            authenticatorAttachment: request.authenticatorAttachment,
            hints: request.hints,
            timeoutMs: request.timeoutMs,
          }),
        )
      } catch {
        // A record the specs can't read fails there, not here.
      }
      return ceremony.create(request)
    },
    assert: (request) => ceremony.assert(request),
  }
}

/** Process-wide auth-service singleton. */
export function getAuthService(): WebAlphaAuthService {
  if (!singleton) {
    const config = getConfig()
    // The e2e build drives Chromium's virtual authenticators: the hybrid hint can steer the sheet
    // away from them, and they report a fixed provider id the allowlist would otherwise refuse.
    // Nothing else sets this flag, so production sends the hint and admits no extra id. Admitting
    // an id widens a gate on the key a funded wallet derives, so mainnet refuses the flag outright,
    // as it does for the other build flags that relax a check.
    const virtualAuthenticators = import.meta.env.VITE_E2E_VIRTUAL_AUTHENTICATORS === "true"
    if (virtualAuthenticators && config.network === Network.MAINNET) {
      throw new WalletError(
        "config.invalid",
        "VITE_E2E_VIRTUAL_AUTHENTICATORS widens the passkey provider allowlist — not valid on mainnet",
      )
    }
    const ceremony = passkeyTelemetry.wrap(
      new BrowserPasskeyCeremony(DEFAULT_CEREMONY_TIMING, passkeyTelemetry.requestHook),
    )
    singleton = new WebAlphaAuthService({
      storage: webStorage,
      rpId: config.rpId,
      rpName: config.rpName,
      ceremony: virtualAuthenticators ? recordingCreateRequests(ceremony) : ceremony,
      laptopHints: virtualAuthenticators ? null : undefined,
      extraProviders: virtualAuthenticators ? [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID] : undefined,
      onSessionSaved: followSavedSession,
    })
  }
  return singleton
}

/** The singleton if one was built; a sign-out before any boot has nothing to clear. */
export function peekAuthService(): WebAlphaAuthService | undefined {
  return singleton
}

/** The stored account as a cache restore compares it. */
async function readStoredAccount(): Promise<StoredAccountSnapshot | null> {
  const account = await AccountStorage.get().getAccount()
  if (!account) return null
  const passkey =
    account.signKeyConfig.type === AUTH_TYPE.WEB_AUTHN ? account.signKeyConfig.webauthnData : null
  if (!passkey) return { kind: "other" }
  return {
    kind: "webauthn",
    credentialId: passkey.credentialId,
    pubkey: passkey.pubkey,
    address: await compAddrToAztecAddrStr(account.completeAddress),
  }
}

/** Names `signer` as the stored account's signer, at the address it already holds. */
export async function writeStoredSigner(signer: WebAuthnData): Promise<void> {
  const accounts = AccountStorage.get()
  const account = await accounts.getAccount()
  if (account?.signKeyConfig.type !== AUTH_TYPE.WEB_AUTHN) return
  await accounts.addWebauthnAccount(account.name, account.completeAddress, signer)
}

/**
 * The auth service over `wallet`: its address derivation and the stored account, so a cached key
 * can be proved before the account's unlock asks for it.
 */
export function walletAuth(wallet: ObsidionWallet): WebAlphaAuthService {
  const service = getAuthService()
  service.setAddressDeriver(async (msk, passkeys) =>
    (await wallet.deriveAccountAddress(msk, passkeys)).toString(),
  )
  service.setAccountReader(readStoredAccount)
  service.setSignerWriter(writeStoredSigner)
  return service
}

/** Hands the page's wallet to the auth service once it is up, whichever session the page runs. */
export function bindWalletAuth(wallet: Resource<ObsidionWallet>): void {
  const bind = () => {
    const ready = valueOf(wallet)
    if (!ready) return
    off()
    walletAuth(ready)
  }
  const off = wallet.subscribe(bind)
  bind()
}
