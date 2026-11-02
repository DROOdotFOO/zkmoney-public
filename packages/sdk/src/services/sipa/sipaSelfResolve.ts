import { predictLegacySIPA, type LegacySipaDeployArgs } from "@oxide/l1-contracts/legacy_sipa.js"
/**
 * SIPA self-resolution — the recipient derives its own deposit address from a key only it holds
 * (`deriveSelfSipaSecret`). Pure derivation — no gateway, no RPC — except `resolveAddress`, which
 * adds the one Registry CREATE2-predict read on top. A self-resolved address is announced on L2
 * through a ClaimFPC-sponsored `OxideToken.notify_sipa_recipient`, with no user signature and no
 * resolver involvement — eligibility is the sponsoring entrypoint's subscription.
 */

import type { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { secp256k1 } from "@noble/curves/secp256k1"
import { predictSIPA, type SipaDeployArgs } from "@oxide/l1-contracts"
import type { Address, Hex, PublicClient } from "viem"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  buildDepositIntent,
  readDepositSIPAImplementation,
  type SipaIntent,
} from "./sipaIntents.js"
import {
  MAX_NONCE,
  computeStealthRecipientHash,
  deriveSelfSipaSecret,
  deriveRecoveryAddress,
  type SipaK1Point,
} from "./sipaStealth.js"

/**
 * The `resweepable` flag self-broadcast clients pass to `OxideToken.notify_sipa_recipient` and
 * predict the address with. Part of the SIPA's CREATE2 commitment, so an address predicted with a
 * different value is not the address the broadcast publishes.
 */
export const SELF_BROADCAST_RESWEEPABLE = true

export interface SipaSelfResolution {
  day: number
  nonce: number
  /** The SIPA event's `shared_secret_salt`. */
  messageSecret: Fr
  recipientHash: Fr
  recoveryCommitment: Fr
  recoveryAccount: EthAddress
}

/**
 * The nonce for a wallet's `slot`-th self-resolution of a day, counting DOWN from `MAX_NONCE - 1`.
 * The resolver hands out nonces counting up from 0 per user-day, so a `(day, nonce)` names one
 * address per side. Sequential slots make a wallet's self-resolved SIPAs recoverable on any device:
 * per day, derive from slot 0 down until the first slot with no on-chain SIPA.
 */
export function selfSipaNonce(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_NONCE) {
    throw new Error(`self SIPA slot out of range: ${slot}`)
  }
  return MAX_NONCE - 1 - slot
}

/** The two wallet keys a self-resolution needs. */
export interface SipaSelfResolverKeys {
  /** The registry stealth scalar. Its point is the base of a `legacy-eoa` recovery address. */
  stealthScalar: bigint
  /** The wallet-only key the salts hash from. */
  selfSipaKey: Fr
}

export class SipaSelfResolver {
  readonly userPublicKey: SipaK1Point
  private readonly selfSipaKey: Fr

  constructor(keys: SipaSelfResolverKeys) {
    this.selfSipaKey = keys.selfSipaKey
    const point = secp256k1.ProjectivePoint.BASE.multiply(keys.stealthScalar).toAffine()
    this.userPublicKey = { x: point.x, y: point.y }
  }

  /**
   * Derive the SIPA parameters for `(day, nonce)` with `user` as the L2 recipient. `messageSecret`
   * replays the salt of an address derived under an earlier key.
   */
  async resolve(
    user: AztecAddress,
    day: number,
    nonce: number,
    recoveryAccount: EthAddress,
    messageSecret: Fr = deriveSelfSipaSecret(this.selfSipaKey, day, nonce),
  ): Promise<SipaSelfResolution> {
    return {
      day,
      nonce,
      messageSecret,
      recipientHash: await computeStealthRecipientHash(messageSecret, user),
      recoveryCommitment: deriveRecoveryCommitment(messageSecret, recoveryAccount),
      recoveryAccount,
    }
  }

  /**
   * {@link resolve} + the SIPAFactory's CREATE2 prediction in one step — the standard self-generated
   * deposit address, shaped exactly as `OxideToken.notify_sipa_recipient` announces it (resweepable,
   * account recovery commitment). The one method here that reads L1. Deterministic in `(day, nonce)`,
   * so callers re-derive rather than persisting the secret.
   */
  async resolveAddress(args: {
    user: AztecAddress
    recoveryAccount: Address
    protocol?: "legacy-eoa" | "account"
    day: number
    /** See {@link selfSipaNonce}. */
    nonce: number
    publicClient: PublicClient
    /** The permanent CREATE2 deployer every SIPA address commits to. */
    sipaFactory: Address
    /** The deployment's ForwardingTable: it routes the SIPA's sweeps to the portal. */
    forwardingTable: Address
    rollupVersion: bigint
  }): Promise<SelfResolvedSipa> {
    const resolution = await this.resolve(
      args.user,
      args.day,
      args.nonce,
      EthAddress.fromString(args.recoveryAccount),
    )
    // A self-broadcast deposit is the deposit intent; its clone delegates to the deposit impl.
    const implementation = await readDepositSIPAImplementation(args.publicClient, args.sipaFactory)
    const intent = buildDepositIntent({
      implementation,
      recipientCommitment: resolution.recipientHash.toString() as Hex,
    })
    const common = {
      implementation,
      intentHash: intent.intentHash,
      rollupVersion: args.rollupVersion,
      resweepable: SELF_BROADCAST_RESWEEPABLE,
    }
    const sipaArgs: SipaDeployArgs | LegacySipaDeployArgs =
      args.protocol === "legacy-eoa"
        ? {
            ...common,
            recoveryAddress: deriveRecoveryAddress(
              this.userPublicKey,
              resolution.messageSecret,
            ).toString() as Address,
          }
        : {
            ...common,
            recoveryCommitment: resolution.recoveryCommitment.toString() as Hex,
            forwardingTable: args.forwardingTable,
          }
    const sipaAddress =
      "recoveryAddress" in sipaArgs
        ? await predictLegacySIPA(args.publicClient, args.sipaFactory, sipaArgs)
        : await predictSIPA(
            args.publicClient,
            args.sipaFactory,
            sipaArgs.implementation,
            sipaArgs.intentHash,
            sipaArgs.recoveryCommitment,
            sipaArgs.rollupVersion,
            sipaArgs.resweepable,
            sipaArgs.forwardingTable,
          )
    return { sipaAddress, sipaArgs, intent, resolution }
  }
}

/** A self-resolved SIPA with its on-chain CREATE2 prediction. */
export interface SelfResolvedSipa {
  sipaAddress: Address
  /** The address's CREATE2 preimage, in the SIPAFactory's deploy-args shape. */
  sipaArgs: SipaDeployArgs | LegacySipaDeployArgs
  /** The built deposit intent — `intentData`/`proofs` the broadcast publishes and the sweep reveals. */
  intent: SipaIntent
  resolution: SipaSelfResolution
}
