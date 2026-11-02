import { useEffect, useId, useMemo, useRef, useState } from "react"
import {
  GlassCircleButton,
  GradientText,
  Icon,
  IconCircle,
  RowChevron,
  SettingsRow,
  StatusPill,
} from "@obsidion/web-ds"
import type { ContractService, ObsidionWallet } from "@obsidion/sdk"
import {
  MAX_PASSKEY_CANDIDATES,
  allowanceCovers,
  authKeyPubkeyHex,
  createOxideL1Reader,
  deriveBootstrapKey,
  envelopeSlot,
  parseKeyMetadata,
  resolveOxideIdentity,
  useContractServiceContext,
  type ParsedKeyMetadata,
  useResource,
} from "@obsidion/front-core"
import {
  BACKUP_ADD_SHEET_COPY,
  currentDevicePosture,
  currentUserAgentInfoSoon,
  isPhysicalOnly,
  providerNameFor,
  windowsHelloBackupWarning,
  type BackupAddChoice,
  type PhoneReach,
  type UserAgentInfo,
} from "@obsidion/passkey-web"
import type { Address } from "viem"
import { getConfig } from "../config/env"
import { backupPasskeySettingsEnabled } from "../config/features"
import { l1PublicClient } from "../config/oxideTuple"
import { useSponsoredAllowance } from "../features/allowance/useSponsoredAllowance"
import { BACKUP_ADD_ICONS, backupAddSheetOptions } from "../features/backupPasskey/backupAddOptions"
import { startBackupAdd } from "../features/backupPasskey/backupPasskeyAdd"
import { approveCopy, entryCopy, panelCopy } from "../features/backupPasskey/backupPasskeyCopy"
import {
  entryBlock,
  type EntryAction,
  type EntryBlock,
} from "../features/backupPasskey/backupPasskeyEntry"
import {
  BackupPasskeyPanel,
  errorLine,
  formatDai,
  warnFailure,
} from "../features/backupPasskey/BackupPasskeyPanel"
import { useBackupEntryFacts, type EntryFacts } from "../features/backupPasskey/backupPasskeyFacts"
import {
  buildBackupAddDeps,
  buildBackupFlowDeps,
  type BackupFlowDeps,
} from "../features/backupPasskey/backupPasskeyRuntime"
import {
  rereadBackupRotation,
  useBackupRotation,
} from "../features/backupPasskey/backupRotationStore"
import { KeyWarningLine, StepsNote } from "../features/identity/PhoneSteps"
import { SignUpChoiceSelect } from "../features/identity/SignUpChoiceSelect"
import { loadWalletIdentity } from "../features/identity/walletIdentity"
import { generationAddresses } from "../features/onboarding/generationAddresses"
import { loadOxideGenerations } from "../features/onboarding/oxideGenerations"
import { getAuthService } from "../platform/auth/useAuthenticator"
import { authenticatorFor, type AuthenticatorRecord } from "../platform/auth/WebPasskeyIdentityMap"
import { Modal } from "./Modal"
import { MAX_PASSKEY_NAME, readPasskeyNames, savePasskeyName } from "./passkeyNames"
import { handOffAccount, useSession } from "../platform/session"

type KeyLabel = "Sign-up" | "Backup" | "Unknown key"

type Row = {
  pubkeyHex: string
  label: KeyLabel
  signsHere: boolean
  /** The passkey manager, where this browser recorded it at creation. */
  provider?: string
}

type AccountKeys = {
  rows: Row[]
  authKeyCount: number
  /** The L1 account the keys are installed on. */
  owner: Address
  /** The key signing this session, hex. */
  session: string
}

/** The sign-up passkey keeps its raw credential id; a backup passkey carries an envelope the opener accepts. */
export function keyLabel(parsed: ParsedKeyMetadata): KeyLabel {
  if (parsed.kind === "credential-id") return "Sign-up"
  if (parsed.kind !== "envelope-prefixed") return "Unknown key"
  try {
    envelopeSlot(parsed.envelope)
    return "Backup"
  } catch {
    return "Unknown key"
  }
}

