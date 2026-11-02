import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Network } from "@obsidion/core/constants"
import {
  MetadataMigrationService,
  readBridgeDestination,
  metadataMigrationContext,
  readNameClaimLog,
  recordNamesOtherAccount,
  SipaSelfResolver,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
  type MetadataMigrationServiceOptions,
  type MetadataMigrationSource,
  type RefundChallengeSigner,
} from "@obsidion/sdk"
import { OxidePortalContract, type R1PublicKeyArg } from "@oxide/l1-contracts"
import { toBytes, toHex, type Address, type Hex, type PublicClient } from "viem"
import { deriveBootstrapKey, selfSipaResolverKeys } from "../../oxide/oxideAccountKeys"
import { toWebAuthnAuthArg, type PasskeySignResult } from "../../oxide/oxideWebAuthn"
import {
  metadataMigrationBinding,
  registrationKeyProof,
} from "../../oxide/metadataMigrationBinding"
import { readResolverOperatorRecords } from "../../oxide/resolverOperatorRecords"
import type { IStorageAdapter, StorageLock } from "../storages/adapter"
import { directDepositClaimed, type SIPADepositStore } from "../services/deposits/SIPADepositStore"
import { MetadataMigrationController } from "./MetadataMigrationController"
import type { MetadataMigrationSteps } from "./metadataMigrationFlow"
import { MigrationFundingStore } from "./MigrationFundingStore"
import {
  ApprovalGate,
  approvalsPrefix,
  savedChallengeSigner,
  webAuthnAssertionCodec,
} from "./savedApprovals"
import type { UpgradeActivity } from "./upgradeActivity"
import { logger } from "../../utils/logger"

export interface MetadataMigrationSessionOptions {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contracts: ContractService
  tokenService: TokenService
  current: OxideEnvTuple
  /** The fee-token bridge that updates registration before another asset moves. */
  metadataCurrent?: OxideEnvTuple
  /** A preceding queued source establishes registration before this source sends. */
  recoveryOnly?: boolean
  network: Network
  secretKey: Fr
  client: PublicClient
  storage: Pick<IStorageAdapter, "getItem" | "setItem">
  lock: StorageLock
  key: string
  /** The account's installed passkey: it signs the record update. */
  passkey: {
    publicKey: R1PublicKeyArg
    signChallenge(challenge: Hex, opts?: { signal?: AbortSignal }): Promise<PasskeySignResult>
  }
  /** Told of every write, so activity lists this run's batches. */
  activity?: UpgradeActivity
  /** The deposit rail's records: the rail claims the migration's direct deposits. */
  deposits: Pick<SIPADepositStore, "load" | "get">
  /** Whether a balance read begun now is stored: a run is done only once it holds all it imported. */
  confirmBalance?(): Promise<boolean>
  /** Stores what the source holds; `anchor` is the L1 block its read began at, so no older read lands last. */
  holdings?(amount: bigint, anchor: number): Promise<void>
  source(
    context: Pick<
      MetadataMigrationServiceOptions,
      | "registered"
      | "bootstrap"
      | "broadcaster"
      | "selfResolver"
      | "token"
      | "owner"
      | "destination"
    > & {
      tokenService: TokenService
      /** The total the rail claimed from the direct deposits to `recipientCommitment`, which have no SIPA. */
      directDepositClaimed(recipientCommitment: Hex): Promise<bigint>
      /** The coordinates of the direct batches the account's other runs saved; a new batch avoids them. */
      reservedCoordinates(): Promise<{ day: number; nonce: number }[]>
      /** Runs a build only until its approval is saved, so every approval comes before any proof. */
      approvalPass<T>(step: () => Promise<T>): Promise<T>
      /** The current advance only saves approvals. */
      approvalsOnly(): boolean
    },
    batches: MigrationFundingStore,
    /** Wraps the source's refund signer so each approval is asked for once. */
    savedRefundSigner: (sign: RefundChallengeSigner) => RefundChallengeSigner,
    /** A source-generation build may ask for a passkey before proving. */
    beforeSourceApproval?: () => void,
  ): Promise<MetadataMigrationSource>
}

