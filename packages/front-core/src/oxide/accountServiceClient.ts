/**
 * AccountServiceClient — drives Obsidion's account-service (a1 gasless onboarding)
 * routes. Every mutating route is attestation-gated: the client builds a
 * service-namespaced preimage, `sha256`es it, and sends the digest's assertion in
 * `x-app-attest-assertion`. How the assertion is produced is platform-specific
 * (App Attest on iOS), so it is injected via `AssertionProvider`; `testMode`
 * clients (web on sandbox, where the server gate is a pass-through) send none.
 *
 * The `SPONSOR` preimage is a keccak fingerprint the backend keeps un-exported,
 * replicated here byte-for-byte and pinned by a parity test against the server.
 */

import { sha256 } from "@aztec-labs/foundation/crypto/sha256"
import { BOOTSTRAP_SIGNATURE_HEADER } from "@obsidion/core/constants"
import type { DrawnNameResponse, NameClaimResponse } from "@obsidion/core/types"
import { type Hex, encodeAbiParameters, keccak256, parseAbiParameters } from "viem"
import type { PackedUserOperation } from "@oxide/l1-contracts"

/** Produces the platform attestation assertion over a base64 clientDataHash. */
export interface AssertionProvider {
  generateAssertion(keyId: string, clientDataHashB64: string): Promise<string>
}

/**
 * Signs gated requests with a session credential — the browser path, where no platform attestation
 * exists. `subject` is what the server re-derives from the session and matches against the `keyId`
 * in the body, so it is the value callers must pass as `keyId`.
 */
export interface SessionCredentialProvider {
  readonly subject: string
  /** Headers proving this request: a signature over the raw clientDataHash plus a fresh counter. */
  authorize(clientDataHash: Uint8Array): Promise<Record<string, string>>
}

/** ERC-4337 v0.8 PackedUserOperation, JSON wire shape (mirrors the backend `UserOpSchema`). */
export interface UserOpJson {
  sender: Hex
  nonce: string
  initCode: Hex
  callData: Hex
  accountGasLimits: Hex
  preVerificationGas: string
  gasFees: Hex
  paymasterAndData: Hex
  signature: Hex
}

export interface DomainInfoResponse {
  service: string
  registry: Hex
  chainId: string
  domainOwner: Hex
  domainOwnerPubKey: Hex
  /**
   * What a paylink must hold to buy the ticket schedule, and the schedule itself (base units),
   * so a signup can price the registration slice before it spends a ticket. Null when tickets are
   * not accepted.
   */
  goldenTicket?: { threshold: string; schedule?: { fee: string; minDeposit: string } } | null
}

/** A golden ticket proof and its public claim; the server supplies threshold and token. */
export interface GoldenTicketRedeemRequest {
  proof: Hex
  root: Hex
  blockNumber: number
  nullifier: Hex
  /** Direct then email class ids the proof was made for; the server checks each is reviewed. */
  classIds?: [Hex, Hex]
  /** testMode only: the bootstrap address the proof names. Ignored when a bootstrap provider is set. */
  owner?: Hex
}

export interface GoldenTicketRedeemResponse {
  status: "created" | "repeat"
}

export interface PastUserClaimRequest {
  proof: Hex
  /** The circuit's public inputs in ABI order: merkle_root, category, owner, nullifier. */
  publicInputs: [Hex, Hex, Hex, Hex]
}

export type PastUserClaimResponse = GoldenTicketRedeemResponse

/**
 * Produces the bootstrap-key request-auth header for `/domain/sign` (backend `BootstrapKeyCredential`,
 * PR #1174). The wallet's own bootstrap key signs the request's `clientDataHash` directly — a RAW
 * secp256k1 signature over the 32-byte digest, no EIP-191/712 prefix — and the server recovers the
 * subject from it. This is a REQUEST-AUTH signature, distinct from the on-chain `consentSig`.
 */
export interface BootstrapKeyProvider {
  /** The bootstrap EOA address (lowercased) — the subject the server binds the claim to, sent as `keyId`. */
  readonly subject: string
  /** Raw ECDSA (secp256k1) signature over the 32-byte `clientDataHash`. */
  signClientDataHash(clientDataHash: Uint8Array): Promise<Hex>
}

export { BOOTSTRAP_SIGNATURE_HEADER }

/**
 * The op fields the sponsorship fixed (the sponsor re-prices gas, so all four are
 * server-set) — adopt them into the locally-built op, then sign over the result.
 */
