import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  rotationDepositOrigin,
  SIPADepositStore,
  type BackupRotationRecord,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import type { PersistedRotation } from "@obsidion/sdk"
import type { Address } from "viem"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { broadcastLanded, getBroadcastLedger, oweRotationBroadcast } from "../broadcasts/broadcasts"

export interface RotationDepositInput {
  record: BackupRotationRecord
  l1ChainId: number
  /** The wallet's network, stamped on the deposit record. */
  networkId: string
  token: Address
  sipaFactory: Address
  /** The factory that predicts the account from its bootstrap key. */
  accountFactory: Address
}

/**
 * Writes the deposit address's rail record with the origin its recovery needs
 * (`rotationDepositOrigin`); the rail record keeps the salt. A record written without the origin
 * gains it, even after the attempt dropped its own salt.
 */
export async function seedRotationDeposit(input: RotationDepositInput): Promise<SIPADepositRecord> {
  const { plan, rotation } = input.record
  if (!rotation) throw new Error("nothing signed to publish")
  const origin = rotationDepositOrigin(rotation, input)
  const sipa = rotation.sipa
  const deposits = SIPADepositStore.get(webStorage)
  await deposits.load()
  const existing = deposits.get(sipa)
  if (existing?.origin) return existing
  if (existing) {
    return (
      (await deposits.update(sipa, (c) => (c.origin ? null : { phase: c.phase, origin }))) ??
      existing
    )
  }
  if (!plan || !rotation.sharedSecretSalt) throw new Error("nothing signed to publish")
  return deposits.upsert(
    sipa,
    { phase: "broadcast", origin },
    {
      recipientL2Address: plan.address,
      messageSecret: rotation.sharedSecretSalt,
      recipientHash: rotation.intent.recipientCommitment,
      recoveryAddress: "",
      l1ChainId: input.l1ChainId,
      networkId: input.networkId,
      amount: "0",
      tokenSymbol: WALLET_TOKEN_SYMBOL,
      startTime: Date.now(),
      tokenAddress: input.token,
      intent: "user-op",
    },
  )
}

/**
 * Publishes a rotation's deposit address: the rail's record for it, then its broadcast on the
 * ledger. Resolves once the broadcast landed, through however many attempts: the funding goes out
 * only after it. Rejects once the ledger drops the job.
 */
export async function publishRotationAddress(
  input: RotationDepositInput & { owner: Address; rotation: PersistedRotation },
): Promise<void> {
  const sipa = input.rotation.sipa
  await seedRotationDeposit(input)
  await oweRotationBroadcast(input.owner, sipa)
  await broadcastLanded(sipa.toLowerCase())
}

/**
 * Sends the deposit address's landed broadcast again, from the block `sinceBlock` reads, or owes a
 * fresh one when the ledger lost the job; the flow decides when. False while a send is already owed.
 */
export async function republishRotationAddress(
  owner: Address,
  record: BackupRotationRecord,
  sinceBlock: () => Promise<number>,
): Promise<boolean> {
  const sipa = record.rotation?.sipa.toLowerCase()
  if (!sipa) return false
  const ledger = getBroadcastLedger()
  await ledger.load()
  const job = ledger.get(sipa)
  if (!job) {
    await oweRotationBroadcast(owner, sipa, await sinceBlock())
    return true
  }
  if (job.state !== "landed") return false
  return ledger.republish(sipa, await sinceBlock())
}
