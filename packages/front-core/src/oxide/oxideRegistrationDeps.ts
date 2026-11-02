import { predictLegacySIPA, type LegacySipaDeployArgs } from "@oxide/l1-contracts/legacy_sipa.js"
/**
 * Wiring helpers that assemble the real collaborators the registration session and
 * resume tick consume: the a1 environment from the resolved OxideEnvTuple, and the
 * L1 reads backed by a viem PublicClient + @oxide/l1-contracts.
 */

import { type Address, type Hex, type PublicClient, zeroAddress } from "viem"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  type R1PublicKeyArg,
  type SipaDeployArgs,
  NamePortalAbi,
  OxideAccountAbi,
  OxideAccountFactoryAbi,
  getAccountNonce,
  getAuthKeys,
  getUserOpHash,
  getUserRecord,
  hasUserRecord,
  predictAccountAddress,
  predictSIPA,
  readAccountMetadataRegistry,
  readNameOf,
  readR1InstallGas,
  readRegistrationController,
  readUserAddress,
} from "@oxide/l1-contracts"
import type { OxideEnvTuple, RegistrationIntent, RegistrationSchedule } from "@obsidion/core/types"
import { registrationFloor } from "@obsidion/core/constants"
import { requireNonZeroL1Address, sipaIntentToken } from "@obsidion/core/oxide"
import { readResolverOperatorRecords } from "./resolverOperatorRecords"
import type { SIPADepositStore } from "../core/services/deposits/SIPADepositStore"
import {
  MAX_NONCE,
  deriveRecoveryAddress,
  type Network,
  SipaSelfResolver,
  deriveSharedSecret,
  readDepositFee,
  type SipaRoute,
  readRegistrationSIPAImplementation,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  type SipaK1Point,
  type SipaResolverOperatorRecord,
} from "@obsidion/sdk"
import { logger } from "../utils/logger"

import { AccountStorage } from "../core/storages/AccountStorage"
import type {
  BoundedAuthKeys,
  OxideL1Reader,
  OxideRegistrationEnv,
  RegistrationDepositReader,
  RegistrationSipaDeriver,
} from "./oxideRegistration"
import { deriveStealthKey, selfSipaResolverKeys, type FieldLike } from "./oxideAccountKeys"
import {
  encodeRegistrationData,
  encodeUserRecord,
  registrationCommitment,
} from "./oxideRegistrationData"
import { pubkeyToR1KeyArg } from "./oxideWebAuthn"

/**
 * The operator EOA to record into `UserRecord.resolverOperator` at signup, read from the live
 * AccountMetadataRegistry: the `ResolverOperatorUpdated` history → the record matching the
 * manifest's forwarding table (+ gateway URL), preferring the known operator EOA among matches.
 * Same selection the SIPA discovery path uses, so signup and discovery always agree on the operator.
 */
export async function fetchSignupResolverOperator(
  publicClient: PublicClient,
  tuple: OxideEnvTuple,
  network: Network,
): Promise<Address> {
  return (await fetchSignupResolverRecord(publicClient, tuple, network)).owner as Address
}

/** The resolver operator record {@link fetchSignupResolverOperator} selects. */
export async function fetchSignupResolverRecord(
  publicClient: PublicClient,
  tuple: OxideEnvTuple,
  network: Network,
): Promise<SipaResolverOperatorRecord> {
  const { accountMetadataRegistry, forwardingTable } = tuple
  if (!accountMetadataRegistry || !forwardingTable) {
    throw new Error(
      "oxide manifest lacks the resolver-selection surface (accountMetadataRegistry / forwardingTable) — " +
        "signup needs it to record a live resolver operator",
    )
  }
  const records = await readResolverOperatorRecords(
    publicClient,
    accountMetadataRegistry as Address,
    tuple,
  )
  const record = selectManifestResolverOperator(records, {
    forwardingTable,
    resolverGatewayUrl: tuple.resolverGatewayUrl,
    ...resolverSelectionPolicy(network),
  })
  logger.info(
    "[oxideRegistration] signup resolver operator:",
    record.owner,
    `(${records.length} records)`,
  )
  return record
}

/**
 * The a1 account factory to predict against. Oxide owns the factory on every network and their
 * manifest tuple is the only source — L1-format + non-zero validated, failing closed rather than
 * predicting a garbage account from an absent field or mainnet's zero placeholder (which their
 * manifest ships until their ERC-4337 stack lands there).
 */
export function resolveOxideAccountFactory(deps: { tuple: OxideEnvTuple }): Address {
  return requireNonZeroL1Address(deps.tuple.accountFactory, "accountFactory") as Address
}

