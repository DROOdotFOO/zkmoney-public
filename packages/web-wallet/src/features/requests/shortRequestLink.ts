import { useCallback, useEffect, useMemo, useReducer, useState } from "react"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import {
  requestLinkOperationId,
  trackSubmission,
  TxInFlightError,
  useContractServiceContext,
  useResource,
} from "@obsidion/front-core"
import {
  base64UrlToBytes,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  bytesToBase64Url,
  claimFpcSponsoredFee,
  type ContractService,
  findLinkPayloads,
  linkAnnounceInteraction,
  type LinkKey,
  LinkKind,
  type LinkLocatorClasses,
  MAX_LINK_PAYLOAD_BYTES,
  randomLinkKey,
  shortLinksEnabled,
} from "@obsidion/sdk"
import { requestAmountLabel } from "../../ui/format"
import { getOperationStore, runOperation } from "../operations/operations"
import {
  claimSponsorContext,
  noteSubscribed,
  type ClaimSponsorDeps,
} from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { shortRequestUrl } from "../shortLinks"
import { session, useSession } from "../../platform/session"
import type { ReceiveCode } from "../receive/receiveCode"

/** What a short link publishes: a request, its full link and its amount. A Receive code is one. */
export type ShareableRequest = Pick<ReceiveCode, "requestId" | "url" | "amount">

/** A code's fragment as the bytes its short link announces, or undefined when they don't fit. */
function codePayload(code: ShareableRequest): Uint8Array | undefined {
  const fragment = code.url.slice(code.url.indexOf("#") + 1)
  const bytes = base64UrlToBytes(fragment)
  return bytes.length > 0 && bytes.length <= MAX_LINK_PAYLOAD_BYTES ? bytes : undefined
}

/**
 * Publish a code signed by its short link's key: one sponsored call, no passkey. The FPC
 * subscription pays, folded into this tx when the account has none yet.
 */
async function announceCode(
  deps: ClaimSponsorDeps,
  key: LinkKey,
  bytes: Uint8Array,
  operationId: string,
) {
  const { wallet, account, contractService } = deps
  const user = account.getAddress()
  const { fpcAddress, fpcArtifact, railId, policy, subscribe } = await claimSponsorContext(
    deps,
    RAIL_REGISTERED,
  )
  const announce = await linkAnnounceInteraction(
    wallet,
    contractService,
    LinkKind.Request,
    key,
    bytes,
  )
  const innerCalls = (await announce.request()).calls
  // The locator matches the rail's `ByAny` entry: no class witness.
  const common = { fpcAddress, fpcArtifact, railId, policy, user, innerCalls, classWitnesses: [] }
  const payload = subscribe
    ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
    : await buildClaimSponsorPayload(common)
  // The operation is this tx's only record, and holds its hash once sent.
  const submission = trackSubmission(operationId)
  try {
    // The user tags the tx, so the FPC's refreshed SubscriptionNote stays discoverable.
    await wallet.sendTx(payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [user],
      fee: claimFpcSponsoredFee(policy, innerCalls),
      operationId,
    })
  } catch (e) {
    const inFlight = await submission.survived(wallet.node)
    if (inFlight) throw new TxInFlightError(inFlight, e)
    throw e
  } finally {
    submission.stop()
  }
  if (subscribe) noteSubscribed(account, fpcAddress, railId)
}

/** Resolves once the chain settles a sent operation; rejects once it fails. */
function chainOutcome(operationId: string): Promise<void> {
  const store = getOperationStore()
  return new Promise((resolve, reject) => {
    const check = () => {
      const record = store.get(operationId)
      if (record?.state === "settled") resolve()
      else if (!record || record.state === "failed") reject(new Error(record?.error ?? "dropped"))
      else return
      off()
    }
    const off = store.onListChanged(check)
    check()
  })
}