export interface SponsorResponse {
  accountGasLimits: Hex
  preVerificationGas: string
  gasFees: Hex
  paymasterAndData: Hex
  validUntil: string
  validAfter: string
}

export interface BundleResponse {
  userOpHash: Hex
}

export interface UserOpReceipt {
  txHash: Hex
  success: boolean
}

export interface ReceiptResponse {
  receipt: UserOpReceipt | null
}

// ── Attestation preimages (byte-identical to the account-service routers) ─────

export const ATTEST_KEY_PREIMAGE = (keyId: string): string =>
  `OBSIDION_ACCT_AUTH_V1:ATTEST:${keyId}`

export const DOMAIN_SIGN_PREIMAGE = (nameHash: string, userAddress: string): string =>
  `OBSIDION_ACCT_AUTH_V1:DOMAIN_SIGN:${nameHash.toLowerCase()}:${userAddress.toLowerCase()}`

export const DOMAIN_RESERVATION_PREIMAGE = (subject: string, timestamp: number): string =>
  `OBSIDION_ACCT_AUTH_V1:DOMAIN_RESERVATION:${subject.toLowerCase()}:${timestamp}`

export type InviteRoute = "CODE" | "ATTRIBUTE" | "STATUS"

export const INVITE_PREIMAGE = (
  route: InviteRoute,
  subject: string,
  timestamp: number,
  code = "",
): string => `OBSIDION_ACCT_AUTH_V1:INVITE_${route}:${subject.toLowerCase()}:${timestamp}:${code}`

export interface InviteStatus {
  pending: number
  credited: number
}

export const GOLDEN_TICKET_PREIMAGE = (nullifier: string, owner: string): string =>
  `OBSIDION_ACCT_AUTH_V1:GOLDEN_TICKET:${nullifier.toLowerCase()}:${owner.toLowerCase()}`

export const PAST_USER_PREIMAGE = (nullifier: string, owner: string): string =>
  `OBSIDION_ACCT_AUTH_V1:PAST_USER:${nullifier.toLowerCase()}:${owner.toLowerCase()}`

export const PAYMASTER_SPONSOR_PREIMAGE = (fingerprint: string): string =>
  `OBSIDION_ACCT_AUTH_V1:SPONSOR:${fingerprint.toLowerCase()}`

export const BUNDLER_BUNDLE_PREIMAGE = (userOpHash: string): string =>
  `OBSIDION_ACCT_AUTH_V1:BUNDLE:${userOpHash.toLowerCase()}`

/**
 * Replica of the backend's un-exported `sponsorRequestFingerprint`: a stable hash
 * over the client-controlled unsigned op fields, excluding the server-set
 * paymasterAndData and the account signature. Pinned by the parity test.
 */
export function sponsorRequestFingerprint(op: UserOpJson): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address, uint256, bytes, bytes, bytes32, uint256, bytes32"),
      [
        op.sender,
        BigInt(op.nonce),
        op.initCode,
        op.callData,
        op.accountGasLimits,
        BigInt(op.preVerificationGas),
        op.gasFees,
      ],
    ),
  )
}

/** A typed error carrying the server status so callers can branch (409/502/503). */
export class AccountServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
    /** Parsed `Retry-After` seconds (429/503), so callers back off for at least as long as the server asked. */
    readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = "AccountServiceError"
  }
}

/** How the global name gate sees a tag: blocklisted, held by a live reservation, or free. */
export type AvailabilityStatus = "available" | "reserved" | "blocked"
/** A name can be both reserved and blocklisted; status keeps the existing primary result. */
export type AvailabilityDetails = {
  status: AvailabilityStatus
  blocked: boolean
  grantValid?: boolean
  grantBound?: boolean
}

/** Reads retry a rejected fetch this many times before giving up. */
const READ_ATTEMPTS = 3
const READ_BACKOFF_MS = 250

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A call that did not finish within its caller's deadline. Deliberately not an `AbortError`: web
 * sign-in reads every `AbortError` as a passkey prompt the user closed.
 */
export class AccountServiceTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`account-service ${path} did not answer within ${timeoutMs}ms`)
    this.name = "AccountServiceTimeoutError"
  }
}

const NAME_HASH_HEX = /^0x[0-9a-fA-F]{64}$/

