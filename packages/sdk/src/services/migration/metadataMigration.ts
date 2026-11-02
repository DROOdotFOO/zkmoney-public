import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import {
  CANONICAL_ENTRY_POINT_V08,
  depositPayoutTokenFor,
  encodeExecuteBatch,
  encodeSetUserRecord,
  encodeUserRecordMetadata,
  getAccountNonce,
  getUserOpHash,
  OxidePortalContract,
  readAccountMetadataRegistry,
  readMetadataStateHash,
  readNameOf,
  readRegistrationController,
  userRecordStateHash,
  type R1PublicKeyArg,
  type UserRecordArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import {
  buildRecordUpdate,
  buildRecordUpdateOperation,
  recordUpdateCalls,
  type RecordUpdate,
} from "@oxide/oxide-client/record_update.js"
import type { BroadcastL1Operation } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"

export interface MetadataDestination {
  chainId: bigint
  rollupVersion: bigint
  nameRegistry: Address
  metadataRegistry: Address
  controller: Address
  factory: Address
  /** Routes the SIPA's sweeps; its rows must name `portal`. */
  forwardingTable: Address
  portal: Address
  namePortal: Address
  /** The fee token: the portal's underlying, which the SIPA is funded and swept in. */
  token: Address
  depositSubsidy: Address
  operationExecutor: Address
}

/**
 * The saved plan no longer matches the chain: its consent, routing or source batch is out of date.
 * Only this error lets the durable flow discard the plan and prepare again; any other failure keeps
 * it, so a retry reuses its saved approvals.
 */
export class StalePlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StalePlanError"
  }
}

/**
 * Why a retry soon repeats a stop: another account or deployment is in use, a sent transaction
 * reverted, or a saved transfer's deposit address no longer resolves to the one approved.
 */
export type MigrationHalt = "account" | "reverted" | "recipient"

/** A stop a blind retry repeats, so the durable flow stops for the user at once. */
export class MigrationHaltedError extends Error {
  constructor(readonly halt: MigrationHalt, message: string) {
    super(message)
    this.name = "MigrationHaltedError"
  }
}

/**
 * A step needs an approval it has not been given, outside a user's own action. The durable flow
 * stops for one press instead of prompting from a background pass.
 */
export class ApprovalNeededError extends Error {
  constructor(message = "This upgrade needs your approval to continue") {
    super(message)
    this.name = "ApprovalNeededError"
  }
}

/** An approval pass stopped a build once its approval was saved, before its proof. */
export class ApprovalSavedError extends Error {
  constructor() {
    super("The approval is saved; the proof is built later")
    this.name = "ApprovalSavedError"
  }
}

function address(value: string | undefined, field: string): Address {
  if (!value || !/^0x[0-9a-f]{40}$/i.test(value) || value.toLowerCase() === zeroAddress) {
    throw new Error(`Metadata migration requires ${field} in the destination manifest`)
  }
  return value as Address
}

/** The fee token's bridge as every sweep on its row sees it. */
export function bridgeDestination(tuple: OxideEnvTuple): MetadataDestination {
  if (!tuple.chainId || !tuple.rollupVersion)
    throw new Error("Destination chain identity is missing")
  const token = bridgeUnderlying(tuple)
  if (tuple.feeToken && !same(tuple.feeToken, token)) {
    throw new Error(
      `Metadata updates settle on the fee token ${tuple.feeToken}; the destination bridge holds ${token}`,
    )
  }
  return {
    chainId: BigInt(tuple.chainId),
    rollupVersion: BigInt(tuple.rollupVersion),
    nameRegistry: address(tuple.registry, "nameRegistry"),
    metadataRegistry: address(tuple.accountMetadataRegistry, "accountMetadataRegistry"),
    controller: address(tuple.registrationController, "registrationController"),
    factory: address(tuple.sipaFactory, "sipaFactory"),
    forwardingTable: address(tuple.forwardingTable, "forwardingTable"),
    portal: address(tuple.portal, "portal"),
    namePortal: address(tuple.namePortal, "namePortal"),
    token: address(token, "underlying"),
    depositSubsidy: address(tuple.depositSubsidy, "depositSubsidy"),
    operationExecutor: address(tuple.operationExecutor, "operationExecutor"),
  }
}

/** The tuple with the settlement token read off the portal. */
async function withPortalToken(client: PublicClient, tuple: OxideEnvTuple): Promise<OxideEnvTuple> {
  const portal = address(tuple.portal, "portal")
  const token = await new OxidePortalContract(client as never, portal).getUnderlying()
  return { ...tuple, token: token.toString() }
}

