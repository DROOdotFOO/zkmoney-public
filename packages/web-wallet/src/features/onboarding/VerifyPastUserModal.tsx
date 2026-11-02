import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Hex } from "viem"
import { useResource } from "@obsidion/front-core"
import {
  GradientSpinner,
  GradientText,
  Icon,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import coinsArt from "../../assets/onboarding/past-user-coins.webp"
import badgeArt from "../../assets/onboarding/past-user-badge.webp"
import { fireOnboardingEvent } from "../../lib/analytics"
import { Modal } from "../../ui/Modal"
import { shortL1Addr } from "../../ui/format"
import { useL1Wallet } from "../deposit/l1Wallet"
import { chooseOwnName } from "./chooseOwnName"
import { ADDRESS_RE, PastUserAddressInput, type LookupState } from "./PastUserAddressInput"
import { lookupPastUser } from "./pastUserProver"
import { rememberRegistrationRoute } from "./registrationFunnel"
import { setVerifyOpen, usePastUserCheck } from "./usePastUserCheck"
import { useSession } from "../../platform/session"

/** Text that can still become an address as the user types. */
const ADDRESS_PREFIX_RE = /^0(x[0-9a-fA-F]{0,40})?$/

const SIGN_NOTE =
  "You'll sign a message to prove the wallet is yours, no gas, no transaction, and we can never move your funds. " +
  "The signature is checked in ZK, so your address is never linked to your tag and we never see it."

function Close({ onClick }: { onClick: () => void }) {
  return (
    <div className="ww-verify__close">
      <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClick} />
    </div>
  )
}

function Result(props: {
  label: string
  art: ReactNode
  body: ReactNode
  onClose: () => void
  closeButton?: boolean
  children: ReactNode
}) {
  return (
    <Modal
      variant="bare"
      className="ww-verify ww-verify--result"
      label={props.label}
      onClose={props.onClose}
    >
      {props.closeButton && <Close onClick={props.onClose} />}
      {props.art}
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {props.label}
      </GradientText>
      <p className="ww-verify__body">{props.body}</p>
      {props.children}
    </Modal>
  )
}

/**
 * Proves a past zk.money wallet. The address is checked against the list in this browser before
 * any signature. With `tag` (a paid tag waiting on activation) a pass claims that tag at the free
 * price; otherwise Welcome back hands on to the tag pick.
 */