async function readAccountKeys(
  wallet: ObsidionWallet,
  contractService: ContractService,
): Promise<AccountKeys | "unverified"> {
  const keys = await getAuthService().sessionKeys()
  const address = loadWalletIdentity()?.address
  if (!keys || !address) throw new Error("wallet locked")
  const config = getConfig()
  const generations = await loadOxideGenerations(wallet, contractService, config)
  const bootstrap = deriveBootstrapKey(keys.secretKey).address
  const session = (await keys.authProvider.getPubkeys())
    .map((part) => part.toString("hex"))
    .join("")
  const identity = await resolveOxideIdentity(
    generations,
    bootstrap,
    address,
    generationAddresses(config, `0x${session}`)(keys.secretKey, address),
  )
  // An account the catalog shows and does not verify, or none at all, is not registered; a read
  // that could not conclude is a failed read, so it gets a retry rather than that verdict.
  if (identity.kind === "unverified" || identity.kind === "none") return "unverified"
  if (identity.kind !== "verified") throw new Error(`identity ${identity.kind}`)
  const { entries, authKeyCount } = await createOxideL1Reader(
    l1PublicClient(config),
  ).readAuthKeysCounted(identity.identity.account, MAX_PASSKEY_CANDIDATES)
  const rows = entries.map((entry): Row => {
    const pubkeyHex = authKeyPubkeyHex(entry) ?? `${entry.key.qx.slice(2)}${entry.key.qy.slice(2)}`
    return {
      pubkeyHex,
      label: keyLabel(parseKeyMetadata(entry.metadata)),
      signsHere: pubkeyHex === session,
      provider: providerFor(authenticatorFor(pubkeyHex)),
    }
  })
  return { rows, authKeyCount, owner: identity.identity.account, session }
}

/** The manager this browser recorded for a key; a hardware key no table names is called what it is. */
function providerFor(record: AuthenticatorRecord | undefined): string | undefined {
  if (!record) return undefined
  const named = providerNameFor(record.prfAaguid)
  if (named) return named
  const securityKey =
    record.securityKey ||
    record.authenticatorType === "security-key" ||
    Boolean(record.inferredTransports) ||
    isPhysicalOnly(record.transports)
  return securityKey ? "Security key" : undefined
}

const actionLabel: Record<EntryAction, string> = {
  sponsorship: "Sponsored transactions",
  activity: "Activity",
  migration: "Upgrade",
}

type EntryState = "checking" | "unreadable" | "ready" | EntryBlock

/** The sponsored sends the whole flow takes besides the moves: the publish and the funding. */
const FIXED_USES = 2

/**
 * The add entry for a one-key account, or one not registered yet: on a laptop, a picker for where
 * the backup passkey lives, then a row that presses only once every condition holds, the first
 * unmet one named under it. The picker waits on the phone probe; a phone has no picker.
 */
