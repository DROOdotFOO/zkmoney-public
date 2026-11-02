/** A record as written: stamped with its rollup's L1 address, lowercase. Older records carry none. */
export type OnNetwork<T> = T & { networkId: string }

/** Strict, for reconcilers that rewrite a record: an unstamped record may be another network's. */
export function stampedOn(row: { networkId?: string }, networkId: string): boolean {
  return row.networkId?.toLowerCase() === networkId.toLowerCase()
}

/** Lenient, for recovery work: an unstamped record is this network's unless proved otherwise. */
export function notElsewhere(row: { networkId?: string }, networkId: string): boolean {
  return !row.networkId || stampedOn(row, networkId)
}
