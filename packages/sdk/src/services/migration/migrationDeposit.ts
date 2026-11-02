import { EthAddress, type AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { FunctionCall } from "@aztec-labs/stdlib/abi"
import { isContractDeployed } from "@oxide/l1-contracts"
import { notifySipaRecipient, type SipaNotifier } from "@oxide/oxide-client/sipa_event_calls.js"
import { concat, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem"
import { computeStealthRecipientHash } from "../../oxide/token/contentHash.js"
import type { MetadataDestination } from "./metadataMigration.js"
import {
  assertSubsidySweepsSipa,
  buildSipaSweepBroadcasts,
  OxideSipaIntent,
  type SipaOperationBroadcaster,
} from "../sipa/sipaIntents.js"
import type { SelfResolvedSipa, SipaSelfResolver } from "../sipa/sipaSelfResolve.js"
import { MAX_NONCE } from "../sipa/sipaStealth.js"

/** What a migration needs to publish and receive SIPAs on its destination. */
export interface MigrationDestinationContext {
  client: PublicClient
  node: AztecNode
  destination: MetadataDestination
  selfResolver: SipaSelfResolver
  /** The destination token; it emits the SIPA event and stores the swept deposits. */
  token: SipaNotifier
  broadcaster: SipaOperationBroadcaster
  recipient: AztecAddress
  /** The OxideAccount that may recover a SIPA's balance. */
  recoveryAccount: Address
}

/**
 * A coordinate the plan persists. Its nonce sits between the resolver's, which count up from 0, and
 * self-resolution's, which count down from `MAX_NONCE - 1`, so it never shares a deposit address's secret.
 */
export function migrationSipaCoordinates(now = Date.now()): { day: number; nonce: number } {
  const [word] = crypto.getRandomValues(new Uint32Array(1))
  return { day: Math.floor(now / 86_400_000), nonce: MAX_NONCE / 4 + (word! % (MAX_NONCE / 2)) }
}

/** The ordinary DepositSIPA at `(day, nonce)` on the destination. */
export function resolveMigrationDeposit(
  c: MigrationDestinationContext,
  day: number,
  nonce: number,
): Promise<SelfResolvedSipa> {
  return c.selfResolver.resolveAddress({
    user: c.recipient,
    recoveryAccount: c.recoveryAccount,
    day,
    nonce,
    publicClient: c.client,
    sipaFactory: c.destination.factory,
    forwardingTable: c.destination.forwardingTable,
    rollupVersion: c.destination.rollupVersion,
  })
}

/**
 * The deposit commitment at `(day, nonce)` for a deposit straight into the destination portal, with no SIPA. It uses
 * the same stealth secret that {@link resolveMigrationDeposit} derives for the account, its recovery account and
 * `(day, nonce)`, and it is the recipient commitment of that DepositSIPA. It does not deploy, predict or announce a
 * SIPA, and it reads no chain.
 *
 * The destination's `MigrationExecutor` deposits a refund into the portal under this commitment. No SIPA event
 * announces that deposit: the deposit rail finds it in the portal's `Deposit` events by this commitment and claims it
 * on L2 with `sharedSecret` as the shared-secret salt. Use coordinates from {@link migrationSipaCoordinates}, and do
 * not use the same coordinates for a SIPA.
 */
export async function migrationDirectCommitment(
  c: Pick<MigrationDestinationContext, "selfResolver" | "recipient" | "recoveryAccount">,
  day: number,
  nonce: number,
): Promise<{ recipientCommitment: Hex; sharedSecret: bigint }> {
  const { messageSecret } = await c.selfResolver.resolve(
    c.recipient,
    day,
    nonce,
    EthAddress.fromString(c.recoveryAccount),
  )
  const sharedSecret = messageSecret.toBigInt()
  return {
    recipientCommitment: await computeStealthRecipientHash(sharedSecret, c.recipient),
    sharedSecret,
  }
}

/** The domain of a direct deposit's announcement marker. */
const DIRECT_ANNOUNCEMENT_DOMAIN = keccak256(toHex("oxide.direct-migration"))

/**
 * The `intentHash` of a direct deposit's announcement:
 * `keccak256(concat([keccak256(toHex("oxide.direct-migration")), c]))` for the 32-byte recipient
 * commitment `c`. It is domain-separated because the plain `keccak256(c)` is exactly the intent
 * hash of an ordinary DepositSIPA under `c` (`keccak256(abi.encode(bytes32 c))`), which a rail
 * classifies as a plain deposit. A rail that reads a `SIPA` event whose
 * `computeStealthRecipientHash(salt, recipient)` is `c` and whose intent hash is
 * `directAnnouncementIntentHash(c)` knows that the event announces a direct deposit under `c`.
 */
export function directAnnouncementIntentHash(recipientCommitment: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(recipientCommitment))
    throw new Error("A direct deposit commitment is 32 bytes")
  return keccak256(concat([DIRECT_ANNOUNCEMENT_DOMAIN, recipientCommitment]))
}

/**
 * The call that announces the direct deposit at `(day, nonce)` to the account on L2, so any device
 * of the account can find and claim it, not only the browser that sent it. It is the token's
 * ordinary `SIPA` event: the shared secret as its salt, not resweepable, and
 * {@link directAnnouncementIntentHash} as its intent hash. It rides the same L2 transaction as the
 * refund's broadcast. Throws when the coordinates no longer derive `recipientCommitment`.
 */
export async function migrationDirectAnnouncementCalls(
  c: Pick<MigrationDestinationContext, "selfResolver" | "recipient" | "recoveryAccount" | "token">,
  day: number,
  nonce: number,
  recipientCommitment: Hex,
): Promise<FunctionCall[]> {
  const derived = await migrationDirectCommitment(c, day, nonce)
  if (derived.recipientCommitment.toLowerCase() !== recipientCommitment.toLowerCase())
    throw new Error("The direct deposit commitment does not match its coordinates")
  const announcement = notifySipaRecipient(c.token, c.recipient, {
    sharedSecretSalt: new Fr(derived.sharedSecret),
    resweepable: false,
    intentHash: directAnnouncementIntentHash(derived.recipientCommitment),
  })
  return (await announcement.request()).calls
}

/** The calls that announce `resolved` to its recipient and broadcast its sweep. */
export async function migrationDepositCalls(
  c: MigrationDestinationContext,
  resolved: SelfResolvedSipa,
): Promise<FunctionCall[]> {
  const { sipaAddress: sipa, sipaArgs, intent, resolution } = resolved
  if ("recoveryAddress" in sipaArgs) {
    throw new Error("A migration deposit commits to the account's recovery commitment")
  }
  // The source withdraws the destination's own asset, so the SIPA is only ever funded with that token.
  const route = {
    token: c.destination.token,
    portal: c.destination.portal,
    depositSubsidy: c.destination.depositSubsidy,
  }
  const deployed = await isContractDeployed(c.client, sipa)
  if (!deployed) {
    await assertSubsidySweepsSipa(c.client, {
      routes: [route],
      sipaFactory: c.destination.factory,
      intent: OxideSipaIntent.Deposit,
      deployArgs: sipaArgs,
      intentData: intent.intentData,
      sipa,
    })
  }
  const interactions = buildSipaSweepBroadcasts(c.token, c.broadcaster, {
    recipient: c.recipient,
    sharedSecretSalt: resolution.messageSecret,
    resweepable: sipaArgs.resweepable,
    intentHash: intent.intentHash,
    sipa,
    deployed,
    sipaFactory: c.destination.factory,
    intent: OxideSipaIntent.Deposit,
    deployArgs: sipaArgs,
    intentData: intent.intentData,
    proofs: intent.proofs,
    operationExecutor: c.destination.operationExecutor,
    chainId: c.destination.chainId,
    routes: [route],
  })
  return (await Promise.all(interactions.map((call) => call.request()))).flatMap(
    (payload) => payload.calls,
  )
}
