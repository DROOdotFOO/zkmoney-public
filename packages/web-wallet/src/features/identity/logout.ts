import { closeSession } from "../../platform/session"
import { leavePage } from "../../platform/storage/walletStorage"
import { showReportableError } from "../../errors/errorModal"
import { signOut } from "./signOut"

/**
 * Local sign-out. The passkey and the on-chain claim survive, so /enter brings the account back.
 * A full reload, not a route change: the front-core store singletons cache the signed-out
 * account's state and would leak it into the next account on this browser. The PXE must release
 * its OPFS handles before that reload or the next document can race them while opening its store.
 * A failed removal or shutdown is reported and nothing reloads.
 */
export async function logout(stopPxe: () => Promise<void>): Promise<void> {
  try {
    await signOut()
    await stopPxe()
  } catch (e) {
    showReportableError(e, "identity:logout", { message: "Couldn't sign out. Try again." })
    return
  }
  closeSession()
  await leavePage("/claim")
}
