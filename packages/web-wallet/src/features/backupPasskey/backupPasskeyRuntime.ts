import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  AccountStorage,
  deriveBootstrapKey,
  deriveStealthKey,
  observeSipas,
  planMove,
  pubkeyToR1KeyArg,
  signAccountUserOp,
  unreadDeposits,
  type BackupRotationRecord,
  type OutcomeNode,
  type RotationFlowDeps,
  type SignInput,
} from "@obsidion/front-core"
import {
  base64UrlToBytes,
  runBackupPasskeyCreation,
  type BackupAddChoice,
} from "@obsidion/passkey-web"
import {
  assertBackupSweepProfitable,
  buildBackupSweep,
  ContractService,
  fundingAmount,
  isWithdrawalSpent,
  nextOperationId,
  prepareBackupRotation,
  quoteBackupSweep,
  readBridgeDestination,
  readRotationFundability,
  readSpendShape,
  readTokenBalanceAt,
  RotationRouteNotLiveError,
  UnprofitableSweepError,
  verifyPersistedRotation,
  type BackupPasskeyAdd,
  type FundingAmount,
  type BackupRotationTuple,
  type ObsidionAccount,
  type ObsidionWallet,
  type PersistedRotation,
  type RotationIntent,
} from "@obsidion/sdk"
import {
  CANONICAL_ENTRY_POINT_V08,
  getUserOpHash,
  predictAccountAddressLocally,
  userOpOfIntent,
} from "@oxide/l1-contracts"
import { bytesToHex, formatUnits, type Address, type Hex, type PublicClient } from "viem"
import { getConfig } from "../../config/env"
import { getWebOxideToken } from "../../config/classArtifacts"
import {
  getFeeTokenBridgeTuple,
  l1PublicClient,
  oxideEnvFor,
  requireTupleField,
} from "../../config/oxideTuple"
import { trackBackupPasskeyAdd } from "../../lib/backupPasskeyTelemetry"
import { activeTabSince } from "../../platform/activeTabSince"
import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"
import { DepositReadError, EmptyDepositError } from "../deposit/depositReadErrors"
import { readStrandedToken, type StrandedToken } from "../deposit/sipaRecovery"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { loadWalletIdentity, saveWalletIdentity } from "../identity/walletIdentity"
import { markCreatedHere } from "../migration/upgradeLock"
import { claimSponsorContext } from "../onboarding/claimSponsorship"
import { generationFactories, loadOxideGenerations } from "../onboarding/oxideGenerations"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { unlockedSessionKeys } from "../onboarding/registrationResume"
import { runOperation } from "../operations/operations"
import { l2TokenService } from "../token/l2TokenService"
import { currentTxAmountCap, teeSignerOfToken } from "../token/oxideToken"
import {
  currentDeployment,
  noteSponsoredMine,
  runBurn,
  withdrawalOptions,
} from "../withdraw/withdrawGateway"
import { passkeyDeclined, type BackupAddDeps } from "./backupPasskeyAdd"
import { getBackupRotationStore } from "./backupRotationStore"
import { rerootToPasskeySet } from "./rerootToPasskeySet"
import {
  publishRotationAddress,
  republishRotationAddress,
  seedRotationDeposit,
} from "./rotationPublish"
import { session as openedStores } from "../../platform/session"

/** One id per load of the page: the life of the wallet its sends are seeded under. */
const WALLET_LIFE = crypto.randomUUID()

/**
 * The name the backup passkey is created under: the account's tag, or a short form of the owner
 * for an identity without one. Either fits the user handle's name budget.
 */
export function backupUserName(handle: string | undefined, owner: Address): string {
  return handle || `${owner.slice(0, 6)}…${owner.slice(-4)}`
}

/** What the deposit address holds once a withdrawal of `withdrawn` is released, after its charges. */
export function depositedAmount(live: FundingAmount, withdrawn: bigint): bigint {
  const b = live.breakdown
  return withdrawn - b.withdrawalFee - b.proverTip - b.relayerTip
}

/**
 * What the deposit address holds once the funding is released: the withdrawal of `saved` (the live
 * amount before a plan is saved) less the withdrawal's current charges. Undefined once that no longer
 * covers the route's own charges and minimum credit, so the saved funding cannot be swept.
 */
export function sweepFunding(live: FundingAmount, saved: string | undefined): bigint | undefined {
  const b = live.breakdown
  const held = depositedAmount(live, saved === undefined ? live.amount : BigInt(saved))
  return held >= b.sweepTip + b.beneficiaryFee + b.minCredited ? held : undefined
}

