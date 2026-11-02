/**
 * Direct migration deposits: an upgrade's migration executor deposits a refund straight into the
 * destination portal under a recipient commitment, with no SIPA. No SIPA event announces it, so the
 * rail cannot learn of it from L2. Each sent direct batch therefore gets a deposit record before
 * its deposit lands, as an address this wallet handed out does. The rail reads L1 for every tracked
 * SIPA on a fixed budget of requests, and the record's commitment joins that read: the rail sees
 * the deposit, then claims it like any other sweep. The record keeps the batch's amount: the
 * commitment is public, so the rail reads it until it has claimed that amount in total, and a
 * smaller deposit from another sender does not end the read.
 */

import { Fr } from "@aztec-labs/aztec.js/fields"
import type { MigrationDirectDeposit } from "@obsidion/core/types"
import type { Address, Hex } from "viem"
import { directDepositKey, type SIPADepositStore } from "../core/services/deposits/SIPADepositStore"
import type { UpgradeBatchItem } from "../core/migration/upgradeActivity"
import { logger } from "../utils/logger"
import { sipaRowByPortal, type SipaRow } from "./sipaRows"

type DirectBatch = Pick<UpgradeBatchItem, "run" | "direct" | "fromBlock" | "amount">

export interface DirectMigrationDepositDeps {
  store: Pick<SIPADepositStore, "load" | "get" | "create" | "update">
  /** The sent direct batches (`UpgradeActivity.directBatches`). */
  batches(): Promise<readonly DirectBatch[]>
  /** The rail's rows: a direct deposit is claimed on the row of the portal it lands in. */
  rows: readonly SipaRow[]
  /** The destination portal the batch's run moves into, as its run saved it. */
  destinationPortal(batch: DirectBatch): Address | undefined
  /** The recipient account the rail claims for. */
  recipient: string
  l1ChainId: number
  /** The network the rail claims on, which the deposit lands in. */
  networkId: string
  /** The commitment and shared secret at the batch's `(day, nonce)` (`migrationDirectCommitment`). */
  secret(
    direct: MigrationDirectDeposit,
  ): Promise<{ recipientCommitment: Hex; sharedSecret: bigint }>
}

/**
 * Writes a deposit record for each sent direct batch that has none, and gives the batch's amount
 * to a record that has no amount yet (one written from the deposit's announcement). It reads no
 * chain. Returns how many records it created. A batch that fails is logged and tried again on the
 * next pass.
 */
export async function ensureDirectMigrationDepositRecords(
  deps: DirectMigrationDepositDeps,
): Promise<number> {
  await deps.store.load()
  let written = 0
  for (const batch of await deps.batches()) {
    const direct = batch.direct
    if (!direct) continue
    const key = directDepositKey(direct.recipientCommitment)
    const existing = deps.store.get(key)
    try {
      if (!existing) {
        if (await ensure(deps, batch, direct)) written += 1
      } else if (existing.direct && existing.direct.expected === undefined) {
        await deps.store.update(key, (current) =>
          current.direct && current.direct.expected === undefined
            ? {
                phase: current.phase,
                reorgEpoch: current.reorgEpoch,
                direct: { ...current.direct, expected: batch.amount },
              }
            : null,
        )
      }
    } catch (err) {
      logger.warn(
        `[directMigrationDeposits] ${direct.recipientCommitment} not recorded (will retry next sync):`,
        err,
      )
    }
  }
  return written
}

async function ensure(
  deps: DirectMigrationDepositDeps,
  batch: DirectBatch,
  direct: MigrationDirectDeposit,
): Promise<boolean> {
  const commitment = direct.recipientCommitment.toLowerCase() as Hex
  const portal = deps.destinationPortal(batch)
  const row = portal && sipaRowByPortal(deps.rows, portal)
  if (!row) throw new Error(`no rail row for the destination portal ${portal}`)
  const { recipientCommitment, sharedSecret } = await deps.secret(direct)
  if (recipientCommitment.toLowerCase() !== commitment)
    throw new Error("the batch's commitment does not derive from its coordinates")
  const from = BigInt(batch.fromBlock ?? 0).toString()
  // An address handed out and not yet paid: the rail's first sight of the deposit fills the rest.
  const created = await deps.store.create(directDepositKey(commitment), {
    phase: "broadcast",
    recipientL2Address: deps.recipient,
    messageSecret: new Fr(sharedSecret).toString(),
    recipientHash: commitment,
    recoveryAddress: "",
    l1ChainId: deps.l1ChainId,
    networkId: deps.networkId,
    amount: "0",
    tokenSymbol: row.token.symbol,
    tokenAddress: row.token.address,
    tokenDecimals: row.token.decimals,
    startTime: Date.now(),
    direct: { recipientCommitment: commitment, executor: direct.executor, expected: batch.amount },
    fee: "0",
    // The rail reads the commitment's deposits from the batch's block on.
    observedFrom: from,
    rescanFrom: from,
  })
  return !!created
}
