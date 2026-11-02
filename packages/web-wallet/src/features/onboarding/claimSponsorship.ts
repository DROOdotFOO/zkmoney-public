/**
 * Composes the subscribe leg a ClaimFPC-sponsored batch may carry.
 *
 * SUBSCRIPTION — does the user hold a subscription note for THIS RAIL of THIS ClaimFPC? Per
 * (instance, rail, account), `has_subscription`, answered by the chain rather than by local state.
 * Notes live in the deployed contract's storage and name their rail, so a redeployed FPC leaves
 * every existing user unsubscribed at once, and riding one rail says nothing about another.
 *
 * The eligibility witness that mints a subscription is not a second fact either — the rail's gate
 * says which one it takes, and both are recoverable from public L1 data plus the device master key.
 * A NameClaim gate takes the L1 claim, rebuilt from the Registry's `NameClaimed` log whenever the
 * local cache is missing; a registration gate takes the NamePortal's L1->L2 message, found by
 * scanning the Inbox (`registrationRail.ts`).
 */
import type { Hex } from "viem"
import {
  createOxideL1Reader,
  deriveBootstrapKey,
  NameClaimStore,
  requireVerifiedIdentity,
  resolveOxideAccountFactory,
  resolveOxideIdentity,
  type IdentityGeneration,
  type NameClaimRecord,
  type VerifiedOxideIdentity,
} from "@obsidion/front-core"
import {
  type ContractService,
  claimFpcPolicySponsorsAnyCall,
  hasClaimFpcSubscription,
  KIND_BY_ADDRESS,
  loadClaimFpcPolicy,
  loadClaimFpcPolicyAt,
  registerSponsorFpc,
  type ClaimFpcGateWitness,
  type ClaimFpcRailPolicy,
  type ClaimSponsorContext,
  type ClaimSubscribeContext,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { loadWalletIdentity } from "../identity/walletIdentity"
import {
  buildClaimSubscribeWitness,
  collectOnboardingKeys,
  type OnboardingKeys,
} from "./oxideOnboarding"
import {
  registrationGateWitness,
  RegistrationPendingError,
  type RegistrationPending,
} from "./registrationRail"
import { loadOxideGenerations } from "./oxideGenerations"
import { generationAddresses } from "./generationAddresses"
import { cacheNameClaimFromLog } from "./webRegistration"

export interface SponsorLegDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  config: WebWalletConfig
  fpcAddress: AztecAddress
  fpcArtifact: ContractArtifact
  /** The rail whose subscription this leg is about — its gate decides the witness minted here. */
  rail: ClaimFpcRailPolicy
}

export interface ClaimSponsorRailDeps {
  wallet: ObsidionWallet
  contractService: ContractService
}

export interface ClaimSponsorDeps extends ClaimSponsorRailDeps {
  account: ObsidionAccount
  /**
   * The accounts a batch on the registered instance `sponsor` names: the payer, whose note it
   * spends, and the acting account. Absent, the installed resolver answers; without one the
   * account pays with its own note.
   */
  payerFor?: SponsorAccountsResolver
}

/** The payer and the acting account of a sponsored batch; one account when the wallet never rotated. */
export interface SponsorAccounts {
  payer: ObsidionAccount
  acting: ObsidionAccount
}

export type SponsorAccountsResolver = (
  deps: ClaimSponsorDeps,
  sponsor: ClaimSponsorContext,
) => Promise<SponsorAccounts>

const selfPays: SponsorAccountsResolver = async (deps) => ({
  payer: deps.account,
  acting: deps.account,
})
let installedResolver: SponsorAccountsResolver = selfPays

/** Installed once by the wallet's boot; the session's root record decides the payer per instance. */
export function setSponsorAccountsResolver(resolver: SponsorAccountsResolver | undefined): void {
  installedResolver = resolver ?? selfPays
}

const accountsFor = (deps: ClaimSponsorDeps, sponsor: ClaimSponsorContext) =>
  (deps.payerFor ?? installedResolver)(deps, sponsor)

const sameAccount = (a: ObsidionAccount, b: ObsidionAccount) =>
  a.getAddress().toString() === b.getAddress().toString()

