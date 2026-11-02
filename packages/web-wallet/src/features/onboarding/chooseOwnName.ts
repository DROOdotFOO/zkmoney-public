import { depositOwed } from "@obsidion/front-core"
import { base64UrlToBytes, renamePasskey } from "@obsidion/passkey-web"
import type { ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { rememberUsertag, userHandleFor } from "../../platform/auth/WebPasskeyIdentityMap"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"
import { loadWalletIdentity, saveWalletIdentity } from "../identity/walletIdentity"
import { openRegistration, registrationTagConfirmed } from "./openRegistration"
import { session } from "../../platform/session"
import { claimTag, collectOnboardingKeys } from "./oxideOnboarding"
import { hasCustody } from "./webRegistration"

/** Replaces the registration still owed its deposit with a claim on `tag`, at a new address. */
export async function chooseOwnName(
  tag: string,
  account: ObsidionAccount,
  wallet: ObsidionWallet,
  earned = false,
): Promise<void> {
  // Read once the withdrawals load: a ticket's burn may already fund this address.
  const burns = await session().withdrawals.all()
  const open = openRegistration(burns)
  const identity = loadWalletIdentity()
  if (
    !open?.stage ||
    !identity ||
    open.record.phase !== "awaiting_deposit" ||
    !depositOwed(open.stage) ||
    hasCustody(open.record)
  ) {
    throw new Error("Your first deposit has reached your address, so your name cannot change here.")
  }
  if (registrationTagConfirmed(open.record, burns)) {
    throw new Error("Your name is confirmed and cannot change during registration.")
  }
  const keys = await collectOnboardingKeys(account)
  await claimTag(tag, keys, getConfig(), wallet, undefined, earned, undefined, open.record)
  await saveWalletIdentity({ ...identity, handle: tag, pending: true })
  console.info("[passkey] renaming the passkey to", tag)
  const credentialId = getActiveCredentialId()
  if (!credentialId) {
    console.warn("[passkey] rename skipped: no active credential")
    return
  }
  const { rpId } = getConfig()
  const userHandle = userHandleFor(rpId, credentialId)
  if (userHandle) renamePasskey(rpId, base64UrlToBytes(userHandle), tag)
  else console.warn("[passkey] rename skipped: no user handle stored for this passkey")
  await rememberUsertag(rpId, credentialId, tag).catch(() => {})
}
