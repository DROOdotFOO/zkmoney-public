/**
 * The self-sweep exit in the browser: the user submits the relayer's own deploy-and-sweep
 * transaction for a deposit no relayer picked up, pushing the funds FORWARD into the portal and on
 * into their private balance. Any EOA may submit it; the deposit fee returns to whoever is named as
 * `relayer`, which here is the user's own L1 address.
 *
 * A received deposit is the deposit intent: the deploy-and-sweep binds the SIPA clone to
 * `(depositImplementation, intentHash = keccak256(abi.encode(recipientCommitment)))` and reveals
 * `abi.encode(recipientCommitment)` at sweep with no proofs. The intent builders + calldata come
 * from the SIPA-intents lib (via the local mirror until it vendors); this file supplies the browser
 * collaborators — the manifest addresses the create2 derivation binds to, the deposit
 * implementation read, the pre-submit funding read, and the submission channel it shares with the
 * recovery exit.
 *
 * Nothing is settled here. A confirmed sweep only moves the funds into the portal; the L2 claim is
 * the sync loop's job on its next pass, which reads the very `Sweep` event this transaction emits.
 */
import {
  createPublicClient,
  formatUnits,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { depositPayoutTokenFor } from "@oxide/l1-contracts"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  buildDepositIntent,
  buildSipaSweepCall,
  classifyPortalCapError,
  readDepositSIPAImplementation,
  readSipaFundingStatus,
  readSipaPortalTerms,
  SELF_BROADCAST_RESWEEPABLE,
  type PortalCapErrorKind,
  type SipaSweepDeployArgs,
  type SipaFundingStatus,
} from "@obsidion/sdk"
import {
  computeSIPAAddress,
  computeAccountSIPAAddress,
  depositAmounts,
  SIPADepositStore,
  sipaIntentName,
  sipaRecordIntent,
  sipaRecordRoute,
  sipaSweepAllowed,
  type SIPADepositRecord,
  type SipaProcessingState,
  type SipaSweepBlocker,
  type SipaSweepSubject,
} from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import { getConfig, l1Transport, type WebWalletConfig } from "../../config/env"
import { getOxideTuple, requireTupleField } from "../../config/oxideTuple"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { WebStorageAdapter } from "../../platform/storage/WebStorageAdapter"
import { sipaProcessingObserver } from "./sipaProcessing"
import {
  loadDepositTokens,
  settlementOf,
  tokenMetadata,
  type DepositTokens,
} from "./loadDepositFacts"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "./sipaRecovery"

/**
 * A sweep stopped for a reason the user can act on: capacity, the per-deposit ceiling or a frozen portal. The sheet
 * shows it beside the action instead of reporting it as a fault.
 */
export class SweepRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SweepRefusedError"
  }
}

/** The address is already empty: the relayer won the race and the funds are on their way. Not a fault. */
export class AlreadySweptError extends Error {
  constructor() {
    super("This deposit has already been swept. It will appear in your balance shortly.")
    this.name = "AlreadySweptError"
  }
}

/** A zero read on a record without its own token was against the current deployment's token, so it proves nothing. */
export const UNTRACKED_TOKEN_ZERO =
  "This deposit reads as already swept, but it predates token tracking — if it was made on an older deployment, report it from Settings before assuming the funds moved."

const RECOVER_INSTEAD = "Recover it to an Ethereum address instead."

const BLOCKED: Record<SipaSweepBlocker["kind"], string> = {
  "capacity":
    "Network capacity is currently insufficient for this deposit, so the sweep was stopped before signing. Check again later, or recover the deposit.",
  "ceiling": `This deposit is larger than the network's total deposit capacity, so it can't be swept. ${RECOVER_INSTEAD}`,
  "operation-cap": `This deposit is larger than the network can process in one deposit, so it can't be swept. ${RECOVER_INSTEAD}`,
}

const REFUSED: Record<PortalCapErrorKind, string> = {
  "global-limit":
    "Network capacity is currently insufficient for this deposit, so the sweep did not go through. Check again later, or recover the deposit.",
  "tx-limit": BLOCKED["operation-cap"],
  "frozen":
    "The network is not accepting deposits right now, so the sweep did not go through. You can recover the deposit.",
}

