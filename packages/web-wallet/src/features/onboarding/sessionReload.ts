import { reloadPage } from "../../platform/storage/walletStorage"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { servesAnotherAccount } from "../../platform/session"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { clearWalletIdentity, loadWalletIdentity } from "../identity/walletIdentity"

/**
 * Account stores load once per page. A sign-in that committed another account than the one this
 * page served, even after a sign-out in between, must replace the document before anything is
 * written, or the first write carries that account's records into the new one's storage. The committed session opens the reloaded page from
 * its cached key. An entered identity that is not the committed account's goes first.
 */
export function reloadIfSessionSwitched(
  previousStorageId: string | null,
  l2Address: string,
): boolean {
  const identity = loadWalletIdentity()
  if (identity && identity.address.toLowerCase() !== l2Address.toLowerCase()) clearWalletIdentity()
  if (
    getAuthService()?.recordsStale?.() ||
    servesAnotherAccount() ||
    (previousStorageId !== null && previousStorageId !== getActiveStorageId())
  ) {
    void reloadPage()
    return true
  }
  return false
}