/**
 * `namePortalRecipient` for a deployment where no L2 contract gates on the name message. The
 * controller skips `NamePortal.notify` on the zero word, so nothing is emitted.
 */
export const NO_NAME_PORTAL_RECIPIENT: Hex = `0x${"00".repeat(32)}`

/**
 * Map a resolved OxideEnvTuple into the a1 registration env. The a1 inputs
 * (registry / entryPoint / ensDomain, plus the resolved factory) are required —
 * a missing field means this deployment isn't a1-capable. The factory is supplied
 * (from `resolveOxideAccountFactory`) so it arrives validated, not raw off the tuple.
 */
export function oxideEnvFromTuple(
  tuple: OxideEnvTuple,
  opts: {
    resolverOperator: Address
    l1ChainId: number
    accountFactory: Address
    /** {@link OxideRegistrationEnv.namePortalRecipient} — not a tuple field; the caller names the
     *  L2 contract that gates on the message, or the zero word for none. */
    namePortalRecipient: Hex
  },
): OxideRegistrationEnv {
  const { registry, entryPoint, ensDomain } = tuple
  // Registrations settle on the fee token's row.
  const feeToken = sipaIntentToken(tuple, "registration", tuple.token)
  if (!registry || !opts.accountFactory || !ensDomain || !feeToken) {
    throw new Error(
      "oxide manifest lacks the registration shared block (registry / accountFactory / ensDomain / feeToken) — " +
        "deposit registration requires a dev.json-shaped deployment",
    )
  }
  // rollupVersion binds the name to a specific rollup (it feeds SP-B's SIPA derivation), so a
  // missing/blank value must fail hard rather than coerce to BigInt("") === 0n and record a 0.
  if (!/^\d+$/.test(tuple.rollupVersion ?? "")) {
    throw new Error(
      `oxide manifest has a missing or non-numeric rollupVersion ("${tuple.rollupVersion}") — ` +
        "registration needs it to bind the name to the rollup",
    )
  }
  return {
    registry: registry as Address,
    factory: opts.accountFactory,
    // Retained for the minimal migration relay (updateUserL2Address); registration itself is bundler-free.
    entryPoint: entryPoint as Address | undefined,
    ensDomain,
    resolverOperator: opts.resolverOperator,
    rollupVersion: BigInt(tuple.rollupVersion),
    l1ChainId: opts.l1ChainId,
    feeToken: feeToken as Address,
    namePortalRecipient: opts.namePortalRecipient,
  }
}

/**
 * A stable (day, nonce) for a registration SIPA, derived from its nameHash. Unlike a plain
 * self-broadcast (fresh nonce per view), a registration SIPA must re-derive to the SAME address on
 * resume — the sender may already hold it — so the derivation is deterministic in the name.
 */
function registrationDayNonce(nameHash: Hex): { day: number; nonce: number } {
  const n = BigInt(nameHash)
  return { day: Number((n / BigInt(MAX_NONCE)) % 100_000n), nonce: Number(n % BigInt(MAX_NONCE)) }
}

/**
 * The salt of a registration address shown before the self-SIPA key: the resolver ECDH over the
 * wallet's stealth key. Recovery replays it for an address no record holds.
 */
export function legacyRegistrationSalt(
  masterSecret: FieldLike,
  resolverPublicKey: SipaK1Point,
  nameHash: Hex,
): Hex {
  const { day, nonce } = registrationDayNonce(nameHash)
  const scalar = deriveStealthKey(masterSecret).scalar
  return deriveSharedSecret(resolverPublicKey, scalar, day, nonce).toString() as Hex
}

/**
 * The salt and recipient commitment of each registration address this wallet may have handed out for
 * `nameHash`: the self-SIPA key's, then one per resolver key. Neither commits to the fee, so a sweep's
 * portal deposit is found from these alone. The same resolution as the deriver's.
 */
export async function registrationCommitments(
  masterSecret: FieldLike,
  nameHash: Hex,
  l2Address: Hex,
  resolverPublicKeys: readonly SipaK1Point[],
): Promise<{ salt: Hex; commitment: Hex }[]> {
  const { day, nonce } = registrationDayNonce(nameHash)
  const selfResolver = new SipaSelfResolver(selfSipaResolverKeys(masterSecret))
  const recipient = AztecAddress.fromStringUnsafe(l2Address)
  const salts = [
    undefined,
    ...resolverPublicKeys.map((key) => legacyRegistrationSalt(masterSecret, key, nameHash)),
  ]
  const found = await Promise.all(
    salts.map(async (salt) => {
      // The recovery account shapes only the recovery commitment, which is not read here.
      const resolution = await selfResolver.resolve(
        recipient,
        day,
        nonce,
        EthAddress.ZERO,
        salt === undefined ? undefined : Fr.fromHexString(salt),
      )
      return {
        salt: resolution.messageSecret.toString() as Hex,
        commitment: resolution.recipientHash.toString() as Hex,
      }
    }),
  )
  return [...new Map(found.map((f) => [f.salt, f])).values()]
}