/** A gated route was called on a read-only (detection) client. */
export class ReadOnlyClientError extends Error {
  constructor(path: string) {
    super(`AccountServiceClient is read-only — cannot call gated route ${path}`)
    this.name = "ReadOnlyClientError"
  }
}

/** The server proved custody of this exact op on an earlier POST (typed 409). */
export function isDuplicateSubmission(err: unknown): boolean {
  return (
    err instanceof AccountServiceError &&
    err.status === 409 &&
    (err.body as { reason?: string } | undefined)?.reason === "duplicate"
  )
}

/** The NameClaim attempts budget for this (device, name) is spent — the only terminal 429. */
export function isClaimAttemptsExhausted(err: unknown): boolean {
  return (
    err instanceof AccountServiceError &&
    err.status === 429 &&
    (err.body as { reason?: string } | undefined)?.reason === "claim_attempts_exhausted"
  )
}

/**
 * The machine-readable refusal reason a /domain/sign 409 carries. `claim_inflight` (our own
 * reservation is mid-sign) and `claim_superseded` (a concurrent request re-issued the reservation)
 * clear within seconds. `claim_conflict` (a still-live grant binds this device+name to a different
 * address) clears only when that grant's deadline lapses: no retry inside the window can succeed.
 * None of them means "the name is taken".
 */
export function claimRefusalReason(err: unknown): string | undefined {
  if (!(err instanceof AccountServiceError) || err.status !== 409) return undefined
  return (err.body as { reason?: string } | undefined)?.reason
}

export function isClaimConflict(err: unknown): boolean {
  return claimRefusalReason(err) === "claim_conflict"
}

/** The three refusals above that end on their own. Every other one is terminal to a retry. */
const SELF_CLEARING_REFUSALS: readonly string[] = [
  "claim_conflict",
  "claim_inflight",
  "claim_superseded",
]

/**
 * How long `withClaimRetry` waits a refusal out. Neither bound that ends one is readable from the
 * client: `claim_inflight` ends with the service's reservation lease and `claim_conflict` with the
 * issued grant's validity window, and no route or config profile publishes either. The budget is
 * sized for what actually races on this path (a concurrent sign, a superseded reservation) and
 * stops far short of the minutes an abandoned lease or a live grant can take. Past it the caller
 * tells the user to come back rather than holding a spinner open.
 */
export const CLAIM_RETRY_BUDGET_MS = 30_000
const CLAIM_RETRY_BASE_MS = 400
const CLAIM_RETRY_MAX_GAP_MS = 6_000

