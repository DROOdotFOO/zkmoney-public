/**
 * A link's escrow in this PXE, set up once per page. Every paylink read and claim needs the escrow
 * registered with its keys, its tag sender and its tag secret; the registration is idempotent but
 * not cheap (a tag secret clears the PXE's contract-sync cache), and a PXE refuses two registrations
 * of one contract at once. One shared promise per wallet and link covers both.
 */
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import type { ContractService } from "@obsidion/contracts"
import type { ObsidionWallet } from "../../../obsidion/ObsidionWallet.js"
import { linkChainInfo } from "../../claimFpc/claimSponsor.js"
import type { PaylinkParams } from "../PaylinkService.js"
import { linkEscrow } from "./paylinkEscrow.js"
import { assertLinkChain } from "../link/paylinkInlineCodec.js"
import {
  registerEscrowTagSecret,
  registerPaylinkContractWithKeys,
  type PaylinkKeyMaterial,
} from "./paylinkKeys.js"
import type { PaylinkNoteView } from "./paylinkNoteData.js"
import { findEscrowDepositTx } from "./paylinkRecovery.js"

export interface RegisteredEscrow {
  instance: ContractInstanceWithAddress
  keys: PaylinkKeyMaterial
  artifact: ContractArtifact
}

type EscrowDeps = { wallet: ObsidionWallet; contractService: ContractService }

const registrations = new WeakMap<object, Map<string, Promise<RegisteredEscrow>>>()
const deposits = new WeakMap<object, Map<string, Awaited<ReturnType<typeof findEscrowDepositTx>>>>()
const noteReads = new WeakMap<object, Map<string, Promise<PaylinkNoteView>>>()

/** The wallet's own entries; a wallet that is not an object keeps none. */
function scoped<V>(store: WeakMap<object, Map<string, V>>, wallet: unknown): Map<string, V> {
  if (typeof wallet !== "object" || wallet === null) return new Map()
  let byKey = store.get(wallet)
  if (!byKey) store.set(wallet, (byKey = new Map()))
  return byKey
}

function linkKey(params: PaylinkParams): string {
  return [
    params.paylinkType,
    params.classId,
    params.secret,
    params.fallbackKeyHash,
    params.chainId,
    params.rollupVersion,
    params.escrowTagSecret ?? "",
  ]
    .map(String)
    .join("|")
}

async function register(deps: EscrowDeps, params: PaylinkParams): Promise<RegisteredEscrow> {
  const { artifact, keys, instance } = await linkEscrow(deps.contractService, params)
  assertLinkChain(params, await linkChainInfo(deps.wallet))
  await registerPaylinkContractWithKeys({
    wallet: deps.wallet,
    instance,
    artifact,
    keyMaterial: keys,
  })
  // The escrow tags its own notes, the voucher and the PaylinkNote included, so it is its own
  // sender here. PXE skips it when the escrow is already a local account.
  await deps.wallet.registerSender(instance.address)
  // Old links only: the escrow note is tagged from a creator this PXE does not know.
  if (params.escrowTagSecret) {
    await registerEscrowTagSecret({
      wallet: deps.wallet,
      escrow: instance.address,
      secret: params.escrowTagSecret,
    })
  }
  return { instance, keys, artifact }
}

/**
 * Rebuild the escrow from the link and give this PXE its keys, its tag and its sender: once per
 * wallet and link, shared by concurrent callers. A failed registration is tried again next call.
 */
export function registerEscrow(deps: EscrowDeps, params: PaylinkParams): Promise<RegisteredEscrow> {
  const byKey = scoped(registrations, deps.wallet)
  const key = linkKey(params)
  const known = byKey.get(key)
  if (known) return known
  const pending = register(deps, params)
  byKey.set(key, pending)
  pending.catch(() => {
    if (byKey.get(key) === pending) byKey.delete(key)
  })
  return pending
}

/** The escrow's funding tx, remembered once found: it never changes. Undefined until mined. */
export async function escrowDepositTx(
  wallet: ObsidionWallet,
  instance: Pick<ContractInstanceWithAddress, "address" | "initializationHash">,
): Promise<Awaited<ReturnType<typeof findEscrowDepositTx>>> {
  const byKey = scoped(deposits, wallet)
  const key = instance.address.toString()
  const known = byKey.get(key)
  if (known) return known
  const found = await findEscrowDepositTx(wallet.node, instance)
  if (found) byKey.set(key, found)
  return found
}

/** One `sync_note` simulation per escrow at a time: overlapping reads share it. */
export function sharedNoteRead(
  wallet: unknown,
  escrow: { toString(): string },
  read: () => Promise<PaylinkNoteView>,
): Promise<PaylinkNoteView> {
  const byKey = scoped(noteReads, wallet)
  const key = escrow.toString()
  const inFlight = byKey.get(key)
  if (inFlight) return inFlight
  const pending = read().finally(() => {
    if (byKey.get(key) === pending) byKey.delete(key)
  })
  byKey.set(key, pending)
  return pending
}
