/**
 * What a SIPA's sweep of one token deposits into: the portal its forwarding-table row names, the fee taken off the
 * balance, and the portal's per-transaction cap. The table owner can change a row, so a caller re-reads the terms
 * rather than keeping them for the life of a deposit.
 */
import type { Address, PublicClient } from "viem"
import { OxidePortalAbi, readForwardingTableRow, type SipaIntent } from "@oxide/l1-contracts"

/** The forwarding-table row a sweep routes through. */
export interface SipaRoute {
  forwardingTable: Address
  /** The token the sweep settles in: the row's key. */
  token: Address
  intent: SipaIntent
}

export interface SipaPortalTerms {
  /** The row's portal. */
  portal: Address
  /** The portal's settlement token. */
  token: Address
  /** The row's sweep tip plus its beneficiary fee: taken off every sweep. */
  depositFee: bigint
  /** The portal's `TX_AMOUNT_CAP()`: the most one sweep may deposit. */
  txAmountCap: bigint
}

export async function readSipaPortalTerms(
  client: PublicClient,
  route: SipaRoute,
): Promise<SipaPortalTerms> {
  const row = await readForwardingTableRow(
    client as never,
    route.forwardingTable,
    route.token,
    route.intent,
  )
  if (!row) {
    throw new Error(
      `Forwarding table ${route.forwardingTable} routes no sweep of ${route.token} for this intent`,
    )
  }
  const txAmountCap = await client.readContract({
    address: row.portal,
    abi: OxidePortalAbi,
    functionName: "TX_AMOUNT_CAP",
  })
  return {
    portal: row.portal,
    token: route.token,
    depositFee: row.sweepTip + row.beneficiaryFee,
    txAmountCap,
  }
}
