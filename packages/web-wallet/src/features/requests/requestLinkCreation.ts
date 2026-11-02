import type { Address } from "viem"
import {
  mintableOrigin,
  mintRequestLink,
  sipaDeploymentTag,
  sipaLinkPreimage,
  SIPADepositStore,
  type MintedRequestLink,
  type MintRequestLinkArgs,
  type StoredRequest,
  type SipaOrigin,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

/** Request links land on this deploy's pay page, unless a scanner would refuse its origin. */
export function requestLinkOrigin(): string {
  return mintableOrigin(location.origin, getConfig().network)
}

export interface RequestLinkStore {
  add(row: StoredRequest): Promise<void>
}

/** What this wallet recorded when it derived `sipa`. */
async function recordedSipaOrigin(sipa: string): Promise<SipaOrigin | undefined> {
  const deposits = SIPADepositStore.get(webStorage)
  await deposits.load()
  return deposits.get(sipa as Address)?.origin
}

/**
 * Persist the fulfilled-signal join row before exposing the shareable URL. A link with an address
 * carries its preimage, and a code its deployment tag, so a payer can check it against the active
 * deployment.
 */
export async function createAndStoreRequestLink(
  input: MintRequestLinkArgs,
  store: RequestLinkStore,
  originOf: (sipa: string) => Promise<SipaOrigin | undefined> = recordedSipaOrigin,
): Promise<MintedRequestLink> {
  const origin = input.sipaAddress ? await originOf(input.sipaAddress) : undefined
  const minted = mintRequestLink({
    ...input,
    sipaPreimage: input.sipaPreimage ?? (origin && sipaLinkPreimage(origin)),
    sipaDeployment: input.sipaDeployment ?? (origin && sipaDeploymentTag(origin)),
  })
  await store.add(minted.row)
  return minted
}
