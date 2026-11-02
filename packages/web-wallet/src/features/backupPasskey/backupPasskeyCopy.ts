import {
  cancellable,
  fundingLanding,
  moveProgress,
  recoverable,
  type BackupRotationAttention,
  type BackupRotationRecord,
} from "@obsidion/front-core"

/** Whether a funding of the record's may still reach the deposit address. */
const landing = (record: BackupRotationRecord) => record.fundings.some(fundingLanding)

/** The five steps the panel lists, in order. */
export const rotationSteps = [
  "Create backup",
  "Approve with your current passkey",
  "Fund",
  "Waiting for the network",
  "Finishing",
] as const

/** Which step a saved record is on; `rotationSteps.length` once every step is done. */
export function stepIndex(record: BackupRotationRecord): number {
  switch (record.phase) {
    case "created":
      return 1
    case "signed":
      return 2
    case "published":
      return landing(record) ? 3 : 2
    case "funded":
    case "swept":
    case "installed":
      return 3
    case "rerooted":
    case "moved":
      return 4
    default:
      return rotationSteps.length
  }
}

/** The install waits on Ethereum finality, so the step says how long and that the tab can go. */
const finalityWait =
  "Ethereum has to finalize your funding before the key is installed, which can take up to 40 minutes. " +
  "You can close this tab and come back later to finish."

/** The line under the current step. */
export function stepDetail(record: BackupRotationRecord): string | undefined {
  switch (record.phase) {
    case "signed":
      return "Publishing your deposit address. You can close this tab."
    case "published":
      return landing(record) ? "Your funding is on its way." : undefined
    case "funded":
      return `Your funding is on its way. ${finalityWait}`
    case "swept":
    case "installed":
      return finalityWait
    case "rerooted":
    case "moved": {
      const moved = moveProgress(record)
      if (!moved)
        return record.phase === "rerooted" ? "Installing the key." : "Moving your balance."
      return moved.included < moved.total
        ? `Moving your balance (${moved.included} of ${moved.total}).`
        : "Moving your balance."
    }
    default:
      return undefined
  }
}

/** A line split around the approving passkey's name, which the panel sets in bold. */
export type NamedLine = readonly [before: string, name: string, after: string]

/**
 * The approval step. Only a key already on the account can sign the add, which in a session that
 * started it is the one it signed in with; `name` is that key as the key list names it.
 */
export const approveCopy = {
  ahead:
    "You'll use two passkeys: first save the new backup, then approve it with the passkey you signed in with.",
  button: (name?: string) => `Approve with ${name ?? "your current passkey"}`,
  detail: (name?: string): NamedLine =>
    name
      ? [
          "Use ",
          name,
          " (the one you signed in with). Only a passkey already on your account can add a new one.",
        ]
      : [
          "Use the passkey you signed in with. Only a passkey already on your account can add a new one.",
          "",
          "",
        ],
  declined: (name?: string): NamedLine =>
    name
      ? ["Use ", name, ", the passkey you signed in with. The new backup can't approve itself."]
      : ["Use the passkey you signed in with. The new backup can't approve itself.", "", ""],
}

/** The move: each chunk's send waits for a tap, then asks the passkey the account was built over. */
export const moveCopy = {
  line: (moved?: { included: number; total: number }) =>
    moved && moved.total > 1
      ? `Approve moving part ${moved.included + 1} of ${
          moved.total
        } of your balance to your new account.`
      : "Approve moving your balance to your new account.",
  /** Home's line while the move waits for the user. */
  home: "Your backup passkey is almost ready",
  homeDetail: "Approve moving your balance to finish.",
  resume: "Resume in Settings",
}

export const entryCopy = {
  row: "Add a backup passkey",
  checking: "Checking…",
  unreadable: "Could not check, try again",
}

/** Why a new paylink waits for the add: its escrow would refund only the account the add moves off. */
export const linkWaitsCopy = {
  title: "Finish adding your backup passkey",
  message:
    "A paylink made now couldn't be cancelled or reclaimed once your backup passkey is added. Finish adding it in Settings first.",
}

export const fundCopy = {
  destination: "Your new account",
  fees: "Fees",
  receive: "You'll receive",
  approvals: "Approvals",
  approvalsValue: (now: number, moves: number) => `${now} now, then ${moves} to move your balance`,
  takes: "Takes",
  takesValue: "Up to 40 minutes",
  afterSend: "Once sent, the funding cannot be cancelled. You can close this tab while it waits.",
  fund: "Fund and continue",
}

export const panelCopy = {
  approving: "Approving…",
  cancel: "Cancel",
  checkAgain: "Check again",
  tryAgain: "Try again",
  startOver: "Start over",
  done: "Done",
  doneLine:
    "Your backup passkey is ready. It opens this account on any device once that device signs in by tag.",
  cancelled: "Cancelled.",
  /** The passkey already saved on the device stays there; the account never lists it. */
  leftoverPasskey:
    "The backup passkey stays on your device but does not open this account. You can delete it from your passkey manager.",
  /** From `signed` on, the approval already given stays usable until the account next changes. */
  approvalStays: "The approval you gave stays usable until your account next changes.",
  conflict: "Your passkeys changed on another device. Start again from the current list.",
  unverifiable: "Could not check, try again",
  fundingOnItsWay: "Your funding is on its way.",
  notCancellable:
    "This attempt cannot be dropped: money may have reached its deposit address. Keep this browser.",
  routeNotLive: "Not available on this network yet",
  /** The device minted an id longer than a backup key can carry; no retry changes it. */
  credentialIdTooLong:
    "This passkey can't be a backup: its credential id is longer than the account can store. Cancel and use another passkey.",
  declined: "The passkey request was closed or timed out.",
}

