import { PrimaryGradientButton } from "@obsidion/web-ds"
import { BrandLockup } from "../../../ui/BrandLockup"
import { PRIVACY_URL, TERMS_URL } from "../../../lib/links"
import type { InviteNotice } from "./TagAvailabilityNotes"
import { LandingFeatureCards, useLandingRate } from "./LandingFeatureCards"
import { BootSplash } from "../../../ui/PxeBoot"

/** The landing for a visitor with nothing here yet: the claim server draws their tag. */
export function CreateWalletStep({
  busy,
  returning = false,
  notice,
  onCreate,
  onLogIn,
  onCancel,
}: {
  busy: boolean
  /** This browser opened an account before: "Log in" leads and "Create Account" moves to the footer. */
  returning?: boolean
  /** The draw failed; renders under the button. */
  notice?: InviteNotice
  onCreate: () => void
  onLogIn: () => void
  /** Abandons the draw the busy state is waiting on. */
  onCancel: () => void
}) {
  const rate = useLandingRate()
  if (!rate.ready) return <BootSplash />
  const loginFirst = returning && !busy
  return (
    <div className="ww-landing">
      <LandingFeatureCards apy={rate.apy} />
      <div className="ww-invite__content ww-landing__form">
        <div style={{ marginBottom: 32 }}>
          <BrandLockup />
        </div>
        <h1 className="ww-invite__title">Money that moves privately</h1>
        <p className="ww-invite__subtitle">
          Pay, get paid and save onchain. Your balance and transactions are private by default.
        </p>
        {loginFirst ? (
          <PrimaryGradientButton title="Log in" onClick={onLogIn} testId="have-wallet" />
        ) : (
          <PrimaryGradientButton
            title="Create Account"
            isLoading={busy}
            onClick={onCreate}
            testId="create-wallet"
          />
        )}
        {notice?.kind === "error" && (
          <p className="ww-invite__error" role="alert">
            {notice.message}
          </p>
        )}
        {busy ? (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-invite-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : loginFirst ? (
          <p className="ww-invite__footer">
            New here?{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={onCreate}
              data-testid="create-wallet"
            >
              Create Account
            </button>
          </p>
        ) : (
          <p className="ww-invite__footer">
            I already have an account{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={onLogIn}
              data-testid="have-wallet"
            >
              Log in
            </button>
          </p>
        )}
        <nav className="ww-landing__legal">
          <a href={TERMS_URL} target="_blank" rel="noreferrer">
            TERMS AND CONDITIONS
          </a>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            PRIVACY POLICY
          </a>
        </nav>
      </div>
    </div>
  )
}
