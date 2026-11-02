import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useContractServiceContext, useResource } from "@obsidion/front-core"
import {
  DEFAULT_CONTRACTS,
  decodeLinkFragment,
  encodePaylinkInline,
  getHardcodedArtifact,
  LINK_CLASS_REFUSAL,
  LinkKind,
  resolveShortPaylink,
} from "@obsidion/sdk"
import { Card, ScreenNavBar, Spinner } from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { loadOnboardedIdentity } from "../identity/walletIdentity"
import { OnboardingLayout } from "../../ui/OnboardingLayout"
import { BootSplash } from "../../ui/PxeBoot"
import { warmNoirWasm } from "../../platform/noirProver"
import { stashClaimLink } from "./claimStash"
import { PaylinkVisitorScreen } from "./PaylinkVisitorScreen"
import { EmailPaylinkUnsupportedError, emitLinkOpened, type ViewLinkDeps } from "./sponsoredPaylink"
import { seededLink, watchLink } from "./linkStatus"
import { usePolledChainSeconds } from "./chainTime"
import { withExpiry } from "./claimWindow"
import type { PaymentLink } from "./types"
import { useShortLinkLookup } from "../shortLinks"
import { useSession } from "../../platform/session"

/**
 * `/link#fragment`. A short link's fragment is looked up on chain first and replaced by the full
 * link, so everything past this point reads the full fragment.
 */
export function LinkViewScreen() {
  const location = useLocation()
  const fragment = location.hash.replace(/^#/, "")
  const short = useMemo(() => {
    const decoded = decodeLinkFragment(fragment)
    return decoded?.kind === LinkKind.Paylink ? decoded.seed : undefined
  }, [fragment])
  return short ? <ShortLinkView seed={short} /> : <FullLinkView fragment={fragment} />
}

function ShortLinkView({ seed }: { seed: Uint8Array }) {
  const navigate = useNavigate()
  const obsidionWallet = useResource(useSession().wallet)
  const { contractService } = useContractServiceContext()
  const node = obsidionWallet?.node
  const resolve = useMemo(() => {
    if (!node || !contractService) return undefined
    return async () => {
      const params = await resolveShortPaylink({ node, contractService }, seed)
      return params && encodePaylinkInline(params)
    }
  }, [node, contractService, seed])
  const refused = useShortLinkLookup(
    resolve,
    (fragment) => navigate(`/link#${fragment}`, { replace: true }),
    (e) => (e instanceof Error && e.message === LINK_CLASS_REFUSAL ? e.message : undefined),
  )

  if (!refused) return <BootSplash />
  return (
    <OnboardingLayout>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <ScreenNavBar title="Payment link" onLeading={() => navigate("/")} />
        <Card style={{ marginTop: 24 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              padding: "18px 8px",
              color: "var(--text-secondary)",
              textAlign: "center",
            }}
          >
            {refused}
          </div>
        </Card>
      </div>
    </OnboardingLayout>
  )
}

/**
 * A full link. A signed-in browser claims on Home (ClaimLinkModal), the link's creator included — a
 * creator's recoveries live on the row's detail sheet. No account: the signup page with the amount
 * above it. A fragment that does not decode, or an email link while email-locked links are off,
 * stays here on its error card: nothing is stashed and no signup is offered.
 */
function FullLinkView({ fragment }: { fragment: string }) {
  const navigate = useNavigate()
  const obsidionWallet = useResource(useSession().wallet)
  const rollupAddress = obsidionWallet?.networkId
  const { contractService } = useContractServiceContext()

  const [decoded, unsupported] = useMemo((): [PaymentLink | null, boolean] => {
    try {
      return [fragment ? seededLink(fragment) : null, false]
    } catch (e) {
      return [null, e instanceof EmailPaylinkUnsupportedError]
    }
  }, [fragment])
  // Pinned to this mount: the signup wizard writing an identity must not unmount itself.
  const [visitor] = useState(() => !loadOnboardedIdentity())
  const handoff = !visitor && decoded !== null

  useEffect(() => {
    if (!handoff) return
    stashClaimLink(fragment)
    navigate("/", { replace: true })
  }, [handoff, fragment, navigate])

  // Fetched while the PXE registers the escrow's class, which needs no network: the simulator's
  // wasm, and the token and ClaimFPC artifacts an unclaimed link's reads register next.
  useEffect(() => {
    if (handoff || !decoded) return
    void warmNoirWasm().catch(() => {})
    for (const contract of [DEFAULT_CONTRACTS.oxideToken, DEFAULT_CONTRACTS.claimFpc]) {
      void getHardcodedArtifact(contract).catch(() => {})
    }
  }, [handoff, decoded])

  // Claim-funnel top for the visitor page; a handoff mount stays silent — useClaimLinkFlow emits.
  const openedFragment = useRef<string>(undefined)
  useEffect(() => {
    if (handoff || !decoded || !rollupAddress || openedFragment.current === fragment) return
    openedFragment.current = fragment
    emitLinkOpened(rollupAddress, fragment)
  }, [handoff, decoded, fragment, rollupAddress])

  // Status needs only wallet + contracts, no passkey: the visitor page says when the link is
  // already claimed.
  const statusDeps: ViewLinkDeps | undefined = useMemo(
    () =>
      obsidionWallet && contractService ? { wallet: obsidionWallet, contractService } : undefined,
    [obsidionWallet, contractService],
  )
  const [status, setStatus] = useState<PaymentLink | null>(null)
  const chainNow = usePolledChainSeconds(obsidionWallet?.node)
  // Settled either way: the visitor page's voucher read waits on it, and a failed check must not
  // hold that read forever.
  const [statusSettled, setStatusSettled] = useState(false)
  const [noteMissed, setNoteMissed] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  useEffect(() => {
    if (handoff || !decoded || !statusDeps) return
    setStatusSettled(false)
    setNoteMissed(false)
    return watchLink(
      statusDeps,
      fragment,
      setStatus,
      // Transport failures keep the decoded view but tell the user the status is unverified.
      (e: unknown) => {
        showReportableError(e, "paylink:status", {
          message: `Could not check the link's status: ${
            e instanceof Error ? e.message : String(e)
          }`,
        })
      },
      (noteRead) => {
        setStatusSettled(true)
        setNoteMissed(!noteRead)
      },
    )
  }, [handoff, decoded, statusDeps, fragment, statusAttempt])

  if (handoff) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
        <Spinner size={20} />
      </div>
    )
  }

  const link = status?.fragment === fragment ? status : decoded
  if (link)
    return (
      <PaylinkVisitorScreen
        link={withExpiry(link, chainNow)}
        statusSettled={statusSettled}
        noteMissed={noteMissed}
        onRetryStatus={() => setStatusAttempt((n) => n + 1)}
      />
    )

  return (
    <OnboardingLayout>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <ScreenNavBar title="Payment link" onLeading={() => navigate("/")} />
        <Card style={{ marginTop: 24 }}>
          <div style={{ textAlign: "center", padding: "18px 8px", color: "var(--text-secondary)" }}>
            {unsupported
              ? "Email-locked payment links aren't supported in this wallet. Ask the sender for a new link."
              : "This link is malformed or incomplete. Check that the full URL was copied."}
          </div>
        </Card>
      </div>
    </OnboardingLayout>
  )
}
