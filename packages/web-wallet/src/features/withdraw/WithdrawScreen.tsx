import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { getAddress, isAddress, type Address } from "viem"
import {
  ContactStorage,
  L1_PLACEHOLDER_NAME,
  contactRowFromEntry,
  useEnsAddress,
  type Contact,
} from "@obsidion/front-core"
import { Card, GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { fireEvent } from "../../lib/analytics"
import { ensClient } from "../../lib/ens"
import { shortL1Addr } from "../../ui/format"
import { Blockie, L1AddressText } from "../../ui/L1AddressText"
import { useBack } from "../../ui/hooks"
import { Modal } from "../../ui/Modal"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { Warning } from "../../ui/Warning"
import { useL1Wallet } from "../deposit/l1Wallet"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { WithdrawToWalletModal } from "./WithdrawToWalletModal/WithdrawToWalletModal"
import { useFreshAddressAvailable } from "./freshAddressAvailability"
import {
  FRESH_ADDRESS_VERDICT_COPY,
  localVerdict,
  useFreshAddressVerdict,
} from "./freshAddressCheck"
import { VerdictCard, type VerdictKind } from "./WithdrawFreshScreen"
import { useWithdrawals } from "./useWithdrawals"
import {
  ETHERFI_ASSETS_COPY,
  ETHERFI_DEFAULT_ASSET,
  ETHERFI_RECEIVE_ASSETS,
  isEtherfiContact,
} from "./etherfi"
import walletIcon from "../../assets/deposit/wallet-line.svg"

export interface SavedL1Wallet {
  address: Address
  name: string
  entry: Contact
}

/** Most-recent L1 wallet contacts (saved recipients + deposit funders), tombstones hidden. */
export function useSavedL1Wallets(limit = 3): SavedL1Wallet[] {
  const [wallets, setWallets] = useState<SavedL1Wallet[]>([])
  useEffect(() => {
    ContactStorage.get()
      .getEntries()
      .then((entries) => {
        const rows = entries
          .filter((e) => e.addressKind === "ethereum-l1" && !!e.l1Wallet)
          .filter((e) => {
            const w = e.l1Wallet!
            return !w.deletedAt || (w.lastUsedAt ?? 0) > w.deletedAt
          })
          .sort((a, b) => (b.l1Wallet!.lastUsedAt ?? 0) - (a.l1Wallet!.lastUsedAt ?? 0))
          .slice(0, limit)
          .map((e) => ({ address: e.address as Address, name: e.name, entry: e }))
        setWallets(rows)
      })
      .catch(() => {})
  }, [limit])
  return wallets
}

const TAGS = { "linked-deposit": "Has history", "withdrew-before": "Used before" } as const
/** How long a pressed row waits on Ethereum before the address reads as unchecked. */
const VERDICT_WAIT_MS = 5_000

/**
 * Existing-address withdrawal, as a sheet over the method step: pick or paste a destination, read
 * what ties it to the user, then hand it to `WithdrawToWalletModal`. A pressed row leaves for the
 * next step on its own once its address clears screening and its history is read.
 */
export function WithdrawScreen() {
  const config = getConfig()
  const navigate = useNavigate()
  const close = useBack("/withdraw")
  // Prefill from contact-detail navigation.
  const prefill = (useLocation().state ?? {}) as { recipient?: string; alias?: string }
  const [query, setQuery] = useState(prefill.recipient ?? "")
  const [picked, setPicked] = useState<Address | "connected">()
  const [naming, setNaming] = useState(false)
  const [typedName, setTypedName] = useState("")
  const [step, setStep] = useState<"pick" | "privacy" | "amount">("pick")
  // A pressed row, waiting on the checks before it leaves the step.
  const [going, setGoing] = useState(false)
  // Fixed as the row leaves, so nothing that changes under a later step can move the destination.
  const [chosen, setChosen] = useState<{
    recipient: Address
    name?: string
    kind: VerdictKind
    /** A saved ether.fi Cash address only takes what ether.fi credits. */
    etherfi: boolean
  }>()

  const saved = useSavedL1Wallets(Infinity)
  const { records } = useWithdrawals()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const freshOffered = useFreshAddressAvailable() === true
  const connected = l1.account

  const search = query.trim()
  const ens = useEnsAddress(search, ensClient)
  const raw = ens.name
    ? ens.address ?? ""
    : search || (picked === "connected" ? connected : picked) || ""
  const target = isAddress(raw) ? getAddress(raw) : null
  const same = (address?: string | null) =>
    !!target && address?.toLowerCase() === target.toLowerCase()
  const match = saved.find((w) => same(w.address))
  const name =
    (naming && typedName.trim()) ||
    (match && match.name !== L1_PLACEHOLDER_NAME && match.name) ||
    (same(connected) && l1.walletName) ||
    (same(prefill.recipient) && prefill.alias) ||
    ens.name ||
    undefined

  const contacts = saved.map((w) => w.entry)
  const tie = (address: string) => localVerdict(address.toLowerCase(), records, contacts)?.kind
  // Past the pick step the read follows the fixed destination, not the live one.
  const checked = step === "pick" ? target : chosen?.recipient ?? null
  const onchain = useFreshAddressVerdict(checked, VERDICT_WAIT_MS).kind
  // The wallet's own records answer at once. The contract copy is about the fresh flow's ETH for gas.
  const kind = (target && tie(target)) || (onchain === "contract" ? "history" : onchain)
  const screened = useScreenedAddress(target, "withdraw", { debounceMs: 300 })

  useEffect(() => {
    fireEvent("withdraw_opened", { method: "existing" })
  }, [])

  // Connecting is a pick, and only while nothing else is chosen.
  useEffect(() => {
    if (connected) setPicked((current) => current ?? "connected")
  }, [connected])

  useEffect(() => {
    if (!going || !target || !screened.cleared || kind === "idle" || kind === "checking") return
    setGoing(false)
    setChosen({
      recipient: target,
      name: name || undefined,
      kind,
      etherfi: !!match && isEtherfiContact(match.entry),
    })
    setStep(kind === "fresh" ? "amount" : "privacy")
  }, [going, target, screened.cleared, kind, name])

  // A name being resolved lists only the wallet it resolves to: a saved wallet of the same name may
  // hold an address the name has moved off (stealth names hand out a fresh one per lookup). Text
  // that is not a name, or a name with no address, searches as usual (e.g. "ether.fi Cash").
  const ensPick = !!ens.name && (ens.state === "resolving" || ens.state === "found")
  const rows = ensPick
    ? saved.filter((w) => same(w.address))
    : search
    ? saved.filter((w) => `${w.name} ${w.address}`.toLowerCase().includes(search.toLowerCase()))
    : saved.filter((w, i) => i < 3 || same(w.address))

  // An address in the field that no saved wallet answers to gets a row of its own.
  const typed = !!search && !!target && !match
  const type = (value: string) => {
    setQuery(value)
    setPicked(undefined)
    setGoing(false)
  }
  const pick = (address: Address | "connected") => {
    setQuery("")
    setNaming(false)
    setPicked(address)
    setGoing(true)
  }
  const paste = () =>
    navigator.clipboard
      .readText()
      .then((text) => type(text.trim()))
      .catch(() => {})

  if (step === "amount" && chosen) {
    return (
      <WithdrawToWalletModal
        recipient={chosen.recipient}
        walletName={chosen.name}
        receiveAsset={chosen.etherfi ? ETHERFI_DEFAULT_ASSET : undefined}
        receiveAssets={chosen.etherfi ? ETHERFI_RECEIVE_ASSETS : undefined}
        assetNote={chosen.etherfi ? `ether.fi Cash credits ${ETHERFI_ASSETS_COPY}.` : undefined}
        recipientIsContract={onchain === "contract"}
        onClose={() => setStep("pick")}
        onDone={() => navigate("/")}
      />
    )
  }

  return (
    <Modal
      variant="bare"
      label={step === "pick" ? "Withdraw" : "You'll lose privacy"}
      className="ww-deposit-warning"
      onClose={close}
    >
      {step === "privacy" && (
        <div className="ww-deposit-warning__back">
          <TopNavIconButton icon="chevron-left" ariaLabel="Back" onClick={() => setStep("pick")} />
        </div>
      )}
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={close} />
      </div>
      {step === "pick" ? (
        <>
          <GradientText size={24} weight={700}>
            Withdraw
          </GradientText>
          <div className="ww-fund__fields">
            <span className="ww-withdraw__box">
              <Icon name="search" size={16} color="var(--text-secondary)" />
              <input
                aria-label="Address"
                placeholder="Search, or paste an address or ENS name"
                spellCheck={false}
                data-autofocus
                value={query}
                onChange={(e) => type(e.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__clear"
                  aria-label="Clear address"
                  onClick={() => type("")}
                >
                  <Icon name="x" size={12} />
                </button>
              ) : (
                <button type="button" className="zkm-btn-reset ww-withdraw__paste" onClick={paste}>
                  Paste <Icon name="copy" size={12} />
                </button>
              )}
            </span>
            {ens.name && ens.state !== "found" && (
              <span className="ww-fund__label">
                {ens.state === "resolving"
                  ? "Looking up this name…"
                  : ens.state === "missing"
                  ? "No address resolution found for this name."
                  : ens.state === "invalid"
                  ? "This isn't a valid ENS name."
                  : "Couldn't look up this name. Try again, or paste the address."}
              </span>
            )}
            {target && !screened.cleared ? (
              <ScreeningNotice
                verdict={screened.verdict}
                checkingCopy="Checking address…"
                blockedFallback="This address can't receive withdrawals."
                errorCopy="Couldn't verify this address. Check your internet connection or try another address."
                onRetry={screened.rescreen}
              />
            ) : (
              kind === "checking" && (
                <span className="ww-fund__label">Checking address history…</span>
              )
            )}
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-withdraw__howto"
              onClick={() => {
                setNaming(true)
                setPicked(undefined)
                setGoing(false)
              }}
            >
              <span
                className="ww-deposit__connect-icon"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 4,
                  background: "rgba(255,255,255,.1)",
                }}
              >
                <Icon name="plus" size={20} color="#fff" />
              </span>
              <span className="ww-deposit__connect-text">
                <b>New address</b>
                <span>Name an address you own</span>
              </span>
            </button>
            {naming && (
              <label className="ww-withdraw__field">
                <span>Wallet name (optional)</span>
                <span className="ww-withdraw__box">
                  <input
                    autoFocus
                    placeholder="e.g. Rainbow"
                    value={typedName}
                    onChange={(e) => setTypedName(e.target.value)}
                  />
                </span>
              </label>
            )}
            {(typed || rows.length > 0) && (
              <Card>
                <div className="ww-withdraw__saved">
                  {typed && target && (
                    <div
                      className="ww-deposit__actions"
                      style={{
                        borderRadius: 8,
                        background: going ? "var(--surface-card)" : undefined,
                      }}
                    >
                      <button
                        type="button"
                        aria-label="Use this address"
                        aria-current={going || undefined}
                        className="zkm-btn-reset ww-deposit__connect ww-paymethod"
                        style={{ flex: 1, paddingBlock: 12, background: "none" }}
                        onClick={() => setGoing(true)}
                      >
                        <Blockie address={target} size={44} />
                        <span className="ww-deposit__connect-text">
                          <b>{name ?? "Address"}</b>
                          <L1AddressText address={target} cut />
                        </span>
                        {tie(target) && (
                          <span
                            className="ww-withdraw__tag"
                            data-tone={FRESH_ADDRESS_VERDICT_COPY[tie(target)!].tone}
                          >
                            {TAGS[tie(target)!]}
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                  {rows.map((w) => {
                    const id = contactRowFromEntry(w.entry).id
                    const tag = tie(w.address)
                    return (
                      <div
                        key={id}
                        className="ww-deposit__actions"
                        style={{
                          borderRadius: 8,
                          background: same(w.address) ? "var(--surface-card)" : undefined,
                        }}
                      >
                        <button
                          type="button"
                          aria-current={same(w.address) || undefined}
                          className="zkm-btn-reset ww-deposit__connect ww-paymethod"
                          style={{
                            flex: 1,
                            paddingBlock: 12,
                            paddingRight: 0,
                            background: "none",
                          }}
                          onClick={() => (ensPick ? setGoing(true) : pick(w.address))}
                        >
                          <Blockie address={w.address} size={44} />
                          <span className="ww-deposit__connect-text">
                            <b>{w.name}</b>
                            <L1AddressText address={w.address} cut />
                          </span>
                          {tag && (
                            <span
                              className="ww-withdraw__tag"
                              data-tone={FRESH_ADDRESS_VERDICT_COPY[tag].tone}
                            >
                              {TAGS[tag]}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="zkm-btn-reset"
                          style={{ paddingRight: 12 }}
                          aria-label={`Edit ${w.name}`}
                          onClick={() => navigate(`/contacts/${encodeURIComponent(id)}`)}
                        >
                          <Icon name="ellipsis" size={16} style={{ transform: "rotate(90deg)" }} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </Card>
            )}
          </div>
          {!isDesktopL1SubmitActive() && (
            <div className="ww-fund__fields">
              <div className="ww-deposit__or">
                <hr className="ww-divider" />
                <span>or</span>
                <hr className="ww-divider" />
              </div>
              <button
                type="button"
                className={
                  "zkm-btn-reset zkm-pressable ww-deposit__connect" +
                  (same(connected) ? " ww-paymethod--best" : "")
                }
                style={{ position: "relative" }}
                onClick={() => (connected ? pick("connected") : void l1.connect())}
              >
                <span className="ww-deposit__connect-icon">
                  <img src={walletIcon} alt="" width={19} height={17} />
                </span>
                <span className="ww-deposit__connect-text">
                  <b>{connected ? "Use your connected wallet" : "Connect your wallet"}</b>
                  <span>
                    {connected
                      ? `${l1.walletName ?? "Wallet"} · ${shortL1Addr(connected)}`
                      : "Use Rainbow, MetaMask, Rabby, or WalletConnect"}
                  </span>
                </span>
                <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
              </button>
              {connected && (
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit__disconnect"
                  onClick={l1.disconnect}
                >
                  Disconnect
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        chosen && (
          <>
            <div className="ww-sheet__title" style={{ gap: 10 }}>
              <GradientText size={24} weight={700}>
                You'll lose privacy
              </GradientText>
              <small>
                None of this can be undone later.
                {freshOffered &&
                  " A fresh address takes about three minutes to create and keeps your funds private."}
              </small>
            </div>
            <div className="ww-fund__fields">
              <div className="ww-withdraw__field">
                <span>{chosen.name ?? "Address"}</span>
                <span
                  className="ww-withdraw__box"
                  style={{ fontSize: 11, boxShadow: "inset 0 0 0 1px var(--accent-pink)" }}
                >
                  <Blockie address={chosen.recipient} />
                  <L1AddressText address={chosen.recipient} />
                </span>
              </div>
              <VerdictCard kind={chosen.kind} address={chosen.recipient} />
              <Warning title="Address traceability" tone="error" role="note">
                Any action taken by this address can be tracked for as long as it remains in use.
              </Warning>
            </div>
            <div className="ww-fund__fields">
              {freshOffered && (
                <PrimaryGradientButton
                  title="Use a fresh address instead"
                  onClick={() => navigate("/withdraw/fresh", { replace: true })}
                  style={{ width: "100%", height: 48 }}
                />
              )}
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-deposit__btn"
                style={{ flex: "none", width: "100%" }}
                onClick={() => setStep("amount")}
              >
                Continue without privacy
              </button>
            </div>
          </>
        )
      )}
    </Modal>
  )
}