export function VerifyPastUserModal(props: {
  tag?: string
  onChoose: () => void
  onKeepRandom?: () => void
  onPickInstead?: () => void
}) {
  const { state, check, reset } = usePastUserCheck()
  const wallet = useL1Wallet()
  const obsidionAccount = useResource(useSession().account)
  const obsidionWallet = useResource(useSession().wallet)
  const [address, setAddress] = useState<string>(state.account ?? "")
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" })
  const [attempt, setAttempt] = useState(0)
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState<string>()
  const lookupSeq = useRef(0)
  // What to do once the wallet connects: fill the address, or go on to sign.
  const pending = useRef<"fill" | "sign" | null>(null)

  const close = () => {
    reset()
    setVerifyOpen(false)
  }

  useEffect(() => {
    if (!ADDRESS_RE.test(address)) {
      lookupSeq.current++
      setLookup(
        address && !ADDRESS_PREFIX_RE.test(address) ? { kind: "invalid" } : { kind: "idle" },
      )
      return
    }
    const seq = ++lookupSeq.current
    setLookup({ kind: "loading" })
    const timer = setTimeout(async () => {
      try {
        const eligible = await lookupPastUser(address as Hex)
        if (seq === lookupSeq.current) setLookup({ kind: eligible ? "found" : "not-found" })
      } catch {
        if (seq === lookupSeq.current) setLookup({ kind: "error" })
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [address, attempt])

  const same = (account: string | null) => account?.toLowerCase() === address.toLowerCase()

  useEffect(() => {
    if (!wallet.account || !pending.current) return
    const next = pending.current
    pending.current = null
    // A different wallet connected: its address replaces the typed one and is checked first.
    if (next === "sign" && same(wallet.account)) check(wallet.account)
    else setAddress(wallet.account)
  }, [wallet.account]) // eslint-disable-line react-hooks/exhaustive-deps

  const connectWallet = () => {
    if (wallet.account) return setAddress(wallet.account)
    pending.current = "fill"
    void wallet.connect()
  }

  const sign = () => {
    if (wallet.account && same(wallet.account)) return check(wallet.account)
    pending.current = "sign"
    void wallet.connect()
  }

  const claimTag = async (tag: string) => {
    if (!obsidionAccount || !obsidionWallet) return
    setClaiming(true)
    setClaimError(undefined)
    try {
      await chooseOwnName(tag, obsidionAccount, obsidionWallet, true)
      rememberRegistrationRoute(tag, "past_user")
      fireOnboardingEvent("name_route_chosen", { route: "past_user" })
      setVerifyOpen(false)
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : String(e))
      setClaiming(false)
    }
  }

  if (state.step === "confirmed") {
    const { tag } = props
    return (
      <Result
        label="Welcome back"
        art={<img className="ww-verify__badge" src={badgeArt} alt="" />}
        body={
          tag
            ? `This wallet had a zk.money account. @${tag} is free for you.`
            : "This wallet had a zk.money account. Your own tag is free: pick the name people pay you at."
        }
        onClose={claiming ? () => {} : close}
        closeButton
      >
        {claimError && (
          <p className="ww-invite__error" role="alert">
            {claimError}
          </p>
        )}
        <PrimaryGradientButton
          title={tag ? `Claim @${tag} for free` : "Choose my tag"}
          testId="past-user-choose"
          isLoading={claiming}
          onClick={() => {
            if (tag) return void claimTag(tag)
            setVerifyOpen(false)
            props.onChoose()
          }}
        />
        {!tag && props.onKeepRandom && (
          <button
            type="button"
            className="zkm-btn-reset ww-verify__link"
            onClick={() => {
              setVerifyOpen(false)
              props.onKeepRandom?.()
            }}
          >
            Keep a random tag instead
          </button>
        )}
      </Result>
    )
  }

  if (state.step === "claimed") {
    return (
      <Result
        label="This address has already been claimed"
        art={
          <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--accent-gold)" aria-hidden>
            <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1 8v7h2v-7h-2Zm0-3v2h2V7h-2Z" />
          </svg>
        }
        body="Please try verifying using a different address."
        onClose={close}
      >
        <button
          type="button"
          className="zkm-btn-reset ww-verify__pill"
          onClick={() => {
            reset()
            setAddress("")
          }}
        >
          Try another address
        </button>
      </Result>
    )
  }

  if (state.step === "not_found") {
    return (
      <Result
        label="No zk.money account found"
        art={<Icon name="x" size={48} color="var(--accent-pink)" />}
        body="This wallet never had a zk.money account. Try the wallet you signed in with back then, or continue with a random tag for free."
        onClose={close}
      >
        <button type="button" className="zkm-btn-reset ww-verify__pill" onClick={close}>
          Close
        </button>
      </Result>
    )
  }

  if (state.step === "check" && !state.error) {
    return (
      <Result
        label="Checking your wallet"
        art={<GradientSpinner size={40} />}
        body="Looking for a zk.money account for this wallet. This takes a few seconds."
        onClose={() => setVerifyOpen(false)}
        closeButton
      >
        <PrimaryGradientButton title="Checking…" isDisabled />
      </Result>
    )
  }

  const signing = state.step === "sign" && !state.error
  return (
    <Modal
      variant="bare"
      className="ww-verify"
      label="Verify your old wallet"
      onClose={signing ? () => setVerifyOpen(false) : close}
    >
      <div className="ww-verify__privacy">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="var(--accent-green)" aria-hidden>
          <path d="M12 1l8.22 1.83a1 1 0 0 1 .78.97v9.99a6 6 0 0 1-2.67 4.99L12 23l-6.33-4.22A6 6 0 0 1 3 13.79V3.8a1 1 0 0 1 .78-.97L12 1Zm4.45 7.4-5.36 5.36-2.83-2.83-1.41 1.41 4.24 4.25 6.78-6.78-1.42-1.41Z" />
        </svg>
        <p>
          Your wallet address stays on your device. It is never sent to zk.money and never linked to
          your tag.
        </p>
      </div>
      <Close onClick={signing ? () => setVerifyOpen(false) : close} />
      <img className="ww-verify__art" src={coinsArt} alt="" />
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        Verify your old wallet
      </GradientText>
      <p className="ww-verify__lede">
        Sign a message with the Ethereum wallet you used on zk.money. You can choose your own tag
        for free.
      </p>
      <div className="ww-verify__connect">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-verify__connect-main"
          data-testid="past-user-connect"
          disabled={signing}
          onClick={connectWallet}
        >
          <span className="ww-verify__connect-icon">
            <Icon name="wallet" size={24} color="#fff" />
          </span>
          <span className="ww-verify__connect-text">
            <b>
              {wallet.account
                ? `Use ${shortL1Addr(wallet.account)}`
                : "Connect the wallet you used"}
            </b>
            <span>
              {wallet.account
                ? `Connected${wallet.walletName ? ` with ${wallet.walletName}` : ""}`
                : "Use WalletConnect, Rainbow, or MetaMask"}
            </span>
          </span>
          {!wallet.account && <Icon name="chevron-right" size={16} color="var(--text-secondary)" />}
        </button>
        {wallet.account && (
          <button
            type="button"
            className="zkm-btn-reset ww-verify__pill"
            data-testid="past-user-disconnect"
            disabled={signing}
            onClick={() => {
              if (same(wallet.account)) setAddress("")
              wallet.disconnect()
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      <div className="ww-verify__or">
        <hr />
        <span>or</span>
        <hr />
      </div>
      <PastUserAddressInput
        address={address}
        state={lookup}
        connected={same(wallet.account)}
        onAddress={setAddress}
        onRetry={() => setAttempt((n) => n + 1)}
      />
      {state.error && (
        <p className="ww-invite__error" role="alert">
          {state.error}
        </p>
      )}
      {lookup.kind === "found" && (
        <div className="ww-verify__sign">
          <PrimaryGradientButton
            title={signing ? "Confirm in your wallet…" : "Sign to verify"}
            testId="past-user-sign"
            isDisabled={signing}
            onClick={sign}
          />
          <p className="ww-verify__note">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="var(--text-secondary)"
              aria-hidden
            >
              <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm1 9h-2v6h2v-6Zm0-4h-2v2h2V7Z" />
            </svg>
            {SIGN_NOTE}
          </p>
        </div>
      )}
      {props.onPickInstead && lookup.kind !== "found" && (
        <button
          type="button"
          className="zkm-btn-reset ww-verify__link"
          onClick={() => {
            close()
            props.onPickInstead?.()
          }}
        >
          Don’t have it anymore? Pick a tag instead
        </button>
      )}
    </Modal>
  )
}