export interface ClaimRetryOptions {
  /** Wall-clock budget across attempts. A request already in flight is never cut short. */
  budgetMs?: number
  /** Fires once, with the reason, when the first refusal turns the call into a wait. */
  onWait?: (reason: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Runs `attempt`, waiting out the self-clearing `/domain/sign` refusals with exponential backoff.
 * Anything else — a terminal refusal, a spent attempts budget, a network fault — propagates on the
 * first throw, so only a state the service itself calls wait-and-retry ever costs the caller a wait.
 * The refusal that ends the wait is what surfaces, so callers can still name what they waited for.
 */
export async function withClaimRetry<T>(
  attempt: () => Promise<T>,
  opts: ClaimRetryOptions = {},
): Promise<T> {
  const nap = opts.sleep ?? sleep
  const clock = opts.now ?? Date.now
  const deadline = clock() + (opts.budgetMs ?? CLAIM_RETRY_BUDGET_MS)
  let waiting = false
  for (let tries = 0; ; tries++) {
    try {
      return await attempt()
    } catch (err) {
      const reason = claimRefusalReason(err)
      if (reason === undefined || !SELF_CLEARING_REFUSALS.includes(reason)) throw err
      const backoff = Math.min(CLAIM_RETRY_MAX_GAP_MS, CLAIM_RETRY_BASE_MS * 2 ** tries)
      const asked = err instanceof AccountServiceError ? err.retryAfterSec : undefined
      const gap = asked === undefined ? backoff : Math.max(backoff, asked * 1000)
      if (clock() + gap > deadline) throw err
      if (!waiting) {
        waiting = true
        opts.onWait?.(reason)
      }
      await nap(gap)
    }
  }
}

/** The name-policy 409: the name is reserved by another user (registration-fee.md Campaign). */
export function isNameReserved(err: unknown): boolean {
  return (
    err instanceof AccountServiceError &&
    err.status === 409 &&
    (err.body as { reason?: string } | undefined)?.reason === "name_reserved"
  )
}

/** The name-policy 403: the name is blocklisted and can never be claimed. */
export function isNameBlocked(err: unknown): boolean {
  return (
    err instanceof AccountServiceError &&
    err.status === 403 &&
    (err.body as { reason?: string } | undefined)?.reason === "name_blocked"
  )
}

const DEFAULT_TIMEOUT_MS = 120_000

export class AccountServiceClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly testMode: boolean
  private readonly readOnly: boolean
  private readonly assertionProvider?: AssertionProvider
  private readonly sessionProvider?: SessionCredentialProvider
  private readonly bootstrapProvider?: BootstrapKeyProvider
  private readonly grantToken?: string

  constructor(
    baseUrl: string,
    opts: {
      timeoutMs?: number
      testMode?: boolean
      /**
       * Detection mode: construction needs no credential provider, open routes (status/receipt)
       * work, and gated routes throw — even under testMode, so a test can't accidentally mutate
       * through a client meant only to read.
       */
      readOnly?: boolean
      assertionProvider?: AssertionProvider
      sessionProvider?: SessionCredentialProvider
      /** Bootstrap-key request auth for `/domain/sign` — the sole gate registration uses (PR #1174). */
      bootstrapProvider?: BootstrapKeyProvider
      /** Single-use token from a `?grant=` link, waiving the blocklist for the one name it names. */
      grantToken?: string
    } = {},
  ) {
    if (!baseUrl) throw new Error("AccountServiceClient: empty baseUrl")
    if (
      !opts.readOnly &&
      !opts.testMode &&
      !opts.assertionProvider &&
      !opts.sessionProvider &&
      !opts.bootstrapProvider
    ) {
      throw new Error(
        "AccountServiceClient: an assertionProvider, sessionProvider, or bootstrapProvider is required outside testMode",
      )
    }
    this.baseUrl = baseUrl.replace(/\/$/, "")
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.testMode = opts.testMode ?? false
    this.readOnly = opts.readOnly ?? false
    this.assertionProvider = opts.assertionProvider
    this.sessionProvider = opts.sessionProvider
    this.bootstrapProvider = opts.bootstrapProvider
    this.grantToken = opts.grantToken
  }

  /** The subject gated calls must carry as `keyId` (bootstrap-key or session credential). */
  get subject(): string | undefined {
    return this.bootstrapProvider?.subject ?? this.sessionProvider?.subject
  }

  /** POST /attest/key — open route; relays the one-time attestation. No assertion header. */
  async registerKey(req: { keyId: string; attestation: string }): Promise<{ keyId: string }> {
    return this.post("/attest/key", req)
  }

  /**
   * POST /domain/sign — gated; returns the EIP-712 NameClaim plus the operator-signed terms when configured.
   *
   * Bootstrap-key gated (PR #1174): the bootstrap provider signs the request's `clientDataHash` and
   * the recovered address is both the header signer and the `keyId` the server binds the claim to,
   * so `keyId` is taken from the provider, not the caller. Under `testMode` (sandbox, the e2e) the
   * signature gate is a pass-through that takes the declared `keyId` as the subject: the provider's
   * subject when one is set, so a prior golden-ticket entitlement is priced for the same subject,
   * else the caller's synthetic id.
   */
  async signDomain(req: {
    nameHash: Hex
    userAddress: Hex
    /** Synthetic keyId for testMode without a bootstrap provider; ignored when one is set. */
    keyId?: string
  }): Promise<NameClaimResponse> {
    if (this.readOnly) throw new ReadOnlyClientError("/domain/sign")
    const preimage = DOMAIN_SIGN_PREIMAGE(req.nameHash, req.userAddress)

    if (this.bootstrapProvider) {
      const keyId = this.bootstrapProvider.subject
      const body = {
        keyId,
        nameHash: req.nameHash,
        userAddress: req.userAddress,
        grantToken: this.grantToken,
      }
      return this.postBootstrapSigned("/domain/sign", keyId, preimage, body)
    }

    // testMode / legacy providers without a bootstrap key: the caller's synthetic id (or a placeholder).
    const keyId = req.keyId ?? "test"
    return this.postGated("/domain/sign", keyId, preimage, {
      keyId,
      nameHash: req.nameHash,
      userAddress: req.userAddress,
      grantToken: this.grantToken,
    })
  }

  /** GET /domain/info — open route. */
  async domainInfo(): Promise<DomainInfoResponse> {
    return this.get("/domain/info")
  }

  /**
   * POST /domain/golden-ticket — spend a paylink's golden ticket for the reduced schedule. The
   * proof is bound to this client's bootstrap subject, which also signs the request.
   */
  async redeemGoldenTicket(req: GoldenTicketRedeemRequest): Promise<GoldenTicketRedeemResponse> {
    if (this.readOnly) throw new ReadOnlyClientError("/domain/golden-ticket")
    const owner = (this.bootstrapProvider?.subject ?? req.owner)?.toLowerCase()
    if (!owner) throw new Error("redeemGoldenTicket: no bootstrap subject to bind the ticket to")
    const body = {
      keyId: owner,
      proof: req.proof,
      root: req.root,
      blockNumber: req.blockNumber,
      owner,
      nullifier: req.nullifier,
      classIds: req.classIds,
    }
    const preimage = GOLDEN_TICKET_PREIMAGE(req.nullifier, owner)
    return this.postBootstrapSigned("/domain/golden-ticket", owner, preimage, body)
  }

  /**
   * POST /domain/eligibility/claim — spend a past-user proof for the earned schedule. The proof's
   * public `owner` is this client's bootstrap subject, which also signs the request.
   */
  async claimPastUser(req: PastUserClaimRequest): Promise<PastUserClaimResponse> {
    if (this.readOnly) throw new ReadOnlyClientError("/domain/eligibility/claim")
    const keyId = this.bootstrapProvider?.subject.toLowerCase()
    if (!keyId) throw new Error("claimPastUser: no bootstrap subject to bind the proof to")
    const [, , owner, nullifier] = req.publicInputs
    const body = { keyId, proof: req.proof, publicInputs: req.publicInputs }
    return this.postBootstrapSigned(
      "/domain/eligibility/claim",
      keyId,
      PAST_USER_PREIMAGE(nullifier, owner),
      body,
    )
  }

  private async postBootstrapSigned<T>(
    path: string,
    keyId: string,
    preimage: string,
    body: unknown,
  ): Promise<T> {
    if (this.bootstrapProvider && !this.testMode) {
      const clientDataHash = sha256(Buffer.from(preimage, "utf-8"))
      const signature = await this.bootstrapProvider.signClientDataHash(clientDataHash)
      return this.post(path, body, { [BOOTSTRAP_SIGNATURE_HEADER]: signature })
    }
    return this.postGated(path, keyId, preimage, body)
  }

  /** GET /domain/invite — the caller's invite code, created on the first call. */
  async inviteCode(): Promise<string> {
    const { code } = await this.signedInvite<{ code?: unknown }>("/domain/invite", "CODE")
    if (typeof code !== "string" || !code)
      throw new Error("account-service /domain/invite answered with a malformed body")
    return code
  }

  /** POST /domain/invite/attribute — names the code this signup came from. */
  async attributeInvite(code: string): Promise<void> {
    await this.signedInvite("/domain/invite/attribute", "ATTRIBUTE", code)
  }

  /** GET /domain/invite/status — the caller's referrals, by credit state. */
  async inviteStatus(): Promise<InviteStatus> {
    return this.signedInvite("/domain/invite/status", "STATUS")
  }

  private async signedInvite<T>(path: string, route: InviteRoute, code?: string): Promise<T> {
    if (this.readOnly) throw new ReadOnlyClientError(path)
    if (!this.bootstrapProvider)
      throw new Error(`AccountServiceClient: ${path} needs a bootstrap provider`)
    const keyId = this.bootstrapProvider.subject
    const timestamp = Math.floor(Date.now() / 1000)
    const preimage = INVITE_PREIMAGE(route, keyId, timestamp, code)
    const headers = {
      [BOOTSTRAP_SIGNATURE_HEADER]: await this.bootstrapProvider.signClientDataHash(
        sha256(Buffer.from(preimage, "utf-8")),
      ),
    }
    if (code !== undefined) return this.post(path, { keyId, timestamp, code }, headers)
    const query = new URLSearchParams({ keyId, timestamp: String(timestamp) })
    return this.parse(await this.fetchWithTimeout(`${this.baseUrl}${path}?${query}`, { headers }))
  }

  /**
   * POST /domain/reservation — gated, read-only: the name hashes this client's bootstrap key has
   * claimed. `timeoutMs` bounds the whole exchange, the reply body included, and ends it with
   * `AccountServiceTimeoutError`. Anything but a well-formed list throws, so no failure can read as
   * "no claims". Never retried and never sends the grant token, which only `/domain/sign` spends.
   */
  async claimedNames(req: {
    timeoutMs: number
    /** Synthetic keyId for testMode only; ignored when a bootstrap provider is set. */
    keyId?: string
  }): Promise<Hex[]> {
    const path = "/domain/reservation"
    if (this.readOnly) throw new ReadOnlyClientError(path)
    const timestamp = Math.floor(Date.now() / 1000)
    let keyId: string
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.bootstrapProvider && !this.testMode) {
      keyId = this.bootstrapProvider.subject
      const clientDataHash = sha256(
        Buffer.from(DOMAIN_RESERVATION_PREIMAGE(keyId, timestamp), "utf-8"),
      )
      headers[BOOTSTRAP_SIGNATURE_HEADER] = await this.bootstrapProvider.signClientDataHash(
        clientDataHash,
      )
    } else if (this.testMode) {
      keyId = req.keyId ?? "test"
    } else {
      throw new Error(`AccountServiceClient: ${path} needs a bootstrap provider`)
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, req.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ keyId, timestamp }),
        signal: controller.signal,
      })
      const body = await this.parse<{ nameHashes?: unknown } | null>(res)
      const nameHashes = body?.nameHashes
      if (
        !Array.isArray(nameHashes) ||
        !nameHashes.every((h) => typeof h === "string" && NAME_HASH_HEX.test(h))
      ) {
        throw new Error(`account-service ${path} answered with a malformed body`)
      }
      return nameHashes as Hex[]
    } catch (err) {
      if (timedOut) throw new AccountServiceTimeoutError(path, req.timeoutMs)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * GET /domain/available probes the global name policy. With a grant, POST keeps the bearer token
   * out of the URL and checks revocation and binding without consuming it. `/domain/sign` decides the claim.
   */
  async availableNameDetails(
    nameHash: Hex,
    grantToken?: string,
    bootstrap?: string,
  ): Promise<AvailabilityDetails> {
    const details = grantToken
      ? await this.postRead<AvailabilityDetails>("/domain/available", {
          nameHash,
          grantToken,
          ...(bootstrap ? { bootstrap } : {}),
        })
      : await this.get<AvailabilityDetails>(`/domain/available?nameHash=${nameHash}`)
    const { status, blocked, grantValid, grantBound } = details
    if (grantToken && (typeof grantValid !== "boolean" || typeof grantBound !== "boolean")) {
      throw new Error("account-service /domain/available omitted grant state")
    }
    return {
      status,
      blocked: blocked ?? status === "blocked",
      ...(grantToken ? { grantValid, grantBound } : {}),
    }
  }

  /**
   * POST /domain/draw — open: a random free name under `ensDomain`, with the grant the later sign
   * spends. Read-plumbed on purpose: it needs no credential, and a draw retried over a dropped
   * connection only leaves an unspent grant to expire.
   */
  async drawName(ensDomain: string): Promise<DrawnNameResponse> {
    return this.postRead("/domain/draw", { ensDomain })
  }

  /**
   * POST /domain/eligibility/grant — open; spends a past-user proof once for a grant on `nameHash`,
   * before any passkey exists. The proof is the credential, its `owner` unused.
   */
  async pastUserGrant(req: {
    proof: Hex
    publicInputs: readonly [Hex, Hex, Hex, Hex]
    nameHash: Hex
  }): Promise<{ grantToken: string; expiresAt: number }> {
    return this.postRead("/domain/eligibility/grant", req)
  }

  /** Existing status-only view for callers that do not need the simultaneous blocklist state. */
  async availableName(nameHash: Hex): Promise<AvailabilityStatus> {
    return (await this.availableNameDetails(nameHash)).status
  }

  /** POST /paymaster/sponsor — gated; returns the sponsored fields to adopt into the local op. */
  async sponsor(req: { keyId: string; userOp: UserOpJson }): Promise<SponsorResponse> {
    const preimage = PAYMASTER_SPONSOR_PREIMAGE(sponsorRequestFingerprint(req.userOp))
    return this.postGated("/paymaster/sponsor", req.keyId, preimage, req)
  }

  /** POST /bundler/bundle — gated; async submit. The preimage binds the locally-derived `userOpHash`. */
  async bundle(req: {
    keyId: string
    userOp: UserOpJson
    userOpHash: Hex
  }): Promise<BundleResponse> {
    const preimage = BUNDLER_BUNDLE_PREIMAGE(req.userOpHash)
    return this.postGated("/bundler/bundle", req.keyId, preimage, {
      keyId: req.keyId,
      userOp: req.userOp,
    })
  }

  /** POST /bundler/receipt — open read; null while the op is still pending. */
  async receipt(req: { userOpHash: Hex }): Promise<ReceiptResponse> {
    return this.post("/bundler/receipt", req)
  }

  private async postGated<T>(
    path: string,
    keyId: string,
    preimage: string,
    body: unknown,
  ): Promise<T> {
    if (this.readOnly) throw new ReadOnlyClientError(path)
    if (this.testMode) return this.post(path, body)

    const clientDataHash = sha256(Buffer.from(preimage, "utf-8"))
    if (this.sessionProvider) {
      return this.post(path, body, await this.sessionProvider.authorize(clientDataHash))
    }
    const assertion = await this.assertionProvider!.generateAssertion(
      keyId,
      Buffer.from(clientDataHash).toString("base64"),
    )
    return this.post(path, body, { "x-app-attest-assertion": assertion })
  }

  private async post<T>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    return this.parse(
      await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
      }),
    )
  }

  private async get<T>(path: string): Promise<T> {
    return this.parse(await this.fetchRead(`${this.baseUrl}${path}`, { method: "GET" }))
  }

  private async postRead<T>(path: string, body: unknown): Promise<T> {
    return this.parse(
      await this.fetchRead(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  }

  /**
   * Read-only requests retry a rejected fetch. A response of any status, 429 included, goes to
   * `parse` without a retry. Mutating requests never come through here.
   */
  private async fetchRead(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      try {
        return await this.fetchWithTimeout(url, init)
      } catch (err) {
        lastError = err
        if (attempt < READ_ATTEMPTS - 1) await sleep(READ_BACKOFF_MS * 2 ** attempt)
      }
    }
    throw lastError
  }

  /** On abort the fetch rejects, and the caller treats it like any other transient network failure. */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({} as Record<string, unknown>))
      const message =
        typeof errBody === "object" && errBody !== null && "error" in errBody
          ? String((errBody as { error: unknown }).error)
          : res.statusText
      const retryAfterRaw = res.headers.get("Retry-After")
      const retryAfterSec =
        retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : undefined
      throw new AccountServiceError(res.status, message, errBody, retryAfterSec)
    }
    return res.json() as Promise<T>
  }
}

