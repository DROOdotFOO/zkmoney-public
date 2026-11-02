// The v5 source generation. Built inside a checkout of the pinned v5 wallet commit (see
// scripts/build.mjs), so every import below resolves to that commit's packages.
import { NO_FROM } from "@aztec/aztec.js/account"
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import type { AztecNode } from "@aztec/aztec.js/node"
import { InboxContract } from "@aztec/ethereum/contracts"
import type { ViemClient } from "@aztec/ethereum/types"
import { createLogger } from "@aztec/foundation/log"
import { createArtifactCatalog } from "@obsidion/config-client"
import { DEFAULT_CONTRACTS, PaylinkActionEnum, TokenActionEnum } from "@obsidion/core/constants"
import type { ContractServiceConfig, OxideEnvTuple } from "@obsidion/core/types"
import {
  creatorLinksFromRows,
  deploymentScanRange,
  deriveRefundableSipaSources,
  markPaylinkMigrated,
  readSkyFactoryPortals,
  rebuildPaylinks,
  rebuildWithdrawals,
  SavingsMoveStorage,
  savingsRoute,
  setActiveNetworkId,
  settleSavingsMoves,
  SIPADepositStore,
  syncSipaDeposits,
  TransactionStorage,
  TransferEventScanner,
  WithdrawalStorage,
  WithdrawalTrackingService,
  type IStorageAdapter,
  type PaylinkTransaction,
  type Transaction,
} from "@obsidion/front-core"
import {
  computeStealthRecipientHash,
  createClassArtifactResolver,
  createWithdrawEventSource,
  ContractService,
  createNode,
  createTransferEventSource,
  discoverFrozenEscrows,
  encodePaylinkInline,
  fetchSipaEvents,
  FrozenRefundMigrationRuntime,
  getBroadcasterArtifact,
  L1WithdrawalFinalizationReader,
  loadTeeSigner,
  ObsidionAccountContractManager,
  ObsidionWallet,
  PaylinkService,
  passkeyRefundOwner,
  readRefundableEscrowNotes,
  readRefundableFrozenDeposits,
  readRefundableFrozenNotes,
  syncSourcePxe,
  TokenService,
  WebAuthnAlphaAuthProvider,
  type FrozenEscrow,
  type ObsidionAccount,
} from "@obsidion/sdk"
import { OxidePortalContract } from "@oxide/l1-contracts"
import type { L2BlockTag, L2TipId } from "@aztec/stdlib/block"
import { deriveMasterNullifierHidingSecretKey } from "@aztec/stdlib/keys"
import { TxHash } from "@aztec/stdlib/tx"
import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem"
import { foundry, mainnet, sepolia } from "viem/chains"
import { createPxeStore } from "../src/platform/storage/createPxeStore"
import {
  SOURCE_GENERATION_PROTOCOL,
  type SourceGenerationModule,
  type SourceGenerationOpenParams,
  type SourceExecutorCall,
  type SourceGenerationSession,
  type SourcePaylinkRows,
  type SourceRefundRuntime,
  type SourceSipaScan,
} from "./protocol"

declare const __AZTEC_VERSION__: string

export const protocol = SOURCE_GENERATION_PROTOCOL
export const aztecVersion: string = __AZTEC_VERSION__

const artifacts = new Map()
const artifactStorage = {
  getArtifactCache: () => artifacts,
  setArtifactCache: (name: never, artifact: never) => void artifacts.set(name, artifact),
}

let bound: { contracts: string; node?: AztecNode } | undefined

/**
 * Binds this bundle's ContractService singleton to the source version's contracts and, when given,
 * its artifact manifest, which names the retired classes a payment link escrow may still carry. A
 * session rebinds it with its node and PXE, so the bundle serves one source node at a time.
 */
function bindContracts(
  o: Pick<SourceGenerationOpenParams, "network" | "contracts" | "artifacts">,
  chain?: { node: AztecNode; pxe: ObsidionWallet["pxe"] },
) {
  // One source version has one manifest, so an address lookup without `artifacts` keeps a session's
  // catalog.
  const contracts = JSON.stringify(o.contracts)
  if (bound && bound.contracts === contracts && (!chain || bound.node === chain.node)) return
  if (bound?.node && chain && bound.node !== chain.node)
    throw new Error("The v5 generation serves one source node at a time")
  const catalog = o.artifacts && createArtifactCatalog(o.artifacts)
  ContractService.resetInstance()
  ContractService.getInstance(artifactStorage, chain?.node, chain?.pxe, o.network as never, {
    source: "profile",
    config: o.contracts as ContractServiceConfig,
    ...(catalog && {
      listClassIds: catalog.classIds,
      resolveClassArtifact: createClassArtifactResolver(catalog.resolvePin),
    }),
  })
  bound = { contracts, node: chain?.node }
}

