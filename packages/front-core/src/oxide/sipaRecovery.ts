import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { Address, Hex } from "viem"
import type { LegacySipaDeployArgs } from "@oxide/l1-contracts/legacy_sipa.js"
import {
  sipaERC20RecoveryDigest,
  sipaETHRecoveryDigest,
} from "@oxide/l1-contracts/sipa_recovery.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { buildDepositIntent, buildSipaRecoverCall, type SipaDeployArgs } from "@obsidion/sdk"
import { logger } from "../utils/logger"

import { isNativeEth } from "./sipaFunding"
import {
  buildRecoverErc20Digest,
  signSipaRecovery,
} from "../core/services/deposits/sipa/recoverySignature"
import {
  deriveRecoveryAddress,
  deriveRecoveryPrivateKey,
  type SipaK1Point,
} from "../core/services/deposits/sipa/stealth"
import type {
  SIPADepositRecord,
  SIPADepositStore,
} from "../core/services/deposits/SIPADepositStore"

export interface SipaRecoveryDeps {
  record: Pick<
    SIPADepositRecord,
    "sipaAddress" | "phase" | "messageSecret" | "recoveryAddress" | "tokenAddress" | "origin"
  > &
    Partial<Pick<SIPADepositRecord, "tokenSymbol" | "tokenDecimals">>
  /** The user's stealth keypair (`deriveStealthKey(masterSecret)`). */
  stealthKey: { scalar: bigint; publicKey: SipaK1Point }
  /** Where the recovered funds go — the connected wallet's address. */
  target: Address
  signAccount?: (account: Address, digest: Hex) => Promise<Hex>
  accountInitCode?: Hex
  /** The tokens to recover, each with a balance; the record names the first after the recovery. */
  tokens: readonly [Address, ...Address[]]
  chainId: number
  /**
   * Deploy capability for a SIPA no relayer ever touched. A relayer deploys only as part of a
   * sweep, so the `recoverable` population is typically counterfactual — and `recoverERC20` sent
   * to a codeless address confirms while moving nothing. An undeployed SIPA is deployed and
   * recovered atomically; the CREATE2 args are picked by prediction, so a wrong candidate can
   * never deploy to a stranger's address.
   */
  deployment: {
    /** Whether the SIPA already has code (`getCode` non-empty). */
    readDeployed: (sipa: Address) => Promise<boolean>
    /** Candidate CREATE2 origins (e.g. per manifest generation × resweepable flag). */
    candidates: SipaRecoverCandidate[]
    /** CREATE2 prediction for one candidate, against its own factory. */
    predict: (candidate: SipaRecoverCandidate) => Promise<Address>
  }
  /** L1 submission channel (connected wallet); resolves to the tx hash. */
  sendTransaction: (to: Address, data: Hex) => Promise<Hex>
  /** Confirmation wait; throws or returns false on a reverted tx. */
  waitForReceipt: (hash: Hex) => Promise<boolean>
  store: Pick<SIPADepositStore, "get" | "upsert">
  /** Injectable for tests; defaults to crypto.getRandomValues. */
  makeNonce?: () => Uint8Array
}

/** One possible CREATE2 origin for a record's SIPA: the deploying factory and its args. */
export type SipaRecoverCandidate =
  | { protocol: "legacy-eoa"; sipaFactory: Address; args: LegacySipaDeployArgs }
  | { protocol: "account"; sipaFactory: Address; args: SipaDeployArgs }

/**
 * CREATE2 candidates for `record` over the deployments it may have been derived under (the current
 * manifest tuple, plus historic ones for a deposit that predates a roll) × both `resweepable`
 * variants — the flag is not persisted, and prediction picks the right combination. Empty when the
 * record lacks its identity fields (pre-discovery).
 */
export function sipaDeployArgCandidates(
  record: Pick<SIPADepositRecord, "recipientHash" | "recoveryAddress" | "origin">,
  deployments: {
    sipaFactory: Address
    rollupVersion: bigint
    /** The factory's `depositSIPAImplementation()` — constant per factory. */
    implementation: Address
  }[],
): SipaRecoverCandidate[] {
  const origin = record.origin
  if (origin) {
    const args = {
      implementation: origin.implementation,
      intentHash: origin.intentHash,
      rollupVersion: BigInt(origin.rollupVersion),
      resweepable: origin.resweepable,
    }
    return [
      origin.protocol === "account"
        ? {
            protocol: "account",
            sipaFactory: origin.sipaFactory,
            args: {
              ...args,
              recoveryCommitment: origin.recoveryCommitment,
              forwardingTable: origin.forwardingTable,
            },
          }
        : {
            protocol: "legacy-eoa",
            sipaFactory: origin.sipaFactory,
            args: { ...args, recoveryAddress: origin.recoveryAddress },
          },
    ]
  }
  if (!record.recipientHash || !record.recoveryAddress) return []
  return deployments.flatMap((d) => {
    const intent = buildDepositIntent({
      implementation: d.implementation,
      recipientCommitment: record.recipientHash as Hex,
    })
    return [true, false].map((resweepable) => ({
      protocol: "legacy-eoa" as const,
      sipaFactory: d.sipaFactory,
      args: {
        implementation: d.implementation,
        intentHash: intent.intentHash,
        recoveryAddress: record.recoveryAddress as Address,
        rollupVersion: d.rollupVersion,
        resweepable,
      },
    }))
  })
}