/** The context with `holder` as its payer; unchanged when the acting account pays itself. */
const withPayer = (
  sponsor: ClaimSponsorContext,
  holder: ObsidionAccount,
  acting: ObsidionAccount,
): ClaimSponsorContext =>
  sameAccount(holder, acting) ? sponsor : { ...sponsor, payer: holder.getAddress() }

export interface ClaimSponsorRailOptions {
  /**
   * The deployment this batch operates on: it names the token the rail must pay for and the ClaimFPC
   * the batch asks for. It does not say which account the user owns. Omit for the current
   * deployment.
   */
  tuple?: OxideEnvTuple
}

/**
 * ClaimFPC coordinates for one declared rail, with the FPC registered in this PXE and no subscribe
 * leg: what a batch whose user is not an account needs (a paylink's escrow spending its voucher).
 * `railName` is one of the names in `rails.ts`; the deployment's manifest decides which `rail_id`
 * and gate that is. Every shipped network carries a ClaimFPC (deploys fail closed without it), so
 * the address is asserted.
 */
export async function claimSponsorRail(
  deps: ClaimSponsorRailDeps,
  railName: string,
  opts: ClaimSponsorRailOptions = {},
): Promise<{ sponsor: ClaimSponsorContext; rail: ClaimFpcRailPolicy }> {
  // Sequential, not parallel: the artifact fetch is anchored to the resolved address, so it cannot
  // start until the rail read has produced one.
  const { rail, fpcAddress } = opts.tuple
    ? await loadClaimFpcPolicyAt(
        deps.contractService,
        railName,
        requireTupleField(opts.tuple, "fpcBeneficiary"),
      )
    : await loadClaimFpcPolicy(deps.contractService, railName)
  return { sponsor: await sponsorFor(deps, rail, fpcAddress!), rail }
}

/**
 * One named ClaimFPC instance as a batch rides it, registered in this PXE. Registration leads every
 * read of the FPC. `has_subscription` is a utility call on it, and a PXE that holds neither the
 * instance nor the class throws instead of answering — which the read takes for "unsubscribed",
 * replaying the rail's one-per-identity nullifier. Registration is guarded: a PXE that already holds
 * both pays two store reads, not the class hashing.
 */
async function sponsorFor(
  deps: ClaimSponsorRailDeps,
  rail: ClaimFpcRailPolicy,
  address: AztecAddress,
): Promise<ClaimSponsorContext> {
  const artifact = await deps.contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.claimFpc,
    address,
  )
  const fpcArtifact = await registerSponsorFpc(deps.wallet, {
    fpcAddress: address,
    fpcArtifact: artifact,
    railId: rail.railId,
    gate: rail.gate,
    policy: rail.policy,
  })
  return {
    fpcAddress: address,
    fpcArtifact,
    railId: rail.railId,
    gate: rail.gate,
    policy: rail.policy,
  }
}

/**
 * `claimSponsorRail` plus the subscribe leg (below) — the shared preamble of every sponsored flow
 * an account drives (send, paylink, withdraw, SIPA broadcast).
 */
export async function claimSponsorContext(
  deps: ClaimSponsorDeps,
  railName: string,
  opts: ClaimSponsorRailOptions = {},
): Promise<ClaimSponsorContext> {
  const { sponsor, rail } = await claimSponsorRail(deps, railName, opts)
  const config = getConfig()
  if (opts.tuple && rail.gate !== "registration") {
    throw new Error(
      `the ${railName} rail of deployment ${opts.tuple.version} gates on ${rail.gate}, and this ` +
        "wallet can only satisfy that gate on the current deployment",
    )
  }
  const accounts = await accountsFor(deps, sponsor)
  if (rail.gate === "registration") {
    return registrationSponsor(deps, {
      sponsor,
      rail,
      railName,
      config,
      tuple: opts.tuple,
      accounts,
    })
  }
  const leg = legFor(deps, config, sponsor, rail)
  const holder = await subscribedPayer(leg, accounts)
  if (holder) return withPayer(sponsor, holder, accounts.acting)
  return { ...sponsor, subscribe: await subscribeLeg(leg(accounts.acting)) }
}

