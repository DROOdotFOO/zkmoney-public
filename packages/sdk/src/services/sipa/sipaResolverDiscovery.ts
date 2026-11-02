/**
 * SIPA resolver-operator discovery — the L1 `AccountMetadataRegistry` reads that locate
 * the Labs operator's L2 broadcast account. The env manifest does not carry that address;
 * the on-chain `ResolverOperator` record is the only source. The caller
 * feeds `l2Address` to `pxe.registerSender`
 * so the PXE can discover the operator's broadcast SIPA notes.
 *
 * The registry keeps no operator enumeration, so the candidate set comes from the
 * `ResolverOperatorUpdated` history: one log per (re-)registration, deduped by
 * operator address, then each survivor's current record read back on-chain.
 *
 * Lives in sdk because these are contract reads; front-core never originates
 * a contract call.
 */

import type { Address, Hex, PublicClient } from "viem"
import {
  AccountMetadataRegistryAbi,
  getUserRecord,
  hasUserRecord,
  readResolverOperator,
} from "@oxide/l1-contracts"
import { readResolverOperatorHistory } from "@oxide/l1-contracts/resolver_operator_history.js"
import { chunkedContractEvents } from "../helpers/l1Logs.js"
import { Network } from "@obsidion/core/constants"
import type { SipaK1Point } from "./sipaStealth.js"

export interface SipaResolverOperatorRecord {
  /** The operator's L1 record-owner EOA (the `setResolverOperator` caller). */
  owner: Address
  /** The L2 account the operator broadcasts SIPA notes from — the `registerSender` target. */
  l2Address: Hex
  /** The operator's CCIP gateway URL template. */
  url: string
  /** The ForwardingTable the operator's SIPAs commit to. */
  forwardingTable: Address
  /** The operator's stealth-derivation key — the ECDH counterparty a self-resolving
   * recipient derives against, not the recipient's own key. */
  resolverPublicKey: SipaK1Point
}

/**
 * Every resolver operator the AccountMetadataRegistry recorded in `range`, at its current values.
 * An operator whose record was never written (or was zeroed) is dropped — an empty `url` is the
 * registry's uninitialized sentinel.
 *
 * `range` is required and has no default: selection here is an anti-squatter decision, and a window
 * that hides the legitimate operator while showing a recent impostor turns the preferred-owner
 * tie-break and the mainnet ambiguity check into a silent first-match. Pass a window that starts
 * at or before the deployment whose portal you will select for — its record cannot predate it.
 */
export async function fetchSipaResolverOperators(
  publicClient: PublicClient,
  accountMetadataRegistry: Address,
  range: { fromBlock: bigint; toBlock: bigint },
): Promise<SipaResolverOperatorRecord[]> {
  const logs = await chunkedContractEvents(
    publicClient,
    {
      address: accountMetadataRegistry,
      abi: AccountMetadataRegistryAbi,
      eventName: "ResolverOperatorUpdated",
    },
    range.fromBlock,
    range.toBlock,
  )
  const owners = [
    ...new Map(
      logs
        .map((log) => (log as { args?: { resolverOperator?: Address } }).args?.resolverOperator)
        .filter((owner): owner is Address => !!owner)
        .map((owner) => [owner.toLowerCase(), owner] as const),
    ).values(),
  ]
  const records = await Promise.all(
    owners.map(async (owner) => {
      const {
        l2Address,
        url,
        oxidePortal: forwardingTable,
        publicKey: resolverPublicKey,
      } = await readResolverOperator(publicClient, accountMetadataRegistry, owner)
      return { owner, l2Address, url, forwardingTable, resolverPublicKey }
    }),
  )
  return records.filter((record) => record.url.length > 0)
}

/** What the resolver reads to derive an address for `account`: its user record and the operator it names. */
export interface AccountResolution {
  l2Address: Hex
  rollupVersion: bigint
  /** The account's registered stealth key. */
  publicKey: SipaK1Point
  operator: SipaResolverOperatorRecord
}

/**
 * The user record of `account` and the operator entry it names, read the way the resolver gateway
 * reads them before it derives an address. Null when `account` has no record (`getUserRecord`
 * reverts on one).
 */
