import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
/**
 * Manual sweep for a funded registration deposit: the user submits the relayer's own
 * register-deploy-and-sweep for a SIPA no relayer picked up. It registers the name, pays the
 * on-chain registration fee out of the deposit (a broadcast-time waiver is honored), and bridges
 * the remainder — manual only skips the relayer, never the fee.
 *
 * Nothing extra is persisted for this path: one passkey assertion recovers the master secret, the
 * derivation is recomputed and checked against the record's address before anything is signed
 * (fail closed), and the NameClaim comes from the device cache or a claim-server re-request (see
 * `requireNameClaim`). The submission rides the same injected-wallet / desktop-bridge channel as
 * the plain deposit's self-sweep.
 */

import { createPublicClient, formatUnits, type Address, type Hex, type PublicClient } from "viem"
import { registrationFloor } from "@obsidion/core/constants"
import { EMPTY_SIGNED_TERMS, type SignedTermsArg } from "@obsidion/sdk"
import {
  buildRegistrationR1Install,
  buildRegistrationSelfSweepCall,
  createOxideL1Reader,
  createRegistrationSipaDeriver,
  deriveRecordedRegistrationSipa,
  SIPADepositStore,
  signAccountDigest,
  deriveBootstrapKey,
  consentDigest,
  readSipaFunding,
  settledBalance,
  type AddressScreener,
  type PendingRegistrationRecord,
  type SipaFundingToken,
  type SipaSweepSubject,
} from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getConfig, l1Transport } from "../../config/env"
import { getFeeTokenBridgeTuple, oxideEnvFor, requireTupleField } from "../../config/oxideTuple"
import {
  AlreadySweptError,
  assertSweepCapacity,
  readSipaDeployed,
  revertedSweepMessage,
  submitSweep,
  sweepManifestFrom,
} from "../deposit/sipaSweep"
import { sipaProcessingObserver } from "../deposit/sipaProcessing"
import { sipaFundingTokens } from "../deposit/loadDepositFacts"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "../deposit/sipaRecovery"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { txAmountCap } from "../token/oxideToken"
import { getPendingStore } from "./webRegistration"
import { sweptPhase } from "./registrationRailSync"
import { readRegistrationSchedule } from "./registrationTerms"
import { requireNameClaim } from "./nameClaim"
import { seededRegistrationSalt } from "./registrationDepositSeed"
import type { OnboardingKeys } from "./oxideOnboarding"
import { reportRegistrationDepositSwept } from "./registrationFunnel"

export { sweptPhase }

export { registrationRecordForSipa } from "./webRegistration"

/** A blocked verdict throws Predicate's own message, stopping the sweep before signing. */
export async function assertScreened(
  screen: AddressScreener["screen"] | undefined,
  address: Address,
): Promise<void> {
  if (!screen) return
  const verdict = await screen(address)
  if (!verdict.compliant) {
    throw new Error(
      verdict.reason?.message ?? "This address can't be used here. Use a different one.",
    )
  }
}

export interface ManualRegistrationSweepOptions {
  /** Recovered account keys — the caller runs the passkey assertion so the prompt has UI context. */
  keys: Pick<OnboardingKeys, "secretKey" | "account">
  /** Bridge mode: the address the deposit fee is paid to. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting account. */
  from?: Hex
  /** Screens the paid address once the channel resolves it; a blocked verdict stops the sweep before signing. */
  screen?: AddressScreener["screen"]
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
  /** Progress the sweep makes before it reaches a channel stage, such as waiting out a name-claim refusal. */
  onNotice?: (message: string) => void
}

/** This address holds the earlier price for good: only a recovery frees the funds to re-register. */
export const SWEEP_PRICE_COMMITTED =
  "This address is registered at a different price. Recover the deposit, then register again at the current price."

/** No claim priced this address, and the deployment's own schedule does not either. A re-signed claim may. */
export const SWEEP_QUOTE_UNUSABLE =
  "This quote cannot register this address yet. Try the sweep again in a moment."

/**
 * Re-derive, guard, and submit the registration sweep for `record`. Resolves to the L1 tx hash;
 * the record gets `sweepTxHash` stamped and the detection tick confirms from the Sweep event as
 * usual — this path never writes `sweptAt` itself.
 */
