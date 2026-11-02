import { REGISTRATION_SCHEDULE_DEFAULTS } from "@obsidion/core/constants"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import { getConfig } from "../../../src/config/env"
import { getPendingStore } from "../../../src/features/onboarding/webRegistration"
import { saveRegistrationTerms } from "../../../src/features/onboarding/registrationTerms"
import { DEMO_L2_ADDRESS, DEMO_L1_TOKEN, DEMO_L1_FUNDER } from "../../../src/dev/demoFixtures"
import { SIPA, field } from "./data"

export async function seedRegistration(kind: string) {
  const kinds = ["awaiting", "free", "expired", "wrong-network", "retry", "short", "passkey-mismatch", "passkey-unavailable", "funded", "swept"]
  if (!kinds.includes(kind)) throw new Error(`Unknown registration fixture: ${kind}`)
  const fee = kind === "free" ? "0" : String(REGISTRATION_SCHEDULE_DEFAULTS.standard.fee)
  const record: PendingRegistrationRecord = {
    account: "0x00000000000000000000000000000000000000f1", tag: "demo",
    nameHash: field("11") as `0x${string}`, l2Address: DEMO_L2_ADDRESS as `0x${string}`,
    l1ChainId: getConfig().l1ChainId + (kind === "wrong-network" ? 1 : 0),
    sipaAddress: SIPA, fee, beneficiary: DEMO_L1_FUNDER, depositToken: DEMO_L1_TOKEN,
    broadcast: !["retry", "passkey-mismatch", "passkey-unavailable"].includes(kind),
    phase: kind === "funded" ? "funded" : "awaiting_deposit", retries: kind === "retry" ? 3 : 0,
    startTime: Date.now() - 6 * 60_000,
    ...(kind === "funded" ? { fundedAt: Date.now() - 60_000 } : {}),
    ...(kind === "swept" ? { sweptAt: Date.now() - 30_000 } : {}),
  }
  await getPendingStore().upsert(record.account, record, record)
  saveRegistrationTerms({
    account: record.account, tag: record.tag,
    // The reservation's end: the claim server's seven-day hold.
    deadline: Math.floor(Date.now() / 1000) + (kind === "expired" ? -60 : 7 * 86_400),
    fee,
    minDeposit: String(REGISTRATION_SCHEDULE_DEFAULTS.standard.min), feeWaived: kind === "free",
  })
}
