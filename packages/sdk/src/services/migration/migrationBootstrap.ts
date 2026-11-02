import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import type { BlockParameter } from "@aztec-labs/stdlib/block"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import type { FunctionCall } from "@aztec-labs/stdlib/abi"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { broadcastL1Operation } from "@oxide/oxide-client/broadcaster_calls.js"
import { encodeL1OperationCalldata } from "@oxide/oxide-lib/l1_operation_calldata.js"
import type { Address } from "viem"
import {
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
} from "../../feePaymentMethod/claimFpc/claimSponsoredCall.js"
import { claimFpcSponsoredFee } from "../../feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import type { PreparedRecordUpdate } from "./metadataMigration.js"
import type { SipaOperationBroadcaster } from "../sipa/sipaIntents.js"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import { hasClaimFpcSubscription } from "../claimFpc/claimSponsor.js"

type SubscribeOptions = Parameters<typeof buildClaimSubscribePayload>[0]

export type MigrationSponsorship =
  | { kind: "bootstrap"; gate: SubscribeOptions["gate"] }
  | { kind: "registered" }

/** Whether ClaimFPC's one-per-identity `subscribe` nullifier for `identity` on `railId` is spent as of `block`. */
async function claimFpcSubscriptionSpent(
  node: Pick<AztecNode, "findLeavesIndexes">,
  fpc: SubscribeOptions["fpcAddress"],
  identity: Fr,
  railId: number,
  block: BlockParameter,
): Promise<boolean> {
  const inner = await poseidon2HashWithSeparator([identity, new Fr(railId)], 1236)
  const [leaf] = await node.findLeavesIndexes(block, MerkleTreeId.NULLIFIER_TREE, [
    await siloNullifier(fpc, inner),
  ])
  return leaf !== undefined
}

/** Matches this wallet's ClaimFPC gate.nr and subscribe. Identity is L1 owner, independent of L2 address. */
export function claimFpcIdentitySubscribed(
  node: Pick<AztecNode, "findLeavesIndexes">,
  fpc: SubscribeOptions["fpcAddress"],
  owner: Address,
  railId: number,
): Promise<boolean> {
  return claimFpcSubscriptionSpent(node, fpc, new Fr(BigInt(owner)), railId, "latest")
}

/**
 * Whether a bootstrap key subscribed on a registration-gated rail as of `block`, whichever flow or device sent it. The
 * identity is bootstrap_key.nr's `bootstrap_key_identity`, over the key witness's two 16-byte halves.
 */
export async function claimFpcRegistrationSubscribed(
  node: Pick<AztecNode, "findLeavesIndexes">,
  fpc: SubscribeOptions["fpcAddress"],
  keyWitness: Uint8Array,
  railId: number,
  block: BlockParameter = "latest",
): Promise<boolean> {
  const half = (bytes: Uint8Array) => new Fr(BigInt(`0x${Buffer.from(bytes).toString("hex")}`))
  const identity = await poseidon2HashWithSeparator(
    [half(keyWitness.subarray(0, 16)), half(keyWitness.subarray(16, 32))],
    1241,
  )
  return claimFpcSubscriptionSpent(node, fpc, identity, railId, block)
}

export interface MigrationBootstrapOptions {
  wallet: ObsidionWallet
  recordUpdate: PreparedRecordUpdate
  /** The destination L2 broadcaster the relayer reads L1 operations from. */
  broadcaster: SipaOperationBroadcaster
  setupCalls?: FunctionCall[]
  sponsorship: MigrationSponsorship
  fpc: Omit<SubscribeOptions, "innerCalls" | "gate">
}

export interface PreparedMigrationBootstrap {
  payload: ExecutionPayload
  innerCalls: FunctionCall[]
  sendOptions: {
    from: typeof NO_FROM
    sendMessagesAs: SubscribeOptions["user"]
    additionalScopes: SubscribeOptions["user"][]
    fee: ReturnType<typeof claimFpcSponsoredFee>
  }
  metrics: {
    topLevelCalls: number
    recordBytes: number
    recordMethod: string
  }
}

/**
 * Prepare the sponsored transaction that broadcasts the record update. This function never sends
 * or consumes the allowance.
 */
export async function prepareMigrationBootstrap(
  args: MigrationBootstrapOptions,
): Promise<PreparedMigrationBootstrap> {
  if (args.sponsorship.kind === "bootstrap" && args.sponsorship.gate.kind !== "nameClaim") {
    throw new Error("Bootstrap migration requires the NameClaim registration-broadcast rail")
  }
  const { recordUpdate, fpc } = args
  const { update } = recordUpdate
  if (args.sponsorship.kind === "bootstrap") {
    if (
      await claimFpcIdentitySubscribed(args.wallet.node, fpc.fpcAddress, update.owner, fpc.railId)
    ) {
      throw new Error(
        "The registration-broadcast allowance is already spent for this identity and FPC",
      )
    }
  } else if (
    !(await hasClaimFpcSubscription(
      args.wallet,
      fpc.fpcAddress,
      fpc.fpcArtifact,
      fpc.user,
      fpc.railId,
    ))
  ) {
    throw new Error("The destination account has no registered sponsorship subscription")
  }
  if (update.record.l2Address.toLowerCase() !== fpc.user.toString().toLowerCase()) {
    throw new Error("The record update and the sponsored account must name the same account")
  }
  if (BigInt(update.namePortalRecipient) !== fpc.fpcAddress.toBigInt()) {
    throw new Error("The record update notifies a different destination FPC")
  }
  const innerCalls = [
    ...(args.setupCalls ?? []),
    ...(await broadcastL1Operation(args.broadcaster, recordUpdate.operation).request()).calls,
  ]
  const tier = encodeL1OperationCalldata(recordUpdate.operation.calldata)
  const payload =
    args.sponsorship.kind === "bootstrap"
      ? await buildClaimSubscribePayload({ ...fpc, innerCalls, gate: args.sponsorship.gate })
      : await buildClaimSponsorPayload({ ...fpc, innerCalls })
  return {
    payload,
    innerCalls,
    sendOptions: {
      from: NO_FROM,
      sendMessagesAs: fpc.user,
      additionalScopes: [fpc.user],
      fee: claimFpcSponsoredFee(fpc.policy, innerCalls),
    },
    metrics: {
      topLevelCalls: innerCalls.length,
      recordBytes: tier.bytesLen,
      recordMethod: tier.tier.method,
    },
  }
}