function BackupEntry({
  keys,
  wallet,
  contractService,
  attempt,
  onStarted,
  onAction,
}: {
  keys: AccountKeys | "unverified"
  wallet: ObsidionWallet
  contractService: ContractService | null
  /** The modal's slot for the add in flight; the modal aborts it when it closes. */
  attempt: { current: AbortController | undefined }
  onStarted: () => void
  onAction?: (action: EntryAction) => void
}) {
  const allowance = useSponsoredAllowance()
  const chain = useBackupEntryFacts(wallet, contractService, keys !== "unverified")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // The row waits for this read, so a device whose own manager cannot hold a backup sees its line
  // before any press opens the sheet.
  const [device, setDevice] = useState<UserAgentInfo>()
  useEffect(() => {
    let live = true
    void currentUserAgentInfoSoon().then((info) => {
      if (live) setDevice(info)
    })
    return () => {
      live = false
    }
  }, [])
  const [laptop] = useState(() => currentDevicePosture() === "laptop")
  const [reach, setReach] = useState<PhoneReach>()
  const [picked, setPicked] = useState<BackupAddChoice>()
  const pickerLabel = useId()
  useEffect(() => {
    if (!laptop) return
    let cancelled = false
    void getAuthService()
      .probePhoneReach()
      .catch((): PhoneReach => "unknown")
      .then((answer) => {
        if (!cancelled) setReach(answer)
      })
    return () => {
      cancelled = true
    }
  }, [laptop])
  // The page's own reads are taken once, when the probe settles.
  const sheet = useMemo(
    () => (laptop && reach ? backupAddSheetOptions({ reach }) : undefined),
    [laptop, reach],
  )
  const option =
    sheet && (sheet.options.find((o) => o.id === (picked ?? sheet.selected)) ?? sheet.options[0])

  // The entry shows on a one-key account only, where the installed key is the sign-up passkey by
  // definition, so the session is root when its key is the one installed; an unregistered account
  // has that key alone. The row label plays no part: it is read off the metadata's shape and a raw
  // credential id can look like an envelope.
  const sessionIsRoot = keys === "unverified" || keys.rows.some((row) => row.signsHere)
  let entry: EntryState
  const snapshot = allowance.snapshot
  const facts = keys === "unverified" ? UNREGISTERED_FACTS : chain.facts
  if (snapshot.status === "unavailable" || facts === "unreadable") entry = "unreadable"
  else if (snapshot.status !== "ready" || facts === "checking" || !device) entry = "checking"
  else
    entry =
      entryBlock(
        {
          ...facts,
          sessionIsRoot,
          verified: keys !== "unverified",
          registered: snapshot.state.kind !== "not-subscribed",
          usesLeft: allowanceCovers(snapshot.state, FIXED_USES + facts.moves),
        },
        formatDai,
      ) ?? "ready"
  // Only a ready laptop entry waits on the probe; a blocked one keeps its reason.
  if (entry === "ready" && laptop && !sheet) entry = "checking"

  const start = async () => {
    if (keys === "unverified") return
    setBusy(true)
    setError(undefined)
    const abort = new AbortController()
    attempt.current = abort
    try {
      const deps = await buildBackupAddDeps({
        wallet,
        owner: keys.owner,
        ...(option ? { choice: option.id } : {}),
      })
      await startBackupAdd(deps, abort.signal)
      onStarted()
    } catch (err) {
      if (abort.signal.aborted) return
      warnFailure("add failed", err)
      setError(errorLine(err))
    } finally {
      if (attempt.current === abort) attempt.current = undefined
      setBusy(false)
    }
  }

  const line =
    entry === "checking"
      ? entryCopy.checking
      : entry === "unreadable"
      ? entryCopy.unreadable
      : entry === "ready"
      ? undefined
      : entry.line
  const action = typeof entry === "object" ? entry.action : undefined
  const ready = entry === "ready" && !busy
  const deviceLine = device && windowsHelloBackupWarning(device)
  return (
    <section className="ww-contacts__section" data-testid="backup-entry">
      <span className="ww-contacts__label">Backup passkey</span>
      {sheet && option && entry === "ready" && (
        <>
          <p className="ww-passkeys__picker-label" id={pickerLabel}>
            {BACKUP_ADD_SHEET_COPY.pickerLabel}
          </p>
          <SignUpChoiceSelect
            options={sheet.options.map((o) => ({
              id: o.id,
              icon: BACKUP_ADD_ICONS[o.id],
              label: o.label,
              description: o.description,
            }))}
            selected={option.id}
            onChange={setPicked}
            labelledBy={pickerLabel}
            disabled={busy}
            testId="backup-add"
          />
          {(option.advice.length > 0 || option.keyWarning) && (
            <div className="ww-phone-steps__advice" data-testid="backup-add-advice">
              {option.advice.map((text) => (
                <StepsNote key={text}>{text}</StepsNote>
              ))}
              {option.keyWarning && <KeyWarningLine warning={option.keyWarning} />}
            </div>
          )}
        </>
      )}
      {entry === "ready" && (
        <p className="ww-sheet__note" data-testid="backup-add-ahead">
          {approveCopy.ahead}
        </p>
      )}
      <div className="ww-contacts__group">
        <button
          type="button"
          className={`zkm-btn-reset zkm-settings-row ww-passkeys__add${
            line ? " zkm-settings-row--described" : ""
          }`}
          disabled={!ready}
          onClick={() => void start()}
          data-testid="backup-add"
        >
          <span className="zkm-settings-row__leading">
            <IconCircle name="plus" />
          </span>
          <span className="zkm-settings-row__label">{entryCopy.row}</span>
          {line ? (
            <span className="zkm-settings-row__description" data-testid="backup-entry-line">
              {line}
            </span>
          ) : (
            <span className="zkm-row-spacer" />
          )}
          {ready && (
            <span className="zkm-settings-row__trailing">
              <RowChevron />
            </span>
          )}
        </button>
      </div>
      {((action && onAction) || entry === "unreadable") && (
        <div className="ww-passkeys__links">
          {action && onAction && (
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              onClick={() => onAction(action)}
              data-testid="backup-entry-action"
            >
              {actionLabel[action]}
            </button>
          )}
          {entry === "unreadable" && (
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              onClick={() => {
                allowance.refresh()
                chain.refresh()
              }}
              data-testid="backup-entry-retry"
            >
              {panelCopy.tryAgain}
            </button>
          )}
        </div>
      )}
      {deviceLine && (
        <p className="ww-sheet__note" data-testid="backup-windows10-line">
          {deviceLine}
        </p>
      )}
      {error && (
        <p className="ww-search__error" aria-live="assertive">
          {error}
        </p>
      )}
    </section>
  )
}