/** The leg deps of one account on one registered instance. */
const legFor =
  (
    deps: ClaimSponsorRailDeps,
    config: WebWalletConfig,
    sponsor: ClaimSponsorContext,
    rail: ClaimFpcRailPolicy,
  ) =>
  (account: ObsidionAccount): SponsorLegDeps => ({
    wallet: deps.wallet,
    account,
    config,
    fpcAddress: sponsor.fpcAddress,
    fpcArtifact: sponsor.fpcArtifact,
    rail,
  })

/**
 * Which of the batch's accounts holds the rail's note on the instance: the payer, else the acting
 * account, else none. A payer whose note is gone on the instance is not subscribed on behalf of the
 * acting account; the acting account subscribes itself.
 */
async function subscribedPayer(
  leg: (account: ObsidionAccount) => SponsorLegDeps,
  { payer, acting }: SponsorAccounts,
): Promise<ObsidionAccount | undefined> {
  if (!(await needsSubscription(leg(payer)))) return payer
  if (sameAccount(payer, acting)) return undefined
  return (await needsSubscription(leg(acting))) ? undefined : acting
}

// One utility call per (account, FPC, rail), not per transaction. Keying on the FPC address is what
// makes a redeploy re-ask instead of trusting an answer about a contract that no longer serves us;
// keying on the rail is what keeps one rail's answer from standing in for another's.
const subscriptionChecks = new Map<string, Promise<boolean>>()

const subscriptionKey = (account: ObsidionAccount, fpcAddress: AztecAddress, railId: number) =>
  `${account.getAddress().toString()}|${fpcAddress.toString()}|${railId}`

type SubscriptionReadDeps = Pick<
  SponsorLegDeps,
  "wallet" | "account" | "fpcAddress" | "fpcArtifact"
> & { rail: Pick<ClaimFpcRailPolicy, "railId"> }

/** Whether `account` holds the rail's note on the registered instance `sponsor` names. */
export async function holdsSubscription(
  wallet: ObsidionWallet,
  sponsor: ClaimSponsorContext,
  account: ObsidionAccount,
): Promise<boolean> {
  return !(await needsSubscription({
    wallet,
    account,
    fpcAddress: sponsor.fpcAddress,
    fpcArtifact: sponsor.fpcArtifact,
    rail: { railId: sponsor.railId },
  }))
}

/** True when this account has no subscription note for this rail of the live ClaimFPC. */
async function needsSubscription(deps: SubscriptionReadDeps): Promise<boolean> {
  const key = subscriptionKey(deps.account, deps.fpcAddress, deps.rail.railId)
  const cached = subscriptionChecks.get(key)
  if (cached) return cached
  const check = hasClaimFpcSubscription(
    deps.wallet,
    deps.fpcAddress,
    deps.fpcArtifact,
    deps.account.getAddress(),
    deps.rail.railId,
  )
    .then((has) => !has)
    // A failed read must not downgrade to `sponsor` against an FPC that would reject it: assume a
    // subscribe is needed and let the tx be the judge.
    .catch(() => true)
  subscriptionChecks.set(key, check)
  // Only "subscribed" is worth holding on to. A pending subscribe is transient, so drop that answer
  // and re-read next time rather than pinning the wallet to it.
  void check.then((needs) => {
    if (needs) subscriptionChecks.delete(key)
  })
  return check
}

/** Record a landed subscribe so the next batch on this rail rides `sponsor` without re-reading. */
export function noteSubscribed(
  account: ObsidionAccount,
  fpcAddress: AztecAddress,
  railId: number,
): void {
  subscriptionChecks.set(subscriptionKey(account, fpcAddress, railId), Promise.resolve(false))
}

/**
 * Rebuild the claim artifacts from L1: the MSK's bootstrap key CREATE2-predicts the OxideAccount,
 * and the Registry logged the domain-owner authorization against it. Null when this device's
 * account never claimed a name — no subscription is possible, and the caller pays its own fees.
 */
async function recoverNameClaim(
  secretKey: Parameters<typeof deriveBootstrapKey>[0],
  address: string,
  config: WebWalletConfig,
): Promise<NameClaimRecord | null> {
  const tuple = await getOxideTuple(config)
  const accountFactory = resolveOxideAccountFactory({ tuple })
  const registry = requireTupleField(tuple, "registry") as Hex
  const publicClient = l1PublicClient(config)

  const oxideAccount = await createOxideL1Reader(publicClient).predictAccountAddress(
    accountFactory,
    deriveBootstrapKey(secretKey).address,
  )
  return cacheNameClaimFromLog(publicClient, registry, {
    account: oxideAccount,
    tag: loadWalletIdentity()?.handle ?? "",
    l2Address: address,
  })
}

