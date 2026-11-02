import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { createLogger } from "@aztec-labs/foundation/log"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import { derivePublicKeyFromSecretKey, hashPublicKey } from "@aztec-labs/stdlib/keys"
import type { ContractName, ContractService } from "@obsidion/contracts"
import { deriveRefundOwnerAddress, type RefundOwner } from "@oxide/oxide-lib/migration_signature.js"
import type { ObsidionWallet } from "../../../obsidion/ObsidionWallet.js"
import type { FrozenEscrow } from "../../migration/FrozenRefundMigrationRuntime.js"
import type { CreatedPaylinkParams, PaylinkService } from "../PaylinkService.js"
import type { TransferEventSource } from "../../token/transferEventSource.js"
import { registerEscrow } from "./escrowRegistration.js"
import { derivePaylinkFallbackSecretKey, type PaylinkKeyMaterial } from "./paylinkKeys.js"
import { makePaylinkSpendMetadataResolver } from "../claim/paylinkSpendMetadata.js"

const log = createLogger("wallet-sdk:frozen-escrows")

/**
 * A link's escrow as a refund owner, or undefined when the fallback secret or keys don't derive it.
 * Its address commits to no passkey, so the creator signs the refund with the fallback key: no
 * prompt.
 */
export async function paylinkRefundOwner(
  instance: ContractInstanceWithAddress,
  keys: PaylinkKeyMaterial,
  fallbackSecret: Fr,
): Promise<RefundOwner | undefined> {
  const fbskM = derivePaylinkFallbackSecretKey(fallbackSecret)
  const fallbackKey = await derivePublicKeyFromSecretKey(fbskM)
  if (!(await hashPublicKey(fallbackKey)).equals(keys.fallbackKeyHash)) return
  const owner: RefundOwner = {
    address: instance.address,
    publicKeys: keys.publicKeys,
    instance: {
      contractClassId: instance.originalContractClassId,
      salt: instance.salt,
      initializationHash: instance.initializationHash,
      deployer: instance.deployer,
    },
    signer: { kind: "fallbackKey", fbskM },
  }
  if (!(await deriveRefundOwnerAddress(owner)).equals(instance.address)) return
  return owner
}

/**
 * The account's payment link escrows on a source rollup, registered in its wallet. Links come from the
 * funding transfers the account sent, whose created lane the master secret recovers, and from `hints`
 * for links with no lane (bring-your-own keys). A link whose own material does not rebuild its escrow
 * is skipped, as the rescan skips one: no retry can refund it. A failed read throws, so a scan is never
 * partial. A link neither one names is not found.
 */
export async function discoverFrozenEscrows(o: {
  /** Bound to the source rollup's wallet and the account. */
  paylinkService: Pick<PaylinkService, "recoverPaylinkFromTransfer">
  /** The source rollup's wallet and contracts, which rebuild and register each escrow. */
  escrows: { wallet: ObsidionWallet; contractService: ContractService }
  events: Pick<TransferEventSource, "headBlock" | "listIncoming">
  account: AztecAddress
  masterSecret: Fr
  hints: CreatedPaylinkParams[]
}): Promise<FrozenEscrow[]> {
  const me = o.account.toString().toLowerCase()
  const head = await o.events.headBlock()
  // What the escrow address derives from.
  const escrowKey = (link: CreatedPaylinkParams) =>
    [link.secret, link.fallbackKeyHash, link.classId].map(String).join(":")
  // Every copy of each link, its lane first: a bad copy must not hide a good one.
  const copies = new Map<string, CreatedPaylinkParams[]>()
  const add = (link: CreatedPaylinkParams) =>
    copies.set(escrowKey(link), [...(copies.get(escrowKey(link)) ?? []), link])
  for (const event of await o.events.listIncoming(1, head + 1)) {
    if (!event.paylinkCreated || event.from.toLowerCase() !== me) continue
    const link = await o.paylinkService.recoverPaylinkFromTransfer(event, o.masterSecret)
    if (link) add(link)
    else log.warn(`the link ${event.txHash} funded does not rebuild its escrow`)
  }
  o.hints.forEach(add)
  const escrows: FrozenEscrow[] = []
  for (const links of copies.values()) {
    let escrow: FrozenEscrow | undefined
    for (const link of links) {
      escrow = await frozenEscrow(o.escrows, link)
      if (escrow) break
    }
    if (escrow) escrows.push(escrow)
    else log.warn("a payment link's own material does not rebuild its escrow")
  }
  return escrows
}

/** The link's escrow, registered, or undefined when the link's own material can never register it. */
async function frozenEscrow(
  deps: { wallet: ObsidionWallet; contractService: ContractService },
  link: CreatedPaylinkParams,
): Promise<FrozenEscrow | undefined> {
  const classes = await deps.contractService.getKnownClassIds(link.paylinkType as ContractName)
  if (!classes.includes(link.classId.toString())) return
  // PXE refuses a zero or off-curve tag secret.
  const tag = link.escrowTagSecret
  if (tag && (tag.isZero() || !tag.isOnCurve())) return
  const { instance, keys } = await registerEscrow(deps, link)
  const owner = await paylinkRefundOwner(instance, keys, link.fallbackSecret)
  if (!owner) return
  return {
    owner,
    // Each frozen note spends with the transaction that created it, which a later transfer to the
    // escrow does not share with the link's deposit.
    resolveSpendMetadata: makePaylinkSpendMetadataResolver(instance, undefined, keys),
  }
}
