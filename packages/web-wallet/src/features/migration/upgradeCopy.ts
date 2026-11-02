import type { MetadataMigrationPhase, MetadataMigrationRecord } from "@obsidion/front-core"
import type { WalletAction } from "../actionGate"
import type { SavingsAccount } from "../savings/AccountSwitcher"
import type { UpgradeStatus } from "./migrationDialog"
import { usd } from "../../ui/format"

/** Where a run stands, as the upgrade dialog says it. */
export const upgradePhaseLabel: Record<MetadataMigrationPhase, string> = {
  preparing: "Preparing your upgrade",
  broadcasting: "Sending your upgrade",
  awaitingMessages: "Updating your account",
  subscribing: "Setting up your account on the new version",
  recovering: "Sending your remaining funds",
  arriving: "Your funds are on their way",
  waiting: "Setting up your account on the new version",
  done: "Upgrade complete",
  needsAttention: "Your upgrade needs attention",
  needsApproval: "Your upgrade needs your approval",
}

/** Where a run stands: a waiting run says why, when it knows. */
export function upgradePhaseText(record: MetadataMigrationRecord): string {
  return (record.phase === "waiting" && record.waitReason) || upgradePhaseLabel[record.phase]
}

/** An upgrade run's name in activity, by the account it pays into. */
export const upgradeRunTitle: Record<SavingsAccount, string> = {
  main: "Main Account upgrade",
  savings: "Savings upgrade",
}

/** What stopped a run and what the user can do, in their terms; the cause itself goes to the console. */
export function upgradeStopText(record: MetadataMigrationRecord): string {
  if (record.phase === "needsApproval") return "Your upgrade needs another approval to continue."
  if (record.halt === "account")
    return "This upgrade no longer matches your wallet setup. Try again. If it still stops, report a bug in Settings."
  if (record.halt === "reverted")
    return "A transaction in your upgrade failed. Try again to check whether it can continue. If it keeps failing, report a bug in Settings."
  if (record.halt === "recipient")
    return "The address prepared for one of your transfers no longer matches, so that transfer was not sent. Try again to check whether it can continue. If it keeps failing, report a bug in Settings."
  if (record.stale)
    return published(record)
      ? "Your upgrade no longer matches what was prepared. Try again to check whether it can continue."
      : "Your upgrade plan is out of date. Continue to prepare it again; you may be asked to approve again."
  if (record.refused) return "The passkey request was closed or timed out. Continue to try again."
  return "Your upgrade couldn't finish a step. Continue to try again."
}

/** The dialog's button for a saved run: what continuing does next, counting the upgrade's `approvals`. */
export function continueLabel(
  record: MetadataMigrationRecord,
  approvals = record.approvals,
): string {
  if (record.phase === "needsAttention" && (record.halt || (record.stale && published(record))))
    return "Try again"
  if (approvals && approvals.approved < approvals.total)
    return `Continue approving (${approvals.approved + 1} of ${approvals.total})`
  if (record.phase === "needsApproval") return "Approve and continue"
  return "Continue upgrade"
}

/** A run that waits, recovers or arrives is carried on without the user. */
const REOPEN_PHASES: ReadonlySet<string> = new Set([
  "preparing",
  "broadcasting",
  "needsAttention",
  "needsApproval",
])

/**
 * The reopen screen for a stopped run (Figma S1 to S3): S2 once funds may have moved, S3 for a
 * stop the user may not clear by starting again, S1 otherwise.
 */
export function reopenScreen(
  record: MetadataMigrationRecord,
): "left" | "finish" | "error" | undefined {
  if (!REOPEN_PHASES.has(record.phase)) return undefined
  if (record.fundsSent) return "finish"
  if (record.halt || (record.phase === "needsAttention" && !record.refused && !record.stale))
    return "error"
  return "left"
}

/** S3's "What happened". */
export function upgradeStopReason(record: MetadataMigrationRecord): string {
  if (record.halt === "account") return "Your wallet setup changed"
  if (record.halt === "reverted") return "A transaction failed"
  if (record.halt === "recipient") return "A prepared address changed"
  return "A step could not finish"
}

/** Something was sent: a stale plan is kept, not prepared again. */
const published = (record: MetadataMigrationRecord) =>
  !!record.bootstrapTx || !!record.subscriptionTx

/** A recipient still on an old version, who can't be paid or asked until they upgrade. */
export const recipientNotUpgradedCopy = {
  title: (tag: string) => `@${tag} hasn't upgraded yet`,
  badge: "Not upgraded",
  searchSubtitle: "See your history. Send funds once they upgrade.",
  payHint: (tag: string) =>
    `@${tag} hasn't upgraded yet. You can send or request funds once they upgrade.`,
  chatHint:
    "You can still see your history together. You can send or request funds once they upgrade.",
  requestHint: (tag: string) =>
    `@${tag} hasn't upgraded yet. You can request funds once they upgrade.`,
  payPageHint: "They haven't upgraded yet. You can pay them once they upgrade.",
}

/** The sheet that offers the upgrade (Figma 12709:36185). */
export const offerCopy = {
  title: "Upgrade to a faster zk.money",
  lead: "Upgrade to send and receive faster. It takes about 40 minutes, and your balance stays safe.",
}

/** A migration operation's one line, from a decimal amount. */
export function migrationSummary(amount: string): string {
  return `${usd(Number(amount))} to the new version`
}

export const keepOpenCopy = {
  title: "Keep zk.money open",
  phone:
    "Don't close this app or browser, switch apps, or lock your phone until your funds are sent, usually a few minutes.",
  desktop: "Don't close this tab or browser until your funds are sent, usually a few minutes.",
}

/** The sheet when an action waits on the upgrade (Figma 12709:37036). */
export const actionUpgradeTitle: Record<WalletAction, string> = {
  send: "Upgrade to send",
  receive: "Upgrade to receive",
  deposit: "Upgrade to deposit",
  withdraw: "Upgrade to withdraw",
  link: "Upgrade to create a link",
  requests: "Upgrade to use Requests",
  savings: "Upgrade to use Savings",
  claim: "Upgrade to claim",
}

/** The claim prompt's line for an account that must upgrade before it claims. */
export const claimUpgradeLead = "Upgrade your account to claim these funds"

/** Under an action's title while the wallet checks whether the account must upgrade first. */
export const checkingLead = "Checking whether your account needs to upgrade first."

/** The dialog for an account whose registration is current here but not active yet. */
export const finishingCopy = {
  title: "Finish your upgrade",
  lead: "Your account is being set up on the new version. Sending and withdrawing open once it's ready, in a few minutes.",
}

/** The dialog over a run the wallet follows to the end by itself. */
export const followingLead = "Your funds are on their way. Nothing more is needed from you."

/** Home's banner for where the upgrade stands (Figma 12709:35478); none while there is nothing to say. */
export function upgradeBannerCopy(
  status: UpgradeStatus,
): { title: string; body?: string; cta?: string } | null {
  switch (status.state) {
    case "offered":
      // actionGate.ts blocks every action while an upgrade is offered.
      return {
        title: "Upgrade to keep using zk.money",
        body: "A better wallet with quicker transactions.",
        cta: "Upgrade now",
      }
    case "finishing":
      return { title: finishingCopy.title }
    case "running":
    case "stopped":
      // One title while it runs; only a stop the user must act on says why.
      return {
        title:
          status.phase === "needsApproval" || status.phase === "needsAttention"
            ? upgradePhaseLabel[status.phase]
            : "Processing your upgrade",
      }
    case "failed":
      return { title: "Couldn't check your old funds", body: "Tap to try again." }
    default:
      return null
  }
}