/** The token's service for `account` with the co-signer its sponsored sends go through. */
export async function sponsoredTokenService(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  token: string,
) {
  const [service, signer] = await Promise.all([
    l2TokenService(wallet, account, token),
    teeSignerOfToken(token),
  ])
  service.setTeeSigner(signer)
  return service
}

/** The wallet's node as `txOutcome` reads it. */
export function walletOutcomeNode(wallet: ObsidionWallet): OutcomeNode {
  return {
    getTxReceipt: async (txHash) => {
      const receipt = await wallet.node.getTxReceipt(TxHash.fromString(txHash))
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash?.toString(),
        executionResult: receipt.executionResult,
      }
    },
    finalizedTimestampMs: async () => {
      const block = await wallet.node.getBlockData("finalized")
      if (!block) throw new Error("no finalized block")
      return Number(block.header.globalVariables.timestamp) * 1000
    },
  }
}

/** The session's root key as the flows name it: 64 bytes x‖y, hex, no prefix. */
async function sessionRootKey(wallet: ObsidionWallet) {
  const keys = await unlockedSessionKeys(wallet)
  if (!keys) throw new Error("wallet locked")
  return { keys, rootPubkeyHex: keys.pubkeyHex.slice(2) }
}

/**
 * The add's dependencies for the signed-in session and the account the record names: the session
 * key is the root key, the auth service creates the passkey, and the page's store keeps the record.
 * Nothing here reads the account's key list. The add attempt is not reported.
 */
export async function buildBackupAddDeps(input: {
  wallet: ObsidionWallet
  owner: Address
  choice?: BackupAddChoice
}): Promise<BackupAddDeps> {
  const auth = getAuthService()
  const { keys } = await sessionRootKey(input.wallet)
  const userName = backupUserName(loadWalletIdentity()?.handle, input.owner)
  return {
    owner: input.owner,
    masterKey: () => new Uint8Array(keys.secretKey.toBuffer()),
    create: (ceremony, observe, signal) =>
      auth.createBackupPasskey(runBackupPasskeyCreation, ceremony, {
        userName,
        observe,
        ...(input.choice ? { choice: input.choice } : {}),
        ...(signal ? { signal } : {}),
      }),
    track: trackBackupPasskeyAdd,
    store: getBackupRotationStore(),
  }
}

/** The flow's dependencies plus the reads the panel runs before signing and before a recovery. */
export interface BackupFlowDeps extends RotationFlowDeps {
  /** The change for the record's backup, priced and planned over the chain now. */
  prepare(record: BackupRotationRecord): Promise<SignInput>
  /**
   * Writes the recovery origin on the deposit address's rail record if it lacks one, then reads the
   * fee token held there, for the Settings recovery sheet.
   */
  strandedDeposit(record: BackupRotationRecord): Promise<StrandedToken>
}

type SessionRootKey = Awaited<ReturnType<typeof sessionRootKey>>

/** The two-key address of the root key and `pubkeyHex`, as the account contract derives it. */
const twoKeyAddress = (wallet: ObsidionWallet, session: SessionRootKey, pubkeyHex: string) =>
  wallet.deriveAccountAddress(session.keys.secretKey, [session.rootPubkeyHex, pubkeyHex])

const keyHex = (key: { qx: string; qy: string }) => `${key.qx.slice(2)}${key.qy.slice(2)}`
const addPubkeyHex = (add: BackupPasskeyAdd) => keyHex(add.pubkey)
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The signed change as this session may act on it: its root key must be the session's, so the move
 * spends from the account the change was built over and nothing else.
 */
export function signedChangeFor(
  rotation:
    | {
        expectedKeys: readonly { key: { qx: string; qy: string } }[]
        builtOver: { l2Address: string }
        add: { pubkey: { qx: string; qy: string } }
      }
    | undefined,
  rootPubkeyHex: string,
): { source: string; add: string } {
  if (!rotation) throw new Error("nothing signed to move")
  const root = rotation.expectedKeys[0]?.key
  if (!root || !sameHex(keyHex(root), rootPubkeyHex)) {
    throw new Error("the first passkey must be signed in to move the balance")
  }
  return { source: rotation.builtOver.l2Address, add: keyHex(rotation.add.pubkey) }
}

/**
 * Everything the rotation flow runs against for `owner`, on this session's keys: the L1 reads over
 * the fee token bridge's deployment, the root passkey's signature, the deposit address's rail record
 * and broadcast, the funding withdrawal through the wallet's burn path, the re-root of this browser
 * and the move of the one-key account's balance.
 */
