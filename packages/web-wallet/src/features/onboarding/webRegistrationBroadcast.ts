import { getWebBroadcasterArtifact, getWebOxideToken } from "../../config/classArtifacts"
/**
 * D3a: publish a registration SIPA to relayers (registration-fee.md §Relayers). It rides the
 * one-shot `registration-broadcast` rail, so the tx that subscribes against the NameClaim also pays
 * for itself and spends the rail's only use.
 *
 * The batch carries no account call and needs no signature: the account has no setup step, and
 * the subscribe leg's eligibility is the NameClaim. A ticket-funded registration's claim sends it,
 * on this rail or in the claim's own batch.
 *
 * The plain-SIPA analogue is `sipaGateway.broadcastSipa`; registration rides the same `SIPA` event
 * and sweep broadcast — it is just one more intent (the registration record + its
 * consent/domain/waiver proofs) — and caches the fresh claim here so the subscribe leg can find it
 * (it can't be recovered from the `NameClaimed` log before registration).
 */
import type { Address } from "viem"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  assertSubsidySweepsSipa,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildSipaSweepBroadcasts,
  claimFpcSponsoredFee,
  encodeRegistrationProofs,
  encodeLegacyRegistrationProofs,
  BroadcasterContract,
  OxideSipaIntent,
  type ContractService,
  ensureContractRegisteredInPXE,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import {
  composeWireNameHash,
  NameClaimStore,
  type RegistrationBroadcaster,
  type RegistrationBroadcastPayload,
} from "@obsidion/front-core"

import { claimSponsorContext } from "./claimSponsorship"
import { RAIL_REGISTRATION_BROADCAST } from "./rails"
import {
  getFeeTokenBridgeTuple,
  getOxideTuple,
  l1PublicClient,
  requireTupleField,
} from "../../config/oxideTuple"
import { readSipaDeployed } from "../deposit/sipaSweep"
import { getSipaSweepRoutes } from "../deposit/sipaSweepRoutes"
import type { WebWalletConfig } from "../../config/env"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"

export interface WebRegistrationBroadcasterDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contractService: ContractService
  config: WebWalletConfig
  /** The bare tag being registered — names the cached NameClaim so the subscribe leg resolves it. */
  handle: string
}

/**
 * Cache the fresh claim so `claimSponsorContext`'s subscribe leg finds it: the name is not yet
 * registered, so it cannot be recovered from the Registry's NameClaimed log. Runs ahead of the
 * registration's broadcast, wherever it is sent.
 */
export async function cacheFreshClaim(
  deps: Pick<WebRegistrationBroadcasterDeps, "account" | "config" | "handle">,
  payload: RegistrationBroadcastPayload,
): Promise<void> {
  const tuple = await getOxideTuple(deps.config)
  await NameClaimStore.get().put({
    address: deps.account.getAddress().toString(),
    handle: deps.handle,
    nameHash: composeWireNameHash(deps.handle, requireTupleField(tuple, "ensDomain")),
    nonce: String(payload.domainAuth.nonce),
    deadline: String(payload.domainAuth.deadline),
    signature: payload.domainAuth.signature,
    // The signed terms ride the record so a later manual sweep prices the same floor.
    ...(payload.signedTerms.signature !== "0x"
      ? {
          terms: {
            fee: String(payload.signedTerms.fee),
            minDeposit: String(payload.signedTerms.minDeposit),
            nonce: String(payload.signedTerms.nonce),
            deadline: String(payload.signedTerms.deadline),
            signature: payload.signedTerms.signature,
          },
        }
      : {}),
  })
}

/**
 * The PXE only simulates calls into contracts it holds an instance + artifact for, and at
 * onboarding nothing else has registered the broadcaster yet (the deposit-discovery mount does,
 * but only once the wallet is open). A PXE that already holds it is not asked again.
 */
export async function registeredBroadcaster(
  wallet: ObsidionWallet,
  tuple: OxideEnvTuple,
): Promise<BroadcasterContract> {
  const address = AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Broadcaster"))
  const instance = await wallet.node.getContract(address)
  if (!instance) throw new Error(`Broadcaster instance not found at ${address}`)
  const artifact = await getWebBroadcasterArtifact(wallet, address, instance)
  // The instance is read once: the registration takes the one the artifact lookup used.
  await ensureContractRegisteredInPXE(
    wallet.pxe,
    { getContract: async () => instance },
    address,
    async () => artifact,
  )
  return BroadcasterContract.at(address, artifact, wallet as never)
}

