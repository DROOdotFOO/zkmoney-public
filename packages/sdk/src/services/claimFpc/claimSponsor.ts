/**
 * Shared collaborators for ClaimFPC-sponsored (`NO_FROM`) batches — the pieces every sponsored
 * leg needs regardless of the operation it wraps (paylink create/claim, withdraw): the sponsor
 * context shape, FPC registration, the ByClass witness for whitelist matching, and the
 * `authorize_intents` account call that authorizes delegated token spends inside the batch.
 */
import { computeSaltedInitializationHash } from "@aztec-labs/stdlib/contract"
import type { ContractInstancePreimageWithAddress } from "@aztec-labs/stdlib/contract"
import { Contract, type ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact, FunctionCall } from "@aztec-labs/stdlib/abi"
import type { AuthWitness } from "@aztec-labs/stdlib/auth-witness"
import {
  type ContractService,
  DEFAULT_CONTRACTS,
  ensureContractRegisteredInPXE,
} from "@obsidion/contracts"

import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { ChainInfo } from "@aztec-labs/entrypoints/interfaces"
import {
  computeIntentsOnlyAuthWitHash,
  padIntentHashes,
} from "../../feePaymentMethod/claimFpc/sponsoredCall.js"
import type { AlphaAuthProvider } from "../../obsidion/alpha/auth/AlphaAuthProvider.js"
import {
  parseClaimFpcPolicyManifest,
  railByName,
  type ClaimFpcGateKind,
  type ClaimFpcGateWitness,
  type ClaimFpcPolicy,
  type ClaimFpcRailPolicy,
  type ClassWitnessInput,
} from "../../feePaymentMethod/index.js"

/**
 * First-transaction subscribe context: when present, the sponsored leg rides `subscribe` instead of
 * `sponsor`, so ONE tx claims the rail's subscription and runs the batched operation. `gate`
 * carries the witnesses the rail's gate consumes.
 */
export interface ClaimSubscribeContext {
  gate: ClaimFpcGateWitness
}

/**
 * ClaimFPC sponsorship inputs for the `NO_FROM`, gasless legs. The account-entrypoint
 * (self-paid) methods take none of this; the sponsored methods wrap the SAME TEE-attested op in
 * a ClaimFPC batch instead of paying through the sender's account. Rate limiting is the rail's
 * own SubscriptionNote — no client-managed state.
 */
export interface ClaimSponsorContext {
  fpcAddress: AztecAddress
  fpcArtifact: ContractArtifact
  /** The rail this leg rides, and the gate its subscribe has to satisfy. */
  railId: number
  gate: ClaimFpcGateKind
  policy: ClaimFpcPolicy
  subscribe?: ClaimSubscribeContext
  /**
   * The account whose subscription note the batch spends when it is not the acting account: the
   * FPC's `user`, read as a scope beside the acting account. Absent means the acting account pays.
   */
  payer?: AztecAddress
}

const railsCache = new WeakMap<object, Promise<ClaimFpcRailPolicy[]>>()

/**
 * The ClaimFPC address plus the declared rail — id, gate kind and integrity-checked policy — from
 * one read of its record. `getContractRecord` is what makes it one read: taken separately, the pair
 * can span a config change or a first registry fetch and yield a policy that parses cleanly but
 * belongs to a different FPC instance, so every sponsored call fails simulation.
 *
 * The rail is named, not indexed: a flow declares which sponsorship offer it rides, and the
 * deployment's published manifest decides which `rail_id` that is.
 */
export async function loadClaimFpcPolicy(
  contractService: ContractService,
  railName: string,
): Promise<{ rail: ClaimFpcRailPolicy; fpcAddress: AztecAddress | undefined }> {
  const { meta, address: fpcAddress } = await contractService.getContractRecord(
    DEFAULT_CONTRACTS.claimFpc,
  )
  const manifest = meta?.policyManifest
  if (!manifest || typeof manifest !== "object") {
    return { rail: railByName(await parseClaimFpcPolicyManifest(manifest), railName), fpcAddress }
  }

  const cached = railsCache.get(manifest)
  if (cached) return { rail: railByName(await cached, railName), fpcAddress }

  const rails = parseClaimFpcPolicyManifest(manifest).catch((error) => {
    railsCache.delete(manifest)
    throw error
  })
  railsCache.set(manifest, rails)
  return { rail: railByName(await rails, railName), fpcAddress }
}

