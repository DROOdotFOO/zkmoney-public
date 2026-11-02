/**
 * Send + request rails to a saved contact. Send is a ClaimFPC-sponsored
 * `TokenService.sendTokenSponsored` — the same gasless rail as withdraw and paylink, so a first-ever
 * send folds the subscription (and account setup) into its own batch; the recipient discovers the
 * transfer from the chain (`Transfer.meta` carries tag / memo / request id). Request is an XMTP
 * announce, persisted to the requests store only on confirmed delivery.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  type ContractService,
  nextOperationId,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import {
  bestEffort,
  ContactStorage,
  RequestBroadcaster,
  toFailure,
  trackSubmission,
  TxInFlightError,
  resolveAssetConstants,
  WalletError,
} from "@obsidion/front-core"
import { parseUnits } from "viem"
import { getConfig } from "../../config/env"
import { isFlowCancelled, runOperation } from "../operations/operations"
import { session } from "../../platform/session"
import {
  getXmtpSender,
  getXmtpUiState,
  xmtpUnavailableCode,
} from "../../platform/xmtp/xmtpLifecycle"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { claimSponsorContext, noteSubscribed } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { recipientNotUpgradedCopy } from "../migration/upgradeCopy"
import { resolveTagForCommit, resolveTagViaRegistry } from "./registryResolution"

export type PayStage = "resolving" | "proving" | "submitting"

export interface ContactPayDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  tokenService: TokenService
  contractService: ContractService
}

/** The recipient's tag is still on a retired rollup, so funds sent now would not reach them. */
export class RecipientNotUpgradedError extends Error {
  constructor(readonly tag: string) {
    super(recipientNotUpgradedCopy.title(tag))
    this.name = "RecipientNotUpgradedError"
  }
}

/**
 * Whether `tag` has upgraded, read from the cached manifest before the user enters an amount. A
 * failed read answers true: the commit-time resolution is the guard.
 */
export async function recipientUpgraded(tag: string): Promise<boolean> {
  try {
    return (await resolveTagViaRegistry(tag)).status !== "staleRollup"
  } catch {
    return true
  }
}

async function resolveContact(tag: string) {
  const resolved = await resolveTagForCommit(tag)
  if (resolved.status === "staleRollup") throw new RecipientNotUpgradedError(tag)
  if (resolved.status !== "resolved")
    throw new WalletError("contact.unregistered", `@${tag}`, { data: { tag } })
  return resolved
}

/**
 * Send `amountDisplay` to the contact's registry-resolved L2 address and wait for the mine. The
 * recipient discovers it from the chain — the send carries the sender tag / memo / request id in
 * `Transfer.meta`.
 *
 * The transaction row is written before the proof rather than after the mine, and advanced in
 * place, because the screen can close mid-flight and the contact chat is where the user lands. Its
 * three states are the tx's own: no hash while proving, the real hash, saved before the node takes
 * the tx, then `success`. The chat draws them as a spinner, one tick, two ticks.
 */
export function sendToContact(
  deps: ContactPayDeps,
  args: {
    tag: string
    senderTag: string
    amountDisplay: string
    expectedL2Address?: string
    note?: string
    /** Payment request this send fulfills; rides the on-chain `Transfer.meta`. */
    requestId?: string
    /**
     * Save the resolved tag as a contact. It is saved as `autoAdded` before the row is written, so
     * the send shows its name, and becomes a contact for requests only once the send lands.
     */
    saveContact?: boolean
  },
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  // Correlates the TEE and prove benchmark legs → one tx_timing analytics event, and keys the row
  // this send advances (there is no txHash to key it by until the wallet reaches Mining).
  const operationId = nextOperationId("send")
  return runOperation(
    { operationId, flow: "send", summary: `$${args.amountDisplay} to @${args.tag}` },
    () => sendToContactFlow(operationId, deps, args, onStage),
    (r) => r.txHash,
  )
}