/** Re-reads the deposit's portal before a manual sweep and stops it while a blocker is confirmed. */
export async function assertSweepCapacity(
  check: (() => Promise<SipaProcessingState | undefined>) | undefined,
): Promise<void> {
  const state = await check?.()
  if (!sipaSweepAllowed(state)) throw new SweepRefusedError(BLOCKED[state!.blocker!.kind])
}

/**
 * Submit a sweep, turning a portal refusal decoded from the estimate into its own copy. A deploy-and-sweep batch
 * hides the portal's revert, and so does the desktop helper page; those failures pass through unchanged.
 */
export async function submitSweep(channel: L1ExitChannel, to: Address, data: Hex): Promise<Hex> {
  try {
    return await channel.sendTransaction(to, data)
  } catch (err) {
    const kind = classifyPortalCapError(err)
    throw kind ? new SweepRefusedError(REFUSED[kind]) : err
  }
}

/**
 * A reverted receipt carries no reason. A capacity read taken now can show a current blocker, but not that it caused
 * this failure, so the copy says both.
 */
export function revertedSweepMessage(
  hash: Hex,
  state: SipaProcessingState | undefined,
  otherCause: string,
): string {
  const capacity =
    state?.blocker?.kind === "capacity"
      ? " Network capacity is currently insufficient for this deposit."
      : ""
  return `Sweep transaction ${hash} failed, and the wallet could not determine why. ${otherCause}${capacity}`
}

/** The manifest surface the derivation and the sweep bind to. */
export interface SweepManifest {
  sipaFactory: Address
  /** The deployment's ForwardingTable: part of the CREATE2 preimage, and its rows route the sweep. */
  forwardingTable: Address
  portal: Address
  /** Part of the CREATE2 preimage. */
  rollupVersion: bigint
  token: Address
}

export interface SweepDeps {
  channel: L1ExitChannel
  manifest: SweepManifest
  /** The deposit implementation new SIPAs clone (`SIPAFactory.implementationFor`). */
  implementation: Address
  /** The row portal's `TX_AMOUNT_CAP()`. */
  txAmountCap: bigint
  /** Non-empty `getCode` — a deployed SIPA is swept directly, an undeployed one deploy-and-swept. */
  readDeployed: (sipa: Address) => Promise<boolean>
  readFunding: (sipa: Address, token: Address) => Promise<SipaFundingStatus>
  /** Offline create2 prediction (`computeSIPAAddress`), checked before any deploy. */
  predict: (args: SipaSweepDeployArgs) => Promise<Address>
  store: Pick<SIPADepositStore, "upsert" | "get">
  /**
   * A new capacity read of the deposit's own portal, given the funding just read; undefined where
   * no observer runs.
   */
  checkCapacity?: (
    live: Omit<SipaSweepSubject, "sipaAddress">,
  ) => Promise<SipaProcessingState | undefined>
  /** Injectable for tests. */
  build?: typeof buildSipaSweepCall
}

/**
 * The deploy args for `record` as the deposit intent. The recipient's stealth `recipientHash` is
 * the intent's `recipientCommitment`; the clone commits to `(implementation, intentHash)` where
 * `intentHash = keccak256(abi.encode(recipientCommitment))` and `implementation` is the deposit
 * intent type. `resweepable` is the web wallet's own broadcast flag — every address this wallet
 * hands out is derived under it — and the args are checked against `computeSIPAAddress` before they
 * are used, so a record derived under anything else fails closed rather than deploying to a
 * stranger's address.
 */
export function sweepDeployArgs(
  record: Pick<SIPADepositRecord, "recipientHash" | "recoveryAddress" | "origin">,
  manifest: SweepManifest,
  implementation: Address,
): SipaSweepDeployArgs {
  if (record.origin) {
    const origin = record.origin
    const common = {
      implementation: origin.implementation,
      intentHash: origin.intentHash,
      rollupVersion: BigInt(origin.rollupVersion),
      resweepable: origin.resweepable,
    }
    return origin.protocol === "account"
      ? {
          ...common,
          recoveryCommitment: origin.recoveryCommitment,
          forwardingTable: origin.forwardingTable,
        }
      : { ...common, recoveryAddress: origin.recoveryAddress }
  }
  const { intentHash } = buildDepositIntent({
    implementation,
    recipientCommitment: record.recipientHash as Hex,
  })
  return {
    implementation,
    intentHash,
    recoveryAddress: record.recoveryAddress as Address,
    rollupVersion: manifest.rollupVersion,
    resweepable: SELF_BROADCAST_RESWEEPABLE,
  }
}