/**
 * The declared rail of one named ClaimFPC instance: the current one, or the retired generation the
 * profile still publishes. An oxide portal roll leaves the displaced FPC live and sponsoring its own
 * generation's token, so a balance on a retired deployment is spent through the instance that
 * deployment named.
 *
 * Callers name the instance from the deployment's own `fpcBeneficiary`, which is the address oxide's
 * FPCFunder pays and the deploy refuses to land anywhere else. An address the profile does not
 * publish is refused rather than substituted: an FPC's Config pins its own NamePortal, and its
 * address is part of the message leaf its registration gate consumes, so any other instance yields a
 * subscribe that can never be gated.
 */
export async function loadClaimFpcPolicyAt(
  contractService: ContractService,
  railName: string,
  fpcAddress: string,
): Promise<{ rail: ClaimFpcRailPolicy; fpcAddress: AztecAddress | undefined }> {
  const wanted = fpcAddress.toLowerCase()
  const current = await loadClaimFpcPolicy(contractService, railName)
  if (current.fpcAddress?.toString().toLowerCase() === wanted) return current

  const { meta } = await contractService.getContractRecord(DEFAULT_CONTRACTS.claimFpc)
  const retired = Array.isArray(meta?.retired)
    ? (meta.retired as { address?: string; policyManifest?: unknown }[])
    : []
  const generation = retired.find((entry) => entry.address?.toLowerCase() === wanted)
  if (!generation?.address) {
    throw new Error(
      `this profile publishes no ClaimFPC at ${fpcAddress} — it names ` +
        `${current.fpcAddress?.toString() ?? "no current instance"} and ${retired.length} ` +
        "retired generation(s)",
    )
  }
  return {
    rail: railByName(await parseClaimFpcPolicyManifest(generation.policyManifest), railName),
    fpcAddress: AztecAddress.fromStringUnsafe(generation.address),
  }
}

/**
 * The account's authorization of a sponsored batch: its account call, the operation's own intents
 * that call authorizes, and the one signature over them. One intent list feeds the signature, the
 * account call and the payload's capsule, since the account's intents note commits to exactly
 * that list. Spread the result into `buildSponsoredTeeOperation`'s args or the payload
 * builder's options.
 */
export async function authorizeSponsoredBatch(
  wallet: ObsidionWallet,
  contractService: ContractService,
  _sponsor: ClaimSponsorContext,
  user: AztecAddress,
  authProvider: Pick<AlphaAuthProvider, "createAuthWit">,
  ownIntents: Fr[],
  chainInfo: ChainInfo,
  signal?: AbortSignal,
): Promise<{
  accountCall: { call: FunctionCall; classWitness: ClassWitnessInput }
  intentHashes: Fr[]
  combinedAuthWitness: AuthWitness
}> {
  // The signature first: on the web it is a passkey assertion that has to land inside the click's
  // user-activation window, before anything slow.
  const combinedAuthWitness = await authProvider.createAuthWit(
    await computeIntentsOnlyAuthWitHash(user, chainInfo, ownIntents),
    { signal },
  )
  const accountCall = await buildAccountBatchCall(wallet, contractService, user, ownIntents)
  return { accountCall, intentHashes: ownIntents, combinedAuthWitness }
}

/**
 * The FPC's `gift_voucher` as a batch carries it: hand one use of `from`'s allowance on the batch's
 * rail to `recipient`, as a single-use note on `toRailId`. A `BY_SELF` call the TEE does not sign,
 * so it rides `teeUnsignedInteractions` and matches the rail's gift leaf. The send has to scope the
 * recipient beside the sender: the note is tagged from the recipient to itself.
 */
export function giftVoucherInteraction(
  wallet: ObsidionWallet,
  sponsor: ClaimSponsorContext,
  from: AztecAddress,
  recipient: AztecAddress,
  toRailId: number,
): ContractFunctionInteraction {
  // The typed binding omits `#[only_self]` functions; the artifact still has them.
  return Contract.at(sponsor.fpcAddress, sponsor.fpcArtifact, wallet).methods.gift_voucher!(
    from,
    sponsor.railId,
    recipient,
    toRailId,
  )
}

