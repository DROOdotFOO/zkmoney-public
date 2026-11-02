import type { Contact, RegistryTagResolution } from "@obsidion/front-core"
import { MAX_TAG_LENGTH } from "@obsidion/core/constants"
import type { MintMyCodeDeps } from "../features/contacts/myCode"
import { demoScenario } from "./demoFlag"
import { demoContacts } from "./demoFixtures"

/** A tag at the length limit, still on a retired rollup. */
export const LONG_STALE_TAG = "mslongtag".padEnd(MAX_TAG_LENGTH, "x")

let retryVerification = 0
let mintAttempts = 0
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

export function longDemoContacts(): Contact[] {
  return [
    ...demoContacts(),
    {
      name: "Alexandria's long contact identity",
      address: `0x${"19".repeat(32)}`,
      tag: "alexandria".padEnd(MAX_TAG_LENGTH, "a"),
    },
    { name: LONG_STALE_TAG, address: `0x${"1a".repeat(32)}`, tag: LONG_STALE_TAG },
    {
      name: "Savings wallet shared with the household for long-term expenses",
      address: `0x${"19".repeat(20)}`,
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "rainbow", provenance: "saved-recipient", userLabeled: true },
    },
    ...Array.from(
      { length: 18 },
      (_, i): Contact => ({
        name: `Contact ${i + 1}`,
        tag: `friend${i + 1}`,
        address: `0x${(100 + i).toString(16).padStart(64, "0")}`,
      }),
    ),
  ]
}

/** Local registry responses; persistence and fresh-verification decisions remain real. */
export async function demoContactResolution(
  tag: string,
  fresh: boolean,
): Promise<RegistryTagResolution> {
  await wait(tag === "slowfriend" ? 2200 : fresh ? 900 : 450)
  if (fresh && tag === "retryfriend" && retryVerification++ === 0)
    throw new Error("Demo verification unavailable")
  if (tag === "dmitri" || tag === LONG_STALE_TAG) return { status: "staleRollup" }
  if (!["newfriend", "slowfriend", "retryfriend", "mismatchfriend"].includes(tag))
    return { status: "notFound" }
  return {
    status: "resolved",
    account: "0x00000000000000000000000000000000000000aa",
    l2Address: `0x${(fresh && tag === "mismatchfriend" ? "16" : "17").repeat(32)}`,
    rollupId: "1",
    sipaStealthPublicKey: { x: 1n, y: 2n },
    xmtpAddress: "0x00000000000000000000000000000000000000b0",
  }
}

/** Deterministic inputs to the real mint/codec, with an optional recoverable failure. */
export async function prepareDemoConnectMint(deps: MintMyCodeDeps): Promise<MintMyCodeDeps> {
  await wait(700)
  const attempt = ++mintAttempts
  if (demoScenario() === "share-retry" && attempt === 1) throw new Error("Demo mint unavailable")
  return {
    ...deps,
    ...(demoScenario() === "share-long"
      ? {
          ownTag: "a".repeat(MAX_TAG_LENGTH),
          origin: `https://${"preview".repeat(9)}.${"branch".repeat(10)}.zk.money`,
        }
      : {}),
    uuid: () => `00000000-0000-4000-8000-${attempt.toString(16).padStart(12, "0")}`,
  }
}
