import { type ReactNode, useState } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { normalizeTag } from "@obsidion/front-core"
import type { SignInKeyChoice } from "@obsidion/passkey-web"
import type { RememberedAccount } from "../../../platform/auth/WebPasskeyIdentityMap"
import { KeyCards } from "../../identity/KeyCards"
import { OnboardingCard } from "../OnboardingCard"
import { tagError } from "../tagError"

/** What a typed tag came to, shown under the field: a row it duplicates, or what the L1 read said. */
export type ByTagNotice =
  | { kind: "listed"; tag: string }
  | { kind: "notFound"; tag: string }
  | { kind: "reserved"; tag: string }
  | { kind: "staleRollup"; tag: string }
  | { kind: "noKeyInstalled"; tag: string }
  | { kind: "unreadable"; tag: string }
  | { kind: "inconclusive"; tag: string }
  | { kind: "lookupFailed"; tag: string }

export function noticeText(notice: ByTagNotice): string {
  switch (notice.kind) {
    case "listed":
      return `@${notice.tag} is already on this browser — choose it in the list above, or`
    case "inconclusive":
      return `@${notice.tag}'s account has more passkeys than this version can read. Sign in on the device you registered on.`
    case "notFound":
      return `No registered account for @${notice.tag} yet. If you just signed up, continue with Show passkeys; otherwise check the spelling.`
    case "reserved":
      return `@${notice.tag} is reserved but not active yet. Tap Show passkeys and pick the passkey you reserved it with. Until its deposit lands, the network can't find @${notice.tag} by name.`
    case "staleRollup":
      return `@${notice.tag} was registered on an earlier version of the network. Sign in on the device you registered on to move it.`
    case "noKeyInstalled":
      return `@${notice.tag}'s account has no passkey key installed yet. Continue with Show passkeys and sign in with the passkey you registered with.`
    case "unreadable":
      return `@${notice.tag}'s passkey couldn't be read from the network. Continue with Show passkeys.`
    case "lookupFailed":
      return `Couldn't reach the network to look up @${notice.tag}.`
  }
}

/** A selected row's keys, shown in place of Login: read from L1 when this browser lacks a record for one. */
export type RowKeys = {
  credentialId: string
  choices: SignInKeyChoice[]
  reading?: boolean
  failed?: boolean
}

/** The sign-in screen's own state: the field the parent resolves, the remembered accounts, and readiness. */
export type SignInStart = {
  candidates: RememberedAccount[]
  onCandidate: (candidate: RememberedAccount) => void
  /** The rows whose wallet has more than one key: a tap selects the row instead of opening a prompt. */
  keyed: ReadonlySet<string>
  rowKeys?: RowKeys
  onRowKey: (credentialId: string) => void
  onRowKeysAgain: () => void
  /** The resolved tag's keys, shown in place of Login; unset for a one-key account. */
  tagKeys?: SignInKeyChoice[]
  onTagKey: (credentialId: string) => void
  value: string
  onTagChange: (tag: string) => void
  onTagBlur: () => void
  /** A remembered tag's way in with a passkey its row does not hold: the tag is read like any other. */
  onDifferentPasskey: () => void
  /** The typed text is the tag the resolve found: Login (and Enter) fire only then. */
  submitReady: boolean
  resolving: boolean
  /** The manifest and the cache proof are in hand; until then no ceremony action is live. */
  prepared: "pending" | "ready" | "failed"
  onPrepareAgain: () => void
  notice?: ByTagNotice
  /** Show passkeys takes the primary button: the user asked for a different passkey. */
  chooserFirst: boolean
  /** A sign-in is running: no second tap may start a competing prompt. */
  busy: boolean
  /** Opens the endpoint editor; unset where the wallet does not own the endpoints. */
  onEndpoints?: () => void
}

/** A selected row's keys in place of Login, or the L1 read still naming them. */
function RowKeysAction({
  rowKeys,
  caption,
  disabled,
  onChoose,
  onAgain,
}: {
  rowKeys: RowKeys
  caption: string
  disabled: boolean
  onChoose: (credentialId: string) => void
  onAgain: () => void
}) {
  if (rowKeys.reading) {
    return (
      <p
        className="ww-invite__checking ww-key-choice__status"
        role="status"
        data-testid="sign-in-account-keys-reading"
      >
        Finding your passkeys…
      </p>
    )
  }
  if (rowKeys.failed) {
    return (
      <p className="ww-invite-modal-error" role="alert" data-testid="sign-in-account-keys-failed">
        Couldn't find this account's passkeys on the network.{" "}
        <button
          type="button"
          className="zkm-btn-reset ww-invite__link"
          data-testid="sign-in-account-keys-again"
          onClick={onAgain}
        >
          Try again
        </button>
      </p>
    )
  }
  return (
    <KeyCards
      caption={caption}
      verb="Log in"
      choices={rowKeys.choices}
      disabled={disabled}
      onChoose={onChoose}
      testId="sign-in-account-keys"
    />
  )
}

/**
 * A remembered account. A one-key row signs in on a tap; a row whose wallet has more than one key
 * (`keyed`) is selected instead, and its keys take Login's place.
 */
