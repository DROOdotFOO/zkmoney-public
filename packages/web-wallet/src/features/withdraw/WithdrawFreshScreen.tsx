import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { getAddress, isAddress, type Address } from "viem"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { fireEvent } from "../../lib/analytics"
import { l1AddressUrl } from "../../ui/detailRows"
import { useBack } from "../../ui/hooks"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { Warning } from "../../ui/Warning"
import { FRESH_ADDRESS_VERDICT_COPY, useFreshAddressVerdict } from "./freshAddressCheck"
import { WithdrawFreshModal } from "./WithdrawFreshModal/WithdrawFreshModal"

export type VerdictKind = keyof typeof FRESH_ADDRESS_VERDICT_COPY

/** The verdict card for a destination: advice on the address, never a block. */
export function VerdictCard({ kind, address }: { kind: VerdictKind; address: Address }) {
  const copy = FRESH_ADDRESS_VERDICT_COPY[kind]
  const explorer = l1AddressUrl(address)
  return (
    <Warning title={copy.title} tone={copy.tone}>
      <p>{copy.body}</p>
      {explorer && (
        <p>
          Want to check the address's onchain history?{" "}
          <a className="ww-send-to__link" href={explorer} target="_blank" rel="noreferrer">
            Open Etherscan <Icon name="share-box" size={12} />
          </a>
        </p>
      )}
    </Warning>
  )
}

/**
 * Fresh-address withdrawal: paste a fresh L1 address, read its verdict, name it if wanted, then
 * fund it and add gas in two burns through `WithdrawFreshModal`. There is no connected-wallet
 * pick here: a connected wallet has history.
 */
export function WithdrawFreshScreen() {
  const [recipient, setRecipient] = useState("")
  const [walletName, setWalletName] = useState("")
  const [amountOpen, setAmountOpen] = useState(false)
  const navigate = useNavigate()
  const back = useBack("/withdraw")

  const parsed = isAddress(recipient) ? getAddress(recipient) : null
  const verdict = useFreshAddressVerdict(parsed)
  const {
    verdict: screening,
    cleared: recipientCleared,
    rescreen,
  } = useScreenedAddress(parsed, "withdraw", { debounceMs: 300 })

  useEffect(() => {
    fireEvent("withdraw_opened", { method: "fresh" })
  }, [])

  const paste = () =>
    navigator.clipboard
      .readText()
      .then((text) => setRecipient(text.trim()))
      .catch(() => {})

  return (
    <div className="ww-panel ww-deposit ww-withdraw">
      <div className="ww-deposit__stealth">
        <div className="ww-withdraw__head ww-modal__head">
          <span className="ww-modal__head-slot">
            <TopNavIconButton icon="arrow-left" ariaLabel="Back" onClick={back} />
          </span>
          <span className="ww-modal__head-title">
            <GradientText size={24} weight={700}>
              Withdraw
            </GradientText>
          </span>
        </div>

        <div className="ww-deposit__fields">
          <label className="ww-withdraw__field">
            <span>Paste your fresh address</span>
            <span className="ww-withdraw__box">
              <input
                placeholder="0x"
                spellCheck={false}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {recipient ? (
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__clear"
                  aria-label="Clear address"
                  onClick={() => setRecipient("")}
                >
                  <Icon name="x" size={12} />
                </button>
              ) : (
                <button type="button" className="zkm-btn-reset ww-withdraw__paste" onClick={paste}>
                  Paste <Icon name="copy" size={12} />
                </button>
              )}
            </span>
            {verdict.kind === "checking" && <span>Checking address history…</span>}
          </label>
          {parsed && verdict.kind !== "idle" && verdict.kind !== "checking" && (
            <VerdictCard kind={verdict.kind} address={parsed} />
          )}
          {parsed && !recipientCleared && (
            <ScreeningNotice
              verdict={screening}
              checkingCopy="Checking address…"
              blockedFallback="This address can't receive withdrawals."
              errorCopy="Couldn't verify this address. Check your internet connection or try another address."
              onRetry={rescreen}
            />
          )}
          <label className="ww-withdraw__field">
            <span>Name this address (optional)</span>
            <span className="ww-withdraw__box">
              <input
                placeholder="e.g. Ghost in mempool"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
              />
            </span>
          </label>
          <PrimaryGradientButton
            title="Continue"
            isDisabled={!parsed || !recipientCleared}
            onClick={() => setAmountOpen(true)}
            style={{ width: "100%", height: 48 }}
          />
        </div>
      </div>

      {amountOpen && parsed && (
        <WithdrawFreshModal
          recipient={parsed}
          walletName={walletName.trim() || undefined}
          onClose={() => setAmountOpen(false)}
          onDone={() => navigate("/")}
        />
      )}
    </div>
  )
}