/**
 * Guard the sweep, then submit it. The funding read is the honest failure: a relayer that won the
 * race leaves nothing to sweep and the transaction would revert in the user's wallet, and a balance
 * that fell to the fee floor or was topped up past the per-operation ceiling can never be swept at all.
 */
export async function selfSweepDeposit(record: SIPADepositRecord, deps: SweepDeps): Promise<Hex> {
  const { manifest } = deps
  if (!record.recipientHash || (!record.recoveryAddress && !record.origin)) {
    throw new Error(
      "This wallet is still looking up this deposit's details. Sweeping becomes available once it has them.",
    )
  }
  const token = record.tokenAddress ?? manifest.token
  const funding = await deps.readFunding(record.sipaAddress, token)
  if (funding.balance === 0n) {
    throw record.tokenAddress ? new AlreadySweptError() : new Error(UNTRACKED_TOKEN_ZERO)
  }
  if (!funding.sweepable) {
    // The fee comes off first, and the ceiling measures what is forwarded after it. `scaledBalance`
    // is the balance in the fee's denomination.
    throw new SweepRefusedError(
      funding.scaledBalance - funding.fee > deps.txAmountCap
        ? BLOCKED["operation-cap"]
        : `This deposit is at or below the network's deposit fee, so it can't be moved into your private balance. ${RECOVER_INSTEAD}`,
    )
  }
  // The rail may not have seen this funding yet.
  const decimals = record.tokenDecimals ?? DEFAULT_DECIMALS
  const live = {
    l1ChainId: record.l1ChainId,
    origin: record.origin,
    phase: record.phase,
    amount: formatUnits(funding.balance, decimals),
    tokenAddress: token,
    tokenDecimals: decimals,
  }
  await assertSweepCapacity(deps.checkCapacity && (() => deps.checkCapacity!(live)))

  // The deposit intent: forward the whole balance to the recipient, no fee, no proofs. The record
  // revealed at sweep is `abi.encode(recipientCommitment)`; the clone delegates to the deposit impl.
  const intent = buildDepositIntent({
    implementation: deps.implementation,
    recipientCommitment: record.recipientHash as Hex,
  })
  const deployed = await deps.readDeployed(record.sipaAddress)
  const deployArgs = sweepDeployArgs(record, manifest, deps.implementation)
  if (!deployed) {
    const predicted = await deps.predict(deployArgs)
    if (predicted.toLowerCase() !== record.sipaAddress.toLowerCase()) {
      throw new Error(
        "These deposit details point to a different address, so the sweep was stopped before signing.",
      )
    }
  }

  const call = (deps.build ?? buildSipaSweepCall)({
    deployed,
    sipaFactory: record.origin?.sipaFactory ?? manifest.sipaFactory,
    sipa: record.sipaAddress,
    deployArgs,
    sweepArgs: {
      token,
      relayer: deps.channel.target,
      intentData: intent.intentData,
      proofs: intent.proofs,
    },
  })

  const hash = await submitSweep(deps.channel, call.to, call.data)
  if (!(await deps.channel.waitForReceipt(hash))) {
    const state = await deps.checkCapacity?.(live).catch(() => undefined)
    throw new Error(
      revertedSweepMessage(
        hash,
        state,
        "A relayer may have swept this deposit first, in which case it is already on its way into your balance.",
      ),
    )
  }
  // Deliberately not terminal: the funds are in the portal, not the balance. The record stays on
  // the fast scan lane, and the next sync reads this very transaction's `Sweep` event and drives
  // the claim. `sweepTxHash` on a `sweeping` record is the "submitted" marker both exits check.
  //
  // Re-read rather than echo the snapshot: a sync pass can claim the deposit while the receipt is
  // awaited, and writing `sweeping` back over `claimed` never heals — later scans short-circuit on
  // `claimedInboxIndexes` and leave the row pending forever.
  const phase = deps.store.get(record.sipaAddress)?.phase ?? "sweeping"
  await deps.store.upsert(record.sipaAddress, { phase, sweepTxHash: hash })
  return hash
}