function AccountRow({
  candidate,
  keyed,
  picked,
  disabled,
  onPick,
}: {
  candidate: RememberedAccount
  keyed: boolean
  picked: boolean
  disabled: boolean
  onPick: (candidate: RememberedAccount) => void
}) {
  const backupNote = candidate.backup && !keyed
  return (
    <li>
      <button
        type="button"
        className={`zkm-btn-reset zkm-pressable ww-account-row${
          picked ? " ww-account-row--selected" : ""
        }`}
        data-testid="sign-in-account"
        aria-label={`Sign in as @${candidate.usertag}${
          backupNote ? " with the backup passkey" : ""
        }`}
        aria-pressed={keyed ? picked : undefined}
        disabled={disabled}
        onClick={() => onPick(candidate)}
      >
        <span className="ww-account-row__tag">
          @{candidate.usertag}
          <span className="ww-account-row__domain">.zk.money</span>
          {backupNote && (
            <span className="ww-account-row__note" data-testid="sign-in-account-backup">
              Backup passkey
            </span>
          )}
        </span>
        {picked ? (
          <span className="ww-account-row__check" aria-hidden="true">
            <Icon name="check" size={12} color="#fff" strokeWidth={3} />
          </span>
        ) : (
          <span className="ww-account-row__go" aria-hidden="true">
            ›
          </span>
        )}
      </button>
    </li>
  )
}

/**
 * The card's action: a selected row's key cards, a typed tag's, else Login, after Show passkeys
 * when the user asked for a different passkey. `foot` follows every action but the chooser, which
 * is Show passkeys itself; `endpoints` follows them all.
 */
function SignInAction({
  start,
  selected,
  tagKeys,
  disabled,
  canSubmit,
  submit,
  submitTitle,
  onShowPasskeys,
  foot,
  endpoints,
}: {
  start?: SignInStart
  selected?: RememberedAccount
  tagKeys?: SignInKeyChoice[]
  disabled: boolean
  canSubmit: boolean
  submit: () => void
  submitTitle: string
  onShowPasskeys?: () => void
  foot: ReactNode
  endpoints: ReactNode
}) {
  if (start && selected && start.rowKeys) {
    return (
      <>
        <RowKeysAction
          rowKeys={start.rowKeys}
          caption={`Log in as @${selected.usertag} with`}
          disabled={disabled}
          onChoose={start.onRowKey}
          onAgain={start.onRowKeysAgain}
        />
        {foot}
        {endpoints}
      </>
    )
  }
  if (start && tagKeys) {
    return (
      <>
        <KeyCards
          caption="Log in with"
          verb="Log in"
          choices={tagKeys}
          disabled={disabled}
          onChoose={start.onTagKey}
          testId="sign-in-tag-keys"
        />
        {foot}
        {endpoints}
      </>
    )
  }
  if (start?.chooserFirst) {
    return (
      <>
        <PrimaryGradientButton
          title="Show passkeys"
          testId="sign-in-show-passkeys"
          isDisabled={start.prepared !== "ready"}
          isLoading={start.busy}
          onClick={onShowPasskeys}
        />
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-pill ww-sign-in__alt"
          data-testid="sign-in-login"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitTitle}
        </button>
        {endpoints}
      </>
    )
  }
  return (
    <>
      <PrimaryGradientButton
        title={submitTitle}
        testId={start ? "sign-in-login" : undefined}
        isDisabled={!canSubmit}
        isLoading={start?.busy ?? false}
        onClick={submit}
      />
      {foot}
      {endpoints}
    </>
  )
}

/**
 * The tag card in its two roles. As the sign-in screen (`start`): the remembered accounts this
 * browser holds, a field that resolves as it is typed, Login pinned to what resolved, and "Show
 * passkeys" for the browser's full chooser. As the confirm step (no `start`): the passkey resolved
 * an account whose claim is only known by hash — on the chain, or in a signup's reservation — so
 * the user names it, and "Show passkeys" re-opens the prompt for a different passkey. An account
 * with more than one key shows its keys as cards in place of Login, before any prompt: a typed
 * tag's, or a selected row's.
 */