async function sendToContactFlow(
  operationId: string,
  deps: ContactPayDeps,
  args: {
    tag: string
    senderTag: string
    amountDisplay: string
    expectedL2Address?: string
    note?: string
    /** Payment request this send fulfills; rides the on-chain `Transfer.meta`. */
    requestId?: string
    saveContact?: boolean
  },
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  onStage("resolving")
  const resolved = await resolveContact(args.tag)
  // requesterAddress pin from a v3 request link: the tag must still resolve to
  // the address the link was minted for, or the funds go to a re-registered tag.
  if (
    args.expectedL2Address &&
    resolved.l2Address.toLowerCase() !== args.expectedL2Address.toLowerCase()
  ) {
    throw new WalletError("contact.requestMismatch", `@${args.tag}`, { data: { tag: args.tag } })
  }
  const contact = { name: args.tag, address: resolved.l2Address, verified: true, tag: args.tag }
  let added = false
  if (args.saveContact) {
    const unapproved = { ...contact, autoAdded: true }
    added =
      (await ContactStorage.get().addOrMergeContact(unapproved).catch(console.warn)) === unapproved
  }
  return sendResolved(operationId, deps, args, resolved.l2Address, onStage).catch(async (err) => {
    // A send that may still land keeps the row; one that cannot takes back the row it added.
    if (added && !(err instanceof TxInFlightError)) {
      await ContactStorage.get().removeEntry({ address: contact.address }).catch(console.warn)
    }
    throw err
  })
}

async function sendResolved(
  operationId: string,
  deps: ContactPayDeps,
  args: Parameters<typeof sendToContactFlow>[2],
  l2Address: string,
  onStage: (stage: PayStage) => void,
): Promise<{ txHash: string }> {
  const contact = { name: args.tag, address: l2Address, verified: true, tag: args.tag }
  const [sponsor, token, resolveSpendMetadata] = await Promise.all([
    claimSponsorContext(deps, RAIL_REGISTERED),
    deps.tokenService.fetchTokenInformation(),
    deps.account.makeSpendMetadataResolver(),
  ])

  onStage("proving")
  const { activity } = session()
  const walletAsset = resolveAssetConstants(getConfig().network).DAI
  await activity.insertPending({
    id: operationId,
    operationId,
    networkId: deps.wallet.networkId,
    action: "send",
    token: {
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      logo: walletAsset.logo,
      price: walletAsset.price,
      amount: Number(args.amountDisplay),
    },
    amountAtomic: parseUnits(args.amountDisplay, token.decimals),
    timestamp: Date.now(),
    status: "pending",
    txHash: "",
    to: l2Address,
    toTag: args.tag,
    ...(args.note ? { memo: args.note } : {}),
    // Lets the feed hide the request this send pays while the row is pending.
    ...(args.requestId ? { requestId: args.requestId } : {}),
  })
  const submission = trackSubmission(operationId)

  // Resolves on the L2 receipt: the sponsored rail owns simulate/attest/prove/submit as one step,
  // so there is no pre-mine handle to broadcast against.
  let result
  try {
    result = await deps.tokenService.sendTokenSponsored(
      AztecAddress.fromStringUnsafe(l2Address),
      args.amountDisplay,
      sponsor,
      {
        resolveSpendMetadata,
        userAccount: deps.account,
        operationId,
        requestId: args.requestId,
        senderTag: args.senderTag,
        recipientTag: args.tag,
        memo: args.note,
        // A missing row saved nothing, so the send must not go out.
        onTxHash: async (txHash) => {
          if (!(await activity.setHash(operationId, txHash)))
            throw new WalletError("invariant", "send row missing")
        },
      },
    )
  } catch (err) {
    // Failed only if the send never reached the node or a receipt says so; past the submit boundary
    // the row stays at MINING for ReorgMonitor to settle from the chain.
    const inFlight = await submission.survived(deps.wallet.node)
    if (inFlight) throw new TxInFlightError(inFlight, err)
    // A closed passkey prompt sent nothing: drop the row rather than leave a failed send behind.
    await bestEffort<unknown>(
      "unknown",
      isFlowCancelled(err)
        ? activity.remove(operationId)
        : activity.fail(operationId, toFailure(err, "tx.failed")),
    )
    throw err
  } finally {
    submission.stop()
  }
  if (sponsor.subscribe) noteSubscribed(deps.account, sponsor.fpcAddress, sponsor.railId)
  maybeRefuelFpc({ ...deps, fpc: { address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact } })
  const txHash = result.txHash
  onStage("submitting")

  await bestEffort("unknown", activity.settle(operationId, txHash))
  // Paying someone makes them a contact whose requests show as a contact's.
  if (args.saveContact) void ContactStorage.get().addEntry(contact).catch(console.warn)
  else void ContactStorage.get().approveAutoAdded(l2Address).catch(console.warn)
  return { txHash }
}