export const accountAddress: SourceGenerationModule["accountAddress"] = async (o) => {
  bindContracts(o)
  const contractName = DEFAULT_CONTRACTS.obsidionAccountAlpha
  const manager = await ObsidionAccountContractManager.create(
    Fr.fromString(o.secretKey),
    o.publicKeyHex,
    {
      artifact: await ContractService.getInstance().getArtifactForContract(contractName),
      contractName,
      pxe: undefined as never,
    },
    false,
  )
  return (await manager.getCompleteAddress()).address.toString()
}

const hexBuffer = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex")

/** The node reads v5's deposit sync makes: the spent-deposit lookup and the message readiness. */
const DEPOSIT_NODE_READS: ReadonlySet<PropertyKey> = new Set([
  "findLeavesIndexes",
  "getL1ToL2MessageCheckpoint",
  "getBlockData",
])

// v5's stores stamp each record with the bundle's one active network, so histories take turns.
let historyTurn: Promise<unknown> = Promise.resolve()
function takeTurn<T>(run: () => Promise<T>): Promise<T> {
  const turn = historyTurn.then(run)
  historyTurn = turn.catch(() => {})
  return turn
}

/** A store of the source wallet's own over `arg`, beside any the bundle already holds. */
const fresh = <T, A>(store: { prototype: T }, arg: A): T =>
  new (store as unknown as new (arg: A) => T)(arg)

/** The portal binding reads the chain id from its client, as the v5 wallet's `l1ChainFor` gives it. */
const l1Chain = (id: number): Chain =>
  [mainnet, sepolia, foundry].find((chain) => chain.id === id) ?? {
    ...foundry,
    id,
    name: `Chain ${id}`,
  }

/**
 * `node` with its chain held at the tip given to `hold`. A frozen source refunds what its freeze
 * archive holds, so its PXE stops there, and its synced state and cached node reads stay valid. The
 * blocks past the hold are hidden too, so a PXE synced past it prunes back and drops their notes.
 */
function holdableNode(node: AztecNode) {
  let held: L2TipId | undefined
  // Once the held block is finalized, every capped tip is the held one, so the node is not asked.
  let settled = false
  const cap = (tip: L2TipId) => (held && tip.block.number > held.block.number ? held : tip)
  const proxy = new Proxy(node, {
    get(target, key, receiver) {
      if (key === "getChainTips")
        return async () => {
          if (held && settled)
            return { proposed: held.block, checkpointed: held, proven: held, finalized: held }
          const tips = await target.getChainTips()
          if (!held) return tips
          settled = tips.finalized.block.number >= held.block.number
          return {
            proposed: tips.proposed.number > held.block.number ? held.block : tips.proposed,
            checkpointed: cap(tips.checkpointed),
            proven: cap(tips.proven),
            finalized: cap(tips.finalized),
          }
        }
      if (key === "getBlockNumber")
        return async (tip?: L2BlockTag) => {
          if (held && settled) return held.block.number
          const number = await target.getBlockNumber(tip)
          return held && number > held.block.number ? held.block.number : number
        }
      if (key === "getBlock")
        return async (...args: Parameters<AztecNode["getBlock"]>) => {
          const block = await target.getBlock(...args)
          return held && block && block.header.globalVariables.blockNumber > held.block.number
            ? undefined
            : block
        }
      return Reflect.get(target, key, receiver)
    },
  })
  const hold = (tip: L2TipId | undefined) => {
    held = tip
    settled = false
  }
  return { node: proxy, hold }
}

export const open: SourceGenerationModule["open"] = async (params) => {
  const { node, hold } = holdableNode(createNode(params.nodeUrl, params.nodeApiKey))
  const { rollupAddress } = await node.getL1ContractAddresses()
  const store = await createPxeStore(rollupAddress.toString(), undefined)
  let wallet: ObsidionWallet
  try {
    wallet = await ObsidionWallet.create(
      node,
      { proverEnabled: params.proverEnabled },
      { loggers: { pxe: createLogger("pxe:v5") }, store },
    )
  } catch (error) {
    await store.close()
    throw error
  }
  bindContracts(params, wallet)
  const { passkey } = params.account
  const auth = new WebAuthnAlphaAuthProvider(
    hexBuffer(passkey.publicKey.x),
    hexBuffer(passkey.publicKey.y),
    (challenge) => passkey.sign(challenge),
  )
  const account = await wallet.createObsidionAccount(Fr.fromString(params.account.secretKey), auth)
  const client = createPublicClient({
    chain: l1Chain(params.l1ChainId),
    transport: http(params.l1RpcUrl),
  }) as PublicClient
  return session({
    wallet,
    account,
    client,
    network: params.network,
    l1ChainId: params.l1ChainId,
    masterSecret: Fr.fromString(params.account.secretKey),
    rollupAddress: rollupAddress.toString(),
    hold,
  })
}