export async function manualRegistrationSweep(
  record: PendingRegistrationRecord,
  opts: ManualRegistrationSweepOptions,
): Promise<Hex> {
  const config = getConfig()
  const { tuple, env, publicClient } = await oxideEnvFor(config)

  const derive = createRegistrationSipaDeriver({
    publicClient,
    env,
    tuple,
  })
  // The record's committed payment: a record from before the intent committed it cannot re-derive.
  if (record.fee === undefined || record.beneficiary === undefined) {
    throw new Error(
      "This claim predates the committed registration fee, so the sweep was stopped before signing.",
    )
  }
  const derivation = await deriveRecordedRegistrationSipa(
    derive,
    {
      owner: record.account as Address,
      nameHash: record.nameHash as Hex,
      l2Address: record.l2Address as Hex,
      fee: BigInt(record.fee),
      beneficiary: record.beneficiary as Address,
      masterSecret: opts.keys.secretKey,
    },
    record.sipaAddress as Address,
    seededRegistrationSalt,
  )
  if (derivation.sipaAddress.toLowerCase() !== record.sipaAddress.toLowerCase()) {
    throw new Error(
      "This claim's details point to a different deposit address, so the sweep was stopped before signing.",
    )
  }

  // Read before the claim: the controller's own fee is what tells a terms-less cached claim apart
  // from one that cannot price this address, so it decides whether the service is asked at all.
  const controllerSchedule = await readRegistrationSchedule(config).catch(() => undefined)
  const claim = await requireNameClaim(record, opts.keys, {
    onNotice: opts.onNotice,
    controllerFee: controllerSchedule?.fee,
  })

  const schedule = claim.terms
    ? { fee: BigInt(claim.terms.fee), min: BigInt(claim.terms.minDeposit) }
    : controllerSchedule
  const priced = schedule !== undefined && schedule.fee === BigInt(record.fee)
  const floor = priced ? registrationFloor(schedule) : undefined
  // The pre-flight checks the same cap the sweep enforces, the fee token row's, so an unread cap signs nothing.
  const cap = await getFeeTokenBridgeTuple(config)
    .then((fee) => txAmountCap(publicClient, requireTupleField(fee, "portal") as Address))
    .catch(() => undefined)
  // The SIPA swaps whichever accepted token it holds into the fee token at sweep time, and the
  // controller floors what lands, so a swapped deposit is judged on the least the swap may settle.
  const tokens = await sipaFundingTokens(config, record.depositToken as Address, "registration")
  const covers = (balance: bigint, sent: SipaFundingToken) =>
    floor !== undefined && settledBalance(tokens[0], sent, balance) >= floor
  const fee = BigInt(record.fee)
  const { token, status } = await readSipaFunding(publicClient, {
    sipa: record.sipaAddress as Address,
    routes: tokens.map((sent) => ({
      token: sent,
      settlesIn: tokens[0],
      fee,
      txAmountCap: cap ?? 0n,
    })),
    accepted: floor === undefined ? undefined : covers,
    decided: floor !== undefined && cap !== undefined,
  })
  if (status.balance === 0n) throw new AlreadySweptError()
  if (!priced) {
    // A signed schedule naming another fee is the price this address is shut out of; a claim that
    // carried none fell back to the deployment's own figures and a re-signed one may yet price it.
    throw new Error(claim.terms ? SWEEP_PRICE_COMMITTED : SWEEP_QUOTE_UNUSABLE)
  }
  if (cap === undefined) {
    throw new Error(
      "This registration's deposit limit is not available yet. Try again in a moment.",
    )
  }
  if (!covers(status.scaledBalance, token)) {
    throw new Error("The deposit does not yet cover this registration's fee and opening balance.")
  }
  // The rail can lag this balance or lack the record; the re-derived address pins its origin. The
  // amount is in the token the SIPA holds, which may not be the fee token.
  const live: Omit<SipaSweepSubject, "sipaAddress"> = {
    l1ChainId: record.l1ChainId,
    origin: derivation.origin,
    phase: "funded",
    amount: formatUnits(status.balance, token.decimals),
    tokenAddress: token.address,
    tokenDecimals: token.decimals,
    intent: "registration",
    registrationFee: record.fee,
  }
  const checkCapacity = () =>
    sipaProcessingObserver()?.refreshForSweep(record.sipaAddress, live) ??
    Promise.resolve(undefined)
  await assertSweepCapacity(checkCapacity)

  // The controller resolves the metadata registry off the NameRegistry at sweep time, and checks
  // the committed SIPA against its own caller, so both are read the same way the sweep will.
  const reader = createOxideL1Reader(publicClient)
  const bootstrap = deriveBootstrapKey(opts.keys.secretKey)
  const consentSig = await signAccountDigest({
    account: record.account as Address,
    chainId: env.l1ChainId,
    bootstrap,
    reader,
    passkey: await oxideAccountPasskey(opts.keys.account.getAuthProvider()),
    hash: consentDigest(
      derivation.recordData,
      env.l1ChainId,
      await reader.readAccountMetadataRegistry(env.registry),
      record.sipaAddress as Address,
    ),
  })
  const signedTerms: SignedTermsArg = claim.terms
    ? {
        fee: BigInt(claim.terms.fee),
        minDeposit: BigInt(claim.terms.minDeposit),
        nonce: BigInt(claim.terms.nonce),
        deadline: BigInt(claim.terms.deadline),
        signature: claim.terms.signature as Hex,
      }
    : EMPTY_SIGNED_TERMS

  if (!record.r1Key || !record.credentialId) {
    throw new Error("pending registration record lacks the passkey to install — cannot sweep")
  }
  const r1Install = await buildRegistrationR1Install(
    opts.keys.secretKey,
    record.account as Address,
    env,
    createOxideL1Reader(publicClient),
    record.r1Key,
    record.credentialId,
  )

  const l1Client: PublicClient = createPublicClient({ transport: l1Transport(config) })
  const channel = await registrationSweepChannel(record, l1Client, opts)
  await assertScreened(opts.screen, channel.target)
  const manifest = sweepManifestFrom(tuple)
  const deployed = await readSipaDeployed(l1Client, record.sipaAddress as Address)
  const call = buildRegistrationSelfSweepCall(
    {
      sipaAddress: record.sipaAddress as Address,
      sipaArgs: derivation.sipaArgs,
      registrationData: derivation.registrationData,
      consentSig,
      bootstrap: bootstrap.address,
      domainAuth: {
        nonce: BigInt(claim.nonce),
        deadline: BigInt(claim.deadline),
        signature: claim.signature as Hex,
      },
      signedTerms,
      r1Install,
    },
    {
      deployed,
      relayer: channel.target,
      manifest: {
        sipaFactory: manifest.sipaFactory,
        token: token.address,
      },
    },
  )

  const hash = await submitSweep(channel, call.to, call.data)
  if (!(await channel.waitForReceipt(hash))) {
    const state = await checkCapacity().catch(() => undefined)
    throw new Error(
      revertedSweepMessage(
        hash,
        state,
        "A relayer may have swept this deposit first, or the deposit is below the registration total.",
      ),
    )
  }
  // The receipt is authoritative: the detection tick and the rail's sync loop reconcile from the
  // Sweep event, so a failed local stamp must not report a landed sweep as failed. The rail stamp
  // clears the stuck-sweep affordance on the deposit surface too; the phase is re-read because a
  // sync pass may have advanced it while the receipt was awaited.
  try {
    await getPendingStore().upsert(record.account, { sweepTxHash: hash, sweptAt: Date.now() })
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    const deposit = rail.get(record.sipaAddress as Address)
    if (deposit) {
      await rail.upsert(deposit.sipaAddress, {
        phase: sweptPhase(deposit.phase),
        sweepTxHash: hash,
      })
    }
  } catch (err) {
    console.warn("[registrationSweep] sweep landed but the local stamp failed", err)
  }
  reportRegistrationDepositSwept(record.account, Date.now() - (record.fundedAt ?? record.startTime))
  return hash
}

/** Same channel split as the plain self-sweep: injected wallet, or the desktop helper page. */
async function registrationSweepChannel(
  record: PendingRegistrationRecord,
  publicClient: PublicClient,
  opts: ManualRegistrationSweepOptions,
): Promise<L1ExitChannel> {
  const config = getConfig()
  if (!isDesktopL1SubmitActive()) {
    return await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }
  if (!opts.destination) {
    throw new Error("Enter the Ethereum address that should receive the network tip.")
  }
  return desktopBridgeChannel({
    destination: opts.destination,
    chainId: config.l1ChainId,
    publicClient,
    display: {
      title: "Register your zk.money name",
      lines: [
        ["Name", `${record.tag}.zk.money`],
        ["Deposit address", record.sipaAddress],
        ["Network tip to", opts.destination],
      ],
    },
    onHelperOpened: opts.onHelperOpened,
    onStage: opts.onStage,
  })
}
