/**
 * Feature switches read from the build environment. Each defaults to off and is turned on with the
 * string "true", the convention the other VITE_ flags follow.
 */

/**
 * Email-locked paylinks (`VITE_EMAIL_LOCKED_LINKS`). Off by default (QA standup, 2026-09-22): a sender
 * could lock a link to any address with no warning that the claim needs a Google account for exactly
 * that address, and the proof cache mis-reported a good sign-in as a mismatch. Off hides the "Protect
 * payment" option, and `sponsoredPaylink.ts` refuses an email lock at creation and an email link at
 * decode. Before turning it on, move the Google sign-in hand-off in `googleAuth.tsx` off storage:
 * its callback popup would stop at the already-open screen (see that file).
 */
export const emailLockedLinksEnabled = import.meta.env.VITE_EMAIL_LOCKED_LINKS === "true"

/**
 * The sdk's `[Perf][ProveTx]` console line per transaction (`VITE_PROVE_TX_PERF_LOGS`): request
 * build, simulation, app and kernel witness, proof and total times, for reading a device's proving
 * from its console. Off by default.
 */
export const proveTxPerfLogsEnabled = import.meta.env.VITE_PROVE_TX_PERF_LOGS === "true"

/**
 * Short links on the zk.money apex (`VITE_ZK_MONEY_LINK_HOST`): `zk.money/p#…` and
 * `zk.money/r#…`. Off until the apex routes those paths to the wallet; off, short links use
 * this deploy's own origin.
 */
export const zkMoneyLinkHostEnabled = import.meta.env.VITE_ZK_MONEY_LINK_HOST === "true"

/**
 * Lets a user start adding a backup passkey from the Passkeys sheet in settings
 * (`VITE_BACKUP_PASSKEY_SETTINGS`). Off by default. The rotation signs a real L1 user operation,
 * moves the balance and re-roots the wallet. It must stay off until it takes turns with the
 * upgrade's record update, which uses the same nonce. Off hides only the "Add a backup passkey"
 * row; a rotation already saved still shows and runs to the end.
 */
export const backupPasskeySettingsEnabled = import.meta.env.VITE_BACKUP_PASSKEY_SETTINGS === "true"
