import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { SIPADepositStore, type SIPADepositRecord } from "@obsidion/front-core"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { deriveRecoveryAddress } from "@obsidion/sdk"
import type { Address } from "viem"
import { isDemoMode } from "../../../src/dev/demoFlag"
import {
  DEMO_L1_FUNDER,
  DEMO_L1_TOKEN,
  DEMO_L2_ADDRESS,
  demoStealthKey,
} from "../../../src/dev/demoFixtures"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { ROLLUP, SIPA, SIPA_NEXT } from "./data"

// The desktop launcher's approved send that never reports a hash. `unresolved-funded` also lands the late transfer.
const STATES = ["unresolved", "unresolved-funded"] as const
type DesktopState = (typeof STATES)[number]
const KEY = "ui-capture.desktop-state"
/** After the hold starts, long enough to capture it before the late transfer lands. */
const LATE_TRANSFER_MS = 5000

/** `?desktopFixture=`, latched for the tab like `flowFixture`; `off` clears it. */
export function desktopState(): DesktopState | null {
  if (!isDemoMode()) return null
  const requested = new URLSearchParams(location.search).get("desktopFixture")
  if (requested === "off") {
    sessionStorage.removeItem(KEY)
    return null
  }
  const value = requested ?? sessionStorage.getItem(KEY)
  if (value === null) return null
  if (!STATES.includes(value as DesktopState)) throw new Error(`Unknown desktop fixture: ${value}`)
  sessionStorage.setItem(KEY, value)
  return value as DesktopState
}

/** The launcher's injected bridge and no injected wallet: what `isDesktopL1SubmitActive` checks. */
export function installDesktopBridge(): void {
  ;(globalThis as { __ZKMONEY_DESKTOP_BRIDGE__?: unknown }).__ZKMONEY_DESKTOP_BRIDGE__ = {
    l1SubmitPath: "/__capture/l1-submit",
    capabilities: ["recheck"],
  }
  delete (window as { ethereum?: unknown }).ethereum
}

const store = () => SIPADepositStore.get(webStorage)

/** Discovery's record of a published address before anything was sent to it. */
export async function seedPublishedAddress(sipaAddress: Address): Promise<void> {
  const messageSecret = Fr.random()
  const record: SIPADepositRecord = {
    sipaAddress,
    recipientL2Address: DEMO_L2_ADDRESS,
    messageSecret: messageSecret.toString(),
    recipientHash: Fr.random().toString(),
    recoveryAddress: deriveRecoveryAddress(demoStealthKey().publicKey, messageSecret).toString(),
    l1ChainId: 11155111,
    amount: "0",
    tokenSymbol: WALLET_TOKEN_SYMBOL,
    tokenAddress: DEMO_L1_TOKEN,
    phase: "broadcast",
    startTime: Date.now(),
  }
  const { phase, ...rest } = record
  await store().upsert(sipaAddress, { ...rest, phase }, { ...rest, networkId: ROLLUP })
}

/** Addresses whose send ended without a hash; the pool never hands them out again. */
const unresolved = new Set<string>()

export function nextPooledAddress(): Address {
  return unresolved.has(SIPA.toLowerCase()) ? SIPA_NEXT : SIPA
}

/** Record the unresolved send and, for `unresolved-funded`, land its transfer later as discovery would. */
export function sendUnresolved(target: Address): void {
  unresolved.add(target.toLowerCase())
  if (desktopState() !== "unresolved-funded") return
  setTimeout(() => {
    void store().upsert(target, {
      phase: "funded",
      amount: "24",
      fundingTxHash: `0x${"0d".repeat(32)}`,
      fundingFromAddress: DEMO_L1_FUNDER,
    })
  }, LATE_TRANSFER_MS)
}