/** The account's L1 OxideAccount, which owns its name and record. */
async function accountOwner(
  o: Pick<MetadataMigrationSessionOptions, "client" | "current" | "secretKey">,
) {
  // Registration helpers also load AccountStorage. Defer them until composition so exporting
  // this factory from core does not initialize storage through a circular barrel import.
  const { createOxideL1Reader, resolveOxideAccountFactory } = await import(
    "../../oxide/oxideRegistrationDeps"
  )
  return createOxideL1Reader(o.client).predictAccountAddress(
    resolveOxideAccountFactory({ tuple: o.current }),
    deriveBootstrapKey(o.secretKey).address,
  )
}

/** Whether the account's L1 record still names another account or rollup. L1 reads only. */
export async function accountRecordStale(
  o: Pick<
    MetadataMigrationSessionOptions,
    "account" | "current" | "metadataCurrent" | "secretKey" | "client"
  >,
): Promise<boolean> {
  const [destination, owner] = await Promise.all([
    readBridgeDestination(o.client, o.metadataCurrent ?? o.current),
    accountOwner(o),
  ])
  return recordNamesOtherAccount(
    o.client,
    destination.metadataRegistry,
    owner,
    o.account.getAddress().toString() as Hex,
    destination.rollupVersion,
  )
}

/** Shared migration composition. The host supplies signing, storage and source generation. */
export async function createMetadataMigrationSession(o: MetadataMigrationSessionOptions) {
  const metadataCurrent = o.metadataCurrent ?? o.current
  const destination = await readBridgeDestination(o.client, metadataCurrent)
  const separateAsset = o.current.portal.toLowerCase() !== metadataCurrent.portal.toLowerCase()
  if (
    separateAsset &&
    ["chainId", "rollupVersion", "forwardingTable", "accountMetadataRegistry", "sipaFactory"].some(
      (field) =>
        String(o.current[field as keyof OxideEnvTuple]).toLowerCase() !==
        String(metadataCurrent[field as keyof OxideEnvTuple]).toLowerCase(),
    )
  )
    throw new Error("Migration asset and registration must use the same destination deployment")
  const depositDestination = separateAsset
    ? {
        ...destination,
        portal: o.current.portal as Address,
        token: (await new OxidePortalContract(o.client as never, o.current.portal as Hex)
          .getUnderlying()
          .then((asset) => asset.toString())) as Address,
        depositSubsidy: o.current.depositSubsidy as Address,
      }
    : destination
  const records = await readResolverOperatorRecords(
    o.client,
    destination.metadataRegistry,
    o.current,
  )
  const resolver = selectManifestResolverOperator(records, {
    forwardingTable: destination.forwardingTable,
    resolverGatewayUrl: o.current.resolverGatewayUrl,
    ...resolverSelectionPolicy(o.network),
  })
  const selfResolver = new SipaSelfResolver(selfSipaResolverKeys(o.secretKey))
  const owner = await accountOwner(o)
  const context = {
    ...(await metadataMigrationContext(o.wallet, o.contracts, o.current, o.account.getAddress())),
    selfResolver,
    owner,
    destination,
    tokenService: o.tokenService,
  }
  const bindingWitness = (nameHash: Hex) =>
    metadataMigrationBinding(o.secretKey, o.account.getAddress().toString() as Hex, nameHash)
  const storage = o.activity ? o.activity.reporting(o.key, o.storage) : o.storage
  const approvals = approvalsPrefix(o.key, o.passkey.publicKey)
  const gate = new ApprovalGate()
  // A failed read leaves the last stored figure until a read succeeds.
  const holdings = async (): Promise<boolean> => {
    if (!o.holdings) return true
    try {
      const anchor = Number(await o.client.getBlockNumber({ cacheTime: 0 }))
      const amount = await service.holdings()
      if (amount !== undefined) await o.holdings(amount, anchor)
      return true
    } catch (error) {
      logger.warn("[upgrade] holdings read failed:", error)
      return false
    }
  }
  const source = await o.source(
    {
      ...context,
      destination: depositDestination,
      directDepositClaimed: (recipientCommitment) =>
        directDepositClaimed(o.deposits, recipientCommitment),
      // The coordinates of every direct batch the account's runs saved on this device, planned
      // ones included, so no new batch repeats one. Storage only, no chain read.
      reservedCoordinates: async () => {
        await o.activity?.changed()
        return (o.activity?.items() ?? []).flatMap((item) =>
          item.direct ? [{ day: item.direct.day, nonce: item.direct.nonce }] : [],
        )
      },
      approvalPass: (step) => gate.approvalPass(step),
      approvalsOnly: () => gate.approvalsOnly,
    },
    new MigrationFundingStore(storage, `${o.key}/source`),
    (sign) => savedChallengeSigner(sign, o.storage, approvals, webAuthnAssertionCodec, gate),
    () => gate.check(),
  )
  // An approval holds only over the record state it was given for.
  const signRecordUpdate = async (userOpHash: Hex, expectedStateHash: Hex) =>
    toWebAuthnAuthArg(
      await savedChallengeSigner(
        o.passkey.signChallenge,
        o.storage,
        `${approvals}/record/${expectedStateHash}`,
        undefined,
        gate,
      )(userOpHash),
    )
  const service = new MetadataMigrationService({
    ...context,
    destination,
    ...(separateAsset ? { depositDestination } : {}),
    ...(o.recoveryOnly ? { recoveryOnly: true } : {}),
    owner,
    source,
    client: o.client,
    wallet: o.wallet,
    confirmBalance: o.confirmBalance,
    record: {
      l2Address: o.account.getAddress().toString() as Hex,
      rollupVersion: destination.rollupVersion,
      publicKey: selfResolver.userPublicKey,
      resolverOperator: resolver.owner,
    },
    registrationKeyProof: (nameHash: Hex) => registrationKeyProof(o.secretKey, nameHash),
    nameClaim: async () => {
      const claim = await readNameClaimLog(o.client, destination.nameRegistry, owner)
      if (!claim) throw new Error("No existing name claim is available for migration")
      return {
        kind: "nameClaim",
        ...(await bindingWitness(claim.nameHash)),
        nonce: toBytes(toHex(BigInt(claim.nonce), { size: 32 })),
        deadline: toBytes(toHex(BigInt(claim.deadline), { size: 32 })),
        claimSig: toBytes(claim.signature).slice(0, 64),
      }
    },
    recordPasskey: o.passkey.publicKey,
    signRecordUpdate,
  })
  const steps: MetadataMigrationSteps = {
    // A funds-only run waits for the run that registers the account; it never stops for it.
    waitsForRegistration: !!o.recoveryOnly || !!source.fundsOnly,
    binding: () => service.binding(),
    prepare: (...args) => service.prepare(...args),
    ready: (...args) => service.ready(...args),
    observe: (record) => service.observe(record),
    broadcast: (...args) => service.broadcast(...args),
    subscribe: (...args) => service.subscribe(...args),
    recoverRemaining: (...args) => service.recoverRemaining(...args),
    reconcileRemaining: (...args) => service.reconcileRemaining(...args),
    confirmBalance: () => service.confirmBalance(),
  }
  return {
    service,
    /** The source, for a withdrawal of its funds to L1 in place of the upgrade. */
    source,
    controller: new MetadataMigrationController(storage, steps, o.key, o.lock, gate),
    /** Reads and stores what the source holds; false when that failed. Never throws. */
    holdings,
    /** The source moves only funds, through its destination's migration executor, with no tip. */
    fundsOnly: !!source.fundsOnly,
  }
}
