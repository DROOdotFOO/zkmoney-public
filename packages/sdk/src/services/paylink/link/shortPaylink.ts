import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import type { ContractService } from "@obsidion/contracts"
import type { PaylinkParams } from "../PaylinkService.js"
import { findLinkPayloads, LinkKind, linkSecret } from "./linkLocator.js"
import { linkEscrow } from "../escrow/paylinkEscrow.js"
import { decodePaylinkLocatorPayload, LINK_CLASS_REFUSAL } from "./paylinkInlineCodec.js"

/**
 * The link a short paylink's seed stands for, read from its locator log. Undefined until the create
 * tx lands. Only a payload the link's key signed opens, and only one whose escrow the announcing tx
 * initialized counts. Its terms then refuse any note but the one that create deposited.
 */
export async function resolveShortPaylink(
  deps: {
    node: Pick<AztecNode, "getPrivateLogsByTags">
    contractService: Pick<ContractService, "getArtifactForClass" | "getKnownClassIds">
  },
  seed: Uint8Array,
): Promise<PaylinkParams | undefined> {
  const secret = await linkSecret(LinkKind.Paylink, seed)
  let refused = false
  for (const found of await findLinkPayloads(
    deps.node,
    deps.contractService,
    LinkKind.Paylink,
    seed,
  )) {
    let params: PaylinkParams
    try {
      params = decodePaylinkLocatorPayload(found.bytes, secret, seed)
    } catch {
      continue
    }
    const escrow = await linkEscrow(deps.contractService, params).catch((error: unknown) => {
      if (error instanceof Error && error.message === LINK_CLASS_REFUSAL) refused = true
      return undefined
    })
    if (!escrow) continue
    const init = await computeSiloedPrivateInitializationNullifier(
      escrow.instance.address,
      escrow.instance.initializationHash,
    )
    if (found.nullifiers.some((nullifier) => nullifier.equals(init))) return params
  }
  if (refused) throw new Error(LINK_CLASS_REFUSAL)
  return undefined
}