/**
 * The registration SIPA deriver: it self-resolves from the wallet's own keys and commits the SIPA to
 * `keccak256(registrationData)`, deriving non-resweepable (a registration is one-shot). The user
 * record names `env.resolverOperator`, the operator `fetchSignupResolverOperator` selected.
 */
export function createRegistrationSipaDeriver(deps: {
  publicClient: PublicClient
  env: OxideRegistrationEnv
  tuple: OxideEnvTuple
}): RegistrationSipaDeriver {
  const sipaFactory = requireNonZeroL1Address(deps.tuple.sipaFactory, "sipaFactory") as Address
  const forwardingTable = requireNonZeroL1Address(
    deps.tuple.forwardingTable,
    "forwardingTable",
  ) as Address
  // One read serves every derivation this deriver makes.
  let implementationRead: Promise<Address> | undefined
  const registrationImplementation = () => {
    const read = (implementationRead ??= readRegistrationSIPAImplementation(
      deps.publicClient,
      sipaFactory,
    ))
    read.catch(() => {
      if (implementationRead === read) implementationRead = undefined
    })
    return read
  }

  return async (input) => {
    const stealth = deriveStealthKey(input.masterSecret)
    const { day, nonce } = registrationDayNonce(input.nameHash)
    const selfResolver = new SipaSelfResolver(selfSipaResolverKeys(input.masterSecret))
    const resolution = await selfResolver.resolve(
      AztecAddress.fromStringUnsafe(input.l2Address),
      day,
      nonce,
      EthAddress.fromString(input.owner),
      input.sharedSecretSalt === undefined ? undefined : Fr.fromHexString(input.sharedSecretSalt),
    )
    const intent: RegistrationIntent = {
      owner: input.owner,
      nameHash: input.nameHash,
      record: {
        l2Address: input.l2Address,
        rollupVersion: deps.env.rollupVersion,
        publicKey: { x: stealth.publicKey.x, y: stealth.publicKey.y },
        resolverOperator: deps.env.resolverOperator,
      },
      fee: input.fee,
      beneficiary: input.beneficiary,
      // The remainder recipient the SIPA base bridges the post-fee deposit to: the owner's stealth
      // recipient commitment, the same value the broadcast SIPA event commits to.
      recipientCommitment: resolution.recipientHash.toString() as Hex,
      namePortalRecipient: deps.env.namePortalRecipient,
    }
    const registrationData = encodeRegistrationData(intent)
    const recordData = encodeUserRecord(intent.owner, intent.nameHash, intent.record)
    // The registration SIPA is the registration intent: a RegistrationSIPA clone whose single
    // committed word is intentHash = keccak256(registrationData). Derivation is the deposit path's
    // (predictSIPA), delegating to the registration implementation and non-resweepable.
    const registration = registrationCommitment(intent)
    const implementation = await registrationImplementation()
    const recoveryCommitment = resolution.recoveryCommitment.toString() as Hex
    const common = {
      implementation,
      intentHash: registration,
      rollupVersion: deps.env.rollupVersion,
      resweepable: false,
    }
    const sipaArgs: SipaDeployArgs | LegacySipaDeployArgs =
      (deps.tuple.sipaRecoveryProtocol ?? "legacy-eoa") === "legacy-eoa"
        ? {
            ...common,
            recoveryAddress: deriveRecoveryAddress(
              stealth.publicKey,
              resolution.messageSecret,
            ).toString() as Address,
          }
        : { ...common, recoveryCommitment, forwardingTable }
    const sipaAddress =
      "recoveryAddress" in sipaArgs
        ? await predictLegacySIPA(deps.publicClient, sipaFactory, sipaArgs)
        : await predictSIPA(
            deps.publicClient,
            sipaFactory,
            implementation,
            registration,
            recoveryCommitment,
            deps.env.rollupVersion,
            false,
            forwardingTable,
          )
    return {
      sipaAddress,
      recipientCommitment: resolution.recipientHash.toString() as Hex,
      sipaArgs,
      origin:
        "recoveryAddress" in sipaArgs
          ? {
              protocol: "legacy-eoa",
              sipaFactory,
              ...sipaArgs,
              rollupVersion: sipaArgs.rollupVersion.toString(),
            }
          : {
              protocol: "account",
              sipaFactory,
              ...sipaArgs,
              rollupVersion: sipaArgs.rollupVersion.toString(),
              recoveryAccount: input.owner,
              accountFactory: deps.env.factory,
            },
      registrationData,
      recordData,
      registration,
      stealthScalar: stealth.scalar,
      // The event-delivery pair the new broadcast passes so the token delivers the recipient
      // their `SIPA` event with this same recipient commitment.
      recipient: input.l2Address,
      sharedSecretSalt: resolution.messageSecret.toString() as Hex,
    }
  }
}