export async function readAccountResolution(
  publicClient: PublicClient,
  accountMetadataRegistry: Address,
  account: Address,
): Promise<AccountResolution | null> {
  if (!(await hasUserRecord(publicClient, accountMetadataRegistry, account))) return null
  const user = await getUserRecord(publicClient, accountMetadataRegistry, account)
  const entry = await readResolverOperator(
    publicClient,
    accountMetadataRegistry,
    user.resolverOperator,
  )
  return {
    l2Address: user.l2Address,
    rollupVersion: user.rollupVersion,
    publicKey: user.publicKey,
    operator: {
      owner: user.resolverOperator,
      l2Address: entry.l2Address,
      url: entry.url,
      forwardingTable: entry.oxidePortal,
      resolverPublicKey: entry.publicKey,
    },
  }
}

/**
 * The known Labs resolver-operator EOA on the CURRENT staging deployment, used ONLY
 * as the anti-squatter tie-break (`preferredOwner`) when selecting among
 * manifest-matched operator records — `setResolverOperator` is permissionless and
 * the owner key is the one record field a squatter cannot copy. It is NOT authoritative
 * and MUST NOT be recorded into `UserRecord.resolverOperator` directly: operators rotate on
 * oxide deployment rolls, and a stale owner baked into the user record makes every
 * subsequent resolve of that tag revert with
 * `AccountMetadataRegistry__ResolverOperatorNotFound`. Staleness HERE degrades gracefully
 * (selection falls back to the manifest-matched record) but silently forfeits the squatter
 * defense — refresh this alongside the vendor pin on each roll (the live staging registry's
 * `ResolverOperatorUpdated` history).
 */
export const PREFERRED_RESOLVER_OWNER: Address = "0xe959F1c4F84C55c10114f3FA46a8DcFB51ab8d30"

/**
 * Per-network anti-squatter policy for `selectManifestResolverOperator`, shared by
 * ALL resolver-operator callers (signup, SIPA deposit discovery, and the ClaimFPC deploy that pins
 * the operator key its users must derive against) so they can't drift — a deploy pinning one
 * resolver's key while clients derive against another rejects every proof.
 * Testnet/sandbox use the known staging operator as the `preferredOwner`
 * tie-break; the first mainnet build ships with NO known operator and instead
 * fails closed on multiple manifest-matching candidates rather than silently
 * first-matching. If oxide later designates a canonical mainnet resolver owner
 * it becomes a manifest/config value.
 */
export function resolverSelectionPolicy(network: Network): {
  preferredOwner?: Address
  failOnAmbiguousMatch: boolean
} {
  return network === Network.MAINNET
    ? { failOnAmbiguousMatch: true }
    : { preferredOwner: PREFERRED_RESOLVER_OWNER, failOnAmbiguousMatch: false }
}

/**
 * Pick the operator whose record matches the manifest's forwarding table (+ gateway URL
 * when the manifest carries one) — i.e. the operator publishing for the
 * CURRENT deployment. Operator records survive deployment rolls, so a
 * multi-record array can contain stale entries pointing at retired tables;
 * selecting one of those would register a sender that never broadcasts for
 * deposits on the live portal. `setResolverOperator` is permissionless, so a
 * squatter can also register manifest-matching values — callers that know
 * the operator's EOA pass it as `preferredOwner`, which wins over any other
 * candidate (a squatter can copy every record field except the owner key).
 * A caller with no known operator (e.g. the first mainnet build) sets
 * `failOnAmbiguousMatch` so multiple manifest-matching candidates fail closed
 * rather than silently first-matching a possible squatter.
 */
export function selectManifestResolverOperator(
  records: SipaResolverOperatorRecord[],
  manifest: {
    forwardingTable: string
    resolverGatewayUrl?: string
    preferredOwner?: string
    failOnAmbiguousMatch?: boolean
  },
): SipaResolverOperatorRecord {
  const candidates = records.filter(
    (record) =>
      record.forwardingTable.toLowerCase() === manifest.forwardingTable.toLowerCase() &&
      (!manifest.resolverGatewayUrl || record.url === manifest.resolverGatewayUrl),
  )
  if (candidates.length === 0) {
    throw new Error(
      `no resolver-operator record matches the manifest forwarding table ${manifest.forwardingTable} ` +
        `(${records.length} registered operator(s))`,
    )
  }
  const preferred =
    manifest.preferredOwner &&
    candidates.find(
      (record) => record.owner.toLowerCase() === manifest.preferredOwner!.toLowerCase(),
    )
  if (preferred) return preferred
  if (manifest.failOnAmbiguousMatch && candidates.length > 1) {
    throw new Error(
      `${candidates.length} resolver-operator records match the manifest forwarding table ` +
        `${manifest.forwardingTable} ` +
        `and no preferred owner disambiguates them — refusing to first-match ` +
        `(anti-squatter fail-closed).`,
    )
  }
  return candidates[0]!
}