export function ConfirmTagModal({
  initialHandle = "",
  error,
  submitTitle = "Login",
  start,
  onConfirm,
  onShowPasskeys,
  onBack,
  onClose,
}: {
  initialHandle?: string
  error?: string
  submitTitle?: string
  start?: SignInStart
  onConfirm: (handle: string) => void
  /** The start role's open request: the browser's own list. */
  onShowPasskeys?: () => void
  /** The confirm role's way back to the sign-in screen, for a passkey that is not the user's. */
  onBack?: () => void
  onClose: () => void
}) {
  const [own, setOwn] = useState(normalizeTag(initialHandle) ?? "")
  const typed = start ? start.value : own
  const normalised = normalizeTag(typed)
  const valid = normalised !== null
  const prepared = !start || start.prepared === "ready"
  const busy = start?.busy ?? false
  // A selected row, or a resolved tag with more than one key, signs in from its cards, never Login.
  const rowKeys = start?.rowKeys
  const selected = rowKeys && start?.candidates.find((c) => c.credentialId === rowKeys.credentialId)
  const tagKeys = !selected && start?.submitReady ? start.tagKeys : undefined
  // The confirm role submits any well-formed tag; the start role only the tag that resolved.
  const canSubmit = start ? start.submitReady && !tagKeys && !selected && prepared && !busy : valid
  const submit = () => canSubmit && onConfirm(typed)
  const endpointsFoot = start?.onEndpoints && (
    <p className="ww-invite-modal-foot">
      Using your own node?{" "}
      <button
        type="button"
        className="zkm-btn-reset ww-invite__link"
        data-testid="sign-in-endpoints"
        disabled={busy}
        onClick={start.onEndpoints}
      >
        Endpoints
      </button>
    </p>
  )
  const foot = start ? (
    <p className="ww-invite-modal-foot">
      Can't find your account?{" "}
      <button
        type="button"
        className="zkm-btn-reset ww-invite__link"
        data-testid="sign-in-show-passkeys"
        disabled={!prepared || busy}
        onClick={onShowPasskeys}
      >
        Show passkeys
      </button>
    </p>
  ) : (
    <p className="ww-invite-modal-foot">
      Not your account?{" "}
      <button type="button" className="zkm-btn-reset ww-invite__link" data-testid="confirm-back" onClick={onBack}>
        Go back
      </button>
    </p>
  )
  return (
    <OnboardingCard onClose={onClose} className="ww-modal--create">
      <form
        data-testid={start ? "sign-in-start" : "confirm-tag"}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="ww-invite-modal-head">
          <span className="ww-invite-modal-badge">
            <Icon name="user-search" size={28} color="#fff" />
          </span>
          <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
            {start ? (
              "Type your @tag"
            ) : (
              <>
                Confirm by typing <br />
                your @tag
              </>
            )}
          </h2>
        </div>
        {start && start.candidates.length > 0 && (
          <div className="ww-invite-field">
            <span className="ww-invite-field__label">Accounts on this browser</span>
            <ul
              className="ww-account-list"
              data-testid="sign-in-accounts"
              aria-label="Accounts on this browser"
            >
              {start.candidates.map((candidate) => {
                const keyed = start.keyed.has(candidate.credentialId)
                return (
                  <AccountRow
                    key={candidate.credentialId}
                    candidate={candidate}
                    keyed={keyed}
                    picked={keyed && selected === candidate}
                    disabled={!prepared || busy}
                    onPick={start.onCandidate}
                  />
                )
              })}
            </ul>
          </div>
        )}
        <label className="ww-invite-field">
          <span className="ww-invite-field__label">Your tag</span>
          <span className="ww-invite-field__input">
            <span>@</span>
            <input
              aria-label="Your tag"
              placeholder="tag"
              value={typed}
              autoFocus
              data-autofocus
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value.replace(/^@/, "").toLowerCase()
                if (start) start.onTagChange(next)
                else setOwn(next)
              }}
              onBlur={start?.onTagBlur}
            />
            <span>.zk.money</span>
          </span>
        </label>
        {start && typed && !valid && !start.notice && (
          <p className="ww-invite__error" role="alert">
            {tagError(typed)}
          </p>
        )}
        {start?.resolving && <p className="ww-invite__checking">Finding your passkey…</p>}
        {start?.notice && (
          <p
            className="ww-invite-modal-error"
            role="alert"
            data-testid={`by-tag-${start.notice.kind}`}
          >
            {noticeText(start.notice)}
            {start.notice.kind === "listed" && (
              <>
                {" "}
                <button
                  type="button"
                  className="zkm-btn-reset ww-invite__link"
                  data-testid="by-tag-different-passkey"
                  disabled={busy}
                  onClick={start.onDifferentPasskey}
                >
                  use a different passkey
                </button>
                .
              </>
            )}
            {start.notice.kind === "lookupFailed" && (
              <>
                {" "}
                <button
                  type="button"
                  className="zkm-btn-reset ww-invite__link"
                  data-testid="by-tag-retry"
                  onClick={start.onTagBlur}
                >
                  Try again
                </button>{" "}
                or continue with Show passkeys.
              </>
            )}
          </p>
        )}
        {start?.prepared === "failed" && (
          <p className="ww-invite-modal-error" role="alert" data-testid="sign-in-unprepared">
            Couldn't reach the network.{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              data-testid="sign-in-prepare-again"
              onClick={start.onPrepareAgain}
            >
              Try again
            </button>
          </p>
        )}
        {error && (
          <p className="ww-invite-modal-error" role="alert">
            {error}
          </p>
        )}
        <SignInAction
          start={start}
          selected={selected}
          tagKeys={tagKeys}
          disabled={!prepared || busy}
          canSubmit={canSubmit}
          submit={submit}
          submitTitle={submitTitle}
          onShowPasskeys={onShowPasskeys}
          foot={foot}
          endpoints={endpointsFoot}
        />
      </form>
    </OnboardingCard>
  )
}
