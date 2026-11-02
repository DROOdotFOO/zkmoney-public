/**
 * Savings for the browser: the pinned deployment's Sky savings composed over the rails a withdrawal
 * uses. A move burns into a Sky escrow through `runBurn`; Main's relayer releases and runs the
 * escrow; the settle pass claims its deposit on the destination token. Nothing here calls a
 * contract itself.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  TokenService,
  nextOperationId,
  registerBroadcaster,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type RegisteredTeeSigner,
} from "@obsidion/sdk"
import {
  assertSkyFactoryPortals,
  balanceScope,
  buildSavingsMove,
  quoteSavingsMove,
  readSavingsApy,
  readSavingsPrice,
  readSavingsVault,
  resolveSkySavings,
  savingsSourceExecutor,
  savingsValue,
  settleSavingsMoves,
  skyBridgesOfFactory,
  SKY_PROJECT,
  tupleField,
  type SavingsDeployments,
  type SavingsDirection,
  type SavingsMoveRecord,
  type SavingsMoveStorage,
  type SavingsMoveStage,
  type SavingsPrice,
  type SavingsQuote,
  type SavingsSource,
  type SkySavings,
  type WithdrawalRecord,
  type Withdrawals,
} from "@obsidion/front-core"
import { useSyncExternalStore } from "react"
import { formatUnits, type Address, type Hex } from "viem"
import { usdAtomicFloor } from "../../ui/format"
import { getConfig, type WebWalletConfig } from "../../config/env"
import {
  ASSET_TUPLE_TIMEOUT_MS,
  getManifestDeployments,
  getOxideDeployment,
  getOxideTuple,
  getPortalTuple,
  l1PublicClient,
  oxideProfileKey,
} from "../../config/oxideTuple"
import { createExternalState } from "../../lib/externalState"
import { withTimeout } from "../../lib/withTimeout"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import {
  assertWithinWithdrawalLimit,
  sharesBurnLimitProblem,
  withdrawalLimitRefusal,
} from "../limits/withdrawalLimit"
import { claimSponsorContext } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { runOperation, type OperationHandle } from "../operations/operations"
import {
  noteSponsoredMine,
  ownSwapRecoverer,
  runBurn,
  withdrawalOptions,
  type RescanToken,
} from "../withdraw/withdrawGateway"
import {
  executorSubsidyAt,
  skyFactoryPortalsAt,
  withdrawalExecutorAt,
} from "../withdraw/withdrawalFee"
import { getSavingsMoveStore } from "./savingsMoveStore"
import { SavingsQuoteChangedError } from "./quoteChanged"
import { teeSignerOfToken, txAmountCap } from "../token/oxideToken"
import { l2TokenService } from "../token/l2TokenService"
import { session } from "../../platform/session"

const savingsAvailable = createExternalState(false)

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

let skySavingsCached: { key: string; sky: Promise<SkySavings | undefined> } | undefined

/**
 * Sky savings on the pinned deployment, its Main the pinned bridge itself; undefined where the
 * deployment names none, or pairs Savings with another bridge than the one Main holds. Read once
 * per profile; a failed read is not sticky.
 */
export function getSkySavings(config: WebWalletConfig): Promise<SkySavings | undefined> {
  const key = oxideProfileKey(config)
  if (skySavingsCached?.key !== key) {
    const read = async () => {
      const [{ deployment }, pinned] = await Promise.all([
        getOxideDeployment(config),
        getOxideTuple(config),
      ])
      const found = await resolveSkySavings(l1PublicClient(config), deployment, () =>
        getManifestDeployments(config),
      )
      if (!found) return undefined
      if (!sameAddress(found.deployments.main.portal, pinned.portal)) {
        console.warn(
          `[savingsGateway] Sky savings pairs ${found.deployments.main.portal}, not the pinned portal ${pinned.portal}`,
        )
        return undefined
      }
      return { ...found, deployments: { ...found.deployments, main: pinned } }
    }
    const sky = withTimeout(read(), ASSET_TUPLE_TIMEOUT_MS)
    skySavingsCached = { key, sky }
    sky.catch(() => {
      if (skySavingsCached?.sky === sky) skySavingsCached = undefined
    })
  }
  return skySavingsCached.sky
}