/** The candidate that CREATE2-predicts `sipa`, or null when none does. */
async function matchDeployArgs(
  deployment: SipaRecoveryDeps["deployment"],
  sipa: Address,
): Promise<SipaRecoverCandidate | null> {
  for (const candidate of deployment.candidates) {
    if ((await deployment.predict(candidate)).toLowerCase() === sipa.toLowerCase()) {
      return candidate
    }
  }
  return null
}

type Recovery = Parameters<typeof buildSipaRecoverCall>[0]["recoveries"][number]

export async function runSipaRecovery(deps: SipaRecoveryDeps): Promise<Hex> {
  const { record } = deps
  const messageSecret = Fr.fromHexString(record.messageSecret)
  const [first, ...rest] = deps.tokens
  const recoveries: [Recovery, ...Recovery[]] = [await signRecovery(deps, messageSecret, first)]
  for (const token of rest) recoveries.push(await signRecovery(deps, messageSecret, token))

  const deployed = await deps.deployment.readDeployed(record.sipaAddress)
  let origin: SipaRecoverCandidate | null = null
  if (!deployed) {
    origin = await matchDeployArgs(deps.deployment, record.sipaAddress)
    if (!origin) {
      throw new Error(
        "This deposit's address has not been deployed yet, and its deployment details could not " +
          "be reconstructed. The funds are safe at the deposit address — contact support.",
      )
    }
  }
  const call = buildSipaRecoverCall({
    deployed,
    deployment: origin ?? undefined,
    recoveries,
    accountInitCode: deps.accountInitCode,
  })

  logger.log(
    `[sipaRecovery] recovering ${record.sipaAddress.slice(0, 10)}… → ${deps.target.slice(
      0,
      10,
    )}… (awaiting wallet signature)`,
  )
  const hash = await deps.sendTransaction(call.to, call.data)
  // Stamped before the receipt wait: a session that ends mid-wait must still find the hash. The
  // live phase is kept — a sweep may have been claimed while the wallet signature was pending.
  await deps.store.upsert(record.sipaAddress, {
    phase: deps.store.get(record.sipaAddress)?.phase ?? record.phase,
    recoveryTxHash: hash,
  })
  logger.log(`[sipaRecovery] recovery tx ${hash} sent — awaiting receipt`)
  const confirmed = await deps.waitForReceipt(hash)
  if (!confirmed) {
    throw new Error(`recovery transaction ${hash} reverted`)
  }
  // The record names the token the recovery moved; what it displayed may have been another token
  // that reached the address.
  await deps.store.upsert(record.sipaAddress, {
    phase: "recovered",
    recoveryTxHash: hash,
    tokenAddress: deps.tokens[0],
    ...(record.tokenSymbol !== undefined ? { tokenSymbol: record.tokenSymbol } : {}),
    ...(record.tokenDecimals !== undefined ? { tokenDecimals: record.tokenDecimals } : {}),
  })
  logger.log(`[sipaRecovery] recovered ${record.sipaAddress.slice(0, 10)}… in tx ${hash}`)
  return hash
}

async function signRecovery(
  deps: SipaRecoveryDeps,
  messageSecret: Fr,
  token: Address,
): Promise<Recovery> {
  const { record } = deps
  const nonceBytes = deps.makeNonce?.() ?? crypto.getRandomValues(new Uint8Array(32))
  if (nonceBytes.length !== 32) throw new Error("Recovery nonce must be 32 bytes")
  const nonce = `0x${Buffer.from(nonceBytes).toString("hex")}` as Hex
  const common = { sipa: record.sipaAddress, target: deps.target, token, nonce }
  if (record.origin?.protocol === "account") {
    const account = record.origin.recoveryAccount
    const commitment = deriveRecoveryCommitment(messageSecret, EthAddress.fromString(account))
    if (commitment.toString().toLowerCase() !== record.origin.recoveryCommitment.toLowerCase()) {
      throw new Error("Recovery account does not match the SIPA commitment")
    }
    if (!deps.signAccount) throw new Error("Account recovery signer is unavailable")
    const chainId = BigInt(deps.chainId)
    const signature = await deps.signAccount(
      account,
      isNativeEth(token)
        ? sipaETHRecoveryDigest(record.sipaAddress, chainId, deps.target, nonce)
        : sipaERC20RecoveryDigest(record.sipaAddress, chainId, deps.target, token, nonce),
    )
    return {
      ...common,
      protocol: "account",
      account,
      sharedSecretSalt: messageSecret.toString() as Hex,
      signature,
    }
  }
  const derivedAddress = deriveRecoveryAddress(deps.stealthKey.publicKey, messageSecret)
  if (derivedAddress.toString() !== record.recoveryAddress.toLowerCase()) {
    throw new Error(
      "derived recovery address does not match the SIPA's — wrong stealth key for this deposit",
    )
  }
  const recoveryKey = deriveRecoveryPrivateKey(deps.stealthKey.scalar, messageSecret)
  const digest = buildRecoverErc20Digest({
    contract: EthAddress.fromString(record.sipaAddress),
    chainId: BigInt(deps.chainId),
    target: EthAddress.fromString(deps.target),
    token: EthAddress.fromString(token),
    nonce: Buffer.from(nonceBytes),
  })
  return { ...common, protocol: "legacy-eoa", signature: signSipaRecovery(digest, recoveryKey) }
}
