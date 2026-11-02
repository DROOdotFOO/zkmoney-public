import {
  fundingStarted,
  sealMasterKey,
  type BackupRotationRecord,
  type BackupRotationStore,
} from "@obsidion/front-core"
import {
  bytesToBase64Url,
  isPasskeyCancelled,
  type CeremonyObserver,
  type PasskeyCeremony,
} from "@obsidion/passkey-web"
import type { Address } from "viem"
import type { BackupAddTracker, BackupCreation } from "../../platform/auth/backupCreation"

/** What creating the backup passkey and saving the attempt needs. The rotation itself runs on the flow's deps. */
export interface BackupAddDeps {
  /** The L1 account the backup is installed on. */
  owner: Address
  /** A fresh copy of the master key, 32 bytes `Fr` big-endian; zeroed once sealed. */
  masterKey: () => Uint8Array
  create(
    ceremony: PasskeyCeremony,
    observe: CeremonyObserver,
    signal?: AbortSignal,
  ): Promise<BackupCreation>
  track: BackupAddTracker
  store: BackupRotationStore
  seal?: typeof sealMasterKey
  now?: () => number
  attemptId?: () => string
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

/** The store already holds an attempt for the account. The console shows the code, never the message. */
export class BackupStepError extends Error {
  constructor(readonly code: "pending", message: string) {
    super(`backup add: ${message}`)
    this.name = "BackupStepError"
  }
}

/**
 * The add failed after the passkey was created, so a passkey the account never lists stays on the
 * device. `cause` is what failed.
 */
export class LeftoverPasskeyError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "LeftoverPasskeyError"
  }
}

/** Whether the user closed the passkey prompt or let it time out. */
export function passkeyDeclined(error: unknown): boolean {
  try {
    return isPasskeyCancelled(error)
  } catch {
    // An error whose fields throw when read is still a failure.
    return false
  }
}

/**
 * Create the backup passkey, seal the master key under its PRF and save the attempt. One attempt
 * per account: a record already saved refuses the new one. The tracker's row settles on the saved
 * record: a refusal, a seal error, an abort or a failed write ends the attempt with nothing kept.
 */
export function startBackupAdd(
  deps: BackupAddDeps,
  signal?: AbortSignal,
): Promise<BackupRotationRecord> {
  return deps.track(async (ceremony, observe) => {
    const creation = await deps.create(ceremony, observe, signal)
    try {
      return await saveCreated(deps, creation, signal)
    } catch (err) {
      throw new LeftoverPasskeyError(err)
    }
  })
}

async function saveCreated(
  deps: BackupAddDeps,
  creation: BackupCreation,
  signal?: AbortSignal,
): Promise<BackupRotationRecord> {
  const { created } = creation
  let masterKey: Uint8Array | undefined
  let envelope: Uint8Array
  try {
    masterKey = deps.masterKey()
    envelope = await (deps.seal ?? sealMasterKey)({
      masterKey,
      prfOutput: creation.prfOutput,
      slot: creation.slot,
      account: deps.owner,
      credentialId: created.credentialId,
    })
  } finally {
    creation.prfOutput.fill(0)
    masterKey?.fill(0)
  }
  const at = deps.now?.() ?? Date.now()
  const record: BackupRotationRecord = {
    owner: deps.owner,
    attemptId: deps.attemptId?.() ?? crypto.randomUUID(),
    phase: "created",
    backup: {
      credentialId: created.credentialId,
      pubkeyHex: toHex(created.pubkey),
      envelopeHex: toHex(envelope),
      userHandle: bytesToBase64Url(created.userHandle),
      prfSlot: creation.slot,
      prfAaguid: created.aaguid,
      securityKey: creation.securityKey,
      transports: created.transports,
    },
    fundings: [],
    createdAt: at,
    updatedAt: at,
  }
  // The abort is read in the same step as the insert, so an add ended while the store was being
  // read saves nothing.
  const stored = await deps.store.update(deps.owner, (current) => {
    signal?.throwIfAborted()
    return current ? null : record
  })
  if (stored !== record) throw new BackupStepError("pending", "an attempt is already pending")
  // An add ended while its record was being written drops that record, as long as it is still
  // this attempt and nothing was sent for it.
  if (signal?.aborted) {
    await deps.store.removeIf(
      deps.owner,
      (c) => c.attemptId === record.attemptId && c.phase === "created" && !fundingStarted(c),
    )
    signal.throwIfAborted()
  }
  return record
}