function session(o: {
  wallet: ObsidionWallet
  account: ObsidionAccount
  client: PublicClient
  network: string
  l1ChainId: number
  masterSecret: Fr
  rollupAddress: string
  hold: (tip: L2TipId | undefined) => void
}): SourceGenerationSession {
  const { wallet, account, client } = o
  const portalOf = (tuple: OxideEnvTuple) =>
    new OxidePortalContract(client as unknown as ViemClient, tuple.portal as Address)
  // After a freeze, only an L1 refund changes what a frozen source can refund. So the session reads
  // each owner's frozen notes from the PXE once and checks their refund nullifiers on L1 at each read.
  // A fresh read reads the PXE again and replaces the kept result.
  const frozenAnchors = new Map<string, Promise<void>>()
  const frozenNotes = new Map<string, ReturnType<typeof readRefundableFrozenNotes>>()
  const discovered = new Map<string, Promise<FrozenEscrow[]>>()
  /** Brings the PXE past a frozen portal's freeze once. Every later anchor reads the same notes. */
  const atFrozenAnchor = (tuple: OxideEnvTuple) =>
    memo(frozenAnchors, tuple.portal.toLowerCase(), async () => {
      const portal = portalOf(tuple)
      const [rollupVersion, archive] = await Promise.all([
        portal.getRollupVersion(),
        portal.getFreezeArchive(),
      ])
      const freezeEnd = await wallet.node.getBlockData({ archive })
      if (!freezeEnd) throw new Error("The source freeze archive has no block")
      const synced = await wallet.pxe.getSyncedBlockHeader().catch(() => undefined)
      if (
        synced &&
        synced.globalVariables.version.toBigInt() === rollupVersion &&
        synced.globalVariables.blockNumber >= freezeEnd.header.globalVariables.blockNumber
      )
        return
      await syncSourcePxe({ node: wallet.node, pxe: wallet.pxe, rollupVersion })
    })
  const readFrozenNotes = async (
    tuple: OxideEnvTuple,
    read: Parameters<typeof readRefundableFrozenNotes>[0],
    fresh = false,
  ) => {
    const key = `${read.portal.address}:${read.owner}`.toLowerCase()
    if (fresh) frozenNotes.delete(key)
    const notes = await memo(frozenNotes, key, async () => {
      await atFrozenAnchor(tuple)
      const unrefunded = Object.assign(Object.create(read.portal), {
        isRefundNullifierSpent: async () => false,
      }) as OxidePortalContract
      return readRefundableFrozenNotes({ ...read, portal: unrefunded })
    })
    const refunded = await Promise.all(
      notes.map(({ id }) => read.portal.isRefundNullifierSpent(Fr.fromString(id))),
    )
    return notes.filter((_, i) => !refunded[i])
  }
  const readFrozenEscrowNotes = async (
    tuple: OxideEnvTuple,
    read: Parameters<typeof readRefundableEscrowNotes>[0],
    fresh = false,
  ) =>
    (
      await Promise.all(
        read.escrows.map(async (escrow) => {
          const owner = escrow.owner.address
          const notes = await readFrozenNotes(
            tuple,
            {
              ...read,
              owner,
              resolveSpendMetadata: escrow.resolveSpendMetadata,
              simulateOptions: { from: NO_FROM, additionalScopes: [owner] },
            },
            fresh,
          )
          return notes.map((note) => ({ ...note, escrow }))
        }),
      )
    ).flat()
  // A freeze is final, so each portal's freeze tip is read once. A live portal needs the tip, so
  // once one is seen the session never holds.
  const freezeTips = new Map<string, L2TipId>()
  let live = false
  let held: L2TipId | undefined
  /** Holds the PXE at the latest freeze among the frozen portals the session reads. */
  const holdAtFreeze = async (tuple: OxideEnvTuple) => {
    if (live) return
    const key = tuple.portal.toLowerCase()
    let tip = freezeTips.get(key)
    if (!tip) {
      const portal = portalOf(tuple)
      if (!(await portal.isFrozen())) {
        live = true
        return o.hold((held = undefined))
      }
      const block = await wallet.node.getBlockData({ archive: await portal.getFreezeArchive() })
      if (!block) throw new Error("The source freeze archive has no block")
      const [checkpoint] = await wallet.node.getCheckpointsData({
        from: block.checkpointNumber,
        limit: 1,
      })
      if (!checkpoint) throw new Error("The source freeze checkpoint has no data")
      tip = {
        block: {
          number: block.header.globalVariables.blockNumber,
          hash: block.blockHash.toString(),
        },
        checkpoint: { number: block.checkpointNumber, hash: checkpoint.header.hash().toString() },
      }
      freezeTips.set(key, tip)
    }
    if (!live && (!held || tip.block.number > held.block.number)) o.hold((held = tip))
  }
  // Sponsored calls run with the deployment's ClaimFPC as msg_sender, so the notes they mint for
  // the account are tagged with it. A new PXE finds those notes only with the FPC as a sender.
  const registerClaimFpc = async (tuple: OxideEnvTuple) => {
    if (tuple.fpcBeneficiary)
      await wallet.registerSender(AztecAddress.fromStringUnsafe(tuple.fpcBeneficiary))
  }
  // Registers what the deployment's `SIPA` events are tagged with, and the token that holds them.
  const prepareSipaScan = async ({ tuple, resolverL2Addresses }: SourceSipaScan) => {
    if (!resolverL2Addresses.length)
      throw new Error("The source deployment has no resolver senders")
    for (const sender of resolverL2Addresses)
      await wallet.registerSender(AztecAddress.fromStringUnsafe(sender))
    await registerClaimFpc(tuple)
    if (!tuple.l2Broadcaster) throw new Error("The source deployment has no Broadcaster")
    const broadcaster = AztecAddress.fromStringUnsafe(tuple.l2Broadcaster)
    const instance = await wallet.node.getContract(broadcaster)
    if (!instance) throw new Error(`Broadcaster instance not found at ${tuple.l2Broadcaster}`)
    await wallet.registerContract(instance, await getBroadcasterArtifact())
    return TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(tuple.l2Token))
  }
  // The account's payment link escrows on a frozen source, found as v5's `sourceFrozenEscrows` finds
  // them. The funding events end at the freeze, so a session finds them once for each set of hints,
  // keyed by every field a hint carries.
  const escrows = async (tuple: OxideEnvTuple, paylinkRows: SourcePaylinkRows, fresh = false) => {
    const hints = await creatorLinksFromRows((await paylinkRows()) as Transaction[])
    const key = [
      tuple.portal.toLowerCase(),
      ...hints
        .map((link) =>
          Object.entries(link)
            .map(([field, value]) => `${field}=${String(value)}`)
            .sort()
            .join(","),
        )
        .sort(),
    ].join("|")
    if (fresh) discovered.delete(key)
    return memo(discovered, key, async () => {
      await atFrozenAnchor(tuple)
      const tokenService = await TokenService.create(
        wallet,
        account,
        AztecAddress.fromStringUnsafe(tuple.l2Token),
      )
      const contractService = ContractService.getInstance()
      return discoverFrozenEscrows({
        paylinkService: new PaylinkService(wallet, account, tokenService, contractService),
        escrows: { wallet, contractService },
        events: createTransferEventSource({
          wallet,
          tokenAddress: tuple.l2Token,
          accountAddress: account.getAddress().toString(),
        }),
        account: account.getAddress(),
        masterSecret: o.masterSecret,
        hints,
      })
    })
  }
  /**
   * The open links among `rows` that a frozen refund paid out on L1. Such a refund leaves the link's L2
   * note unspent, so the rescan reads it as open. A link funded inside the freeze archive keeps a
   * refundable note until L1 refunds it, so one with none left was refunded.
   */
  const refundedLinks = async (tuple: OxideEnvTuple, rows: Transaction[]): Promise<string[]> => {
    const open = (rows as PaylinkTransaction[]).filter(
      (link) =>
        link.action === PaylinkActionEnum.PAY &&
        !!link.txHash &&
        !link.isClaimed &&
        !link.isRefunded &&
        !link.isMigrated,
    )
    const portal = portalOf(tuple)
    if (!open.length || !(await portal.isFrozen())) return []
    await holdAtFreeze(tuple)
    await atFrozenAnchor(tuple)
    const freezeEnd = await wallet.node.getBlockData({ archive: await portal.getFreezeArchive() })
    if (!freezeEnd) throw new Error("The source freeze archive has no block")
    const lastFrozenBlock = freezeEnd.header.globalVariables.blockNumber
    const tokenService = await TokenService.create(
      wallet,
      account,
      AztecAddress.fromStringUnsafe(tuple.l2Token),
    )
    const token = await tokenService.getTokenContract()
    const contractService = ContractService.getInstance()
    const paylinkService = new PaylinkService(wallet, account, tokenService, contractService)
    const refunded: string[] = []
    for (const link of open) {
      const funded =
        link.blockNumber ??
        (await wallet.node.getTxReceipt(TxHash.fromString(link.txHash!))).blockNumber
      if (funded === undefined || funded > lastFrozenBlock) continue
      // The link's own material only: one escrow, or none when it does not rebuild.
      const escrows = await discoverFrozenEscrows({
        paylinkService,
        escrows: { wallet, contractService },
        events: { headBlock: async () => 0, listIncoming: async () => [] },
        account: account.getAddress(),
        masterSecret: o.masterSecret,
        hints: await creatorLinksFromRows([link]),
      })
      if (escrows.length !== 1) continue
      const refundable = await readFrozenEscrowNotes(tuple, {
        portal,
        token,
        node: wallet.node,
        escrows,
      })
      if (!refundable.length) refunded.push(link.txHash!)
    }
    return refunded
  }
  return {
    address: account.getAddress().toString(),
    rollupAddress: o.rollupAddress,

    // v5's own sync, each part as the v5 wallet runs it on boot, over one store of its own. A part
    // that reads short is named in `short`, and the import retries the history next boot.
    history: (scan) =>
      takeTurn(async () => {
        const { tuple } = scan
        const short: string[] = []
        await holdAtFreeze(tuple)
        const tokenService = await prepareSipaScan(scan)
        setActiveNetworkId(o.rollupAddress)
        const items = new Map<string, string>()
        const storage: IStorageAdapter = {
          getItem: async (key) => items.get(key) ?? null,
          setItem: async (key, value) => void items.set(key, value),
          removeItem: async (key) => void items.delete(key),
          clear: async () => items.clear(),
        }
        const transactions = fresh(TransactionStorage, storage)
        const withdrawals = fresh(WithdrawalStorage, storage)
        const deposits = fresh(SIPADepositStore, storage)
        const accountAddress = account.getAddress().toString()
        const contractService = ContractService.getInstance()
        const info = await tokenService.fetchTokenInformation()
        const token = { address: tuple.l2Token, symbol: info.symbol, decimals: info.decimals }
        const source = createTransferEventSource({
          wallet,
          tokenAddress: tuple.l2Token,
          accountAddress,
          contractService,
        })

        // Counterparty tags the host verified on this rollup, by lowercase L2 address.
        const tagged = new Map<string, string>()
        let caughtUp = false
        const scanner = new TransferEventScanner({
          source,
          storage,
          transactionStore: transactions,
          tags: {
            resolveL2: async (tag) => {
              const l2Address = await scan.resolveTag?.(tag)
              return l2Address ? { l2Address } : null
            },
          },
          contacts: {
            findByL2Address: async (address) => {
              const tag = tagged.get(address.toLowerCase())
              return tag ? { tag } : null
            },
            registerL2: async ({ tag, l2Address }) => void tagged.set(l2Address.toLowerCase(), tag),
          },
          token,
          onCaughtUp: () => {
            caughtUp = true
          },
        })
        try {
          await scanner.start({
            accountAddress,
            accountTag: scan.accountTag,
            networkId: o.rollupAddress,
          })
        } finally {
          scanner.stop()
        }
        if (!caughtUp) short.push("transfers")
        // A send row keeps the recipient's address in `to`; the view names it by `toTag`.
        for (const tx of await transactions.getTransactions()) {
          const to = tx.action === TokenActionEnum.SEND ? (tx as { to?: string }).to : undefined
          const tag = to && tagged.get(to.toLowerCase())
          if (!tag) continue
          await transactions.updateTransaction(
            (row) => row.txHash === tx.txHash,
            (row) => void ((row as { toTag?: string }).toTag = tag),
          )
        }

        // The rescan defers a link whose note it cannot read, and holds its cursor for a later
        // pass.
        const paylinks = new PaylinkService(wallet, account, tokenService, contractService)
        let deferredLink = false
        await rebuildPaylinks({
          source,
          storage,
          accountAddress,
          masterSecret: o.masterSecret,
          networkId: o.rollupAddress,
          paylinkService: {
            recoverPaylinkFromTransfer: (...args) => paylinks.recoverPaylinkFromTransfer(...args),
            isPaylinkClaimed: (...args) => paylinks.isPaylinkClaimed(...args),
            sync_note: (...args) =>
              paylinks.sync_note(...args).catch((error: unknown) => {
                deferredLink = true
                throw error
              }),
          },
          linkFor: (params) => `${scan.linkBase}${encodePaylinkInline(params)}`,
          store: transactions,
          token,
        })
        if (deferredLink) short.push("payment links")
        for (const txHash of await refundedLinks(tuple, await transactions.getTransactions()))
          await markPaylinkMigrated(txHash, transactions)

        await rebuildWithdrawals({
          source: createWithdrawEventSource({
            wallet,
            tokenAddress: tuple.l2Token,
            accountAddress,
          }),
          store: withdrawals,
          tokenSymbol: info.symbol,
          deployment: { portal: tuple.portal as Hex, l2Token: tuple.l2Token },
        })
        // ponytail: one pass settles what the portal released; a burn still moving stays behind, as
        // the import leaves any.
        const finalization = new L1WithdrawalFinalizationReader(client as never, {
          portal: tuple.portal as Hex,
        })
        await fresh(WithdrawalTrackingService, {
          store: withdrawals,
          node: wallet.node,
          finalizationReader: finalization,
          portalContext: {
            l1Portal: tuple.portal as Hex,
            l2Portal: tuple.l2Token,
            rollupVersion: BigInt(tuple.rollupVersion),
            l1ChainId: BigInt(o.l1ChainId),
          },
        }).syncOnce()
        // The pass logs a failed read and moves on. A burn left unmined, or released but unseen,
        // is a short read; one proven and not yet released is still moving.
        for (const record of withdrawals.list()) {
          const missed =
            record.phase === "l2_mined" ||
            (record.phase === "finalizing_l1" &&
              (!record.withdrawalId || (await finalization.isSpent(record.withdrawalId))))
          if (missed) short.push(`withdrawal ${record.l2TxHash}`)
        }

        // v5's Savings pass over those burns. Its claim is a `store_deposit` simulation.
        const byPortal = new Map(
          (scan.deployments ?? [tuple]).map((t) => [t.portal.toLowerCase(), t]),
        )
        const claimers = new Map<string, Promise<TokenService>>()
        const destination = (t: OxideEnvTuple) => ({
          portal: t.portal as Address,
          token: t.token as Address,
          fromBlock: BigInt(t.deployedAtBlock ?? 0),
          claimer: () => {
            if (!claimers.has(t.l2Token))
              claimers.set(
                t.l2Token,
                TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(t.l2Token)),
              )
            return claimers.get(t.l2Token)!
          },
        })
        const moves = fresh(SavingsMoveStorage, storage)
        const settleDeps = {
          publicClient: client,
          masterSecret: o.masterSecret,
          recipient: account.getAddress(),
          // ponytail: every rebuilt move names its factory, so `destinationFor` decides.
          main: destination(tuple),
          savings: destination(tuple),
          destinationFor: async (move: { direction: "in" | "out"; factory: Address }) => {
            const portals = await readSkyFactoryPortals(client, move.factory)
            const portal = move.direction === "in" ? portals.sUsdsPortal : portals.daiPortal
            const target = byPortal.get(portal.toLowerCase())
            if (!target) throw new Error(`No source deployment at the move's portal ${portal}`)
            return destination(target)
          },
        }
        // A pass searches a bounded window for each deposit; one that moved a cursor has more to read.
        let cursors: string | undefined
        for (;;) {
          await settleSavingsMoves(moves, settleDeps, withdrawals.list())
          // The pass logs a failed search and moves on; a refused claim leaves the move unclaimed.
          const failed = moves
            .list()
            .filter((move) => move.lastCheck?.message.startsWith("search failed"))
          if (failed.length) {
            short.push(...failed.map((move) => `Savings move ${move.escrow}`))
            break
          }
          const next = JSON.stringify(
            moves.list().flatMap((move) => (move.deposit ? [] : [move.depositScanFrom])),
          )
          if (next === cursors) break
          cursors = next
        }

        const depositToken = { ...token, address: tuple.token as Address }
        // The sync logs a failed node read and moves on: a failed spent-deposit lookup leaves a
        // claimed deposit unsettled here, so any one is a short read.
        let nodeFailed = false
        const depositNode = new Proxy(wallet.node, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver)
            if (!DEPOSIT_NODE_READS.has(key) || typeof value !== "function") return value
            return (...args: unknown[]) =>
              (value as (...a: unknown[]) => Promise<unknown>)
                .apply(target, args)
                .catch((error: unknown) => {
                  nodeFailed = true
                  throw error
                })
          },
        })
        const syncDeposits = () =>
          syncSipaDeposits({
            publicClient: client,
            node: depositNode as never,
            wallet,
            // A stored deposit has no nullifier until it is spent; only its claim, a simulation,
            // reads it as claimed.
            tokenService,
            store: deposits,
            tuple,
            recipient: account.getAddress(),
            stealthPublicKey: {
              x: BigInt(scan.stealthPublicKey.x),
              y: BigInt(scan.stealthPublicKey.y),
            },
            masterNullifierHidingKey: deriveMasterNullifierHidingSecretKey(o.masterSecret),
            recoveryAccount: scan.recoveryAccount as Address | undefined,
            // ponytail: the deposit token alone; a sweep still settles a USDC or USDT deposit, only
            // its funding attribution is unread.
            token: depositToken,
            l1ChainId: o.l1ChainId,
            historyStartBlock: async (head) =>
              (await deploymentScanRange(client, tuple, head)).fromBlock,
          })
        // A pass reads an address it adopts only on the next pass, as the v5 wallet's next sync
        // does.
        for (let pass = 0; ; pass++) {
          const known = deposits.list().length
          const synced = await syncDeposits()
          if (!synced.failed && !nodeFailed && deposits.list().length === known) break
          if (synced.failed > 0 || nodeFailed || pass === 3) {
            short.push("deposits")
            break
          }
        }

        return { entries: Object.fromEntries(items), short }
      }),

    async balance({ tuple }) {
      await holdAtFreeze(tuple)
      await registerClaimFpc(tuple)
      const token = AztecAddress.fromStringUnsafe(tuple.l2Token)
      return (await (await TokenService.create(wallet, account, token)).getBalance()).toString()
    },

    async sipaSources(scan) {
      const { tuple } = scan
      await holdAtFreeze(tuple)
      await prepareSipaScan(scan)
      const token = AztecAddress.fromStringUnsafe(tuple.l2Token)
      const events = await fetchSipaEvents(wallet, token, account.getAddress())
      const sources = await deriveRefundableSipaSources({
        events: events.map((event) => ({
          messageSecret: event.sharedSecretSalt.toString(),
          resweepable: event.resweepable,
          intentHash: event.intentHash,
        })),
        recipientL2Address: account.getAddress().toString(),
        stealthPublicKey: {
          x: BigInt(scan.stealthPublicKey.x),
          y: BigInt(scan.stealthPublicKey.y),
        },
        tuple,
        recoveryAccount: scan.recoveryAccount,
      })
      return Promise.all(
        sources.map(async ({ sipaAddress, recipientL2Address, messageSecret }) => ({
          sipaAddress,
          recipientL2Address,
          messageSecret,
          recipientCommitment: (
            await computeStealthRecipientHash(
              Fr.fromString(messageSecret),
              AztecAddress.fromStringUnsafe(recipientL2Address),
            )
          ).toString(),
        })),
      )
    },

    async savingsMoves({ tuple }) {
      await holdAtFreeze(tuple)
      await registerClaimFpc(tuple)
      await TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(tuple.l2Token))
      const source = createWithdrawEventSource({
        wallet,
        tokenAddress: tuple.l2Token,
        accountAddress: account.getAddress().toString(),
      })
      const events = await source.listWithdrawals(1, (await source.headBlock()) + 1)
      return events.flatMap(({ sky }) =>
        sky
          ? [
              {
                direction: sky.route === savingsRoute("in") ? ("in" as const) : ("out" as const),
                factory: sky.factory,
                nonce: sky.nonce,
                recipientCommitment: sky.recipientCommitment,
              },
            ]
          : [],
      )
    },

    // Mirrors v5's `frozenSourceSummary`, and also sums what the waiting deposits hold.
    async frozenSummary({ tuple, depositDescriptors, paylinkRows }) {
      await holdAtFreeze(tuple)
      await registerClaimFpc(tuple)
      const portal = portalOf(tuple)
      if (!(await portal.isFrozen())) return undefined
      await atFrozenAnchor(tuple)
      const tokenService = await TokenService.create(
        wallet,
        account,
        AztecAddress.fromStringUnsafe(tuple.l2Token),
      )
      const token = await tokenService.getTokenContract()
      const [notes, links, deposits] = await Promise.all([
        readFrozenNotes(tuple, {
          portal,
          token,
          node: wallet.node,
          owner: account.getAddress(),
          resolveSpendMetadata: await account.makeSpendMetadataResolver(),
        }),
        readFrozenEscrowNotes(tuple, {
          portal,
          token,
          node: wallet.node,
          escrows: await escrows(tuple, paylinkRows),
        }),
        readRefundableFrozenDeposits({
          portal,
          inbox: await depositInbox(client as unknown as ViemClient, portal),
          node: wallet.node,
          depositMetadata: await (
            await account.makeDepositSpendMetadataResolver()
          )(account.getAddress()),
          descriptors: await depositDescriptors(),
        }),
      ])
      let ready = 0
      let waiting = 0
      let waitingAmount = 0n
      for (const deposit of deposits) {
        if (!deposit.waits) {
          ready++
          continue
        }
        waiting++
        waitingAmount += BigInt(deposit.descriptor.amount)
      }
      return {
        notes: notes.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n).toString(),
        links: links.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n).toString(),
        deposits: ready,
        waiting,
        waitingAmount: waitingAmount.toString(),
      }
    },

    refundedLinks: async ({ tuple, paylinkRows }) =>
      refundedLinks(tuple, (await paylinkRows()) as Transaction[]),

    async refundRuntime({ tuple, tipRecipient, depositDescriptors, paylinkRows }) {
      if (!tuple.plainWithdrawalExecutor)
        throw new Error("The frozen source has no withdrawal executor")
      await holdAtFreeze(tuple)
      await registerClaimFpc(tuple)
      const portal = portalOf(tuple)
      const teeSigner = await loadTeeSigner(
        tuple.enclaveUrl,
        portal.address.toString() as never,
        client as never,
      )
      const [info, tokenService, inbox] = await Promise.all([
        wallet.node.getNodeInfo(),
        TokenService.create(
          wallet,
          account,
          AztecAddress.fromStringUnsafe(tuple.l2Token),
          teeSigner,
        ),
        portal.getInbox(),
      ])
      const token = await tokenService.getTokenContract()
      const owner = await passkeyRefundOwner(wallet, account)
      const resolveSpendMetadata = await account.makeSpendMetadataResolver()
      const read = { portal, token, node: wallet.node }
      return plainRuntime(
        new FrozenRefundMigrationRuntime({
          node: wallet.node,
          pxe: wallet.pxe,
          token,
          portal,
          inbox: new InboxContract(client as unknown as ViemClient, inbox),
          rollup: info.l1ContractAddresses.rollupAddress.toString() as Address,
          rollupVersion: BigInt(info.rollupVersion),
          owner,
          resolveSpendMetadata,
          depositMetadata: await (
            await account.makeDepositSpendMetadataResolver()
          )(account.getAddress()),
          depositDescriptors,
          escrows: ({ fresh }) => escrows(tuple, paylinkRows, fresh),
          teeSigner,
          executor: EthAddress.fromString(tuple.plainWithdrawalExecutor),
          withdrawalSubsidy: tuple.withdrawalSubsidy
            ? EthAddress.fromString(tuple.withdrawalSubsidy)
            : undefined,
          tipRecipient: EthAddress.fromString(tipRecipient),
        }),
        {
          notes: (fresh) =>
            readFrozenNotes(tuple, { ...read, owner: owner.address, resolveSpendMetadata }, fresh),
          escrowNotes: (escrows, fresh) =>
            readFrozenEscrowNotes(tuple, { ...read, escrows }, fresh),
        },
      )
    },
  }
}

