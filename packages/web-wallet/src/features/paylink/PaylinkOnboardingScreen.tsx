import { useState } from "react"
import { OnboardingScreen, type OnboardingScreenProps } from "../onboarding/OnboardingScreen"
import { pendingTicketRegistration } from "./ticketContinuation"
import { usePaylinkKit } from "./usePaylinkDeps"
import { useAssetDemand } from "../../platform/session"

/**
 * The signup wizard with the paylink services a ticket-funded signup claims its link with. For a
 * host that starts the session's token and enclave co-signer, which the claim needs; the ordinary
 * wizard runs without them.
 */
export function PaylinkOnboardingScreen(props: Omit<OnboardingScreenProps, "paylinkKit">) {
  const kit = usePaylinkKit()
  return <OnboardingScreen {...props} paylinkKit={kit} />
}

/**
 * `/claim`. Ordinary onboarding starts no token (see App's AssetGate for why). A pending
 * registration a payment link funds claims that link from its pending step, and the claim needs
 * the token and the co-signer, so that one resume starts them, as the link page hosting the same
 * signup does. Decided at mount: a ticket-funded reservation only ever starts on the link page.
 */
export function ClaimRoute() {
  const [ticketFunded] = useState(pendingTicketRegistration)
  useAssetDemand(ticketFunded)
  return ticketFunded ? <PaylinkOnboardingScreen /> : <OnboardingScreen />
}