/** A key's name from the user, else its manager. */
const keyName = (row: Row, name?: string) => name || row.provider

/**
 * One installed passkey: named by the user, else by its manager, else by its role, which then
 * sits under the name. The pencil edits the name in place; Enter or the check saves it.
 */
function KeyRow({
  row,
  name,
  onRename,
}: {
  row: Row
  name?: string
  onRename: (name: string) => void
}) {
  const [draft, setDraft] = useState<string>()
  const icon = row.label === "Backup" ? "shield-check" : "key"
  const named = keyName(row, name)
  const description = named ? row.label : undefined
  if (draft !== undefined) {
    const save = () => {
      onRename(draft)
      setDraft(undefined)
    }
    return (
      <div
        className={`zkm-settings-row ww-passkeys__row${
          description ? " zkm-settings-row--described" : ""
        }`}
      >
        <span className="zkm-settings-row__leading">
          <IconCircle name={icon} />
        </span>
        <input
          className="zkm-settings-row__label ww-passkeys__name"
          aria-label="Passkey name"
          value={draft}
          maxLength={MAX_PASSKEY_NAME}
          placeholder={row.provider ?? row.label}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save()
            if (e.key === "Escape") setDraft(undefined)
          }}
          data-testid="passkey-name"
        />
        {description ? (
          <span className="zkm-settings-row__description">{description}</span>
        ) : (
          <span className="zkm-row-spacer" />
        )}
        <span className="zkm-settings-row__trailing">
          <GlassCircleButton
            size={32}
            ariaLabel="Save name"
            onClick={save}
            testId="passkey-name-save"
          >
            <Icon name="check" size={14} color="#fff" />
          </GlassCircleButton>
        </span>
      </div>
    )
  }
  return (
    <SettingsRow
      className="ww-passkeys__row"
      leading={<IconCircle name={icon} />}
      label={named ?? row.label}
      description={description}
      trailing={
        <span className="ww-passkeys__trailing">
          {row.signsHere && <StatusPill label="Signed in with" icon="check" />}
          <GlassCircleButton
            size={32}
            ariaLabel="Rename"
            onClick={() => setDraft(name ?? "")}
            testId="passkey-rename"
          >
            <Icon name="pencil" size={14} color="#fff" />
          </GlassCircleButton>
        </span>
      }
    />
  )
}

/** Stands in for the chain facts on an account not registered yet: that condition is named first. */
const UNREGISTERED_FACTS: EntryFacts = {
  routeLive: true,
  balance: 0n,
  fundingAmount: 0n,
  chunk: { kind: "fits" },
  plan: true,
  moves: 0,
  withdrawalInFlight: false,
  openLink: false,
  historicBalance: false,
}

