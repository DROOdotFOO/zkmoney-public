import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import {
  computeContractAddressFromInstance,
  type ContractInstanceWithAddress,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/stdlib/contract"
import { type ContractService, DEFAULT_CONTRACTS, type ContractName } from "@obsidion/contracts"
import type { PaylinkParams } from "../PaylinkService.js"
import { assertLinkClass, LINK_CLASS_REFUSAL } from "../link/paylinkInlineCodec.js"
import { derivePaylinkKeys, type PaylinkKeyMaterial } from "./paylinkKeys.js"

export type PaylinkFlavor = "direct" | "email"

export function paylinkTypeOf(flavor: PaylinkFlavor): ContractName {
  return flavor === "email" ? DEFAULT_CONTRACTS.paylinkEmail : DEFAULT_CONTRACTS.paylinkDirect
}

/**
 * The escrow a secret and fallback key hash derive under the flavor's current class: salt 0, no
 * initializer, so the address is a pure function of the class and the keys. What a transfer's
 * paylink lane is checked against.
 */
export async function paylinkEscrowInstance(
  contractService: Pick<ContractService, "getArtifactForContract">,
  flavor: PaylinkFlavor,
  secret: Fr,
  fallbackKeyHash: Fr,
): Promise<ContractInstanceWithAddress> {
  const artifact = await contractService.getArtifactForContract(paylinkTypeOf(flavor))
  const keys = await derivePaylinkKeys({ secretKey: secret, fallbackKeyHash })
  return getContractInstanceFromInstantiationParams(artifact, {
    salt: new Fr(0n),
    publicKeys: keys.publicKeys,
  })
}

/** The same keys' escrow under each of `classIds`, `instance` itself first. */
export async function escrowInstancesForClasses(
  instance: ContractInstanceWithAddress,
  classIds: string[],
): Promise<ContractInstanceWithAddress[]> {
  const { address: _, ...fields } = instance
  const own = instance.currentContractClassId.toString()
  const others = await Promise.all(
    classIds
      .filter((id) => id !== own)
      .map(async (id) => {
        const classId = Fr.fromHexString(id)
        const swapped = {
          ...fields,
          currentContractClassId: classId,
          originalContractClassId: classId,
        }
        return { ...swapped, address: await computeContractAddressFromInstance(swapped) }
      }),
  )
  return [instance, ...others]
}

/** {@link escrowInstancesForClasses} over every class the flavor has had in this deployment. */
export async function escrowInstancesForKnownClasses(
  contractService: Pick<ContractService, "getKnownClassIds">,
  paylinkType: ContractName,
  instance: ContractInstanceWithAddress,
): Promise<ContractInstanceWithAddress[]> {
  return escrowInstancesForClasses(instance, await contractService.getKnownClassIds(paylinkType))
}

/**
 * The escrow a link addresses, under the class the link carries: the bundled artifact when it is
 * that class, else the reviewed historical one. A class this deployment never reviewed is refused.
 */
export async function linkEscrow(
  contractService: Pick<ContractService, "getArtifactForClass" | "getKnownClassIds">,
  params: Pick<PaylinkParams, "paylinkType" | "classId" | "secret" | "fallbackKeyHash">,
): Promise<{
  artifact: ContractArtifact
  keys: PaylinkKeyMaterial
  instance: ContractInstanceWithAddress
}> {
  const paylinkType = params.paylinkType as ContractName
  const classId = params.classId.toString()
  const artifact = await contractService
    .getArtifactForClass(classId, paylinkType)
    .catch(async (error: unknown) => {
      if ((await contractService.getKnownClassIds(paylinkType)).includes(classId)) throw error
      throw new Error(LINK_CLASS_REFUSAL)
    })
  const keys = await derivePaylinkKeys({
    secretKey: params.secret,
    fallbackKeyHash: params.fallbackKeyHash,
  })
  const instance = await getContractInstanceFromInstantiationParams(artifact, {
    salt: new Fr(0n),
    publicKeys: keys.publicKeys,
  })
  assertLinkClass(params, instance)
  return { artifact, keys, instance }
}