type OperatorHistory = Awaited<ReturnType<typeof readResolverOperatorHistory>>

/** Blocks re-read below the cursor, so a reorged log is replaced. */
const HISTORY_REORG_OVERLAP_BLOCKS = 128n

/** The operator history read so far, by chain, registry and start block: its logs and the block they run to. */
const operatorHistories = new Map<string, Promise<{ logs: OperatorHistory; through: bigint }>>()

export function resetResolverOperatorHistoryForTests(): void {
  operatorHistories.clear()
}

/**
 * The registry's operator history over `range`. Each session reads a registry's history once and then only the blocks
 * past what it read, so every scan of one deployment shares one read.
 */
function operatorHistory(
  publicClient: PublicClient,
  registry: Address,
  range: { fromBlock: bigint; toBlock: bigint },
): Promise<OperatorHistory> {
  const key = `${publicClient.chain?.id ?? "?"}:${registry.toLowerCase()}:${range.fromBlock}`
  const known = operatorHistories.get(key)
  const read = (async () => {
    const cached = await known?.catch(() => undefined)
    if (cached && cached.through >= range.toBlock) return cached
    const overlap = cached ? cached.through + 1n - HISTORY_REORG_OVERLAP_BLOCKS : range.fromBlock
    const fromBlock = overlap > range.fromBlock ? overlap : range.fromBlock
    const fresh = await readResolverOperatorHistory(publicClient, registry, {
      fromBlock,
      toBlock: range.toBlock,
    })
    const kept = cached?.logs.filter((log) => log.blockNumber < fromBlock) ?? []
    return { logs: [...kept, ...fresh], through: range.toBlock }
  })()
  operatorHistories.set(key, read)
  // A failed read keeps what was read before it.
  read.catch(() => {
    if (operatorHistories.get(key) !== read) return
    if (known) operatorHistories.set(key, known)
    else operatorHistories.delete(key)
  })
  return read.then(({ logs }) => logs.filter((log) => log.blockNumber <= range.toBlock))
}

/** Historical senders for one deployment, including rotations by its selected operator. */
export async function fetchHistoricalSipaResolverOperators(
  publicClient: PublicClient,
  accountMetadataRegistry: Address,
  range: { fromBlock: bigint; toBlock: bigint },
  manifest: Parameters<typeof selectManifestResolverOperator>[1],
): Promise<SipaResolverOperatorRecord[]> {
  const history = await operatorHistory(publicClient, accountMetadataRegistry, range)
  const records = history
    .map(({ owner, entry }) => ({
      owner,
      l2Address: entry.l2Address,
      url: entry.url,
      forwardingTable: entry.oxidePortal,
      resolverPublicKey: entry.publicKey,
    }))
    .filter(
      (record) =>
        record.forwardingTable.toLowerCase() === manifest.forwardingTable.toLowerCase() &&
        (!manifest.resolverGatewayUrl || record.url === manifest.resolverGatewayUrl),
    )
  const latest = [
    ...new Map(records.map((record) => [record.owner.toLowerCase(), record])).values(),
  ]
  const selected = selectManifestResolverOperator(latest, manifest)
  return [
    ...new Map(
      records
        .filter((record) => record.owner.toLowerCase() === selected.owner.toLowerCase())
        .map((record) => [record.l2Address.toLowerCase(), record]),
    ).values(),
  ]
}

/**
 * Every resolver key the registry published over `range`, from any operator. A registration address
 * salted before the self-SIPA key used the signup resolver's key of its day, which a later rotation
 * may have replaced.
 */
export async function fetchHistoricalResolverPublicKeys(
  publicClient: PublicClient,
  accountMetadataRegistry: Address,
  range: { fromBlock: bigint; toBlock: bigint },
): Promise<SipaK1Point[]> {
  const history = await operatorHistory(publicClient, accountMetadataRegistry, range)
  return [
    ...new Map(
      history.map(({ entry: { publicKey } }) => [`${publicKey.x}:${publicKey.y}`, publicKey]),
    ).values(),
  ]
}