/** `run`'s result under `key`, shared by concurrent and later callers; a failure is not kept. */
function memo<T>(cache: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  let pending = cache.get(key)
  if (!pending) {
    pending = run()
    cache.set(key, pending)
    const kept = pending
    kept.catch(() => {
      if (cache.get(key) === kept) cache.delete(key)
    })
  }
  return pending
}

// A copy of v5's unexported `depositInbox` in FrozenRefundMigrationRuntime.ts.
async function depositInbox(client: ViemClient, portal: OxidePortalContract) {
  return new InboxContract(client, await portal.getInbox())
}

/** The v5 runtime's executor call: an executor and its payloads, as v5's portal encodes them. */
interface V5ExecutorCall {
  executor: EthAddress
  userPayload: Buffer
  relayerPayload: Buffer
}

/**
 * The v5 runtime builds each refund's executor call in its private `executorCall`: the call of the
 * source's plain withdrawal executor. The host selects the call now, so `build` runs on a view of
 * the runtime whose `executorCall` gives the host's call. The view reads the runtime's state
 * through its prototype, and one build's call never reaches another build.
 */
type ExecutorCallOf = (recipient: Address, relayerTip: bigint) => V5ExecutorCall

function executorCallOf(runtime: FrozenRefundMigrationRuntime): ExecutorCallOf {
  const method = (runtime as unknown as { executorCall?: ExecutorCallOf }).executorCall
  if (typeof method !== "function")
    throw new Error("The v5 refund runtime has no executor call to replace")
  return method.bind(runtime)
}

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