/**
 * Where an attempt whose funding has to go back stands: held at the deposit address, sent back
 * and waiting for Ethereum to finalize it, or recovered. Undefined for every other attempt, which
 * keeps the step list.
 */
export type RecoveryState = "held" | "sent" | "recovered"

export function recoveryState(record: BackupRotationRecord): RecoveryState | undefined {
  if (record.phase === "recovered") return "recovered"
  if (!recoverable(record)) return undefined
  return record.recovery ? "sent" : "held"
}

/** The recovery card's copy. */
export const recoveryCopy = {
  title: "Backup not added",
  started: (when: string) => `Started ${when}`,
  extraTitle: "Extra funding held",
  extraSubtitle: "Backup passkey added",
  badge: { held: "Needs recovery", sent: "Recovering", recovered: "Recovered" },
  line: {
    held: "Adding this backup stopped. Your funding is safe at its deposit address.",
    damaged: "This attempt's record is damaged. Its funding is safe at the deposit address.",
    extra: "Funding arrived after your backup was added. It is safe at the deposit address.",
    sent: "Recovery sent. Ethereum finalizes it within about 20 minutes. You can close this window.",
    recovered: "Your funds were sent back. This backup was not added, so you can start a new one.",
  },
  funding: "Funding",
  depositAddress: "Deposit address",
  recovery: "Recovery",
  gas: "You'll need an Ethereum wallet with ETH for gas.",
  recover: "Recover funds",
  later: "Funding that reaches the address later can be recovered too.",
  checkAddress: "Check the address",
  nothingNew: "Nothing new at the deposit address.",
  nothingYet: "Nothing at the deposit address right now. This updates shortly.",
  done: "Done",
}

/**
 * What each attention state says and what the user can do about it from here. Once funded, only
 * the settlement can move the attempt on, so a funded state offers no action beyond running a
 * paused move again; dropping the attempt is offered only where the flow allows it. Funding held
 * at the deposit address (stranded, or damaged and not cancellable) shows on the recovery card.
 */
export function attentionCopy(
  reason: Exclude<BackupRotationAttention, "stranded">,
  record: BackupRotationRecord,
): { line: string; actions: ("checkAgain" | "retry" | "cancel" | "startOver")[] } {
  switch (reason) {
    case "route":
      return {
        line: "The network is not paying for this right now.",
        actions: landing(record)
          ? []
          : cancellable(record)
          ? ["checkAgain", "cancel"]
          : ["checkAgain"],
      }
    case "corrupt":
      return { line: "This attempt's record is damaged.", actions: ["startOver"] }
    case "move":
      return {
        line: "Part of your balance could not be moved yet. It stays yours on your previous account.",
        actions: ["retry"],
      }
    default:
      return unknownReason(reason)
  }
}

function unknownReason(reason: never): never {
  throw new Error(`backup add: unknown attention ${String(reason)}`)
}

/**
 * Where Home's line about the previous account stands: `unchecked` while this device's rotations
 * cannot be read, `refused` after a spend refusal, `stuck` once its retries ran out, `failed` after
 * any other failed move.
 */
export type PreviousAccountView =
  | "moving"
  | "move"
  | "resume"
  | "unchecked"
  | "backupSession"
  | "refused"
  | "stuck"
  | "failed"

export const previousAccountActions = {
  move: "Move them",
  resume: "Resume in Settings",
  retry: panelCopy.tryAgain,
}

/** What Home's line says about money at the previous account, `amount` as shown, and its action. */
export function previousAccountCopy(
  view: PreviousAccountView,
  amount: string,
): { line: string; detail?: string; action?: keyof typeof previousAccountActions } {
  const arrived = `${amount} arrived at your previous account`
  const left = `${amount} is still on your previous account`
  switch (view) {
    case "moving":
      return { line: "Moving your previous account's balance…" }
    case "move":
      return { line: arrived, action: "move" }
    case "resume":
      return {
        line: arrived,
        detail: "Your backup passkey is still being set up.",
        action: "resume",
      }
    case "unchecked":
      return { line: arrived }
    case "backupSession":
      return { line: arrived, detail: "Sign in with your first passkey to move them." }
    case "refused":
      return { line: left, detail: "It could not be moved in one go.", action: "retry" }
    case "stuck":
      return { line: left, detail: "It can't be moved from the wallet yet." }
    case "failed":
      return { line: arrived, detail: "Could not move them.", action: "retry" }
  }
}

/** Why sponsored spends wait while a rotation moves the balance: the move pays with the same note. */
export const balanceMovingCopy = {
  title: "Moving your balance",
  message:
    "Your balance is moving to your new account. Sending, withdrawing, Savings and payment links open again once the move finishes.",
}
