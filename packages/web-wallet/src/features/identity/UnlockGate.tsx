import { leavePage } from "../../platform/storage/walletStorage"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Navigate } from "react-router-dom"
import {
  AccountStorage,
  memoryStore,
  useResource,
  useStore,
  type Resource,
  type ResourceState,
} from "@obsidion/front-core"
import type { ObsidionAccount } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { failureCode, fireEvent } from "../../lib/analytics"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import {
  PHONE_STEPS_COPY,
  currentMacCopyMayBeWrong,
  inAppBrowserRefusal,
  isPasskeyPolicyError,
  type PasskeyAttemptHandle,
  type SignInKeyChoice,
  signInKeyChoices,
} from "@obsidion/passkey-web"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { mismatchVerdictOf, observedOf } from "../../platform/auth/WebAlphaAuthService"
import { hasRecordFor, walletKeysFor } from "../../platform/auth/WebPasskeyIdentityMap"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"
import { useAsyncAction } from "../../ui/hooks"
import { BootSplash } from "../../ui/PxeBoot"
import { errorCopy } from "../../errors/catalog"
import copy from "./UnlockGate.copy"
import {
  BACKUP_ENVELOPE,
  PasskeyRefusal,
  STORED_ADDRESS_MISMATCH,
  isPasskeyNotOffered,
  type RouteRefusal,
} from "./PasskeyRefusal"
import { KeyCards } from "./KeyCards"
import { signOut } from "./signOut"
import { useSession } from "../../platform/session"

/** Another key of the session's wallet: one this browser holds a record for, or the way to find it. */
type OtherKey = { label: string; credentialId?: string }

/**
 * The session wallet's keys, read once. With a record here for every key, `cards` are them all, the
 * session's key tagged as last used, and `others` every key but `failed` by name for the refusal
 * card. A key with no record here is reached through /enter, which reads it from the chain.
 */
function sessionKeys(
  rpId: string,
  credentialId: string,
  failed = credentialId,
): { cards?: SignInKeyChoice[]; others: OtherKey[] } {
  const keys = walletKeysFor(rpId, credentialId) ?? []
  if (keys.length < 2) return { others: [] }
  const recorded = keys.flatMap((k) => (k.record ? [k.record] : []))
  if (recorded.length < keys.length) {
    const ownBackup = recorded.find((r) => r.credentialId === credentialId)?.backup
    const label =
      keys.length > 2
        ? "Use another passkey"
        : ownBackup
        ? "Use your sign-up passkey"
        : "Use your backup passkey"
    return { others: [{ label }] }
  }
  // The session's key opened the wallet last, whatever the records' stamps say.
  const cards = (signInKeyChoices(recorded.map(({ usedAt: _, ...key }) => key)) ?? []).map((c) =>
    c.credentialId === credentialId ? { ...c, lastUsed: true as const } : c,
  )
  const others = cards
    .filter((c) => c.credentialId !== failed)
    .map((c) => ({
      label: `Use your ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)}`,
      credentialId: c.credentialId,
    }))
  return { cards, others }
}

/**
 * The locked pane's action. A wallet whose every key this browser holds a record for shows its keys
 * as cards, with "Use a different passkey" as a foot link; otherwise Unlock with passkey and `exits`.
 */
function UnlockChoice({
  cards,
  busy,
  onKey,
  onUnlock,
  onDifferentPasskey,
  exits,
}: {
  cards?: SignInKeyChoice[]
  busy: boolean
  onKey: (credentialId: string) => void
  onUnlock: () => void
  onDifferentPasskey: () => void
  exits: ReactNode
}) {
  if (!cards) {
    return (
      <>
        <div style={{ marginTop: 24 }}>
          <PrimaryGradientButton title="Unlock with passkey" isLoading={busy} onClick={onUnlock} />
        </div>
        <div style={{ marginTop: 12 }}>{exits}</div>
      </>
    )
  }
  return (
    <>
      <div style={{ marginTop: 24 }}>
        <KeyCards
          caption="Unlock with"
          verb="Unlock"
          choices={cards}
          disabled={busy}
          onChoose={onKey}
          testId="unlock-keys"
        />
      </div>
      <p className="ww-invite-modal-foot">
        Not your account?{" "}
        <button
          type="button"
          className="zkm-btn-reset ww-invite__link"
          data-testid="unlock-choose-passkey"
          disabled={busy}
          onClick={onDifferentPasskey}
        >
          Use a different passkey
        </button>
      </p>
    </>
  )
}

const NO_ACCOUNT = memoryStore<ResourceState<ObsidionAccount>>({ status: "pending" }).readonly
const existence = (stored: { value: unknown; loaded: boolean }) =>
  stored.loaded ? stored.value !== undefined : undefined