/** Register the on-chain ClaimFPC instance in this PXE; returns the artifact for call building. */
export async function registerSponsorFpc(
  wallet: ObsidionWallet,
  sponsor: ClaimSponsorContext,
): Promise<ContractArtifact> {
  await ensureContractRegisteredInPXE(wallet.pxe, wallet.node, sponsor.fpcAddress, () =>
    Promise.resolve(sponsor.fpcArtifact),
  )
  // Sponsored calls run with the FPC as msg_sender, so every note they mint for the user (the
  // SubscriptionNote itself, SIPA broadcasts) is tagged with the FPC. A PXE that did not mint them
  // discovers them only with the FPC as a registered sender — so it is registered before the first
  // read, which is `has_subscription`.
  await wallet.registerSender(sponsor.fpcAddress)
  return sponsor.fpcArtifact
}

/** ByClass whitelist witness proving a call target derives from the whitelisted class. */
export async function contractClassWitness(
  instance: ContractInstancePreimageWithAddress,
): Promise<ClassWitnessInput> {
  return {
    classId: instance.originalContractClassId,
    saltedInitializationHash: await computeSaltedInitializationHash(instance),
    publicKeys: instance.publicKeys.toNoirStruct(),
  }
}

/** The account call riding a sponsored batch: `authorize_intents` over the batch's intents. */
export async function buildAccountBatchCall(
  wallet: ObsidionWallet,
  contractService: ContractService,
  user: AztecAddress,
  intentHashes: Fr[],
): Promise<{ call: FunctionCall; classWitness: ClassWitnessInput }> {
  const accountArtifact = await contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.obsidionAccountAlpha,
    user,
  )
  const methods = Contract.at(user, accountArtifact, wallet).methods
  const interaction = methods.authorize_intents!(padIntentHashes(intentHashes))
  const call = (await interaction.request()).calls[0]!
  const instance = await wallet.pxe.getContractInstance(user)
  if (!instance) throw new Error("user account instance not registered in PXE")
  return { call, classWitness: await contractClassWitness(instance) }
}

/**
 * Whether `user` already holds a subscription to THIS rail of THIS ClaimFPC instance — the only
 * correct input to the `subscribe` vs `sponsor` choice. Subscription notes live in the deployed
 * contract's storage and name their rail, so a redeployed FPC answers false for every account that
 * subscribed to the previous one, riding one rail says nothing about another, and any local
 * "already subscribed" flag is wrong the moment either moves.
 *
 * A utility (unconstrained) call: no transaction, no fee. Callers should memoize per
 * (user, fpcAddress, railId) rather than asking once per transaction.
 */
export async function hasClaimFpcSubscription(
  wallet: ObsidionWallet,
  fpcAddress: AztecAddress,
  fpcArtifact: ContractArtifact,
  user: AztecAddress,
  railId: number,
): Promise<boolean> {
  const contract = Contract.at(fpcAddress, fpcArtifact, wallet)
  // `from: user` scopes the utility's note view to the subscription's owner; without it PXE reads
  // an empty set and every account looks unsubscribed.
  const sim = await contract.methods.has_subscription!(user, railId).simulate({ from: user })
  return Boolean(sim.result)
}

/**
 * Sponsored txs `user` still holds on the rail, summed over its notes; 0 without a subscription. A
 * stored 0 may still refill on the next batch, so this understates an allowance whose window has
 * lapsed.
 */
export async function claimFpcSubscriptionUses(
  wallet: ObsidionWallet,
  fpcAddress: AztecAddress,
  fpcArtifact: ContractArtifact,
  user: AztecAddress,
  railId: number,
): Promise<number> {
  const contract = Contract.at(fpcAddress, fpcArtifact, wallet)
  const sim = await contract.methods.get_subscription_uses!(user, railId).simulate({ from: user })
  return Number(sim.result)
}

/** The rollup a link is stamped with (`PaylinkParams.chainId` / `rollupVersion`), as plain numbers. */
export async function linkChainInfo(
  wallet: ObsidionWallet,
): Promise<{ chainId: number; rollupVersion: number }> {
  const { l1ChainId, rollupVersion } = await wallet.getNodeIdentity()
  return { chainId: Number(l1ChainId), rollupVersion: Number(rollupVersion) }
}

/** Chain binding fields for authwit hashes: the wallet's cached snapshot, which its tx contexts use. */
export function chainInfoFields(wallet: ObsidionWallet): Promise<ChainInfo> {
  return wallet.getChainInfo()
}