/** The Savings bridge; undefined where the pinned deployment has none, and nothing then shows. */
export function getSavingsTuple(config: WebWalletConfig): Promise<OxideEnvTuple | undefined> {
  const tuple = getSkySavings(config).then((sky) => sky?.deployments.savings)
  tuple.then(
    (found) => savingsAvailable.set(!!found),
    () => {},
  )
  return tuple
}

async function readLiveSavingsApy(): Promise<number | undefined> {
  const config = getConfig()
  const tuple = await getSavingsTuple(config)
  if (!tuple) return undefined
  const client = l1PublicClient(config)
  const vault = await readSavingsVault(client, tupleField(tuple, "portal"))
  return readSavingsApy(client, vault, { l1ChainId: config.l1ChainId })
}

/** How long the landing waits on the live rate before it shows without one. */
const LIVE_APY_WAIT_MS = 2_000

type LiveApy = { settled: false } | { settled: true; apy: number | undefined }
const liveApy = createExternalState<LiveApy>({ settled: false })
let liveApyStarted = false

/**
 * Sky's live savings rate, with no account: what the landing advertises. Read once per page, as
 * soon as the config is up, so the landing it holds usually has it by the time the PXE is.
 */
export function prefetchLiveSavingsApy(): void {
  if (liveApyStarted) return
  liveApyStarted = true
  withTimeout(readLiveSavingsApy(), LIVE_APY_WAIT_MS).then(
    (apy) => liveApy.set({ settled: true, apy }),
    () => liveApy.set({ settled: true, apy: undefined }),
  )
}

export function useLiveSavingsApy(): LiveApy {
  prefetchLiveSavingsApy()
  return useSyncExternalStore(liveApy.subscribe, liveApy.get)
}

/**
 * The Savings token for the withdrawal rescan and the wallet's sync, with its deployment: a fresh
 * device rebuilds its moves back to Main from this token's burns, and the sync reads its shares.
 * A burn through a Sky executor the manifest knows is a move out; any other is a plain withdrawal.
 * Undefined where the pinned deployment has no Savings.
 */
export async function savingsRescanToken(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
): Promise<(RescanToken & { tokenService: TokenService }) | undefined> {
  const config = getConfig()
  const tuple = await getSavingsTuple(config)
  if (!tuple) return undefined
  const [tokenService, skyExecutors] = await Promise.all([
    l2TokenService(wallet, account, tuple.l2Token),
    knownSkyExecutors(config),
  ])
  return {
    tokenService,
    tuple,
    executorKind: (executor) =>
      skyExecutors.executors.has(executor.toLowerCase()) ? "sky" : "plain",
    ...(skyExecutors.complete ? {} : { partial: true }),
  }
}

/**
 * The Sky executors a Savings burn may name: today's, and each one a Sky feature of the manifest lists. A failed read of
 * the manifest leaves today's alone, and the list incomplete.
 */
async function knownSkyExecutors(
  config: WebWalletConfig,
): Promise<{ executors: Set<string>; complete: boolean }> {
  let complete = true
  const [sky, deployments] = await Promise.all([
    getSkySavings(config),
    getManifestDeployments(config).catch((err: unknown) => {
      console.warn(
        "[savingsGateway] manifest read failed; the rescan knows today's Sky executor only",
        err,
      )
      complete = false
      return []
    }),
  ])
  const listed = deployments.flatMap((deployment) =>
    (deployment.features ?? []).flatMap((feature) =>
      feature.project === SKY_PROJECT && feature.contracts.skyWithdrawalExecutor
        ? [feature.contracts.skyWithdrawalExecutor]
        : [],
    ),
  )
  const executors = new Set(
    [sky?.deployments.skyExecutor, ...listed].flatMap((a) => (a ? [a.toLowerCase()] : [])),
  )
  return { executors, complete }
}

/** Whether Sky savings has been found for this profile: what shows the Savings surfaces. */
export const useSavingsAvailable = (): boolean =>
  useSyncExternalStore(savingsAvailable.subscribe, savingsAvailable.get)

export interface SavingsDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contractService: ContractService
  /** Main's token service: the source of a move in, and what claims a move out. */
  tokenService: TokenService
  /** The network the wallet's balance store scopes its balances to. */
  network: string
  /** Reads the balances again: a claim moves them with no `Transfer` event. */
  refreshBalance(): Promise<void>
}

export async function openSavings(deps: SavingsDeps): Promise<SavingsSource | null> {
  const tuple = await getSavingsTuple(getConfig())
  return tuple ? createSavingsSource(deps, tuple) : null
}

