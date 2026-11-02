import { useNavigate } from "react-router-dom"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { ActionWaitScreen } from "./ActionWaitScreen"

/**
 * Shown in place of a sponsored action the ClaimFPC cannot bill yet. Its open rail admits an
 * account the L1 registry registered, so the action waits for a name (`pending` unset) or for the
 * NamePortal's L1->L2 message to reach the rollup (`pending`). The user reaches this by attempting
 * the action, not before.
 */
export function NameRequiredScreen({ pending }: { pending?: boolean }) {
  const navigate = useNavigate()
  return (
    <ActionWaitScreen
      testId={pending ? "registration-pending" : "name-required"}
      title={pending ? "Finishing your registration" : "Register a name first"}
      message={
        pending
          ? "Sending, withdrawing and payment links unlock as soon as your registration reaches the network. This takes a few minutes."
          : "Sending, depositing and withdrawing are paid for by your registration. Register a name to unlock them."
      }
      action={
        !pending && (
          <PrimaryGradientButton title="Register a name" onClick={() => navigate("/claim")} />
        )
      }
    />
  )
}