/** Publish a code as an operation the bell lists; resolves once the chain includes it. */
async function publishCode(
  deps: ClaimSponsorDeps,
  requestId: string,
  key: LinkKey,
  bytes: Uint8Array,
  amount: number,
): Promise<void> {
  const operationId = requestLinkOperationId(requestId)
  const summary = `Request for ${amount > 0 ? requestAmountLabel(amount) : "any amount"}`
  try {
    await runOperation({ operationId, flow: "request-link", summary }, async () => {
      // No screen waits on it, so the bell reports how it ends.
      await getOperationStore().markHandedOff(operationId)
      await announceCode(deps, key, bytes, operationId)
    })
  } catch (e) {
    if (!(e instanceof TxInFlightError)) throw e
    await chainOutcome(operationId)
  }
}

/** `idle` until handed out; `failed` already holds the fresh key the next hand-out publishes. */
export type ShortLinkStatus = "idle" | "publishing" | "ready" | "failed"

interface ShortLink {
  key: LinkKey
  status: ShortLinkStatus
}

// One record per request across every mount, so a remounted sheet neither re-keys nor re-sends.
const links = new Map<string, ShortLink>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())

/**
 * The short link to share for a request, and the hand-out that publishes it. Each request gets
 * one key, whose hash is the link's seed, and its announce tx goes out once, on the first hand-out: codes re-mint unseen, so only
 * a tap may send it. The code's own link stands in while the wallet can't publish, on a deployment
 * that states no locator, and in the QR until the short one resolves.
 */
export function useShortRequestLink(code: ShareableRequest | undefined) {
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const { contractService } = useContractServiceContext()
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(rerender)
    return () => void listeners.delete(rerender)
  }, [])

  const enabled = useShortLinksEnabled(contractService)
  const deps = useMemo((): ClaimSponsorDeps | undefined => {
    if (!obsidionWallet || !obsidionAccount || !contractService || !enabled) return undefined
    return { wallet: obsidionWallet, account: obsidionAccount, contractService }
  }, [obsidionWallet, obsidionAccount, contractService, enabled])

  const bytes = useMemo(() => (code ? codePayload(code) : undefined), [code])
  let link: ShortLink | undefined
  if (code && bytes && deps) {
    link = links.get(code.requestId) ?? { key: randomLinkKey(), status: "idle" }
    links.set(code.requestId, link)
  }
  const url = link ? shortRequestUrl(link.key.seed) : code?.url
  const status = link?.status ?? "idle"
  const qrUrl = status === "ready" ? url : code?.url

  const publish = useCallback(() => {
    if (!code || !bytes || !deps) return
    const requestId = code.requestId
    const current = links.get(requestId)
    if (!current || current.status === "publishing" || current.status === "ready") return
    current.status = "publishing"
    changed()
    void publishCode(deps, requestId, current.key, bytes, code.amount).then(
      () => {
        current.status = "ready"
        changed()
        // Later shares of this request, from Activity too, use the short link.
        void Promise.resolve()
          .then(() => session().requests.setShortLink(requestId, shortRequestUrl(current.key.seed)))
          .catch((e: unknown) => console.warn("[request] short link not saved:", e))
      },
      (e: unknown) => {
        // The next hand-out shares and publishes a fresh link rather than one that never resolves.
        links.set(requestId, { key: randomLinkKey(), status: "failed" })
        changed()
        // The bell row and Receive tell the user; no dialog for a background publish.
        console.warn("[request] short link not published:", e)
      },
    )
  }, [code, bytes, deps])

  return { url, qrUrl, status, publish }
}

function useShortLinksEnabled(contractService: ContractService | null | undefined): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    if (!contractService) return
    let stopped = false
    void shortLinksEnabled(contractService).then((on) => !stopped && setEnabled(on))
    return () => {
      stopped = true
    }
  }, [contractService])
  return enabled
}

/**
 * The fragment a short request link stands for, or undefined until its announce tx lands. Only
 * what the link's key signed counts, so a link holder cannot redirect it.
 */
export async function resolveShortRequest(
  node: Pick<AztecNode, "getPrivateLogsByTags">,
  contractService: LinkLocatorClasses,
  seed: Uint8Array,
): Promise<string | undefined> {
  const [first] = await findLinkPayloads(node, contractService, LinkKind.Request, seed)
  return first && bytesToBase64Url(first.bytes)
}
