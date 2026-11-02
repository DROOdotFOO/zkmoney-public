import { showErrorModal } from "../../errors/errorModal"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { balanceMovingCopy } from "./backupPasskeyCopy"
import { useBalanceMoving } from "./backupRotationStore"

/**
 * Runs a press that spends through the sponsor, or shows why it waits while a backup passkey
 * rotation moves the balance. For presses outside the action gate, such as a payment link refund.
 */
export function useBalanceMovingPause(): (run: () => void) => void {
  const moving = useBalanceMoving(loadWalletIdentity()?.address)
  return (run) => (moving ? showErrorModal(balanceMovingCopy) : run())
}