/** Read the settlement token from the portal before preparing its migration sweeps. */
export async function readBridgeDestination(
  client: PublicClient,
  tuple: OxideEnvTuple,
): Promise<MetadataDestination> {
  return bridgeDestination(await withPortalToken(client, tuple))
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function readMetadataDestinationState(
  client: PublicClient,
  destination: MetadataDestination,
  owner: Address,
): Promise<Hex> {
  const [chainId, registry, controller, name] = await Promise.all([
    client.getChainId(),
    readAccountMetadataRegistry(client, destination.nameRegistry),
    readRegistrationController(client, destination.nameRegistry),
    readNameOf(client, destination.nameRegistry, owner),
  ])
  if (BigInt(chainId) !== destination.chainId) throw new Error("Destination L1 chain changed")
  if (!same(registry, destination.metadataRegistry) || !same(controller, destination.controller)) {
    throw new StalePlanError(
      "Destination metadata registry or controller changed; prepare migration again",
    )
  }
  if (name === zeroHash) throw new Error("Metadata migration requires an existing registered name")
  return readMetadataStateHash(client, controller, owner)
}

/** The account's signed record update, with the state it was approved over. */
export interface PreparedRecordUpdate {
  update: RecordUpdate
  expectedStateHash: Hex
  assertion: WebAuthnAuthArg
  /** The L1 operation the bootstrap broadcasts; building it simulated the signed update. */
  operation: BroadcastL1Operation
}

export interface RecordUpdateContext {
  client: PublicClient
  destination: MetadataDestination
  owner: Address
  record: UserRecordArg
  /** The destination ClaimFPC: the name notification opens its registered rail. */
  fpc: AztecAddress
}

/**
 * Read the record's current state, build the account's zero-fee record update and have its
 * passkey sign it. An approval holds only over the state it was given for.
 */
export async function prepareRecordUpdate(
  args: RecordUpdateContext & {
    passkey: R1PublicKeyArg
    sign(userOpHash: Hex, expectedStateHash: Hex): Promise<WebAuthnAuthArg>
  },
): Promise<PreparedRecordUpdate> {
  const { client, destination, owner, record } = args
  if (record.rollupVersion !== destination.rollupVersion) {
    throw new Error("Destination metadata and deposit rollup disagree")
  }
  const expectedStateHash = await readMetadataDestinationState(client, destination, owner)
  const update = await buildRecordUpdate(client, {
    owner,
    metadataRegistry: destination.metadataRegistry,
    namePortal: destination.namePortal,
    namePortalRecipient: args.fpc,
    rollupVersion: destination.rollupVersion,
    record,
    passkey: args.passkey,
  })
  const assertion = await args.sign(update.userOpHash, expectedStateHash)
  return checkRecordUpdate(client, destination, { update, expectedStateHash, assertion })
}

/**
 * Before each publication: the record and the account's nonce are as approved, and the signed
 * update still runs. A change while unpublished is a stale plan.
 */
export async function checkRecordUpdate(
  client: PublicClient,
  destination: MetadataDestination,
  signed: Omit<PreparedRecordUpdate, "operation">,
): Promise<PreparedRecordUpdate> {
  const { update, expectedStateHash } = signed
  const [state, nonce] = await Promise.all([
    readMetadataDestinationState(client, destination, update.owner),
    getAccountNonce(client, CANONICAL_ENTRY_POINT_V08, update.owner),
  ])
  if (!same(state, expectedStateHash))
    throw new StalePlanError("The account's record changed; prepare the upgrade again")
  if (nonce !== update.userOp.nonce)
    throw new StalePlanError("The account sent another operation; prepare the upgrade again")
  const operation = await buildRecordUpdateOperation(client, update, signed.assertion, {
    target: CANONICAL_ENTRY_POINT_V08,
    payoutToken: depositPayoutTokenFor(
      destination.chainId,
      EthAddress.fromString(destination.token),
    ).toString() as Address,
  })
  return { ...signed, operation }
}

const bigintJson = (_: string, value: unknown) =>
  typeof value === "bigint" ? { bigint: value.toString() } : value
const bigintRevive = (_: string, value: unknown) =>
  value && typeof value === "object" && "bigint" in value && Object.keys(value).length === 1
    ? BigInt((value as { bigint: string }).bigint)
    : value

export function serializeRecordUpdate({
  update,
  expectedStateHash,
  assertion,
}: Omit<PreparedRecordUpdate, "operation">): string {
  return JSON.stringify({ update, expectedStateHash, assertion }, bigintJson)
}

/**
 * A saved record update, re-derived from the trusted context: saved calldata never chooses the
 * registry, record, recipient or fees. Any difference is a stale plan.
 */
export async function restoreRecordUpdate(
  raw: string,
  context: RecordUpdateContext,
): Promise<Omit<PreparedRecordUpdate, "operation">> {
  const signed = JSON.parse(raw, bigintRevive) as Omit<PreparedRecordUpdate, "operation">
  const { update } = signed
  const { client, destination, owner, record } = context
  const writeData = encodeSetUserRecord(owner, record)
  const namePortalRecipient = context.fpc.toString() as Hex
  const op = update.userOp
  const zero32 = `0x${"0".repeat(64)}`
  const expected =
    same(update.owner, owner) &&
    same(op.sender, owner) &&
    same(update.nameRegistry, destination.nameRegistry) &&
    same(update.metadataRegistry, destination.metadataRegistry) &&
    same(update.namePortal, destination.namePortal) &&
    BigInt(update.namePortalRecipient) === BigInt(namePortalRecipient) &&
    update.rollupVersion === destination.rollupVersion &&
    same(encodeUserRecordMetadata(update.record), encodeUserRecordMetadata(record)) &&
    same(update.write.data, writeData) &&
    same(update.write.stateHash, userRecordStateHash(record)) &&
    op.initCode === "0x" &&
    op.paymasterAndData === "0x" &&
    op.preVerificationGas === 0n &&
    same(op.gasFees, zero32) &&
    same(
      op.callData,
      encodeExecuteBatch(
        recordUpdateCalls({
          owner,
          metadataRegistry: destination.metadataRegistry,
          writeData,
          namePortal: destination.namePortal,
          namePortalRecipient,
          rollupVersion: destination.rollupVersion,
        }),
      ),
    )
  if (!expected) throw new StalePlanError("Stored record update does not match the destination")
  if (!same(await getUserOpHash(client, CANONICAL_ENTRY_POINT_V08, op), update.userOpHash))
    throw new StalePlanError("Stored record update does not match its hash")
  return signed
}