/**
 * The calls that publish a registration SIPA: the `SIPA` event to the account and the sweeps the
 * relayer runs. Its own broadcast sends them, and so does a ticket claim batch that carries them.
 * Refuses an address the subsidy would not sweep.
 */
export async function registrationBroadcastCalls(
  deps: Omit<WebRegistrationBroadcasterDeps, "account" | "handle">,
  payload: RegistrationBroadcastPayload,
): Promise<ContractFunctionInteraction[]> {
  const { wallet, contractService, config } = deps
  // A registration settles on the fee token's row, so it sweeps through that bridge.
  const tuple = await getFeeTokenBridgeTuple(config)
  const l1 = l1PublicClient(config)
  const routes = getSipaSweepRoutes(
    config,
    tuple,
    payload.sipaArgs,
    "registration",
    bridgeUnderlying(tuple),
  )
  const [deployed, broadcaster, token, sweepRoutes] = await Promise.all([
    readSipaDeployed(l1, payload.sipaAddress).then(async (deployed) => {
      if (!deployed && !("recoveryAddress" in payload.sipaArgs)) {
        await assertSubsidySweepsSipa(l1, {
          routes: await routes,
          sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
          intent: OxideSipaIntent.Registration,
          deployArgs: payload.sipaArgs,
          intentData: payload.registrationData,
          sipa: payload.sipaAddress,
        })
      }
      return deployed
    }),
    registeredBroadcaster(wallet, tuple),
    getWebOxideToken(wallet, contractService, requireTupleField(tuple, "l2Token")),
    routes,
  ])
  return buildSipaSweepBroadcasts(token, broadcaster, {
    recipient: AztecAddress.fromStringUnsafe(payload.recipient),
    sharedSecretSalt: Fr.fromString(payload.sharedSecretSalt),
    resweepable: payload.sipaArgs.resweepable,
    intentHash: payload.sipaArgs.intentHash,
    sipa: payload.sipaAddress,
    deployed,
    sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
    intent: OxideSipaIntent.Registration,
    deployArgs: payload.sipaArgs,
    intentData: payload.registrationData,
    proofs: ("recoveryAddress" in payload.sipaArgs
      ? encodeLegacyRegistrationProofs
      : encodeRegistrationProofs)({
      consentSig: payload.consentSig,
      bootstrap: payload.bootstrap,
      domainAuth: payload.domainAuth,
      signedTerms: payload.signedTerms,
      r1Install: payload.r1Install,
    }),
    operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
    chainId: BigInt(config.l1ChainId),
    routes: sweepRoutes,
  })
}

/**
 * A {@link RegistrationBroadcaster} bound to this session's wallet + account. Resolves with the tx
 * hash once the node took it; a throw is the ledger's to retry, so this never swallows failures.
 */
export function createWebRegistrationBroadcaster(
  deps: WebRegistrationBroadcasterDeps,
): RegistrationBroadcaster {
  const { wallet, account, contractService } = deps
  return async (payload: RegistrationBroadcastPayload, attempt = {}) => {
    const address = account.getAddress()
    await cacheFreshClaim(deps, payload)
    const [sponsor, broadcastCalls] = await Promise.all([
      claimSponsorContext({ wallet, account, contractService }, RAIL_REGISTRATION_BROADCAST),
      registrationBroadcastCalls(deps, payload).then(async (interactions) =>
        (
          await Promise.all(interactions.map((call) => call.request()))
        ).flatMap((request) => request.calls),
      ),
    ])
    const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor

    const common = {
      fpcAddress,
      fpcArtifact,
      railId,
      policy,
      user: address,
      innerCalls: broadcastCalls,
      classWitnesses: [],
    }
    const txPayload = subscribe
      ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
      : await buildClaimSponsorPayload(common)

    const { operationId, onTxHash } = attempt
    // NO_FROM: eligibility is the entrypoint's subscription, not a user signature over the
    // broadcast. The subscribe leg reads this account's notes, and the `SIPA` event is sent to it.
    // Resolves once mined, so the next scheduler step finds it included.
    const { receipt } = await wallet.sendTx(txPayload, {
      ...(operationId ? { operationId } : {}),
      ...(onTxHash ? { onTxHash } : {}),
      from: NO_FROM,
      sendMessagesAs: address,
      additionalScopes: [address],
      fee: claimFpcSponsoredFee(policy, common.innerCalls),
    })
    return receipt.txHash.toString()
  }
}