// ── Sponsored-op helpers ────────────────────────────────────────────────────────
//
// The 4337 sponsored-op tail (sponsor → adopt → sign → bundle → receipt) the migration relay's
// `updateUserL2Address` self-heal drives. Bundling is async: /bundler/bundle returns a userOpHash
// and the client polls /bundler/receipt until the op lands.

const RECEIPT_POLL_MS = 1000
const RECEIPT_TIMEOUT_MS = 180_000

/** PackedUserOperation → the account-service JSON wire shape (bigints → decimal strings). */
export function packedToJson(op: PackedUserOperation): UserOpJson {
  return {
    sender: op.sender,
    nonce: op.nonce.toString(),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: op.preVerificationGas.toString(),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  }
}

/**
 * Adopt the sponsored fields into the locally-built op. ONLY the four fields the
 * sponsorship fixes are taken from the server — sender, nonce, initCode, and
 * callData stay ours, so a malicious sponsor can re-price gas (its own spend) but
 * never redirect what the op does.
 */
export function adoptSponsorship(
  op: PackedUserOperation,
  sponsored: SponsorResponse,
): PackedUserOperation {
  return {
    ...op,
    accountGasLimits: sponsored.accountGasLimits,
    preVerificationGas: BigInt(sponsored.preVerificationGas),
    gasFees: sponsored.gasFees,
    paymasterAndData: sponsored.paymasterAndData,
  }
}

/** Polls the bundler until the op lands. Throws on timeout. */
export async function waitForUserOpReceipt(
  accountService: Pick<AccountServiceClient, "receipt">,
  userOpHash: Hex,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): Promise<UserOpReceipt> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { receipt } = await accountService.receipt({ userOpHash })
    if (receipt) return receipt
    if (Date.now() >= deadline) {
      throw new Error(`userOp ${userOpHash} not included within ${Math.round(timeoutMs / 1000)}s`)
    }
    await sleep(RECEIPT_POLL_MS)
  }
}
