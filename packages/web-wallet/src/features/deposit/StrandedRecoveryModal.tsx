import { useState } from "react"
import { isAddress, type Address } from "viem"
import { GradientText, PrimaryGradientButton, TextField } from "@obsidion/web-ds"
import { useResource } from "@obsidion/front-core"
import { useSession } from "../../platform/session"
import { Modal } from "../../ui/Modal"
import { DepositExitModal } from "./DepositExitModal/DepositExitModal"
import { readStrandedToken } from "./sipaRecovery"

/**
 * Settings entry to recover a token left at one of this wallet's deposit addresses, for a case the
 * deposit's own row does not offer: a token sent after the deposit settled, or one no sweep accepts.
 */
export function StrandedRecoveryModal({ onClose }: { onClose: () => void }) {
  const [sipa, setSipa] = useState("")
  const [token, setToken] = useState("")
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const [found, setFound] = useState<Awaited<ReturnType<typeof readStrandedToken>>>()
  const networkId = useResource(useSession().wallet)?.networkId

  if (found) {
    return (
      <DepositExitModal
        record={found.record}
        reason="stranded"
        canSweep={false}
        stranded={found}
        onClose={onClose}
      />
    )
  }

  const valid = isAddress(sipa) && isAddress(token) && !!networkId
  const check = async () => {
    if (!networkId) return
    setChecking(true)
    setError(undefined)
    try {
      setFound(await readStrandedToken(sipa as Address, token as Address, networkId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }
  const invalid = (v: string) =>
    v && !isAddress(v) ? "That isn't a valid Ethereum address" : undefined

  return (
    <Modal
      variant="create"
      label="Recover a deposit token"
      onClose={onClose}
      className="ww-feedback"
    >
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        Recover a deposit token
      </GradientText>
      <p className="ww-endpoints__intro">
        Send a token stuck at one of your deposit addresses out to an Ethereum address.
      </p>
      <div className="ww-feedback__body">
        <TextField
          label="Deposit address"
          placeholder="0x…"
          value={sipa}
          onChange={setSipa}
          error={invalid(sipa)}
        />
        <TextField
          label="Token address"
          placeholder="0x…"
          value={token}
          onChange={setToken}
          error={invalid(token)}
        />
        {error && (
          <p className="ww-feedback__error" role="alert" data-testid="stranded-error">
            {error}
          </p>
        )}
      </div>
      <PrimaryGradientButton
        title="Continue"
        isLoading={checking}
        isDisabled={!valid || checking}
        onClick={() => void check()}
      />
      <PrimaryGradientButton title="Cancel" buttonStyle="dark" onClick={onClose} />
    </Modal>
  )
}