export async function buildBackupFlowDeps(input: {
  wallet: ObsidionWallet
  owner: Address
  /** Hands the page the two-key account once the re-root switched to it. */
  switchAccount?: (account: ObsidionAccount) => void
}): Promise<BackupFlowDeps> {
  const { wallet, owner } = input
  const config = getConfig()
  const client = l1PublicClient(config)
  const auth = getAuthService()
  const credentialId = getActiveCredentialId()
  if (!credentialId) throw new Error("wallet locked")
  const session = await sessionRootKey(wallet)
  const { keys, rootPubkeyHex } = session
  const envTuple = await getFeeTokenBridgeTuple(config)
  const [tuple, env, cap] = await Promise.all([
    readBridgeDestination(client, envTuple),
    oxideEnvFor(config),
    currentTxAmountCap(),
  ])
  const plainWithdrawalExecutor = requireTupleField(envTuple, "plainWithdrawalExecutor") as Address
  const l2Token = requireTupleField(envTuple, "l2Token")
  const store = getBackupRotationStore()
  const contractService = ContractService.getInstance()

  const userOpHash = (rotation: Pick<PersistedRotation, "intent">) =>
    getUserOpHash(client, CANONICAL_ENTRY_POINT_V08, userOpOfIntent(rotation.intent))
  /** The persisted change in the shape the sdk's readers take. */
  const rotationIntent = async (rotation: PersistedRotation): Promise<RotationIntent> => {
    const recipient = await twoKeyAddress(wallet, session, addPubkeyHex(rotation.add))
    return {
      sharedSecretSalt: rotation.sharedSecretSalt,
      newRecord: { ...rotation.builtOver, l2Address: recipient.toString() as Hex },
      intent: rotation.intent,
      deployArgs: rotation.deployArgs,
      sipa: rotation.sipa,
      userOpHash: await userOpHash(rotation),
    }
  }
  const liveFunding = () => fundingAmount(client, { tuple, plainWithdrawalExecutor, proverTip: 0n })
  const finalizedBlock = () => client.getBlock({ blockTag: "finalized" })
  /** The one-key account under the root passkey alone: the move spends from it after the re-root. */
  let oneKey: Promise<ObsidionAccount> | undefined
  /** The signal of the send in flight: the account is built once, so its key reads it per request. */
  let sending: AbortSignal | undefined
  const oneKeyAccount = async (source: string) => {
    oneKey ??= wallet
      .createObsidionAccount(
        keys.secretKey,
        auth.providerFor({
          credentialId,
          pubkeyHex: rootPubkeyHex,
          passkeys: [rootPubkeyHex],
          signal: () => sending,
        }),
      )
      .catch((err: unknown) => {
        oneKey = undefined
        throw err
      })
    const account = await oneKey
    if (!sameHex(account.getAddress().toString(), source)) {
      throw new Error("the one-key account is not the signed change's")
    }
    return account
  }
  /** The signed change's source and destination, checked against the session and the saved plan. */
  const signedChange = async () => {
    const record = await store.get(owner)
    const change = signedChangeFor(record?.rotation, rootPubkeyHex)
    const destination = await twoKeyAddress(wallet, session, change.add)
    if (!record?.plan || !sameHex(destination.toString(), record.plan.address)) {
      throw new Error("the signed change names another address")
    }
    return { ...change, destination }
  }
  /** The deposit address's sweeps and recoveries since `fromBlock`. */
  const observeDeposit = async (sipa: Address, fromBlock: number) => {
    const commitment = (await store.get(owner))?.rotation?.intent.recipientCommitment
    if (!commitment) throw new Error("no signed rotation to read the deposit address for")
    const head = await client.getBlockNumber()
    const { observed } = await observeSipas(client, {
      portals: [tuple.portal],
      tokens: [tuple.token],
      subjects: [{ address: sipa, commitment, fromBlock: BigInt(fromBlock), inflows: false }],
      head,
    })
    // A subject the observation could not read is left out of `observed`: that is no answer.
    const seen = observed.get(sipa.toLowerCase())
    if (!seen) throw new Error("the deposit address read did not complete")
    return seen
  }
  /**
   * The account factory the origin names. `recoverDeposit` refuses unless it predicts `owner` from
   * this session's bootstrap key, and the tuple's factory does not predict an account an earlier
   * generation's factory made.
   */
  const resolveOwnerFactory = async (): Promise<Address> => {
    const bootstrap = deriveBootstrapKey(keys.secretKey).address
    const predicts = (factory: Address) =>
      sameHex(predictAccountAddressLocally(factory, bootstrap), owner)
    if (predicts(env.env.factory)) return env.env.factory
    const generations = await loadOxideGenerations(wallet, contractService, config)
    const found = generationFactories(generations).find(predicts)
    if (!found) throw new Error("no account factory predicts the account from this wallet's keys")
    return found
  }
  let factory: Promise<Address> | undefined
  const ownerFactory = () =>
    (factory ??= resolveOwnerFactory().catch((err: unknown) => {
      factory = undefined
      throw err
    }))
  const depositInput = async (record: BackupRotationRecord) => ({
    record,
    l1ChainId: config.l1ChainId,
    networkId: wallet.networkId,
    token: tuple.token,
    sipaFactory: tuple.factory,
    accountFactory: await ownerFactory(),
  })
  /** Reads pinned to the finalized block, for the portal's release check. */
  const finalizedClient = {
    ...client,
    readContract: (args: Parameters<PublicClient["readContract"]>[0]) =>
      client.readContract({ ...args, blockTag: "finalized" } as never),
  } as PublicClient

  return {
    store,
    now: Date.now,
    mintAttemptId: () => crypto.randomUUID(),
    activeSince: activeTabSince(),
    session: WALLET_LIFE,

    verify: (rotation) =>
      verifyPersistedRotation(client, rotation, tuple, {
        derive: (set) =>
          wallet.deriveAccountAddress(
            keys.secretKey,
            set.map((key) => `${key.qx.slice(2)}${key.qy.slice(2)}`),
          ),
        publicKey: deriveStealthKey(keys.secretKey).publicKey,
      }),
    fundability: async (rotation) =>
      readRotationFundability(client, {
        rotation: await rotationIntent(rotation),
        expectedKeys: rotation.expectedKeys,
        builtOver: rotation.builtOver,
        add: rotation.add,
        implementation: rotation.implementation,
        sipaFactory: tuple.factory,
      }),
    // The sweep is quoted over what the deposit address holds once the saved funding is released,
    // against the route's charges read live.
    route: async (rotation) => {
      let live: FundingAmount
      try {
        live = await liveFunding()
      } catch (err) {
        if (err instanceof RotationRouteNotLiveError) return "route"
        throw err
      }
      const funding = sweepFunding(live, (await store.get(owner))?.plan?.fundingAmount)
      if (funding === undefined) return "route"
      const operation = await buildBackupSweep(
        client,
        await rotationIntent(rotation),
        rotation.signature,
        tuple,
      )
      const quote = await quoteSweep(client, tuple, {
        operation,
        owner,
        sipa: rotation.sipa,
        funding,
      })
      try {
        assertBackupSweepProfitable(quote)
      } catch (err) {
        if (err instanceof UnprofitableSweepError) return "route"
        throw err
      }
      return "ok"
    },

    l1: {
      finalizedBlock: async () => {
        const block = await finalizedBlock()
        return { number: Number(block.number), hash: block.hash }
      },
      isFinal: async ({ blockNumber, blockHash }) => {
        const [at, finalized] = await Promise.all([
          client.getBlock({ blockNumber: BigInt(blockNumber) }),
          finalizedBlock(),
        ])
        return at.hash === blockHash && finalized.number >= BigInt(blockNumber)
      },
      sipaBalance: (sipa, at = "finalized") => readTokenBalanceAt(client, tuple.token, sipa, at),
      sweep: async (sipa, fromBlock) => {
        const sweep = (await observeDeposit(sipa, fromBlock)).sweeps[0]
        if (!sweep) return undefined
        return {
          index: sweep.index.toString(),
          blockNumber: Number(sweep.blockNumber),
          blockHash: sweep.blockHash,
          credited: sweep.amount,
        }
      },
      recovery: async (sipa, fromBlock) =>
        (await observeDeposit(sipa, fromBlock)).recoveries.at(-1)?.txHash,
      releaseFinal: (withdrawalId) =>
        isWithdrawalSpent(finalizedClient, tuple.portal, withdrawalId as Hex),
    },
    node: walletOutcomeNode(wallet),
    tracker: {
      row: async (localId) => {
        const rows = openedStores().withdrawals
        await rows.ready
        const row = await rows.get(localId)
        return row
          ? {
              phase: row.phase,
              l2TxHash: row.l2TxHash,
              withdrawalId: row.withdrawalId,
              startTime: row.startTime,
              recipient: row.recipient,
            }
          : undefined
      },
      stamp: async (localId, txHash) => {
        const rows = openedStores().withdrawals
        await rows.ready
        if (!(await rows.get(localId))) throw new Error(`no withdrawal record ${localId} to stamp`)
        await rows.apply(localId, {
          type: "patch",
          fields: { phase: "submitting", l2TxHash: txHash as Hex },
        })
      },
    },

    prepare: async (record) => {
      const envelopeHex = record.backup.envelopeHex
      if (!envelopeHex) throw new Error("the backup's envelope has left the record")
      const identity = loadWalletIdentity()
      if (!identity) throw new Error("no wallet identity")
      const add: BackupPasskeyAdd = {
        pubkey: pubkeyToR1KeyArg(record.backup.pubkeyHex),
        credentialId: bytesToHex(base64UrlToBytes(record.backup.credentialId)),
        envelope: `0x${envelopeHex}`,
      }
      const recipient = await twoKeyAddress(wallet, session, record.backup.pubkeyHex)
      const token = await getWebOxideToken(wallet, contractService, l2Token)
      const [prepared, funding, shape, cap, head] = await Promise.all([
        prepareBackupRotation(client, {
          tuple,
          owner,
          rootKey: pubkeyToR1KeyArg(rootPubkeyHex),
          recordExpected: {
            l2Address: identity.address as Hex,
            rollupVersion: tuple.rollupVersion,
          },
          add,
          recipient,
        }),
        liveFunding(),
        readSpendShape(wallet, token, keys.account.getAddress()),
        currentTxAmountCap(),
        client.getBlockNumber(),
      ])
      const { rotation } = prepared
      return {
        prepared: {
          owner,
          intent: rotation.intent,
          sharedSecretSalt: rotation.sharedSecretSalt,
          nonce: rotation.intent.nonce,
          builtOver: prepared.builtOver,
          expectedKeys: prepared.expectedKeys,
          implementation: prepared.implementation,
          deployArgs: rotation.deployArgs,
          sipa: rotation.sipa,
          add: prepared.add,
        },
        plan: {
          address: recipient.toString(),
          fundingAmount: funding.amount.toString(),
          deposited: depositedAmount(funding, funding.amount).toString(),
          credited: funding.credited.toString(),
          approvals: 1,
          moves: planMove(shape, cap, unreadDeposits(shape)).m,
        },
        fromBlock: Number(head),
      }
    },
    sign: async (prepared) => {
      const passkey = await oxideAccountPasskey(keys.authProvider)
      if (!passkey) throw new Error("the session key is not a passkey")
      const recipient = await twoKeyAddress(wallet, session, addPubkeyHex(prepared.add))
      return signAccountUserOp(
        { client, passkey },
        { intent: prepared.intent, userOpHash: await userOpHash(prepared) },
        {
          owner,
          metadataRegistry: tuple.metadataRegistry,
          namePortal: tuple.namePortal,
          rollupVersion: tuple.rollupVersion,
          add: prepared.add,
          record: prepared.builtOver,
          recipient: recipient.toString() as Hex,
        },
      )
    },
    publish: async (record, rotation) =>
      publishRotationAddress({ ...(await depositInput(record)), owner, rotation }),
    strandedDeposit: async (record) => {
      const { sipaAddress } = await seedRotationDeposit(await depositInput(record))
      return readStrandedToken(sipaAddress, tuple.token, wallet.networkId).catch((err: unknown) => {
        if (err instanceof EmptyDepositError) throw err
        throw new DepositReadError(err instanceof Error ? err.message : String(err))
      })
    },
    republish: async (record) => {
      await republishRotationAddress(owner, record, async () =>
        Number(await wallet.node.getBlockNumber()),
      )
    },
    fund: async (record, funding, onTxHash) => {
      const plan = record.plan
      const sipa = record.rotation?.sipa
      if (!plan || !sipa) throw new Error("nothing signed to fund")
      const amount = BigInt(plan.fundingAmount)
      const tokenService = await sponsoredTokenService(wallet, keys.account, l2Token)
      const [token, sponsor, deployment] = await Promise.all([
        tokenService.fetchTokenInformation(),
        claimSponsorContext({ wallet, account: keys.account, contractService }, RAIL_REGISTERED),
        currentDeployment(envTuple),
      ])
      const { result } = await runOperation(
        {
          operationId: nextOperationId("withdraw"),
          flow: "withdraw",
          summary: "Backup passkey funding",
        },
        (op) =>
          runBurn({
            op,
            wallet,
            localId: funding.localId,
            record: {
              intent: "backup",
              recipient: sipa,
              recipientProvenance: "saved-recipient",
              amount: formatUnits(amount, token.decimals),
              rawAmount: amount.toString(),
              relayerTip: WITHDRAW_RELAYER_TIP.toString(),
              tokenSymbol: token.symbol,
              tokenDecimals: token.decimals,
              phase: "submitting",
              startTime: Date.now(),
              deployment,
            },
            burn: () =>
              tokenService.exitToL1PrivateSponsored(
                EthAddress.fromString(sipa),
                amount.toString(),
                sponsor,
                {
                  userAccount: keys.account,
                  useRawAmount: true,
                  withdrawal: withdrawalOptions(envTuple),
                  proverTip: 0n,
                  operationId: op.operationId,
                  onTxHash,
                },
              ),
            reportContext: "backup:fund",
          }),
      )
      if (!result) return
      noteSponsoredMine({ wallet, account: keys.account, contractService }, sponsor, "funding")
    },
    reroot: (record, checkpoint) =>
      rerootToPasskeySet(
        {
          derive: async (set) =>
            (await wallet.deriveAccountAddress(keys.secretKey, set)).toString(),
          root: { credentialId, pubkeyHex: rootPubkeyHex },
          rootRecord: () => auth.accountRecord(keys.account.getAddress().toString()),
          writeRecord: (meta) => auth.recordRecoveryMetadata(meta),
          providerFor: (set) =>
            auth.providerFor({ credentialId, pubkeyHex: rootPubkeyHex, passkeys: set }),
          commit: async (authProvider) => {
            const generation = await auth.commitSecret(
              { secretKey: keys.secretKey, authProvider },
              () => getActiveCredentialId() === credentialId,
            )
            if (generation === false) throw new SessionChangedError()
            return () => auth.sessionHeld(generation)
          },
          account: (authProvider) => wallet.createObsidionAccount(keys.secretKey, authProvider),
          persist: async (account) => {
            const accounts = AccountStorage.get()
            const stored = await accounts.getAccount()
            await accounts.addWebauthnAccount(
              stored?.name ?? "Account 1",
              account.getCompleteAddress().toString(),
              stored?.signKeyConfig.webauthnData ?? { credentialId, pubkey: rootPubkeyHex },
            )
            const identity = loadWalletIdentity()
            if (identity)
              await saveWalletIdentity({ ...identity, address: account.getAddress().toString() })
            // New on this version: nothing older to upgrade.
            markCreatedHere(account.getAddress().toString())
          },
          switchAccount: input.switchAccount ?? (() => {}),
        },
        record,
        checkpoint,
      ),
    move: {
      tokens: async () => [l2Token],
      shape: async (token) => {
        const { source } = await signedChange()
        return readSpendShape(
          wallet,
          await getWebOxideToken(wallet, contractService, token),
          (await oneKeyAccount(source)).getAddress(),
        )
      },
      // Stored deposits are not enumerated: a balance held in them moves as note-only chunks, then one attempt.
      deposits: async (_token, shape) => unreadDeposits(shape),
      cap,
      // The sponsor refuses a send past the allowance; nothing is read ahead.
      usesLeft: async () => true,
      send: async (token, amount, onTxHash, signal) => {
        sending = signal
        try {
          const { source, destination } = await signedChange()
          const acting = await oneKeyAccount(source)
          const [tokenService, sponsor] = await Promise.all([
            sponsoredTokenService(wallet, acting, token),
            claimSponsorContext({ wallet, account: acting, contractService }, RAIL_REGISTERED),
          ])
          await tokenService.sendTokenSponsored(destination, amount.toString(), sponsor, {
            userAccount: acting,
            useRawAmount: true,
            onTxHash,
          })
          maybeRefuelFpc({
            wallet,
            contractService,
            fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact },
          })
        } finally {
          sending = undefined
        }
      },
      declined: passkeyDeclined,
    },
  }
}

function quoteSweep(
  client: PublicClient,
  tuple: BackupRotationTuple,
  args: {
    operation: Awaited<ReturnType<typeof buildBackupSweep>>
    owner: Address
    sipa: Address
    funding: bigint
  },
) {
  return quoteBackupSweep(client, {
    operation: args.operation,
    executor: tuple.operationExecutor,
    sender: args.owner,
    sipa: args.sipa,
    token: tuple.token,
    depositSubsidy: tuple.depositSubsidy,
    funding: args.funding,
  })
}
