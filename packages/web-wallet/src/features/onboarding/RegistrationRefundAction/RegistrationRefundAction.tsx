import { useEffect, useState } from "react"
import {
  type PendingRegistrationRecord,
  type SIPADepositRecord,
  useResource,
  WalletError,
} from "@obsidion/front-core"
import { errorCopy } from "../../../errors/catalog"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../../config/env"
import { DepositExitModal } from "../../deposit/DepositExitModal/DepositExitModal"
import { isGateCancelled, useCeremonyGate } from "../../identity/ceremonyGate"
import { GateStep } from "../../identity/PhoneSteps"
import { PasskeyRefusal, type RefusalState } from "../../identity/PasskeyRefusal"
import { isPasskeyCancelled, isPasskeyPolicyError } from "@obsidion/passkey-web"
import { reusePasskeyAccount, type OnboardingKeys } from "../oxideOnboarding"
import { reloadIfSessionSwitched } from "../sessionReload"
import { prepareRegistrationRefund, useRegistrationRefunded } from "../registrationQuoteRecovery"
import { askedTotal } from "../registrationAsk"
import { formatDepositDue } from "../steps/DepositTermsRows"
import { useSession } from "../../../platform/session"
import copy from "./RegistrationRefundAction.copy"
import { fmt } from "../../../lib/fmt"

/**
 * The way off an address the earned quote cannot use. A funded one is recovered first, then
 * restarted; an `unfunded` one (nothing ever reached it) is replaced outright. One that
 * `holdsFunds` again is recovered again, whatever was refunded before.
 */
export function RegistrationRefundAction({
  record,
  onRestart,
  unfunded = false,
  holdsFunds = false,
}: {
  record: PendingRegistrationRecord
  onRestart: (keys: OnboardingKeys) => Promise<void>
  unfunded?: boolean
  /** The live registration-token balance is not zero. */
  holdsFunds?: boolean
}) {
  const obsidionWallet = useResource(useSession().wallet)
  const { gate, state, cancel } = useCeremonyGate()
  const recovered = useRegistrationRefunded(record)
  const restart = !holdsFunds && (recovered || unfunded)
  const earnedAsk = formatDepositDue(
    askedTotal("earned_tag"),
    tokenDecimalsForNetwork(getConfig().network),
  )
  useEffect(() => cancel, [cancel])
  const [deposit, setDeposit] = useState<SIPADepositRecord>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [refusal, setRefusal] = useState<RefusalState>()
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setRefusal(undefined)
    try {
      if (!obsidionWallet) throw new WalletError("wallet.notReady")
      const keys = await reusePasskeyAccount(obsidionWallet, record.l2Address, undefined, gate)
      if (reloadIfSessionSwitched(null, record.l2Address)) return
      if (restart) await onRestart(keys)
      else
        setDeposit(await prepareRegistrationRefund(record, getConfig(), obsidionWallet.networkId))
    } catch (err) {
      if (isGateCancelled(err) || isPasskeyCancelled(err)) return
      if (isPasskeyPolicyError(err)) setRefusal({ name: err.name, message: err.message })
      else
        setError(
          errorCopy(err) ?? (err instanceof Error ? err.message : copy.failed), // slice-check-ignore: an uncoded error keeps its own words until its source throws a code
        )
    } finally {
      setBusy(false)
    }
  }
  if (deposit)
    return (
      <DepositExitModal
        record={deposit}
        reason="registration-quote"
        canSweep={false}
        onClose={() => setDeposit(undefined)}
      />
    )
  if (state.kind === "awaiting-action") return <GateStep state={state} onCancel={cancel} />
  return (
    <section aria-label={copy.label}>
      <p>
        {unfunded
          ? fmt(copy.unfunded, { price: earnedAsk })
          : restart
          ? fmt(copy.restart, { price: earnedAsk })
          : fmt(copy.recover, { price: earnedAsk })}
      </p>
      {refusal ? (
        <PasskeyRefusal error={refusal} onRetry={() => void run()} />
      ) : (
        <PrimaryGradientButton
          title={busy ? copy.preparing : restart ? copy.register : copy.recoverAction}
          isDisabled={busy}
          onClick={() => void run()}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