/** The manifest fields a sweep cannot be built without. */
export function sweepManifestFrom(tuple: OxideEnvTuple): SweepManifest {
  const rollupVersion = requireTupleField(tuple, "rollupVersion")
  if (!/^\d+$/.test(rollupVersion)) {
    throw new Error(`oxide manifest has a non-numeric rollupVersion ("${rollupVersion}")`)
  }
  return {
    sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
    forwardingTable: requireTupleField(tuple, "forwardingTable") as Address,
    portal: requireTupleField(tuple, "portal") as Address,
    rollupVersion: BigInt(rollupVersion),
    token: requireTupleField(tuple, "token") as Address,
  }
}

export interface SelfSweepOptions {
  /** Required in bridge mode: the address the deposit fee is paid to. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting (and tipped) account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/**
 * Where the sweep is signed. An injected wallet both pays the gas and takes the tip; the desktop
 * launcher's Chrome profile has no wallet extension, so the prepared transaction goes to a helper
 * page in the user's default browser and the tip goes to the address they typed.
 */
export async function sweepChannel(params: {
  config: WebWalletConfig
  record: Pick<SIPADepositRecord, "sipaAddress" | "tokenSymbol" | "amount" | "netAmount" | "fee">
  /** App-owned client: the helper page's wallet is not ours to poll. */
  publicClient: PublicClient
  opts: SelfSweepOptions
}): Promise<L1ExitChannel> {
  const { config, record, opts } = params
  if (!isDesktopL1SubmitActive()) {
    return await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }
  const destination = opts.destination
  if (!destination || !isAddress(destination)) {
    throw new Error("Enter the Ethereum address that should receive the network tip.")
  }
  return desktopBridgeChannel({
    destination,
    chainId: config.l1ChainId,
    publicClient: params.publicClient,
    display: {
      title: "Finish your zk.money deposit",
      lines: [
        ["Amount", `${depositAmounts(record).grossDisplay} ${record.tokenSymbol}`],
        ["Deposit address", record.sipaAddress],
        ["Network tip to", destination],
      ],
    },
    onHelperOpened: opts.onHelperOpened,
    onStage: opts.onStage,
  })
}

/** The row a sweep of one token reads, and the factor that scales its balance into the row token's units. */
export interface SweepRow {
  rowToken: Address
  /** The swept token's decimals. */
  decimals: number
  balanceScale: bigint
}

/** The row a sweep of `token` settles on; undefined for a token the table routes no sweep of for this intent. */
export function sweepRowOf(tokens: DepositTokens, token: Address): SweepRow | undefined {
  const sent = tokens.options.find((t) => t.address.toLowerCase() === token.toLowerCase())
  if (!sent) return undefined
  const row = settlementOf(tokens, sent)
  return {
    rowToken: sent.settlesIn,
    decimals: sent.decimals,
    balanceScale: 10n ** BigInt(Math.max(row.decimals - sent.decimals, 0)),
  }
}

/**
 * The row a sweep of `token` settles on in a recorded table, which the current one may no longer list: the token's
 * own, or the row token Oxide's SIPA swaps it into on `chainId`.
 */
export async function recordedSweepRow(
  chainId: number | bigint,
  token: Address,
  decimalsOf: (token: Address) => Promise<number>,
): Promise<SweepRow> {
  const sent = EthAddress.fromString(token)
  const payout = depositPayoutTokenFor(BigInt(chainId), sent)
  const rowToken = payout.equals(sent) ? token : (payout.toString() as Address)
  const [decimals, rowDecimals] = await Promise.all([decimalsOf(token), decimalsOf(rowToken)])
  return { rowToken, decimals, balanceScale: 10n ** BigInt(Math.max(rowDecimals - decimals, 0)) }
}

/** Self-sweep `record` over whichever channel this build has. Resolves to the L1 sweep tx hash. */
export async function selfSweep(
  record: SIPADepositRecord,
  opts: SelfSweepOptions = {},
): Promise<Hex> {
  const config = getConfig()
  const publicClient = createPublicClient({ transport: l1Transport(config) })
  const tuple = await getOxideTuple(config)
  // A record that predates token tracking holds the pinned bridge's row token.
  const manifest = { ...sweepManifestFrom(tuple), token: bridgeUnderlying(tuple) as Address }
  const recorded = sipaRecordRoute(record)
  const route = recorded ?? {
    forwardingTable: manifest.forwardingTable,
    intent: sipaRecordIntent(record.intent),
  }
  // The swept token's own row prices the sweep and caps it, in the table the address was made under.
  const token = record.tokenAddress ?? manifest.token
  const row = recorded
    ? await recordedSweepRow(config.l1ChainId, token, (t) =>
        tokenMetadata(config, t).then((m) => m.decimals),
      )
    : sweepRowOf(await loadDepositTokens(config, sipaIntentName(route.intent)), token)
  if (!row) {
    throw new SweepRefusedError(
      `The network has no route for ${
        record.tokenSymbol || "this token"
      }, so it can't be swept. ${RECOVER_INSTEAD}`,
    )
  }
  const [implementation, terms] = await Promise.all([
    record.origin
      ? Promise.resolve(record.origin.implementation)
      : readDepositSIPAImplementation(publicClient, manifest.sipaFactory),
    readSipaPortalTerms(publicClient, { ...route, token: row.rowToken }),
  ])
  const cap = terms.txAmountCap
  const channel = await sweepChannel({ config, record, publicClient, opts })

  // The row names the swept token's decimals where the record does not.
  const swept = { ...record, tokenDecimals: record.tokenDecimals ?? row.decimals }
  return await selfSweepDeposit(swept, {
    channel,
    manifest,
    implementation,
    txAmountCap: cap,
    readDeployed: (sipa) => readSipaDeployed(publicClient, sipa),
    // A swapped token's balance is measured against its row token's fee.
    readFunding: (sipa, token) =>
      readSipaFundingStatus(publicClient, {
        sipa,
        token,
        fee: terms.depositFee,
        txAmountCap: cap,
        balanceScale: row.balanceScale,
      }),
    predict: (args) =>
      Promise.resolve(
        sipaAddressFromArgs(record.origin?.sipaFactory ?? manifest.sipaFactory, args),
      ),
    store: SIPADepositStore.get(new WebStorageAdapter()),
    checkCapacity: (live) =>
      sipaProcessingObserver()?.refreshForSweep(record.sipaAddress, live) ??
      Promise.resolve(undefined),
  })
}

/**
 * Offline create2 prediction from the viem-shaped deploy args — the deposit intent's SIPA address.
 * Mirrors `SIPAFactory.predictSIPA`, which stays the source of truth; this is the pre-deploy
 * parity check.
 */
function sipaAddressFromArgs(sipaFactory: Address, args: SipaSweepDeployArgs): Address {
  const common = {
    sipaFactory: EthAddress.fromString(sipaFactory),
    implementation: EthAddress.fromString(args.implementation),
    intentHash: Buffer.from(args.intentHash.slice(2), "hex"),
    rollupVersion: args.rollupVersion,
    resweepable: args.resweepable,
  }
  return (
    "recoveryAddress" in args
      ? computeSIPAAddress({
          ...common,
          recoveryAddress: EthAddress.fromString(args.recoveryAddress),
        })
      : computeAccountSIPAAddress({
          ...common,
          recoveryCommitment: Fr.fromString(args.recoveryCommitment),
          forwardingTable: EthAddress.fromString(args.forwardingTable),
        })
  ).toString() as Address
}

/** Whether the SIPA clone already exists on L1. */
export async function readSipaDeployed(
  publicClient: PublicClient,
  sipa: Address,
): Promise<boolean> {
  const code = await publicClient.getCode({ address: sipa })
  return !!code && code !== "0x"
}