const REGISTRATION_IMMUTABLES_ABI = [
  {
    name: "REGISTRATION_MIN",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "REGISTRATION_FEE",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const

/**
 * The detection tick's deposit reads. The address's balance, sweeps and funding come from its record
 * in the deposit rail's store, which the rail's observation keeps current; nothing here reads them
 * from L1. The `floor` is the bar a registration sweep accepts: the schedule (the signed terms when
 * held, else the immutable one read from the chain), so a deposit the sweep would refuse never reads
 * funded. The schedule and the implementation's sweep fee are each read once and cached;
 * a failed read drops its cache, and until it lands the floor stays unknown. The floor is a
 * progress signal — the Registry read is the authoritative confirmation.
 */
export function createRegistrationDepositReader(deps: {
  publicClient: PublicClient
  /** The forwarding-table row a registration sweep pays. */
  registrationRoute: SipaRoute
  /** NameRegistry. Deployments older than the RegistrationController keep the schedule immutables here. */
  registry: Address
  /** The blessed RegistrationController, which holds the schedule immutables on deployments that
   *  have one. */
  registrationController?: Address
  /** This account's signed-terms amounts when the wallet holds them (the record has no bearer
   *  material); undefined prices the floor off the immutable schedule. */
  termsFor?: (account: string) => { fee: bigint; minDeposit: bigint } | undefined
  /** The rail's records, one per SIPA, the registration address's among them. */
  store: Pick<SIPADepositStore, "get" | "load">
}): RegistrationDepositReader {
  const recordOf = async (sipa: Address) => {
    await deps.store.load()
    return deps.store.get(sipa)
  }
  const scheduleHolder = deps.registrationController ?? deps.registry
  let immutables: Promise<RegistrationSchedule | undefined> | undefined
  const registrationImmutables = () =>
    (immutables ??= Promise.all([
      deps.publicClient.readContract({
        address: scheduleHolder,
        abi: REGISTRATION_IMMUTABLES_ABI,
        functionName: "REGISTRATION_MIN",
      }),
      deps.publicClient.readContract({
        address: scheduleHolder,
        abi: REGISTRATION_IMMUTABLES_ABI,
        functionName: "REGISTRATION_FEE",
      }),
    ]).then(
      ([min, fee]) => ({ min, fee }),
      (err) => {
        immutables = undefined
        logger.warn("registration immutables read failed; the schedule stays unknown", {
          error: String(err),
        })
        return undefined
      },
    ))
  let sweepFee: Promise<bigint | undefined> | undefined
  const implementationSweepFee = () =>
    (sweepFee ??= readDepositFee(deps.publicClient, deps.registrationRoute).catch((err) => {
      sweepFee = undefined
      logger.warn("registration sweep fee read failed; the floor stays unknown", {
        error: String(err),
      })
      return undefined
    }))
  return {
    readFunding: async (sipa) => {
      const record = await recordOf(sipa)
      return record?.fundingTxHash
        ? [{ amount: BigInt(record.heldBalance ?? "0"), txHash: record.fundingTxHash }]
        : []
    },
    // In fee-token units, the largest across the accepted tokens: what the rail last observed.
    readBalance: async (sipa) => {
      const record = await recordOf(sipa)
      if (record?.heldBalance === undefined) throw new Error(`${sipa} not observed yet`)
      return BigInt(record.heldBalance)
    },
    readSweeps: async (sipa) => {
      const record = await recordOf(sipa)
      if (record?.sweeps?.length) return record.sweeps.map((s) => ({ txHash: s.sweepTxHash }))
      return record?.sweepTxHash ? [{ txHash: record.sweepTxHash }] : []
    },
    floor: async (_token, account) => {
      const terms = deps.termsFor?.(account)
      const [schedule, sweep] = await Promise.all([
        terms
          ? Promise.resolve({ min: terms.minDeposit, fee: terms.fee })
          : registrationImmutables(),
        implementationSweepFee(),
      ])
      if (schedule === undefined || sweep === undefined) return undefined
      if (schedule.fee < sweep) return null
      return registrationFloor(schedule)
    },
    scheduleFee: () =>
      registrationImmutables().then((schedule) => {
        if (schedule === undefined) throw new Error("registration schedule unreadable")
        return schedule.fee
      }),
  }
}

/** Wrap a viem L1 PublicClient in the reads the registration flow needs. */
export function createOxideL1Reader(publicClient: PublicClient): OxideL1Reader {
  const client = publicClient as Parameters<typeof predictAccountAddress>[0]
  return {
    predictAccountAddress: (factory, bootstrap) =>
      predictAccountAddress(client, factory, bootstrap),
    getAccountNonce: (entryPoint, account) => getAccountNonce(client, entryPoint, account),
    readUserAddress: (registry, nameHash) => readUserAddress(client, registry, nameHash),
    readNameOf: (registry, account) => readNameOf(client, registry, account),
    readAccountMetadataRegistry: (registry) => readAccountMetadataRegistry(client, registry),
    // getUserRecord reverts on an account with no record, so the presence check gates it.
    readUserRecord: async (accountMetadataRegistry, account) =>
      (await hasUserRecord(client, accountMetadataRegistry, account))
        ? await getUserRecord(client, accountMetadataRegistry, account)
        : null,
    getUserOpHash: (entryPoint, op) =>
      getUserOpHash(client, entryPoint, op as Parameters<typeof getUserOpHash>[2]),
    // A registry from before the controller split names none and holds the limits itself.
    readR1InstallGas: async (registry) => {
      const controller = await readRegistrationController(client, registry).catch(() => zeroAddress)
      return readR1InstallGas(client, controller === zeroAddress ? registry : controller)
    },
    getAuthKeys: (account) => getAuthKeys(client, account),
    readAuthKeys: async (account, max) =>
      (await readAuthKeysBounded(publicClient, account, max)).entries,
    readAuthKeysCounted: (account, max) => readAuthKeysBounded(publicClient, account, max),
    getCode: (address) => publicClient.getCode({ address }),
    readNamePortalRegistry: (namePortal) =>
      publicClient.readContract({
        address: namePortal,
        abi: NamePortalAbi,
        functionName: "NAME_REGISTRY",
      }),
    readFactoryImplementation: (accountFactory) =>
      publicClient.readContract({
        address: accountFactory,
        abi: OxideAccountFactoryAbi,
        functionName: "implementation",
      }),
  }
}

/**
 * `OxideAccount.authKeyCount`, then either the whole array (when it fits) or the first `max` by
 * index. The count travels back so the caller can tell a full read from a truncated one; a whole
 * array that grew past `max` between the two reads is reported by its own length and capped.
 */
async function readAuthKeysBounded(
  publicClient: PublicClient,
  account: Address,
  max: number,
): Promise<BoundedAuthKeys> {
  const authKeyCount = Number(
    await publicClient.readContract({
      address: account,
      abi: OxideAccountAbi,
      functionName: "authKeyCount",
    }),
  )
  if (authKeyCount === 0) return { entries: [], authKeyCount }
  if (authKeyCount <= max) {
    const all = await getAuthKeys(publicClient as Parameters<typeof getAuthKeys>[0], account)
    return { entries: all.slice(0, max), authKeyCount: all.length }
  }
  const entries = await Promise.all(
    Array.from({ length: max }, (_, index) =>
      publicClient.readContract({
        address: account,
        abi: OxideAccountAbi,
        functionName: "getAuthKey",
        args: [BigInt(index)],
      }),
    ),
  )
  return { entries, authKeyCount }
}

/**
 * The current account's passkey public key as an oxide r1 key, or undefined if none is
 * stored yet. Reads the STORED key only — no passkey ceremony — so registration installs
 * the first r1 key popup-free in the sponsored batch.
 */
export async function resolveStoredR1Key(): Promise<R1PublicKeyArg | undefined> {
  const data = await AccountStorage.get().getWebAuthnDataForCurrentAccount()
  return data ? pubkeyToR1KeyArg(data.pubkey) : undefined
}

/**
 * The current account's passkey credential id — the install's `addAuthKey` metadata. Reads the
 * STORED value only, so registration installs the first r1 key popup-free.
 */
export async function resolveStoredCredentialId(): Promise<string | undefined> {
  const data = await AccountStorage.get().getWebAuthnDataForCurrentAccount()
  return data?.credentialId
}