/** How long one price read answers for; Home and the move sheet read together. */
const PRICE_TTL_MS = 5_000

/** A promise kept until it fails, so one read serves every caller and a failure is retried. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (!pending) {
      const made = make()
      pending = made
      made.catch(() => {
        if (pending === made) pending = undefined
      })
    }
    return pending
  }
}

/**
 * `runBurn` drops a seed that never went out (a cancel, a burn a node refused for a pending one);
 * the move goes with it. A seed kept as failed keeps its move, whose row reads Failed.
 */
export async function dropMoveWithSeed(
  moves: Pick<SavingsMoveStorage, "remove">,
  burns: Pick<Withdrawals, "get">,
  localId: string | undefined,
): Promise<void> {
  if (!localId || (await burns.get(localId))) return
  await moves.remove(localId).catch(() => {})
}

/**
 * What the tray and the bell call a move while it sends: its dollar value and where it goes, the
 * shares of a move out priced at the vault's share price. Without a price the line names only the
 * route.
 */
export function moveSummary(
  direction: SavingsDirection,
  amount: bigint,
  sharePrice?: bigint,
): string {
  const to = direction === "in" ? "Savings" : "Main Account"
  const value =
    direction === "in"
      ? amount
      : sharePrice === undefined
      ? undefined
      : savingsValue(amount, sharePrice)
  return value === undefined ? `Savings to ${to}` : `${usdAtomicFloor(value)} to ${to}`
}

/** The Savings deployment's co-signer, which a burn out of Savings and its release need. */
export async function connectSavingsSigner(savings: OxideEnvTuple): Promise<RegisteredTeeSigner> {
  try {
    return await teeSignerOfToken(savings.l2Token)
  } catch (cause) {
    throw new Error("The Savings co-signer isn't reachable. Try again in a moment.", { cause })
  }
}

/** What finalizing a move out's burn by hand runs on: the Savings deployment and its co-signer. */
export async function savingsFinalizeDeployment(
  burn: Pick<WithdrawalRecord, "deployment">,
): Promise<{ tuple: OxideEnvTuple; signer: RegisteredTeeSigner }> {
  const config = getConfig()
  const current = await getSavingsTuple(config)
  // The burn's own deployment, which an older move keeps after Savings moves to a new portal.
  const portal = burn.deployment?.portal
  const tuple =
    portal && portal.toLowerCase() !== current?.portal.toLowerCase()
      ? await getPortalTuple(config, portal)
      : current
  if (!tuple) throw new Error("Savings isn't available on this network.")
  return { tuple, signer: await connectSavingsSigner(tuple) }
}

