import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { formatUnits } from "viem"
import { normalizeTag, useResource } from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { Modal } from "../../ui/Modal"
import { InviteFriendActions, InviteFriendRow } from "../invite/InviteFriendRow"
import { useInvite } from "../invite/useInvite"
import { fireOnboardingEvent } from "../../lib/analytics"
import { usdFigure } from "../../ui/format"
import { chooseOwnName } from "./chooseOwnName"
import { confirmRegistrationTag, openRegistration } from "./openRegistration"
import { useNameAvailability, type NameAvailability } from "./nameAvailability"
import { askedTotal } from "./registrationAsk"
import { rememberRegistrationRoute, type RegistrationRoute } from "./registrationFunnel"
import { TagAvailabilityNotes } from "./steps/TagAvailabilityNotes"
import { setVerifyOpen, usePastUserCheck, useVerifyOpen } from "./usePastUserCheck"
import { VerifyPastUserModal } from "./VerifyPastUserModal"
import { useSession } from "../../platform/session"

export const PAY_PRICE = usdFigure(formatUnits(askedTotal("standard"), 18))
const VERDICTS: Partial<Record<NameAvailability, string>> = {
  "available": "available",
  "reserved": "taken",
  "blocked": "blocked",
  "blocked-reserved": "blocked",
}
/** One `onboarding_handle_checked` per distinct name a sheet settles a verdict on. */
export function useReportHandleCheck(
  name: string | null,
  fresh: boolean,
  checking: boolean,
  status: NameAvailability,
) {
  const checked = useRef<string | null>(null)
  useEffect(() => {
    const verdict = VERDICTS[status]
    if (!fresh || checking || !verdict || checked.current === name) return
    checked.current = name
    fireOnboardingEvent("onboarding_handle_checked", { status: verdict })
  }, [name, fresh, checking, status])
}
const CHOSEN_ROUTES: Record<"invite" | "past-user" | "pay", string> = {
  "invite": "invite",
  "past-user": "past_user",
  "pay": "pay",
}
const REGISTRATION_ROUTES: Record<"invite" | "past-user" | "pay", RegistrationRoute> = {
  "invite": "invite",
  "past-user": "past_user",
  "pay": "paid",
}

/** Picks a name of the user's own before the first deposit, in place of the drawn `tag`. */
export function ChooseNameSheet({ tag, onClose }: { tag: string; onClose: () => void }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const obsidionAccount = useResource(useSession().account)
  const obsidionWallet = useResource(useSession().wallet)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [route, setRoute] = useState<"invite" | "past-user" | "pay">("pay")
  const verified = usePastUserCheck().state.step === "confirmed"
  const verifying = useVerifyOpen()
  const invite = useInvite()
  const name = normalizeTag(typed)
  const fresh = name !== null && name !== tag
  const { status, checking } = useNameAvailability(typed, fresh)
  const available = fresh && !checking && status === "available"
  useEffect(() => {
    fireOnboardingEvent("name_sheet_opened", {
      screen: pathname === "/deposit" ? "deposit" : "settings",
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [])
  useReportHandleCheck(name, fresh, checking, status)

  const deposit = () => {
    onClose()
    if (pathname !== "/deposit") navigate("/deposit")
  }

  const claim = async (earned: boolean) => {
    if (!available || !name || !obsidionAccount || !obsidionWallet) return
    setBusy(true)
    setError(undefined)
    try {
      await chooseOwnName(name, obsidionAccount, obsidionWallet, earned)
      fireOnboardingEvent("name_route_chosen", { route: CHOSEN_ROUTES[route] })
      rememberRegistrationRoute(name, REGISTRATION_ROUTES[route])
      const open = openRegistration()
      // Home keeps a paid tag at the pick, open to the past-user claim, until it is registered.
      if (route === "pay" && open && pathname === "/deposit") confirmRegistrationTag(open.record)
      onClose()
      if (pathname !== "/deposit") navigate("/")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      variant="bare"
      className="ww-deposit-warning ww-deposit-sheet ww-choose-name"
      label="Choose your name"
      onClose={busy ? undefined : onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={busy ? undefined : onClose} />
      </div>
      <GradientText size={24} weight={700}>
        Choose your name
      </GradientText>
      <div className="ww-choose-name__name">
        <span className="ww-invite-field__input ww-choose-name__field">
          <span>@</span>
          <input
            aria-label="Your name"
            placeholder="name"
            value={typed}
            autoFocus
            disabled={busy}
            onChange={(e) => setTyped(e.target.value.replace(/^@/, "").toLowerCase())}
          />
        </span>
        {available ? (
          <p className="ww-choose-name__ok">
            <Icon name="check-circle" size={14} color="var(--accent-green)" />@{name} is available
          </p>
        ) : (
          <TagAvailabilityNotes
            typed={typed}
            valid={name !== null}
            availability={status}
            checking={checking}
            resuming={false}
          />
        )}
      </div>
      <div
        className="ww-choose-name__routes"
        role="radiogroup"
        aria-labelledby="ww-choose-name-label"
      >
        <p id="ww-choose-name-label" className="ww-choose-name__label">
          How to get it
        </p>
        <InviteFriendRow
          invite={invite}
          selected={route === "invite"}
          onSelect={() => setRoute("invite")}
        />
        <button
          type="button"
          role="radio"
          aria-checked={route === "past-user"}
          className="zkm-btn-reset ww-choose-name__route"
          onClick={() => {
            setRoute("past-user")
            if (!verified) setVerifyOpen(true)
          }}
        >
          <span className="ww-choose-name__dot" />
          <span>Used zk.money before</span>
          <b>Free</b>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={route === "pay"}
          className="zkm-btn-reset ww-choose-name__route"
          onClick={() => setRoute("pay")}
        >
          <span className="ww-choose-name__dot" />
          <span>Pay</span>
          <b>{PAY_PRICE}</b>
        </button>
      </div>
      {error && (
        <p className="ww-invite__error" role="alert">
          {error}
        </p>
      )}
      {route === "invite" ? (
        <InviteFriendActions
          invite={invite}
          depositLabel={`Deposit now as @${tag}`}
          name={available ? name : null}
          busy={busy}
          onClaim={() => void claim(true)}
          onDeposit={deposit}
        />
      ) : (
        <>
          <PrimaryGradientButton
            title={
              route === "pay"
                ? `Make my deposit ${PAY_PRICE}`
                : verified
                ? `Claim ${name ? `@${name} ` : ""}for free`
                : "Verify to claim for free"
            }
            isDisabled={!available}
            isLoading={busy}
            onClick={() =>
              route === "past-user" && !verified
                ? setVerifyOpen(true)
                : void claim(route === "past-user")
            }
          />
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            disabled={busy}
            onClick={onClose}
          >
            Keep @{tag}
          </button>
        </>
      )}
      {verifying && <VerifyPastUserModal onChoose={() => setRoute("past-user")} />}
    </Modal>
  )
}
