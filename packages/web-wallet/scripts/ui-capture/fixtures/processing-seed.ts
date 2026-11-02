import { SIPADepositStore } from "@obsidion/front-core"
import type { Address } from "viem"
import { getConfig } from "../../../src/config/env"
import { getPendingStore } from "../../../src/features/onboarding/webRegistration"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { DEMO_L1_TOKEN, DEMO_L2_ADDRESS } from "../../../src/dev/demoFixtures"
import { seedRegistration } from "./registration-seed"
import { ROLLUP, SIPA, field } from "./data"
import { DEMO_ORIGIN } from "./processing-origin"

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
const CONVERSION_SIPA = "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0" as Address

/**
 * `?processingFixture=<kind>` adds the pending deposits the demo scenarios lack:
 * - `conversion`: a USDC deposit funded half a minute ago that a relayer has not swept yet;
 * - `earned-sweep`: an earned registration whose one-shot broadcast was spent on the refunded address, funded and
 *   waiting for its manual sweep.
 */
export async function seedProcessing(kind: string) {
  const deposits = SIPADepositStore.get(webStorage)
  await deposits.load()
  const { l1ChainId } = getConfig()
  const base = {
    recipientL2Address: DEMO_L2_ADDRESS,
    messageSecret: field("0d"),
    recipientHash: field("0e"),
    recoveryAddress: DEMO_ORIGIN.protocol === "legacy-eoa" ? DEMO_ORIGIN.recoveryAddress : "",
    origin: DEMO_ORIGIN,
    l1ChainId,
    networkId: ROLLUP,
  }
  if (kind === "conversion") {
    await deposits.upsert(
      CONVERSION_SIPA,
      { phase: "sweeping" },
      {
        ...base,
        amount: "250",
        tokenSymbol: "USDC",
        tokenAddress: MAINNET_USDC,
        tokenDecimals: 6,
        startTime: Date.now() - 30_000,
      },
    )
    return
  }
  if (kind === "earned-sweep") {
    await seedRegistration("awaiting")
    const pending = getPendingStore()
    const record = pending.current()!
    await pending.upsert(record.account, {
      ...record,
      broadcast: false,
      fundedAt: Date.now() - 5 * 60_000,
      replaced: { sipaAddress: field("0f").slice(0, 42), refunded: true, broadcastSpent: true },
    })
    await deposits.upsert(
      SIPA,
      { phase: "sweeping" },
      {
        ...base,
        amount: "10",
        tokenSymbol: "DAI",
        tokenAddress: DEMO_L1_TOKEN,
        tokenDecimals: 18,
        intent: "registration",
        registrationFee: record.fee ?? "0",
        startTime: Date.now() - 6 * 60_000,
      },
    )
    return
  }
  throw new Error(`Unknown processing fixture: ${kind}`)
}
