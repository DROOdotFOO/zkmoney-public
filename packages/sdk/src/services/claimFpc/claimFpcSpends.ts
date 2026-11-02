/**
 * The facts behind splitting a ClaimFPC allowance by what spent it. Every sponsored batch pops the
 * user's SubscriptionNote and writes a new one, so the notes this PXE holds, spent ones included,
 * name the txs that used the allowance. A SIPA broadcast also sends the user a `SIPA` event in the
 * same tx, which marks the batch as a deposit-address broadcast.
 */
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import type { NotesFilter } from "@aztec-labs/pxe/client/lazy"
import { NoteStatus, type NoteDao } from "@aztec-labs/stdlib/note"
import { OxideTokenContract } from "@obsidion/contracts"

import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"

/** One SubscriptionNote and the tx that wrote it. */
export interface ClaimFpcSubscriptionNote {
  txHash: string
  blockNumber: number
  uses: number
  /** Seconds. Every note of one allowance carries the same value. */
  refilledAt: bigint
}

/**
 * `user`'s SubscriptionNotes on `railId`, spent and unspent. Read through `PXE.debug.getNotes`, the
 * one note-preimage read `@aztec-labs/pxe` 5.2.0 exposes; the note layout is the wallet's own ClaimFPC
 * (`rail, uses, refilled_at`), and the slot comes from the artifact's storage layout.
 */
export async function readClaimFpcSubscriptionNotes(
  wallet: ObsidionWallet,
  fpcAddress: AztecAddress,
  fpcArtifact: ContractArtifact,
  user: AztecAddress,
  railId: number,
): Promise<ClaimFpcSubscriptionNote[]> {
  const slot = fpcArtifact.storageLayout.subscriptions?.slot
  if (!slot) throw new Error(`ClaimFPC artifact ${fpcArtifact.name} has no subscriptions storage`)
  const filter: NotesFilter = {
    contractAddress: fpcAddress,
    owner: user,
    storageSlot: slot,
    status: NoteStatus.ACTIVE_OR_NULLIFIED,
    scopes: [user],
  }
  const notes: NoteDao[] = await wallet.pxe.debug.getNotes(filter)
  return notes.flatMap((dao) => {
    const [rail, uses, refilledAt] = dao.note.items
    if (!rail || !uses || !refilledAt || Number(rail.toBigInt()) !== railId) return []
    return [
      {
        txHash: dao.txHash.toString(),
        blockNumber: Number(dao.l2BlockNumber),
        uses: Number(uses.toBigInt()),
        refilledAt: refilledAt.toBigInt(),
      },
    ]
  })
}

/** Txs from `fromBlock` on that sent `recipient` a `SIPA` event on `token`: its SIPA broadcasts. */
export async function readSipaBroadcastTxHashes(
  wallet: ObsidionWallet,
  token: AztecAddress,
  recipient: AztecAddress,
  fromBlock: number,
): Promise<Set<string>> {
  const events = await wallet.getPrivateEvents(OxideTokenContract.events.SIPA, {
    contractAddress: token,
    fromBlock: BlockNumber(fromBlock),
    scopes: [recipient],
  })
  return new Set(events.map(({ metadata }) => metadata.txHash.toString()))
}