/**
 * The subscribe leg for this batch, or undefined when the account already holds this rail's
 * subscription (or holds no witness the rail's gate accepts). Requires the unlocked wallet: both
 * gates' witnesses carry a binding signature derived from the MSK, minted fresh here — no extra
 * user assertion, the flow's own covers the batch.
 */
export async function subscribeContext(
  deps: SponsorLegDeps,
): Promise<ClaimSubscribeContext | undefined> {
  if (!(await needsSubscription(deps))) return undefined
  return subscribeLeg(deps)
}

/** The leg for an account read as holding no note. */
async function subscribeLeg(deps: SponsorLegDeps): Promise<ClaimSubscribeContext | undefined> {
  const keys = await collectOnboardingKeys(deps.account)
  const gate = await gateWitness(deps, keys)
  if (!gate) return undefined
  return { gate }
}

/**
 * The witness this rail's gate consumes, or undefined when this device holds none. The registration
 * gate is not built here: its witness decides which generation's ClaimFPC the batch rides, so
 * `registrationSponsor` owns it.
 */
async function gateWitness(
  deps: SponsorLegDeps,
  keys: OnboardingKeys,
): Promise<ClaimFpcGateWitness | undefined> {
  // A rail with no gate is never subscribed: its note arrives by `gift_voucher`, and every batch
  // on it rides `sponsor`.
  if (deps.rail.gate === "none") return undefined

  const address = deps.account.getAddress().toString()
  const record =
    (await NameClaimStore.get().get(address)) ??
    (await recoverNameClaim(keys.secretKey, address, deps.config))
  if (!record) return undefined

  const claim = await buildClaimSubscribeWitness(
    record.handle,
    keys,
    { signature: record.signature as Hex, nonce: record.nonce, deadline: record.deadline },
    deps.config,
    record.nameHash as Hex | undefined,
  )
  return { kind: "nameClaim", ...claim }
}

/**
 * The L1 account this wallet's key owns and the name it holds, across every ClaimFPC generation the
 * deployment still publishes. A factory roll moves the account a key predicts, so the account of an
 * existing user sits under the factory of the generation they registered under. A name this device
 * cannot attribute throws rather than reading as "no account": adopting it and registering over it
 * both lose the account. Read fresh per batch, so a name that lands during the session is seen.
 */
async function verifiedIdentityFor(
  deps: ClaimSponsorDeps,
  keys: OnboardingKeys,
  config: WebWalletConfig,
): Promise<VerifiedOxideIdentity | undefined> {
  const l2Address = deps.account.getAddress().toString()
  const generations = await loadOxideGenerations(deps.wallet, deps.contractService, config)
  return requireVerifiedIdentity(
    await resolveOxideIdentity(
      generations,
      deriveBootstrapKey(keys.secretKey).address,
      l2Address,
      generationAddresses(config, keys.pubkeyHex)(keys.secretKey, l2Address),
    ),
  )
}

const sameFpc = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

/** Whether this rail pays for calls to `target`: an open rail pays for any, else it names it. */
function railCovers(rail: ClaimFpcRailPolicy, target: AztecAddress): boolean {
  if (claimFpcPolicySponsorsAnyCall(rail.policy)) return true
  return rail.policy.witnesses.some(
    ({ entry }) => entry.kind === KIND_BY_ADDRESS && entry.target.equals(target.toField()),
  )
}

/**
 * The instances this account's registration can ride, the one the profile names current first. A
 * ClaimFPC only accepts the portal message its own Config pins, so an existing user rides the
 * instance of the generation that registered them until oxide re-notifies the current one. Only
 * generations that bind the verified identity are listed: an instance of any other generation
 * cannot gate this account, and a batch that rides it is refused on chain. Several compatible
 * instances are not an ambiguity; the first that answers is taken.
 */
