import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { FrozenDepositDescriptor, SourceSavingsMove } from "@obsidion/core/types"
import { chunkedContractEvents } from "@obsidion/sdk"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import type { Address, GetContractEventsReturnType, Hex, PublicClient } from "viem"
import { readSkyFactoryPortals } from "../core/services/savings/savingsDeployment"
import { deriveSkyEscrowSalts, type FieldLike } from "./oxideAccountKeys"
import { logger } from "../utils/logger"

/** Find Savings deposits from verified withdrawal memos, without device-local move records. */
export async function refundableSavingsDeposits(o: {
  publicClient: PublicClient
  portal: Address
  recipient: string
  masterSecret: FieldLike
  moves: readonly SourceSavingsMove[]
  fromBlock: bigint
  head: bigint
  /** A move whose commitment this secret and recipient do not reproduce. It is skipped. */
  onUnverified?: (move: SourceSavingsMove) => void
}): Promise<FrozenDepositDescriptor[]> {
  const factories = new Map<string, ReturnType<typeof readSkyFactoryPortals>>()
  const descriptors = new Map<string, FrozenDepositDescriptor>()
  for (const move of o.moves) {
    let portals = factories.get(move.factory.toLowerCase())
    if (!portals) {
      portals = readSkyFactoryPortals(o.publicClient, move.factory as Address)
      factories.set(move.factory.toLowerCase(), portals)
    }
    const factory = await portals
    const destination = move.direction === "in" ? factory.sUsdsPortal : factory.daiPortal
    if (destination.toLowerCase() !== o.portal.toLowerCase()) continue
    const salt = deriveSkyEscrowSalts(o.masterSecret, move.nonce as Hex).recipient
    const commitment = await computeRecipientCommitment(
      salt,
      AztecAddress.fromStringUnsafe(o.recipient),
    )
    if (commitment.toString().toLowerCase() !== move.recipientCommitment.toLowerCase()) {
      logger.warn(
        `[migration] Savings move commitment mismatch: nonce ${move.nonce}, memo ${
          move.recipientCommitment
        }, derived ${commitment.toString()}, recipient ${o.recipient}`,
      )
      o.onUnverified?.(move)
      continue
    }
    const logs = (await chunkedContractEvents(
      o.publicClient,
      {
        address: o.portal,
        abi: OxidePortalAbi,
        eventName: "Deposit",
        args: { recipientCommitment: move.recipientCommitment as Hex },
      },
      o.fromBlock,
      o.head,
    )) as GetContractEventsReturnType<typeof OxidePortalAbi, "Deposit">
    for (const log of logs) {
      const { key, index, amount } = log.args
      if (log.removed) continue
      if (
        key === undefined ||
        index === undefined ||
        amount === undefined ||
        log.blockNumber === null
      )
        throw new Error("The Savings deposit has incomplete refund inputs")
      descriptors.set(key, {
        messageKey: key,
        messageLeafIndex: index.toString(),
        l1BlockNumber: log.blockNumber.toString(),
        sharedSecretSalt: salt.toString(),
        amount: amount.toString(),
      })
    }
  }
  return [...descriptors.values()]
}
