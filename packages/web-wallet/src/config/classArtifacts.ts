import {
  type createClassArtifactResolver,
  DEFAULT_CONTRACTS,
  ensureContractRegisteredInPXE,
  getBroadcasterArtifact,
  OxideTokenContract,
  resolveInstanceArtifact,
  type ContractService,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"

export type WebClassArtifactResolver = ReturnType<typeof createClassArtifactResolver>

let resolveWebClassArtifact: WebClassArtifactResolver | undefined

export function setWebClassArtifactResolver(resolve: WebClassArtifactResolver): void {
  resolveWebClassArtifact = resolve
}

/** `instance`: the broadcaster's on-chain instance when the caller already read it. */
export function getWebBroadcasterArtifact(
  wallet: ObsidionWallet,
  address: string | AztecAddress,
  instance?: { currentContractClassId: { toString(): string } },
) {
  if (!resolveWebClassArtifact) return getBroadcasterArtifact()
  return resolveInstanceArtifact(
    instance ? { getContract: async () => instance } : wallet.node,
    typeof address === "string" ? AztecAddress.fromStringUnsafe(address) : address,
    getBroadcasterArtifact,
    resolveWebClassArtifact,
  )
}

/** The deployment's L2 token, registered in this PXE: it sends a SIPA's `SIPA` event. */
export async function getWebOxideToken(
  wallet: ObsidionWallet,
  contractService: Pick<ContractService, "getArtifactForContract">,
  l2Token: string,
): Promise<OxideTokenContract> {
  const address = AztecAddress.fromStringUnsafe(l2Token)
  const artifact = await contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.oxideToken,
    address,
  )
  await ensureContractRegisteredInPXE(wallet.pxe, wallet.node, address, async () => artifact)
  return OxideTokenContract.at(address, artifact, wallet as never)
}
