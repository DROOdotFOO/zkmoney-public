/**
 * Assertions around a burn to L1: that it made a withdrawal the enclave actually signed, plus
 * balance helpers for the escrow and the creator.
 */
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { TxHash } from "@aztec-labs/stdlib/tx"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import {
  extractMetadata,
  extractRequiredNullifiers,
  extractTeeNotes,
  extractWithdrawalMessageHashes,
} from "@oxide/oxide-lib/da_extractors.js"
import { decodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { buildWithdrawalOperationDigest } from "@oxide/tee-enclave/digest.js"
import { k1NoteSignatureToRS } from "@oxide/tee-enclave/signer.js"
import { verifyEcdsa } from "@oxide/tee-enclave/libsecp256k1_signer.js"

import type { VerifiedWithdrawalInTx } from "@oxide/oxide-client/withdrawal_in_tx.js"

import { recoverBurnWithdrawals } from "../../../src/oxide/withdrawal/burnWithdrawals.js"
import type { ObsidionWallet } from "../../../src/obsidion/ObsidionWallet.js"
import type { PaylinkService, PaylinkParams } from "../../../src/services/paylink/PaylinkService.js"
import { registerEscrow } from "../../../src/services/paylink/claim/paylinkVoucher.js"
import type { TokenService } from "../../../src/services/token/TokenService.js"
import type { OxideTokenSandbox } from "../oxide/oxideTokenSandbox.js"

export type L1ClaimTips = { proverTip: bigint }
export const ZERO_TIPS: L1ClaimTips = { proverTip: 0n }

/** The escrow's instance as rebuilt in the claimer's PXE. */
export async function escrowInstance(
  paylinkService: PaylinkService,
  params: PaylinkParams,
): Promise<ContractInstanceWithAddress> {
  const { instance } = await paylinkService.reconstructPaylinkContract(params)
  return instance
}

/** A withdrawal of a burn tx. */
export type L1ClaimWithdrawal = {
  executor: EthAddress
  recipient: EthAddress
  amount: bigint
  proverTip: bigint
  relayerTip: bigint
  messageHash: Fr
  /** True when the withdrawal signature verifies against the enclave key over the rebuilt operation digest. */
  signedByEnclave: boolean
}

type ClaimSandbox = Pick<
  OxideTokenSandbox,
  "wallet" | "node" | "portalDomain" | "localTeeSigner" | "contractService"
>

/**
 * `owner`'s withdrawals of a direct `withdraw` burn, recovered from the tx's recovery events.
 * `wallet` must hold `owner`'s keys; default `sandbox.wallet`.
 */
export async function readL1Claim(
  sandbox: ClaimSandbox,
  txHash: TxHash,
  owner: AztecAddress,
  wallet: Pick<ObsidionWallet, "getPrivateEvents"> = sandbox.wallet,
): Promise<L1ClaimWithdrawal[]> {
  const { node, portalDomain: portal } = sandbox
  const withdrawals = await recoverBurnWithdrawals({ wallet, node, portal, owner, txHash })
  return describeWithdrawals(sandbox, txHash, withdrawals)
}

/**
 * The withdrawals of a paylink `claim_to_l1` burn. The escrow is the `from` of the token's
 * `withdraw`, so the token delivers the recovery events to the escrow. `wallet` must hold the
 * escrow's keys, as the wallet that sent the claim does; default `sandbox.wallet`.
 */
export async function readEscrowL1Claim(
  sandbox: ClaimSandbox,
  txHash: TxHash,
  params: PaylinkParams,
  wallet: ObsidionWallet = sandbox.wallet,
): Promise<L1ClaimWithdrawal[]> {
  const { contractService } = sandbox
  const { instance } = await registerEscrow({ wallet, contractService }, params)
  return readL1Claim(sandbox, txHash, instance.address, wallet)
}

/**
 * Check each withdrawal is the one the enclave signed: rebuild the operation digest from the DA logs
 * (anchor block hash, required nullifiers, TEE notes, withdrawal message hashes) and verify the
 * withdrawal signature against the sandbox enclave key. This is the attestation the enclave re-checks
 * at finalization, so a zeroed or wrong-digest signature fails here instead of on production.
 */
async function describeWithdrawals(
  sandbox: ClaimSandbox,
  txHash: TxHash,
  withdrawals: VerifiedWithdrawalInTx[],
): Promise<L1ClaimWithdrawal[]> {
  const { node, portalDomain: portal } = sandbox
  const token = portal.l2Token
  const indexed = await node.getTxEffect(txHash)
  if (!indexed) throw new Error(`tx effect not indexed for ${txHash}`)
  const effect = indexed.data
  const [metadata, requiredNullifiers, siloedNoteHashes, withdrawalMessageHashes] =
    await Promise.all([
      extractMetadata(effect, token),
      extractRequiredNullifiers(effect, token),
      extractTeeNotes(effect, token),
      extractWithdrawalMessageHashes(effect, token),
    ])
  const { x, y } = sandbox.localTeeSigner.publicKey
  const pub = Buffer.concat([Buffer.from([0x04]), x.toBuffer(), y.toBuffer()])
  return Promise.all(
    withdrawals.map(async ({ finalizationData: data, messageHash }) => {
      const digest = await buildWithdrawalOperationDigest({
        anchorBlockHash: metadata.anchorBlockHash,
        tokenAddress: token,
        l1Portal: portal.l1Portal,
        teeRegistry: portal.teeRegistry,
        requiredNullifiers,
        siloedNoteHashes,
        withdrawalMessageHashes,
        messageHash,
      })
      const { r, s } = k1NoteSignatureToRS(data.withdrawalSignature)
      const nonZero = !(r.toBuffer().every((b) => b === 0) && s.toBuffer().every((b) => b === 0))
      const signedByEnclave =
        nonZero && verifyEcdsa(Buffer.concat([r.toBuffer(), s.toBuffer()]), digest.toBuffer(), pub)
      const { recipient, relayerTip } = decodePlainWithdrawalPayload(data.userPayload)
      return {
        executor: data.executor,
        recipient,
        amount: data.amount,
        proverTip: data.proverTip,
        relayerTip,
        messageHash,
        signedByEnclave,
      }
    }),
  )
}

/**
 * Poll until `account`'s private balance equals `expected`. The sender's PXE discovers its change
 * note and marks the spent note lazily on the next simulation, so a deposit issued straight after
 * the previous one can otherwise see a stale note set ("Balance too low" / "Existing nullifier").
 */
export async function waitForBalance(
  tokenService: TokenService,
  account: Parameters<TokenService["getBalance"]>[0],
  expected: bigint,
  attempts = 30,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await tokenService.getBalance(account)) === expected) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`balance did not reach ${expected} after ${attempts} attempts`)
}

/** Private balance of the escrow as seen from the claimer's PXE (escrow keys are in scope there). */
export async function escrowBalance(
  tokenService: TokenService,
  escrow: AztecAddress,
  from: AztecAddress,
): Promise<bigint> {
  const token = await tokenService.getTokenContract()
  const { result } = await token.methods.balance_of!(escrow).simulate({
    from,
    additionalScopes: [escrow],
  })
  return BigInt(result.toString())
}