function registrationTargets(
  sponsor: ClaimSponsorContext,
  identity: VerifiedOxideIdentity | undefined,
): IdentityGeneration[] {
  const current = sponsor.fpcAddress.toString()
  const published = identity?.generations ?? []
  return [
    ...published.filter((generation) => sameFpc(generation.fpcAddress, current)),
    ...published.filter((generation) => !sameFpc(generation.fpcAddress, current)),
  ]
}

/**
 * The ClaimFPC a registered account's batch rides, with its subscribe leg when it needs one. Only
 * an instance whose generation binds this account is asked, and only while its rail pays for the
 * deployment's token: a subscription note proves the rail admits the account, not that its policy
 * covers the calls. A subscription the account already holds rides as it is; a portal message
 * addressed to that instance mints one. Nothing falls back to an instance this account cannot
 * satisfy, and nothing rides an instance whose rail cannot pay.
 */
async function registrationSponsor(
  deps: ClaimSponsorDeps,
  ctx: {
    sponsor: ClaimSponsorContext
    rail: ClaimFpcRailPolicy
    railName: string
    config: WebWalletConfig
    tuple?: OxideEnvTuple
    accounts: SponsorAccounts
  },
): Promise<ClaimSponsorContext> {
  const token = AztecAddress.fromStringUnsafe(
    ctx.tuple?.l2Token ?? (await getOxideTuple(ctx.config)).l2Token,
  )
  const { acting } = ctx.accounts
  // A note already held on the instance the caller asked for rides as it is: the FPC checks the
  // note and the policy, not the registration gate. Reaching any other instance needs the key, the
  // identity and a generation.
  if (railCovers(ctx.rail, token)) {
    const holder = await subscribedPayer(
      legFor(deps, ctx.config, ctx.sponsor, ctx.rail),
      ctx.accounts,
    )
    if (holder) return withPayer(ctx.sponsor, holder, acting)
  }

  const keys = await collectOnboardingKeys(acting)
  const identity = await verifiedIdentityFor(deps, keys, ctx.config)
  const pinned = ctx.tuple ? ctx.sponsor.fpcAddress.toString() : undefined
  const targets = registrationTargets(ctx.sponsor, identity).filter(
    (generation) => !pinned || sameFpc(generation.fpcAddress, pinned),
  )
  if (pinned && targets.length === 0) {
    throw new Error(
      `the ClaimFPC at ${pinned} belongs to no generation that holds this account's name, so it ` +
        "cannot sponsor this batch",
    )
  }

  let waiting: RegistrationPending | undefined
  for (const generation of targets) {
    const address = AztecAddress.fromStringUnsafe(generation.fpcAddress)
    const current = sameFpc(generation.fpcAddress, ctx.sponsor.fpcAddress.toString())
    const sponsor = current
      ? { sponsor: ctx.sponsor, rail: ctx.rail }
      : await sponsorAt(deps, ctx.railName, address)
    if (!railCovers(sponsor.rail, token)) continue
    // The payer travels with the instance: another generation's instance has its own.
    const accounts = current ? ctx.accounts : await accountsFor(deps, sponsor.sponsor)
    const holder = await subscribedPayer(
      legFor(deps, ctx.config, sponsor.sponsor, sponsor.rail),
      accounts,
    )
    if (holder) return withPayer(sponsor.sponsor, holder, acting)
    const found = await registrationGateWitness(
      {
        wallet: deps.wallet,
        config: ctx.config,
        identity,
        generation: { fpcAddress: generation.fpcAddress, namePortal: generation.namePortal },
      },
      keys,
    )
    if ("gate" in found) return { ...sponsor.sponsor, subscribe: { gate: found.gate } }
    waiting ??= found
  }
  throw new RegistrationPendingError(waiting ?? { pending: "message" })
}

/** The rail policy one published instance declares, and that instance registered in this PXE. */
async function sponsorAt(
  deps: ClaimSponsorDeps,
  railName: string,
  address: AztecAddress,
): Promise<{ sponsor: ClaimSponsorContext; rail: ClaimFpcRailPolicy }> {
  const { rail } = await loadClaimFpcPolicyAt(deps.contractService, railName, address.toString())
  return { sponsor: await sponsorFor(deps, rail, address), rail }
}