/** The passkeys installed on the account, read from L1, with the one signing this session marked. */
export function PasskeysModal({
  onClose,
  onAction,
}: {
  onClose: () => void
  /** Where an entry condition sends the user. */
  onAction?: (action: EntryAction) => void
}) {
  const { contractService } = useContractServiceContext()
  const obsidionWallet = useResource(useSession().wallet)
  const [keys, setKeys] = useState<AccountKeys | "unreadable" | "unverified">()
  const [names, setNames] = useState(readPasskeyNames)
  const [reads, setReads] = useState(0)
  const pending = useBackupRotation(typeof keys === "object" ? keys.owner : undefined)
  // Any account's record stands in only once the key read has failed; while it is out, no record
  // is acted on, so another account's attempt is never advanced here.
  const record = keys !== undefined && pending && typeof pending === "object" ? pending : null
  const deps = useRef<{ owner: string; flow: BackupFlowDeps } | undefined>(undefined)
  const [depsReady, setDepsReady] = useState(false)
  const [depsFailed, setDepsFailed] = useState(false)
  const [depsRun, setDepsRun] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  // Closing the modal ends the add in flight wherever it is: the creation, the seal or the record
  // write. The entry itself comes and goes with the record, so it cannot own the attempt.
  const attempt = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => attempt.current?.abort(), [])

  useEffect(() => {
    if (!contractService || !obsidionWallet) {
      setKeys("unreadable")
      return
    }
    let cancelled = false
    readAccountKeys(obsidionWallet, contractService).then(
      (read) => {
        if (!cancelled) setKeys(read)
      },
      () => {
        if (!cancelled) setKeys("unreadable")
      },
    )
    return () => {
      cancelled = true
    }
  }, [contractService, obsidionWallet, reads])

  const sameOwner = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  // A saved record needs the flow's dependencies before the panel can act. They come from the
  // record and the session, so the panel stands whether or not the key list was read.
  useEffect(() => {
    if (!record || !obsidionWallet) return
    if (deps.current && sameOwner(deps.current.owner, record.owner)) return
    let stale = false
    setDepsFailed(false)
    buildBackupFlowDeps({
      wallet: obsidionWallet,
      owner: record.owner as Address,
      switchAccount: handOffAccount,
    }).then(
      (built) => {
        if (stale) return
        deps.current = { owner: record.owner, flow: built }
        setDepsReady(true)
      },
      (err) => {
        warnFailure("dependencies failed", err)
        if (!stale) setDepsFailed(true)
      },
    )
    return () => {
      stale = true
    }
  }, [record, obsidionWallet, depsRun])

  // A pending record shows whatever the account's key count is, and whether or not the keys could
  // be read, so it can always be finished or dropped. A new add starts only on a one-key account
  // whose saved records were read; an unregistered account gets the row with that condition named.
  const showEntry =
    backupPasskeySettingsEnabled &&
    obsidionWallet &&
    (keys === "unverified" || (typeof keys === "object" && keys.authKeyCount === 1)) &&
    pending === null
  const panelDeps =
    depsReady && record && deps.current && sameOwner(deps.current.owner, record.owner)
      ? deps.current.flow
      : undefined
  // The session's key signs the approval.
  const signer = typeof keys === "object" ? keys.rows.find((row) => row.signsHere) : undefined
  const approver = signer && keyName(signer, names[signer.pubkeyHex])

  return (
    <Modal variant="create" label="Passkeys" onClose={onClose} className="ww-feedback">
      <div className="ww-passkeys__head">
        <span className="ww-deposit__connect-icon">
          <Icon name="key" size={24} color="#fff" />
        </span>
        <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
          Passkeys
        </GradientText>
      </div>
      <div className="ww-addresses ww-passkeys">
        {keys === undefined && <p className="ww-sheet__note">Loading…</p>}
        {keys === "unreadable" && (
          <p className="ww-sheet__note">
            Couldn't read the account's keys.{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              onClick={() => {
                setKeys(undefined)
                setReads((n) => n + 1)
              }}
              data-testid="keys-retry"
            >
              {panelCopy.tryAgain}
            </button>
          </p>
        )}
        {keys === "unverified" && (
          <p className="ww-sheet__note">Keys appear once the account is registered.</p>
        )}
        {typeof keys === "object" && (
          <section className="ww-contacts__section">
            <span className="ww-contacts__label">Keys on the account</span>
            <div className="ww-contacts__group">
              {keys.rows.map((row) => (
                <KeyRow
                  key={row.pubkeyHex}
                  row={row}
                  name={names[row.pubkeyHex]}
                  onRename={(name) => setNames(savePasskeyName(row.pubkeyHex, name))}
                />
              ))}
            </div>
            {keys.authKeyCount > keys.rows.length && (
              <p className="ww-sheet__note">
                The account has {keys.authKeyCount} keys; this version shows {keys.rows.length}.
              </p>
            )}
          </section>
        )}
        {obsidionWallet && record && panelDeps && (
          <BackupPasskeyPanel
            record={record}
            deps={panelDeps}
            approver={approver}
            onCancelled={() => setCancelled(true)}
            onFinished={() => {
              setKeys(undefined)
              setReads((n) => n + 1)
            }}
          />
        )}
        {obsidionWallet && record && !panelDeps && (
          <p className="ww-sheet__note" aria-live="polite">
            {depsFailed ? (
              <>
                {entryCopy.unreadable}{" "}
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit__link"
                  onClick={() => setDepsRun((n) => n + 1)}
                  data-testid="backup-deps-retry"
                >
                  {panelCopy.tryAgain}
                </button>
              </>
            ) : (
              entryCopy.checking
            )}
          </p>
        )}
        {pending === "unreadable" && (
          <p className="ww-sheet__note" aria-live="polite">
            {entryCopy.unreadable}{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              onClick={rereadBackupRotation}
              data-testid="backup-store-retry"
            >
              {panelCopy.tryAgain}
            </button>
          </p>
        )}
        {cancelled && pending === null && (
          <p className="ww-sheet__note" data-testid="backup-cancelled">
            {panelCopy.cancelled} {panelCopy.leftoverPasskey}
          </p>
        )}
        {showEntry && (
          <BackupEntry
            keys={keys}
            wallet={obsidionWallet}
            contractService={contractService}
            attempt={attempt}
            onStarted={() => setCancelled(false)}
            onAction={onAction}
          />
        )}
      </div>
    </Modal>
  )
}
