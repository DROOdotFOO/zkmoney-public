import { ActionWaitScreen } from "../../ui/screens/ActionWaitScreen"
import { balanceMovingCopy } from "./backupPasskeyCopy"

/** Shown in place of a sponsored action while a backup passkey rotation moves the balance. */
export function BalanceMovingScreen() {
  return <ActionWaitScreen testId="balance-moving" {...balanceMovingCopy} />
}
