/**
 * The bearer cash-out: burn a vouchered link's escrow straight to an Ethereum address, for a holder
 * with no zk.money account.
 *
 * Nothing here touches an account. The escrow's keys come from the link, the fee comes from the
 * voucher its creator gifted it, and the enclave co-signs the burn as it does every token
 * operation. What the link cannot supply is the destination, so the address is screened at the
 * commit point exactly as the wallet's own withdraw screens it. The burn spends the whole escrow,
 * so a link over the per-withdrawal limit cannot be cashed out.
 *
 * The burn lands in the shared withdrawal store, so oxide's relayer finalizes it and the tracker
 * walks it to `done` like any other. Its provenance says nobody here owns the destination.
 */
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { formatUnits, type Address } from "viem"
import {
  decodePaylinkInline,
  exitPaylinkWithVoucher,
  nextOperationId,
  paylinkVoucherUses,
  type ContractService,
  type ObsidionWallet,
  type RegisteredTeeSigner,
  type PaylinkL1Proof,
} from "@obsidion/sdk"
import {
  DEFAULT_CONTRACTS,
  tokenDecimalsForNetwork,
  WITHDRAW_RELAYER_TIP,
} from "@obsidion/core/constants"
import {
  bestEffort,
  withdrawalRecipients,
  paylinkIdentity,
  type AddressScreener,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { withdrawalExecutorFee } from "../withdraw/withdrawalFee"
import { getConfig } from "../../config/env"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { runOperation, type OperationHandle } from "../operations/operations"
import { withTimeout } from "../../lib/withTimeout"
import { claimSponsorRail } from "../onboarding/claimSponsorship"
import { RAIL_VOUCHER } from "../onboarding/rails"
import { l1PublicClient } from "../../config/oxideTuple"
import { owePaylinkClaim, reportPaylinkClaims } from "./paylinkClaimReport"
import { assertPaylinkSwapSource, paylinkTuple, readPaylinkSource } from "./paylinkSource"
import { linkIdentity } from "./linkIdentity"
import { historicTeeSigner } from "../migration/historicTokenContext"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import type { WithdrawalReceiveAsset } from "../withdraw/withdrawAssets"
import {
  currentDeployment,
  planSwapLeg,
  runBurn,
  swapRecordFields,
  withdrawalOptions,
  type SwapCommit,
  type SwapLeg,
  type WithdrawStage,
} from "../withdraw/withdrawGateway"
import { oxideTokenImmutablesOf, txAmountCap } from "../token/oxideToken"
import { session } from "../../platform/session"

/** Wallet + contracts + the enclave signer: everything a bearer exit needs, and no account. */
export interface PaylinkExitDeps {
  wallet: ObsidionWallet
  contractService: ContractService
  teeSigner: RegisteredTeeSigner
  /** Active network's rollup address, a `paylinkPh` input; without it the claim is not reported. */
  rollupAddress?: string
}

/** The voucher rail's sponsor context plus the link's escrow, registered in this PXE. */
async function voucherDeps(
  deps: Pick<PaylinkExitDeps, "wallet" | "contractService">,
  fragment: string,
) {
  const source = await readPaylinkSource(deps, fragment)
  const { sponsor } = await claimSponsorRail(deps, RAIL_VOUCHER, { tuple: source.tuple })
  return {
    wallet: deps.wallet,
    contractService: deps.contractService,
    sponsor,
    ...source,
  }
}

/** Bound on the escrow read; the visitor page holds its CTAs until this settles. */
const VOUCHER_READ_TIMEOUT_MS = 10_000

/**
 * Sponsored transactions this link's escrow still holds — how many cash-outs it can pay for. Zero
 * for a link created without a voucher, and for one whose voucher has been spent. Registering the
 * escrow in this PXE is part of the read, so it is slower than a plain simulation. `tokenAddress`:
 * the note's token as a read already found it, so the note is not read again for it.
 */
export async function linkVoucherUses(
  deps: Pick<PaylinkExitDeps, "wallet" | "contractService">,
  fragment: string,
  tokenAddress?: string,
): Promise<number> {
  const params = decodePaylinkInline(fragment)
  const tuple = tokenAddress
    ? await paylinkTuple(tokenAddress)
    : (await readPaylinkSource(deps, fragment)).tuple
  const { sponsor } = await claimSponsorRail(deps, RAIL_VOUCHER, { tuple })
  return withTimeout(
    paylinkVoucherUses(
      { wallet: deps.wallet, contractService: deps.contractService, sponsor },
      params,
    ),
    VOUCHER_READ_TIMEOUT_MS,
  )
}

/** Stable recovery identity of a link's withdrawal record. */
export function linkWithdrawalIdentity(fragment: string) {
  return { id: linkIdentity(fragment) }
}

/** What the recipient is left with after the executor's fee and the relayer tip. */
export function cashOutNet(amountAtomic: bigint, withdrawalFee: bigint): bigint {
  const net = amountAtomic - withdrawalFee - WITHDRAW_RELAYER_TIP
  return net > 0n ? net : 0n
}

/** Bearer burns in flight, by fragment: a second confirm while one proves joins it instead of re-burning. */
const inFlight = new Map<string, Promise<WithdrawalRecord>>()

/**
 * Burn the link's escrow to `recipient`, swap route included (a non-DAI output burns to the planned
 * escrow with the deploy broadcast riding the burn). Returns the persisted record, already mined on
 * L2 and armed with the chain watcher; the L1 release is oxide's relayer, as for every withdrawal.
 */
export function cashOutLink(
  deps: PaylinkExitDeps & { screener: AddressScreener },
  fragment: string,
  recipient: Address,
  onStage?: (stage: WithdrawStage) => void,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  /** Live quote at confirm time; persisted so the detail sheet can show the output estimate. */
  quote?: SwapCommit,
  zkProof?: PaylinkL1Proof,
  /** A leg planned ahead of the burn (an email proof binds to its escrow); planned here otherwise. */
  swap?: SwapLeg,
): Promise<WithdrawalRecord> {
  const live = inFlight.get(fragment)
  if (live) return live
  const run = runOperation(
    {
      operationId: nextOperationId("paylink-claim"),
      flow: "paylink-claim-l1",
      summary: "Cash-out to Ethereum",
    },
    (op) =>
      cashOutLinkFlow(op, deps, fragment, recipient, onStage, receiveAsset, quote, zkProof, swap),
  ).finally(() => inFlight.delete(fragment))
  inFlight.set(fragment, run)
  return run
}

/**
 * The swap leg of a bearer cash-out, sized off the escrow note's `amount` (the link carries none).
 * A bearer has no wallet: the escrow's recovery commits to the destination, salted from the link's
 * secret, so the destination can take back a swap the route cannot deliver.
 */
export async function planCashOutSwap(
  deps: Pick<PaylinkExitDeps, "wallet" | "contractService">,
  fragment: string,
  amount: bigint,
  recipient: Address,
  receiveAsset: WithdrawalReceiveAsset,
  quote?: SwapCommit,
): Promise<SwapLeg | undefined> {
  const { params, note, tuple } = await readPaylinkSource(deps, fragment)
  if (note.amount !== amount) throw new Error("The link balance changed; reopen the withdrawal")
  const recoverer = { account: recipient, secret: params.secret }
  return planSwapLeg(deps.wallet, receiveAsset, recipient, amount, quote, recoverer, tuple)
}

async function cashOutLinkFlow(
  op: OperationHandle,
  deps: PaylinkExitDeps & { screener: AddressScreener },
  fragment: string,
  recipient: Address,
  onStage?: (stage: WithdrawStage) => void,
  receiveAsset: WithdrawalReceiveAsset = "DAI",
  quote?: SwapCommit,
  zkProof?: PaylinkL1Proof,
  planned?: SwapLeg,
): Promise<WithdrawalRecord> {
  onStage?.("building")
  const network = getConfig().network

  // Re-screen at the commit point, before the burn: oxide's relayer enforces the same policy when
  // it batches, where a blocked recipient means a burned-but-never-finalized withdrawal. A screener
  // throw (verdict unknown) aborts too — fail closed.
  const verdict = await deps.screener.screen(recipient)
  if (!verdict.compliant) {
    throw new Error(verdict.reason?.message ?? "This address can't receive withdrawals")
  }

  const { params, note, tuple, ...voucher } = await voucherDeps(deps, fragment)
  const { amount } = note
  const decimals = tokenDecimalsForNetwork(network)
  assertWithinWithdrawalLimit(
    amount,
    await txAmountCap(l1PublicClient(getConfig()), tuple.portal as Address),
    "link",
    decimals,
  )
  const withdrawalFee = await withdrawalExecutorFee(tuple)
  if (amount <= withdrawalFee + WITHDRAW_RELAYER_TIP) {
    throw new Error("This link holds too little to cover the withdrawal fee")
  }
  const tokenAddress = note.tokenAddress
  const [signer, token] = await Promise.all([
    historicTeeSigner(tuple),
    oxideTokenImmutablesOf(tuple.l2Token),
  ])
  // The escrow is sized off the note; the burn refuses to sign if the note holds anything else.
  // A bearer has no passkey secret; its destination wallet owns escrow recovery.
  const swap =
    planned ?? (await planCashOutSwap(deps, fragment, amount, recipient, receiveAsset, quote))
  assertPaylinkSwapSource(swap, tuple)
  const withdrawal = withdrawalOptions(tuple, swap)

  const net = formatUnits(cashOutNet(amount, withdrawalFee), decimals)
  op.describe(`$${net} to Ethereum`)
  const paylinkId = paylinkIdentity(params)
  if (deps.rollupAddress) {
    await owePaylinkClaim(webStorage, paylinkId, {
      rollupAddress: deps.rollupAddress,
      secret: params.secret,
      flavor: params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct",
      amount,
      decimals,
    })
  }
  const { record, result } = await runBurn({
    op,
    wallet: deps.wallet,
    // The voucher's one-use allowance never renews, so the account-allowance copy does not apply.
    reportContext: "paylink:claim",
    record: {
      recipient,
      // Whoever held the link typed this address; no contact in this browser stands behind it.
      recipientProvenance: "saved-recipient",
      source: "paylink",
      paylinkId,
      amount: formatUnits(cashOutNet(amount, withdrawalFee), token.decimals),
      rawAmount: amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      ...(withdrawalFee ? { withdrawalFee: withdrawalFee.toString() } : {}),
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      phase: "submitting",
      startTime: Date.now(),
      deployment: await currentDeployment(tuple),
      ...swapRecordFields(swap, quote),
    },
    burn: (seeded, onTxHash) => {
      if (getConfig().network !== network) throw new Error("Network changed — reopen the link")
      onStage?.("proving")
      return exitPaylinkWithVoucher({
        ...voucher,
        params,
        tokenAddress,
        signer,
        // Off the persisted record, so what the burn pays can never drift from what was written.
        l1Recipient: EthAddress.fromString(withdrawalRecipients(seeded).release),
        withdrawal,
        operationId: op.operationId,
        zkProof,
        onTxHash,
      })
    },
    // The burn's own figures, not the link packet's: the escrow note is what was spent.
    minedFigures: async (exit) => ({
      amount: exit.amount.toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
    }),
  })
  if (result) onStage?.("submitting")
  // A burn left to the chain reports once the tracker marks its record mined.
  void bestEffort(
    "unknown",
    session()
      .withdrawals.all()
      .then((burns) => reportPaylinkClaims(burns, webStorage)),
  )
  return record
}