export function createSavingsSource(deps: SavingsDeps, savings: OxideEnvTuple): SavingsSource {
  const config = getConfig()
  const client = l1PublicClient(config)
  const moves = getSavingsMoveStore()
  const sky = once<SkySavings>(async () => {
    const found = await getSkySavings(config)
    if (!found || !sameAddress(found.deployments.savings.portal, savings.portal)) {
      throw new Error("Savings isn't available on this network.")
    }
    return found
  })
  const deployments = once<SavingsDeployments>(async () => (await sky()).deployments)
  const factory = async () => (await sky()).factory
  const savingsToken = once<TokenService>(async () => {
    const { savings } = await deployments()
    return l2TokenService(deps.wallet, deps.account, savings.l2Token)
  })
  // Reads and claims need no co-signer; only a burn out of Savings does, so it connects then, and
  // a failed connect is tried again on the next move out.
  const savingsSigner = once(async () => connectSavingsSigner((await deployments()).savings))
  const vault = once<Address>(async () =>
    readSavingsVault(client, tupleField((await deployments()).savings, "portal")),
  )
  const balance = {
    scope: balanceScope(deps.network, deps.account.getCompleteAddress().toString()),
    tokenAddress: AztecAddress.fromStringUnsafe(savings.l2Token).toString(),
  }

  let lastRead: { at: number; value: Promise<SavingsPrice> } | undefined

  const readPrice = () => {
    const now = Date.now()
    if (lastRead && now - lastRead.at < PRICE_TTL_MS) return lastRead.value
    const value = vault().then((address) =>
      readSavingsPrice(client, address, { l1ChainId: config.l1ChainId }),
    )
    lastRead = { at: now, value }
    value.catch(() => {
      if (lastRead?.value === value) lastRead = undefined
    })
    return value
  }

  // The last quote given for each move: what its review showed.
  const reviewed = new Map<string, SavingsQuote>()
  const quoteDeps = async () => ({
    client,
    deployments: await deployments(),
    factory: await factory(),
    executorReads: { executor: withdrawalExecutorAt, subsidy: executorSubsidyAt },
  })
  const quote = async (direction: SavingsDirection, amount: bigint) => {
    const result = await quoteSavingsMove(await quoteDeps(), direction, amount)
    reviewed.set(`${direction}:${amount}`, result)
    return result
  }

  const moveFlow = async (
    op: OperationHandle,
    direction: SavingsDirection,
    amount: bigint,
    onStage: (stage: SavingsMoveStage) => void,
  ): Promise<SavingsMoveRecord> => {
    onStage("building")
    const deployed = await deployments()
    const { main, savings } = deployed
    // Before anything is signed: the escrow must deposit into the bridges the manifest pairs.
    const { address: factoryAddress } = await factory()
    assertSkyFactoryPortals(await skyFactoryPortalsAt(factoryAddress), deployed, factoryAddress)
    const source = direction === "in" ? main : savings
    const sourceToken = direction === "in" ? deps.tokenService : await savingsToken()
    if (direction === "out") sourceToken.setTeeSigner(await savingsSigner())
    const cap = await txAmountCap(client, source.portal as Address)
    if (direction === "in") assertWithinWithdrawalLimit(amount, cap)
    else if (sharesBurnLimitProblem(amount, cap))
      throw new Error(withdrawalLimitRefusal("protocol"))
    if ((await sourceToken.getBalance()) < amount) throw new Error("Balance not enough")
    const confirmed = reviewed.get(`${direction}:${amount}`)
    const priced = await quote(direction, amount)
    // Fees that rose since the review stop the move; the sheet shows the new figures to confirm.
    if (confirmed && priced.net < confirmed.net) throw new SavingsQuoteChangedError(priced)
    const recoverer = await ownSwapRecoverer(main)
    const broadcaster = await registerBroadcaster(
      deps.wallet,
      deps.contractService,
      tupleField(main, "l2Broadcaster"),
    )
    const build = await buildSavingsMove(
      {
        broadcaster,
        deployments: deployed,
        factory: await factory(),
        masterSecret: recoverer.secret,
        recipient: deps.account.getAddress(),
        recoveryAccount: recoverer.account,
      },
      priced,
    )
    const sponsor = await claimSponsorContext(deps, RAIL_REGISTERED)
    const options = withdrawalOptions(source)
    const token = await sourceToken.fetchTokenInformation()
    // The escrow's deposit lands after the burn, so its search starts here. A move rebuilt from the
    // burn searches from the burn's time instead.
    const depositScanFrom = (await client.getBlockNumber()).toString()
    const moveOf = (record: WithdrawalRecord): SavingsMoveRecord => ({
      direction,
      withdrawalLocalId: record.localId,
      escrow: build.escrow,
      nonce: build.nonce,
      recipientCommitment: build.recipientCommitment,
      amount: amount.toString(),
      factory: build.skyMove.factory,
      depositScanFrom,
      depositScanFloor: depositScanFrom,
      startTime: record.startTime,
      value: priced.value.toString(),
      net: priced.net.toString(),
    })
    let seeded: WithdrawalRecord | undefined
    const { record, result } = await runBurn({
      op,
      wallet: deps.wallet,
      record: {
        recipient: build.escrow,
        recipientProvenance: "saved-recipient",
        recipientAlias: direction === "in" ? "Savings" : "Main Account",
        amount: formatUnits(amount, token.decimals),
        rawAmount: amount.toString(),
        relayerTip: priced.releaseTip.toString(),
        ...(priced.withdrawalFee ? { withdrawalFee: priced.withdrawalFee.toString() } : {}),
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        phase: "submitting",
        startTime: Date.now(),
        deployment: {
          portal: source.portal as Hex,
          l2Token: source.l2Token,
          executor: savingsSourceExecutor(deployed, direction),
        },
        skyMove: { ...build.skyMove, depositScanFrom, value: priced.value.toString() },
      },
      // The move is on both feeds from the seed, while the burn is still proving.
      onSeeded: async (record) => {
        seeded = record
        await moves.put(moveOf(record))
      },
      burn: (_record, onTxHash) => {
        onStage("proving")
        return sourceToken.exitToL1PrivateSponsored(
          build.escrowOptions.escrow,
          amount.toString(),
          sponsor,
          {
            operationId: op.operationId,
            userAccount: deps.account,
            useRawAmount: true,
            withdrawal: { ...options, escrow: build.escrowOptions },
            onTxHash,
          },
        )
      },
    }).catch(async (err: unknown) => {
      await dropMoveWithSeed(moves, session().withdrawals, seeded?.localId)
      throw err
    })
    const move = moves.get(record.localId) ?? (await moves.put(moveOf(record)))
    if (!result) return move
    onStage("submitting")
    noteSponsoredMine(deps, sponsor, "move")
    return move
  }

  const move: SavingsSource["move"] = async (direction, amount, onStage) => {
    // A move out burns shares; the tray names their dollar value at the vault's share price.
    const sharePrice =
      direction === "out"
        ? await readPrice().then(
            (price) => price.sharePrice,
            () => undefined,
          )
        : undefined
    return runOperation(
      {
        operationId: nextOperationId("withdraw"),
        flow: "savings",
        summary: moveSummary(direction, amount, sharePrice),
      },
      (op) => moveFlow(op, direction, amount, onStage),
    )
  }

  // An older move's escrow deposits into the bridges its factory's Sky feature binds, which the
  // manifest still lists; an older portal's token service is made once per token.
  const olderTokens = new Map<string, Promise<TokenService>>()
  const cachedOnce = <T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>) => {
    let value = cache.get(key)
    if (!value) {
      const made = make()
      cache.set(key, made)
      made.catch(() => cache.delete(key))
      value = made
    }
    return value
  }

  let waitingForKey = false
  const settle = async () => {
    const masterSecret = await getAuthService().getSecretKey()
    if (!masterSecret) {
      // Locked: the pass runs again on the next tick once the key is back.
      if (!waitingForKey) console.info("[savingsGateway] settle pass waits for the unlocked key")
      waitingForKey = true
      return
    }
    waitingForKey = false
    const { main, savings } = await deployments()
    const destination = (tuple: OxideEnvTuple, claimer: () => Promise<TokenService>) => ({
      portal: tupleField(tuple, "portal"),
      token: tupleField(tuple, "token"),
      fromBlock: BigInt(tuple.deployedAtBlock ?? 0),
      claimer,
    })
    const withdrawals = session().withdrawals
    await withdrawals.ready
    await settleSavingsMoves(
      moves,
      {
        publicClient: client,
        vault: await vault(),
        onVaultUnknown: (move, txHash, reason) =>
          console.warn(
            `[savingsGateway] move ${move.withdrawalLocalId} (${move.direction}) has no exact figures: ${reason}`,
            txHash,
          ),
        masterSecret,
        recipient: deps.account.getAddress(),
        refreshBalance: deps.refreshBalance,
        main: destination(main, async () => deps.tokenService),
        savings: destination(savings, savingsToken),
        destinationFor: async (move) => {
          const current =
            move.direction === "in"
              ? destination(savings, savingsToken)
              : destination(main, async () => deps.tokenService)
          if (sameAddress(move.factory, (await factory()).address)) return current
          // A read that fails or stalls fails this move's search; the pass settles the others.
          const bridges = await skyBridgesOfFactory(
            client,
            await getManifestDeployments(config),
            move.factory,
          )
          if (!bridges)
            throw new Error(`No deployment lists the Sky escrow factory ${move.factory}`)
          const tuple = move.direction === "in" ? bridges.savings : bridges.main
          if (sameAddress(tuple.portal, current.portal)) return current
          return destination(tuple, () =>
            cachedOnce(olderTokens, tuple.l2Token.toLowerCase(), () =>
              TokenService.create(
                deps.wallet,
                deps.account,
                AztecAddress.fromStringUnsafe(tuple.l2Token),
              ),
            ),
          )
        },
      },
      [...(await withdrawals.all())],
      (move, err) => console.warn(`[savingsGateway] claim for move ${move.escrow} refused:`, err),
    )
  }

  return {
    assetAddress: savings.underlying ?? savings.token,
    moves,
    balance,
    readPrice,
    quote,
    move,
    settle,
  }
}
