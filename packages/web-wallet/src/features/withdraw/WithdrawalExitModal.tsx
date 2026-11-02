/**
 * The one exit from a withdrawal the relayer has not released: submit its release yourself.
 *
 * The node and the TEE signer come from React context, which is why `selfFinalize` takes them as
 * an argument.
 */
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { RegisteredTeeSigner } from "@obsidion/sdk"
import {
  truncateMiddle,
  withdrawalRecipients,
  type WithdrawalRecord,
  useResource,
} from "@obsidion/front-core"
import { ConfirmationSheetDetailRow } from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { withdrawKind } from "./withdrawFunnel"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { ManualExitSheet } from "./ManualExitSheet"
import { selfFinalize } from "./selfFinalize"
import { useSession } from "../../platform/session"

const WALLET_LEAD = "This withdrawal has already been deducted from your Aztec balance. "
const PAYLINK_LEAD = "The link's funds have already left Aztec. "

const EXPLAINER =
  "All that's left is one Ethereum transaction that sends the funds to the recipient, and you can send it yourself. You pay the gas, the tip this withdrawal set aside for whoever sends it comes back to your wallet, and the funds go to the address the withdrawal already named, so nobody can redirect them. If a relayer gets there first, your transaction fails without moving anything and the withdrawal still finishes."

// The desktop helper page picks its account after the calldata is built, so the tip goes to the recipient.
const DESKTOP_EXPLAINER =
  "All that's left is one Ethereum transaction that sends the funds to the recipient, and you can send it yourself. You pay the gas; the funds, and the tip this withdrawal set aside for whoever sends it, go to the address the withdrawal already named, so nobody can redirect them. If a relayer gets there first, your transaction fails without moving anything and the withdrawal still finishes."

// A swap withdrawal burned to a counterfactual escrow, so this transaction releases DAI THERE, not
// to the recipient and not in the asset they chose. A separate L1 operation deploys the escrow and
// runs the swap; finalizing here does not do it.
const SWAP_EXPLAINER =
  "All that's left is one Ethereum transaction, and you can send it yourself. It releases the DAI to the swap escrow this withdrawal committed to — not to your recipient directly. The swap into your chosen asset is a separate step a relayer runs once the escrow is funded, so the recipient is paid after that, not by this transaction."

export function WithdrawalExitModal({
  record,
  deployment,
  onClose,
}: {
  record: WithdrawalRecord
  /** The deployment and co-signer the burn was made on; Main's when absent. */
  deployment?: () => Promise<{ tuple: OxideEnvTuple; signer: RegisteredTeeSigner }>
  onClose: () => void
}) {
  const config = getConfig()
  const amount = `${record.amount} ${record.tokenSymbol}`
  const recipient = record.recipientAlias ?? truncateMiddle(record.recipient, 12)
  const { release, viaEscrow } = withdrawalRecipients(record)
  const swap = viaEscrow ? record.swapOutput : undefined
  const releasedTo = viaEscrow ? truncateMiddle(release, 12) : recipient
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const teeSigner = useResource(useSession().teeSigner)
  const bridgeMode = isDesktopL1SubmitActive()

  return (
    <ManualExitSheet
      label="Withdrawal recovery"
      title="Withdrawal taking too long"
      doneTitle="Withdrawal released"
      explainer={
        <>
          {record.source === "paylink" ? PAYLINK_LEAD : WALLET_LEAD}
          {swap ? SWAP_EXPLAINER : bridgeMode ? DESKTOP_EXPLAINER : EXPLAINER}
        </>
      }
      facts={
        <>
          <ConfirmationSheetDetailRow label="Amount" value={amount} />
          <ConfirmationSheetDetailRow
            label={swap ? "Released to" : "Recipient"}
            value={releasedTo}
          />
          {swap && (
            <ConfirmationSheetDetailRow
              label="Then swapped to"
              value={`${swap} for ${recipient}`}
            />
          )}
          <ConfirmationSheetDetailRow label="Network" value={l1ChainFor(config.l1ChainId).name} />
        </>
      }
      buttonTitle="Finalize this withdrawal"
      run={async ({ from, onHelperOpened, onStage }) => {
        // Null when the session is locked or still connecting; `selfFinalize` refuses it, except in
        // the dev demo, whose stubbed builder needs no wallet at all.
        const own = deployment ? await deployment() : undefined
        const signer = own?.signer ?? teeSigner
        const wallet =
          obsidionWallet && obsidionAccount && signer
            ? {
                node: obsidionWallet.node,
                signer,
                wallet: obsidionWallet,
                owner: obsidionAccount.getAddress(),
              }
            : null
        return await selfFinalize(record, wallet, {
          tuple: own?.tuple,
          from,
          onHelperOpened,
          onStage,
        })
      }}
      // Timing only — the recipient is as identifying as the withdrawal itself.
      onSent={(duration_ms) =>
        fireEvent("withdrawal_self_finalized", { duration_ms, kind: withdrawKind(record) })
      }
      onError={(e) => {
        fireEvent("action_failed", { action: "withdrawal:self-finalize", code: failureCode(e) })
        showReportableError(e, "withdrawal:finalize", { title: "Finalization failed" })
      }}
      done={
        swap
          ? `${amount} released to the swap escrow. Your recipient is paid in ${swap} once a relayer runs the swap.`
          : `${amount} released to ${recipient}.`
      }
      onClose={onClose}
    />
  )
}