/** Unlocks the account again; resolves once it is unlocked or has failed. */
function retryUnlock(account: Resource<ObsidionAccount> | null): Promise<void> {
  if (!account) return Promise.resolve()
  return new Promise((resolve) => {
    const off = account.subscribe(() => {
      if (account.get().status === "pending") return
      off()
      resolve()
    })
    account.retry()
  })
}

/**
 * Holds the wallet surface until the account is unlocked. A session whose cached key proves out
 * never lands here: the auth service restores it before the session's unlock asks. The locked pane
 * is the no-cache case (a fresh browser, a sign-out, a cache that failed its checks): "Unlock with
 * passkey" opens the browser's own prompt, one assertion re-derives the key, verified against this
 * browser's record through the wallet's pure address derivation (`unlock`), then the session's
 * account unlocks again from the key it cached. A device whose AccountStorage record is gone, or
 * whose active passkey has no record here, is routed to /enter. A wallet with a backup shows its keys as cards, each unlocking
 * with that key alone.
 */
export function UnlockGate({ children }: { children: ReactNode }) {
  const session = useSession()
  const account = useStore(session.account ?? NO_ACCOUNT)
  const obsidionAccount = account.status === "ready" ? account.value : undefined
  const unlockError =
    account.status === "failed"
      ? errorCopy(account.error) ??
        (account.error instanceof Error ? account.error.message : copy.unlockFailed)
      : undefined
  const accountExists = useStore(AccountStorage.get().current, existence)
  const obsidionWallet = useResource(useSession().wallet)
  const { busy, run } = useAsyncAction()
  // `asked`: the key the refused unlock asked for, when the user chose one; its retries ask it again.
  const [refusal, setRefusal] = useState<RouteRefusal & { asked?: string }>()
  const [toEnter, setToEnter] = useState(false)
  // The key was recovered but front-core could not install the account; its reason is shown.
  const [installFailed, setInstallFailed] = useState(false)
  const attempt = useRef<AbortController | undefined>(undefined)
  const attemptRef = useRef<PasskeyAttemptHandle | undefined>(undefined)
  // Whether the last unlock was steered to the phone, so its retry is too.
  const phoneRef = useRef(false)

  // Leaving the screen ends the attempt behind its prompt: nothing commits for a pane that is gone.
  useEffect(
    () => () => {
      attemptRef.current?.unmounted()
      attempt.current?.abort()
    },
    [],
  )

  // Demo mode holds the master key in memory but builds no account contract — there is no PXE.
  if (obsidionAccount || isDemoMode()) return <>{children}</>
  if (accountExists === false || toEnter) return <Navigate to="/enter" replace />
  const credentialId = getActiveCredentialId()
  if (accountExists && (!credentialId || !hasRecordFor(getConfig().rpId, credentialId))) {
    return <Navigate to="/enter" replace />
  }
  if (!unlockError || !obsidionWallet) return <BootSplash inShell />

  const unlock = (phone = false, key?: string) => {
    // A phone attempt that ends with nothing offered goes back to the card it came from.
    const cameFrom = phone ? refusal : undefined
    phoneRef.current = phone
    setRefusal(undefined)
    const refuse = (card: RouteRefusal) => setRefusal({ ...card, ...(key ? { asked: key } : {}) })
    setInstallFailed(false)
    // A newer tap supersedes the attempt behind any open prompt: its abort tears that prompt down
    // and lets the service start a fresh flight rather than a second, competing one.
    attempt.current?.abort()
    attemptRef.current?.superseded()
    const controller = new AbortController()
    attempt.current = controller
    const tracked = passkeyTelemetry.begin({ ceremony: "unlock", flow: "unlock" })
    attemptRef.current = tracked
    void run(async () => {
      try {
        await tracked.run((own) =>
          getAuthService().unlock(
            (msk, passkeys) =>
              obsidionWallet
                .deriveAccountAddress(msk, passkeys)
                .then((address) => address.toString()),
            {
              signal: controller.signal,
              own,
              ...(phone ? { phone } : {}),
              ...(key ? { credentialId: key } : {}),
            },
          ),
        )
      } catch (e) {
        // A superseded attempt's late answer belongs to nobody: the newer tap owns the pane.
        if (controller.signal.aborted) return
        if (isPasskeyNotOffered(e)) {
          if (cameFrom) setRefusal(cameFrom)
          return
        }
        if (e instanceof Error && e.name === "NoPasskeySessionError") {
          setToEnter(true)
          return
        }
        // The session moved while the prompt was open: its owner (a commit here, the guard's reload
        // after another tab's change) settles the screen.
        if (e instanceof Error && e.name === "SessionChangedError") return
        // A record we hold no longer reproduces from this passkey: our own refusal row, with the
        // verdict that picks the copy.
        const verdict = mismatchVerdictOf(e)
        if (verdict) {
          fireEvent("action_failed", { action: "identity:unlock", code: failureCode(e) })
          const mac = currentMacCopyMayBeWrong(observedOf(e))
          refuse({
            name: STORED_ADDRESS_MISMATCH,
            message: "",
            verdict,
            ...(mac ? { macUpdate: true } : {}),
            ...(mac && verdict === "wrong-key" ? { macPhone: true } : {}),
          })
          return
        }
        // A backup record's envelope did not open, or the policy refused: the card by name.
        if (isPasskeyPolicyError(e) || (e instanceof Error && e.name === BACKUP_ENVELOPE)) {
          fireEvent("action_failed", { action: "identity:unlock", code: failureCode(e) })
          refuse({ name: e.name, message: e.message })
          return
        }
        // Closed prompts returned above, an iOS app's included: only a NotSupportedError is left.
        const unusable = inAppBrowserRefusal(e)
        if (unusable) {
          fireEvent("action_failed", { action: "identity:unlock", code: failureCode(e) })
          refuse({ ...unusable, cause: e })
          return
        }
        throw e
      }
      if (controller.signal.aborted) return
      await retryUnlock(session.account)
      // An installed account unmounts this pane; a pane still here means the install failed and
      // `unlockError` carries the reason.
      setInstallFailed(true)
    }, "identity:unlock")
  }

  /**
   * Sign out and land on the sign-in screen with Show passkeys first. `avoid` names the credential
   * that just returned the wrong key, so the screen hides its row instead of offering it again.
   */
  const chooseAnotherPasskey = (avoid?: string) => {
    attempt.current?.abort()
    attemptRef.current?.userCancelled()
    void run(async () => {
      await signOut()
      await leavePage(
        avoid ? `/enter?choose=1&avoid=${encodeURIComponent(avoid)}` : "/enter?choose=1",
      )
    }, "identity:choose-passkey")
  }

  /** Sign out and open the sign-in screen on this wallet's keys, read from the chain there. */
  const pickKey = () => {
    attempt.current?.abort()
    attemptRef.current?.userCancelled()
    void run(async () => {
      await signOut()
      await leavePage(`/enter?pick=${encodeURIComponent(credentialId!)}`)
    }, "identity:choose-passkey")
  }

  // The credential the refused unlock asked for: the key the user chose, else the session's.
  const failed = refusal?.asked ?? credentialId ?? undefined
  // On a card that leads with the phone, the credential that returned the wrong key is hidden there.
  const avoid = refusal?.macPhone ? failed : undefined
  const { cards, others } = credentialId
    ? sessionKeys(getConfig().rpId, credentialId, failed)
    : { cards: undefined, others: [] }
  const exits = (
    <>
      {others.map((other) => (
        <button
          key={other.credentialId ?? "pick"}
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-pill"
          data-testid="unlock-other-key"
          disabled={busy}
          onClick={() => (other.credentialId ? unlock(false, other.credentialId) : pickKey())}
        >
          {other.label}
        </button>
      ))}
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-invite-pill"
        data-testid="unlock-choose-passkey"
        disabled={busy}
        onClick={() => chooseAnotherPasskey(avoid)}
      >
        Use a different passkey
      </button>
    </>
  )

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        width: "100%",
        maxWidth: 430,
        margin: "0 auto",
      }}
    >
      {refusal ? (
        <PasskeyRefusal
          error={refusal}
          verdict={refusal.verdict}
          onRetry={() => unlock(phoneRef.current, refusal.asked)}
          busy={busy}
          // The certain wrong key: this copy would answer again, so the way on is another device.
          primary={
            refusal.macPhone
              ? {
                  title: PHONE_STEPS_COPY.noPhone.back,
                  onClick: () => unlock(true, refusal.asked),
                  testId: "unlock-phone",
                }
              : refusal.verdict === "wrong-key"
              ? {
                  title: "Show passkeys",
                  onClick: () => chooseAnotherPasskey(failed),
                  testId: "unlock-show-passkeys",
                }
              : undefined
          }
          exits={exits}
          escapePath="/enter"
          reportContext="identity:unlock"
          testId="unlock-refused"
          retryTestId="unlock-retry"
        />
      ) : (
        <div style={{ textAlign: "center", padding: "48px 0 16px" }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.25, margin: "12px 0 8px" }}>
            Welcome back
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.45, margin: 0 }}>
            Unlock with one of this wallet's passkeys. Transactions are approved with it afterwards.
          </p>
          {installFailed && (
            <p
              role="alert"
              data-testid="unlock-install-failed"
              style={{
                color: "var(--accent-gold)",
                fontSize: 13,
                lineHeight: 1.45,
                margin: "16px 0 0",
                overflowWrap: "anywhere",
              }}
            >
              Your passkey worked, but the wallet could not load the account: {unlockError}
            </p>
          )}
          <UnlockChoice
            cards={cards}
            busy={busy}
            onKey={(key) => unlock(false, key)}
            onUnlock={() => unlock()}
            onDifferentPasskey={() => chooseAnotherPasskey(avoid)}
            exits={exits}
          />
        </div>
      )}
    </div>
  )
}
