import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { getAddress, isAddress, type Address } from "viem"
import {
  Card,
  GradientText,
  Icon,
  NumberedStepRow,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { fireEvent } from "../../../lib/analytics"
import { fmt } from "../../../lib/fmt"
import { shortL1Addr } from "../../../ui/format"
import { useBack } from "../../../ui/hooks"
import { Modal } from "../../../ui/Modal"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { Warning } from "../../../ui/Warning"
import { WithdrawToWalletModal } from "../WithdrawToWalletModal/WithdrawToWalletModal"
import { useEtherfiAddressVerdict, type EtherfiAddressVerdict } from "../etherfiCheck"
import copy from "./WithdrawEtherfiScreen.copy"
import {
  ETHERFI_ASSETS_COPY,
  ETHERFI_CONTACT_NAME,
  ETHERFI_DEFAULT_ASSET,
  ETHERFI_RECEIVE_ASSETS,
  ETHERFI_SHARE_ADDRESS_URL,
  saveEtherfiAddress,
  useSavedEtherfiAddress,
} from "../etherfi"

/** How long the factory read waits before the address reads as unconfirmed. A public RPC can be slow. */
const VERDICT_WAIT_MS = 10_000

const TONE: Record<
  Exclude<EtherfiAddressVerdict["kind"], "idle" | "checking">,
  "success" | "warning" | "error"
> = { confirmed: "success", account: "warning", rejected: "error", unknown: "warning" }

/**
 * Withdrawal to an ether.fi Cash account, as a sheet over the method step: fetch the account's
 * deposit address from ether.fi, paste it, have ether.fi's factory confirm it, keep it for next
 * time, then hand it to `WithdrawToWalletModal` narrowed to the outputs ether.fi credits.
 */
export function WithdrawEtherfiScreen() {
  const navigate = useNavigate()
  const close = useBack("/withdraw")
  const saved = useSavedEtherfiAddress()
  const [query, setQuery] = useState("")
  // Entering a new address over a saved one.
  const [replacing, setReplacing] = useState(false)
  const [keep, setKeep] = useState(true)
  const [chosen, setChosen] = useState<Address>()

  useEffect(() => {
    fireEvent("withdraw_opened", { method: "etherfi" })
  }, [])

  const usingSaved = !!saved && !replacing
  const raw = usingSaved ? saved : query.trim()
  const target = raw && isAddress(raw) ? getAddress(raw) : null
  const screened = useScreenedAddress(target, "withdraw", { debounceMs: 300 })
  const verdict = useEtherfiAddressVerdict(target, VERDICT_WAIT_MS)
  const notice =
    verdict.kind === "idle" || verdict.kind === "checking"
      ? undefined
      : { ...copy.verdict[verdict.kind], tone: TONE[verdict.kind] }

  const type = (value: string) => setQuery(value)
  const paste = () =>
    navigator.clipboard
      .readText()
      .then((text) => type(text.trim()))
      .catch((err) => console.warn("[etherfi] clipboard read refused:", err))
  const go = () => {
    if (!target) return
    if (!usingSaved && keep) void saveEtherfiAddress(target, saved ?? undefined)
    setChosen(target)
  }

  if (chosen) {
    return (
      <WithdrawToWalletModal
        recipient={chosen}
        walletName={ETHERFI_CONTACT_NAME}
        receiveAsset={ETHERFI_DEFAULT_ASSET}
        receiveAssets={ETHERFI_RECEIVE_ASSETS}
        assetNote={fmt(copy.assetNote, { assets: ETHERFI_ASSETS_COPY })}
        onClose={() => setChosen(undefined)}
        onDone={() => navigate("/")}
      />
    )
  }

  return (
    <Modal variant="bare" label={copy.title} className="ww-deposit-warning" onClose={close}>
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={close} />
      </div>
      <div className="ww-sheet__title" style={{ gap: 10 }}>
        <GradientText size={24} weight={700}>
          {copy.title}
        </GradientText>
        <small>{fmt(copy.subtitle, { assets: ETHERFI_ASSETS_COPY })}</small>
      </div>
      <div className="ww-fund__fields">
        {saved === undefined ? null : usingSaved ? (
          <Card>
            <div className="ww-withdraw__saved">
              <div className="ww-deposit__actions" style={{ borderRadius: 8 }}>
                <span
                  className="ww-deposit__connect"
                  style={{ flex: 1, paddingBlock: 12, background: "none" }}
                >
                  <span className="ww-deposit__connect-icon" style={{ width: 44, height: 44 }}>
                    <Icon name="bank" size={20} color="#fff" />
                  </span>
                  <span className="ww-deposit__connect-text">
                    <b>{ETHERFI_CONTACT_NAME}</b>
                    <span>{shortL1Addr(saved)}</span>
                  </span>
                </span>
                <button
                  type="button"
                  className="zkm-btn-reset"
                  style={{ paddingRight: 12 }}
                  onClick={() => setReplacing(true)}
                >
                  {copy.change}
                </button>
              </div>
            </div>
          </Card>
        ) : (
          <>
            <div className="ww-deposit__fields">
              {copy.steps.map((step, i) => (
                <NumberedStepRow key={step} index={i + 1}>
                  {step}
                </NumberedStepRow>
              ))}
            </div>
            <a
              className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-withdraw__howto"
              href={ETHERFI_SHARE_ADDRESS_URL}
              target="_blank"
              rel="noreferrer"
            >
              <span className="ww-deposit__connect-icon">
                <Icon name="bank" size={22} color="#fff" />
              </span>
              <span className="ww-deposit__connect-text">
                <b>{copy.getAddress}</b>
                <span>{copy.getAddressHint}</span>
              </span>
              <Icon name="share-box" size={16} color="var(--text-secondary)" />
            </a>
            <label className="ww-withdraw__field">
              <span>{copy.field}</span>
              <span className="ww-withdraw__box">
                <input
                  aria-label={copy.field}
                  placeholder={copy.placeholder}
                  spellCheck={false}
                  data-autofocus
                  value={query}
                  onChange={(e) => type(e.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-withdraw__clear"
                    aria-label={copy.clear}
                    onClick={() => type("")}
                  >
                    <Icon name="x" size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-withdraw__paste"
                    onClick={paste}
                  >
                    {copy.paste} <Icon name="copy" size={12} />
                  </button>
                )}
              </span>
            </label>
            {query.trim() && !target && <span className="ww-pay__error">{copy.notAnAddress}</span>}
            <label className="ww-sheet__fact" style={{ cursor: "pointer" }}>
              <span>{copy.save}</span>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            </label>
          </>
        )}
        {target && verdict.kind === "checking" && (
          <span className="ww-fund__label">{copy.checking}</span>
        )}
        {notice && (
          <Warning
            title={notice.title}
            tone={notice.tone}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            <p>{notice.body}</p>
          </Warning>
        )}
        {target && !screened.cleared && (
          <ScreeningNotice
            verdict={screened.verdict}
            checkingCopy={copy.screening.checking}
            blockedFallback={copy.screening.blocked}
            errorCopy={copy.screening.error}
            onRetry={screened.rescreen}
          />
        )}
      </div>
      <PrimaryGradientButton
        title={copy.continue}
        isDisabled={
          !target || !screened.cleared || verdict.kind === "checking" || verdict.kind === "rejected"
        }
        onClick={go}
        style={{ width: "100%", height: 48 }}
      />
    </Modal>
  )
}
