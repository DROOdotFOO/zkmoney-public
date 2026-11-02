/**
 * The pinned deployment's forwarding-table rows, read off L1. The table owner can change a row at any time, so a
 * caller re-reads the table rather than keeping it for the life of a deposit.
 */
import type { Address, PublicClient } from "viem"
import { OxidePortalAbi, readForwardingTableRow, SipaIntent } from "@oxide/l1-contracts"
import {
  SIPA_INTENT_NAMES,
  type OxideBridge,
  type OxideDeployment,
  type OxideDeploymentTable,
  type OxideRowTerms,
  type OxideTableRow,
  type SipaIntentName,
} from "@obsidion/core/oxide"

const SIPA_INTENTS: Record<SipaIntentName, SipaIntent> = {
  "deposit": SipaIntent.Deposit,
  "registration": SipaIntent.Registration,
  "user-op": SipaIntent.UserOp,
}

/** The factory intent of a row intent. */
export function sipaIntentOf(intent: SipaIntentName): SipaIntent {
  return SIPA_INTENTS[intent]
}

/**
 * Every token's row: each intent's terms and the portal's cap. Bridges sharing a token are candidates for its row, and
 * the portal the row names picks one. A token the table lists for no intent has no row, and neither has one it routes
 * to a portal no candidate names: the manifest and the table disagree, and offering it would sweep into a portal no
 * bridge names. A failed read still throws.
 */
export async function readDeploymentTable(
  client: PublicClient,
  deployment: OxideDeployment,
): Promise<OxideDeploymentTable> {
  if (!deployment.forwardingTable) {
    throw new Error(`Deployment ${deployment.label} publishes no forwarding table`)
  }
  const forwardingTable = deployment.forwardingTable as Address
  const candidates = new Map<string, OxideBridge[]>()
  for (const bridge of deployment.bridges) {
    const token = bridge.underlying.toLowerCase()
    candidates.set(token, [...(candidates.get(token) ?? []), bridge])
  }
  const read = await Promise.all(
    [...candidates.values()].map((bridges) => readTokenRow(client, forwardingTable, bridges)),
  )
  const rows = read.flatMap((entry) => (entry ? [entry.row] : []))
  const beneficiary = read.find((entry) => entry?.beneficiary)?.beneficiary
  return { deployment, rows, ...(beneficiary ? { beneficiary } : {}) }
}

async function readTokenRow(
  client: PublicClient,
  forwardingTable: Address,
  candidates: readonly OxideBridge[],
): Promise<{ row: OxideTableRow; beneficiary: Address } | undefined> {
  const token = candidates[0]!.underlying
  const reads = await Promise.all(
    SIPA_INTENT_NAMES.map((intent) =>
      readForwardingTableRow(
        client as never,
        forwardingTable,
        token as Address,
        SIPA_INTENTS[intent],
      ),
    ),
  )
  const routed = reads.flatMap((row) => (row ? [row] : []))
  if (!routed.length) return undefined
  const bridge = candidates.find((candidate) =>
    routed.every((row) => row.portal.toLowerCase() === candidate.portal.toLowerCase()),
  )
  if (!bridge) {
    const names = candidates.map((candidate) => candidate.key ?? candidate.portal).join(", ")
    const portal = routed[0]!.portal
    console.warn(
      `Forwarding table ${forwardingTable} routes ${token} to ${portal}, not to bridge ${names}; the token is left out`,
    )
    return undefined
  }
  const intents: Partial<Record<SipaIntentName, OxideRowTerms>> = {}
  for (const [i, intent] of SIPA_INTENT_NAMES.entries()) {
    const row = reads[i]
    if (row) intents[intent] = { sweepTip: row.sweepTip, beneficiaryFee: row.beneficiaryFee }
  }
  const txAmountCap = await client.readContract({
    address: bridge.portal as Address,
    abi: OxidePortalAbi,
    functionName: "TX_AMOUNT_CAP",
  })
  return { row: { bridge, intents, txAmountCap }, beneficiary: routed[0]!.beneficiary }
}
