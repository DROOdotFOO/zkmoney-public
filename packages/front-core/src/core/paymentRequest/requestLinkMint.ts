/**
 * Pure request-link minting. Platform callers own
 * request-id generation, wallet/network lookups, persistence, sharing UI, and
 * amount/expiry display formatting from the returned row.
 */
import { encodePacked, keccak256, type Address } from "viem"
import { parseEscrowAmount } from "../../utils/escrowAmount"
import type { StoredRequest } from "../../engine/requests"
import type { SipaOrigin } from "../services/deposits/SIPADepositStore"
import { encodeRequestInline, type SipaLinkPreimage } from "./requestInlineCodec"

/** The payee's pay page carrying this request: `<wallet origin>/pay/<tag>#<fragment>`. */
function requestLinkUrl(baseUrl: string, tag: string, fragment: string): string {
  return `${baseUrl.replace(/\/$/, "")}/pay/${encodeURIComponent(tag)}#${fragment}`
}

export interface MintRequestLinkArgs {
  /** 0x-hex 254-bit field minted by the platform caller. */
  requestId: string
  /** Raw registered tag (bare, no @). */
  requesterTag: string
  requesterAddress?: string
  tokenAddress: string
  tokenDecimals: number
  tokenSymbol: string
  networkId: string
  /** Wallet origin — `mintableOrigin(origin, network)`. */
  baseUrl: string
  /** Blank or non-positive input mints an any-amount link. */
  amountInput: string
  noteInput: string
  durationMs: number
  now: number
  /** Self-broadcast L1 SIPA. Optional on the v3 fragment. */
  sipaAddress?: string
  sipaPreimage?: SipaLinkPreimage
  /**
   * Mint a compact Receive code; `requestId` must come from `randomCodeRequestId`. One without an
   * amount is unlisted.
   */
  compact?: boolean
  /** A compact code's `sipaDeploymentTag` for `sipaAddress`. */
  sipaDeployment?: string
}

/** What a link carries so a payer can re-predict the SIPA that `origin` records. */
export function sipaLinkPreimage(origin: SipaOrigin): SipaLinkPreimage {
  return {
    intentHash: origin.intentHash,
    recovery: origin.protocol === "legacy-eoa" ? origin.recoveryAddress : origin.recoveryCommitment,
  }
}

/** 4 bytes naming the deployment a SIPA was derived under, so a payer can tell a code's address is current. */
export function sipaDeploymentTag(deployment: {
  sipaFactory: string
  implementation: string
  rollupVersion: string | bigint
}): string {
  return keccak256(
    encodePacked(
      ["address", "address", "uint256"],
      [
        deployment.sipaFactory as Address,
        deployment.implementation as Address,
        BigInt(deployment.rollupVersion),
      ],
    ),
  ).slice(0, 10)
}

export interface MintedRequestLink {
  url: string
  row: StoredRequest
  note?: string
}

export class RequestLinkMintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RequestLinkMintError"
  }
}

/**
 * Rebuild a shareable URL from a persisted outgoing link request. The mint-time tag wins so a
 * later rename cannot change the original request identity; `currentRequesterTag` supports older
 * rows that predate the persisted requester identity. A stored SIPA is written back onto the v3 fragment.
 */
export function buildRequestShareUrl(
  request: Omit<StoredRequest, "status">,
  currentRequesterTag: string,
  baseUrl: string,
): string | null {
  if (!request.networkId || !request.tokenAddress) return null
  const requesterTag = request.requesterTag || currentRequesterTag
  try {
    const fragment = encodeRequestInline({
      requestId: request.id,
      requesterTag,
      ...(request.requesterAddress !== undefined && {
        requesterAddress: request.requesterAddress,
      }),
      amountAtomic: BigInt(request.amountAtomic ?? "0"),
      tokenAddress: request.tokenAddress,
      tokenSymbol: request.asset,
      // Preserve absence for legacy 6-dp rows so the decoder's 6-dp fallback remains authoritative.
      ...(request.tokenDecimals !== undefined && { tokenDecimals: request.tokenDecimals }),
      ...(request.note !== undefined && { note: request.note }),
      ...(request.expiresAt !== undefined && { expiresAt: request.expiresAt }),
      networkId: request.networkId,
      ...(request.sipaAddress !== undefined && { sipaAddress: request.sipaAddress }),
      ...(request.sipaAddress !== undefined &&
        request.sipaPreimage !== undefined && { sipaPreimage: request.sipaPreimage }),
    })
    return requestLinkUrl(baseUrl, requesterTag, fragment)
  } catch {
    return null
  }
}

/** Throws RequestLinkMintError for an unparseable non-empty amount. */
export function mintRequestLink(args: MintRequestLinkArgs): MintedRequestLink {
  let human = 0
  let amountAtomic = "0"
  if (args.amountInput.trim()) {
    try {
      const escrow = parseEscrowAmount(args.amountInput, args.tokenDecimals)
      if (escrow.human > 0) {
        human = escrow.human
        amountAtomic = escrow.atomic.toString()
      }
    } catch {
      throw new RequestLinkMintError(`invalid amount: ${args.amountInput}`)
    }
  }

  const note = args.noteInput.trim() || undefined
  const expiresAt = args.now + args.durationMs
  const fragment = encodeRequestInline({
    requestId: args.requestId,
    requesterTag: args.requesterTag,
    requesterAddress: args.requesterAddress,
    amountAtomic: BigInt(amountAtomic),
    tokenAddress: args.tokenAddress,
    tokenDecimals: args.tokenDecimals,
    tokenSymbol: args.tokenSymbol,
    note,
    expiresAt,
    networkId: args.networkId,
    sipaAddress: args.sipaAddress,
    sipaPreimage: args.sipaPreimage,
    compact: args.compact,
    sipaDeployment: args.sipaDeployment,
  })

  const row: StoredRequest = {
    id: args.requestId,
    contactTag: "",
    amount: human,
    asset: args.tokenSymbol,
    direction: "outgoing",
    status: "pending",
    createdAt: args.now,
    kind: "link",
    amountAtomic,
    tokenAddress: args.tokenAddress,
    tokenDecimals: args.tokenDecimals,
    note,
    expiresAt,
    networkId: args.networkId,
    requesterTag: args.requesterTag,
    requesterAddress: args.requesterAddress,
    sipaAddress: args.sipaAddress,
    sipaPreimage: args.sipaPreimage,
    ...(args.compact && human === 0 ? { unlisted: true } : {}),
  }

  return {
    url: requestLinkUrl(args.baseUrl, args.requesterTag, fragment),
    row,
    note,
  }
}
