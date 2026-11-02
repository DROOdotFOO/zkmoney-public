import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Router, useNavigate } from "react-router-dom"
import { isDemoMode } from "../dev/demoFlag"
import { mockOnboarding } from "../dev/mockOnboarding"
import { hasConnectStash } from "../features/contacts/connectReceive"
import { InvitationChrome } from "../features/onboarding/InvitationChrome"
import { drawnOfferTag } from "../features/onboarding/nameGrant"
import { CreateWalletStep } from "../features/onboarding/steps/CreateWalletStep"
import { useLandingRate } from "../features/onboarding/steps/LandingFeatureCards"
import { stashClaimLink } from "../features/paylink/claimStash"
import { withExpiry } from "../features/paylink/claimWindow"
import {
  prefetchGoldenTicketOffer,
  usePrefetchedGoldenTicketOffer,
} from "../features/paylink/goldenTicketOffer"
import { seededLink } from "../features/paylink/linkStatus"
import { PaylinkVisitorPending } from "../features/paylink/PaylinkVisitorScreen"
import type { PaymentLink } from "../features/paylink/types"
import { useOriginWasFresh } from "../platform/storage/freshOrigin"
import { ShellRoot } from "./AppShell/AppShell"
import { IdleBell } from "./NotificationsBell/NotificationsBell"
import { preBootNavigator, setPreBootCreate, usePreBootCreate, usePreBootLeft } from "./preBootTaps"
import { useFirstScreenShown } from "./PxeBoot"

type PreBootPage = { kind: "landing" } | { kind: "link"; link: PaymentLink }

/** The page the wallet opens on for a visitor with nothing stored, where one can stand in for it. */
function preBootPage(): PreBootPage | undefined {
  try {
    if (isDemoMode() || mockOnboarding() || drawnOfferTag() || hasConnectStash()) return undefined
    const { pathname, search, hash } = location
    if (pathname === "/") return { kind: "landing" }
    if (pathname === "/claim") {
      const params = new URLSearchParams(search)
      const resumed = params.get("resume") === "1" || params.get("recovery") === "1"
      return resumed ? undefined : { kind: "landing" }
    }
    const fragment = hash.replace(/^#/, "")
    if (pathname === "/link" && fragment) {
      return { kind: "link", link: withExpiry(seededLink(fragment), undefined) }
    }
  } catch {
    // A link that does not decode waits for its error card.
  }
  return undefined
}

/**
 * The first screen while the wallet starts, for a visitor on an origin with no wallet database: the
 * landing, or a payment link's page with every read pending. It takes the boot screen's place
 * outside the app's root until the app draws its own first screen, which is the same screen, so
 * the visitor sees it seconds sooner and nothing changes when the app takes over. A tap that needs
 * the wallet waits for it (`preBootTaps`).
 */
export function PreBootLayer() {
  const [page] = useState(preBootPage)
  const fresh = useOriginWasFresh()
  const shown = useFirstScreenShown()
  const left = usePreBootLeft()
  const host = document.getElementById("pre-boot")
  if (!page || !fresh || shown || left || !host) return null
  return createPortal(
    <Router
      location={location.pathname + location.search + location.hash}
      navigator={preBootNavigator}
    >
      {page.kind === "landing" ? <PreBootLanding /> : <PreBootVisitor link={page.link} />}
    </Router>,
    host,
  )
}

function PreBootLanding() {
  const busy = usePreBootCreate()
  const navigate = useNavigate()
  // A landing that waits for its live rate leaves the boot screen up until then.
  if (!useLandingRate().ready) return null
  return (
    <ShellRoot>
      <InvitationChrome bare landing>
        <CreateWalletStep
          busy={busy}
          onCreate={() => setPreBootCreate(true)}
          onLogIn={() => navigate("/enter", { replace: true })}
          onCancel={() => setPreBootCreate(false)}
        />
      </InvitationChrome>
    </ShellRoot>
  )
}

function PreBootVisitor({ link }: { link: PaymentLink }) {
  const navigate = useNavigate()
  // The offer needs no wallet: read now, the page has it when it mounts.
  useEffect(prefetchGoldenTicketOffer, [])
  // Saved as the page does, so a sign-in started here still claims the link.
  useEffect(() => stashClaimLink(link.fragment), [link.fragment])
  const offer = usePrefetchedGoldenTicketOffer()
  return (
    <ShellRoot>
      <PaylinkVisitorPending
        link={link}
        offer={offer}
        bell={<IdleBell />}
        onLogIn={() => navigate("/enter?choose=1")}
      />
    </ShellRoot>
  )
}