const hex = (bytes: Buffer) => `0x${bytes.toString("hex")}`

function fromHex(value: string, name: string): Buffer {
  if (!HEX.test(value)) throw new Error(`The executor call's ${name} is not hex`)
  return Buffer.from(value.slice(2), "hex")
}

function v5ExecutorCall(call: SourceExecutorCall): V5ExecutorCall {
  return {
    executor: EthAddress.fromString(call.executor),
    userPayload: fromHex(call.userPayload, "user payload"),
    relayerPayload: fromHex(call.relayerPayload, "relayer payload"),
  }
}

function plainRuntime(
  runtime: FrozenRefundMigrationRuntime,
  reads: {
    notes(fresh: boolean): ReturnType<typeof readRefundableFrozenNotes>
    escrowNotes(
      escrows: FrozenEscrow[],
      fresh: boolean,
    ): ReturnType<typeof readRefundableEscrowNotes>
  },
): SourceRefundRuntime {
  const plainCall = executorCallOf(runtime)
  // The Inbox leaf of each deposit a read classified.
  const leaves = new Map<string, string>()
  // The runtime's memos live on `runtime`, so a call through any view keeps them. The runtime's
  // `notes()` takes no fresh flag, so a fresh `candidates` runs on a view whose reads are fresh.
  const view = (freshNotes: boolean): FrozenRefundMigrationRuntime =>
    Object.create(runtime, {
      notes: { value: () => reads.notes(freshNotes) },
      escrowNotes: {
        value: async (fresh = false) =>
          reads.escrowNotes(await runtime["readEscrows"](fresh), fresh),
      },
      deposits: {
        value: async (fresh?: boolean) => {
          const read = await runtime["deposits"](fresh)
          for (const { id, descriptor } of read) leaves.set(id, descriptor.messageLeafIndex)
          return read
        },
      },
    })
  const base = view(false)
  const freshBase = view(true)
  return {
    identity: runtime.identity,
    validate: (destinationAsset) => runtime.validate(destinationAsset as Address),
    candidates: async (opts) => {
      const { waiting, maxBatchAmount, ...read } = await runtime.candidates.call(
        opts?.fresh ? freshBase : base,
        opts,
      )
      return {
        ...read,
        candidates: read.candidates.map((c) => {
          const leafIndex = leaves.get(c.id)
          return leafIndex === undefined ? c : { ...c, leafIndex }
        }),
        maxBatchAmount: maxBatchAmount.toString(),
        ...(waiting === undefined ? {} : { waiting: waiting.toString() }),
      }
    },
    plainExecutorCall: async (recipient, relayerTip) => {
      const call = plainCall(recipient as Address, BigInt(relayerTip))
      return {
        executor: call.executor.toString(),
        userPayload: hex(call.userPayload),
        relayerPayload: hex(call.relayerPayload),
      }
    },
    build: async (selection, executorCall) => {
      const call = v5ExecutorCall(executorCall)
      const view: FrozenRefundMigrationRuntime = Object.create(base, {
        executorCall: { value: (() => call) satisfies ExecutorCallOf },
      })
      // The tip is in the host's user payload. The host checks that the amount covers it.
      const built = await runtime.build.call(
        view,
        selection,
        call.executor.toString() as Address,
        0n,
      )
      return {
        amount: built.amount.toString(),
        operation: {
          target: built.operation.target.toString(),
          payoutToken: built.operation.payoutToken.toString(),
          calldata: hex(built.operation.calldata),
        },
      }
    },
    refunded: (ids) => runtime.refunded(ids),
  }
}

void ({ protocol, aztecVersion, accountAddress, open } satisfies SourceGenerationModule)