/** Announce a payment request over XMTP and persist the outgoing row on delivery. */
export async function requestFromContact(
  deps: Pick<ContactPayDeps, "tokenService" | "wallet">,
  args: { tag: string; requesterTag: string; amountDisplay: string; note?: string },
): Promise<void> {
  const xmtp = getXmtpSender()
  if (!xmtp) {
    throw new WalletError(xmtpUnavailableCode(getXmtpUiState()))
  }
  const resolved = await resolveContact(args.tag)
  const token = await deps.tokenService.fetchTokenInformation()
  // A field: the fulfilling send carries it in the on-chain `Transfer.meta`.
  const requestId = Fr.random().toString()
  const amountAtomic = parseUnits(args.amountDisplay, token.decimals).toString()

  const status = await new RequestBroadcaster(xmtp).announce({
    recipientXmtpAddress: resolved.xmtpAddress,
    requestId,
    requesterTag: args.requesterTag,
    amountAtomic,
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    // The wire value a receiver compares: another network's packet is dropped.
    networkId: deps.wallet.networkId,
    note: args.note,
  })
  if (status.status === "skipped") throw new WalletError("contact.cannotReceive", status.reason)
  if (status.status === "failed") {
    throw new WalletError("request.undelivered", status.reason, { data: { reason: status.reason } })
  }

  await session().requests.add({
    id: requestId,
    contactTag: args.tag,
    amount: Number(args.amountDisplay),
    asset: token.symbol,
    direction: "outgoing",
    status: "pending",
    note: args.note,
    createdAt: Date.now(),
    kind: "contact",
    tokenAddress: token.address,
    amountAtomic,
    tokenDecimals: token.decimals,
    networkId: deps.wallet.networkId,
  })
}

export type ContactPayRequest = {
  id: string
  source?: "link"
  requesterAddress?: string
}

type RunContactPayArgs =
  | {
      mode: "send"
      deps: ContactPayDeps
      tag: string
      senderTag: string
      amountDisplay: string
      note?: string
      request?: ContactPayRequest
      saveUnsavedRequester?: boolean
    }
  | {
      mode: "request"
      deps: Pick<ContactPayDeps, "tokenService" | "wallet">
      tag: string
      senderTag: string
      amountDisplay: string
      note?: string
    }

/** Confirm-CTA body: send or request, then fulfill if this send closes a request. */
export async function runContactPay(
  args: RunContactPayArgs,
  onStage: (stage: PayStage) => void,
): Promise<{ txHash?: string }> {
  if (args.mode === "send") {
    const { txHash } = await sendToContact(
      args.deps,
      {
        tag: args.tag,
        senderTag: args.senderTag,
        amountDisplay: args.amountDisplay,
        expectedL2Address: args.request?.requesterAddress,
        note: args.note,
        requestId: args.request?.id,
        saveContact: !!args.request && args.saveUnsavedRequester,
      },
      onStage,
    )
    return { txHash }
  }
  onStage("submitting")
  await requestFromContact(args.deps, {
    tag: args.tag,
    requesterTag: args.senderTag,
    amountDisplay: args.amountDisplay,
    note: args.note,
  })
  return {}
}
