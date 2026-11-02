import { publishContractClass } from "@aztec-labs/aztec.js/deployment"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import {
  DEFAULT_CONTRACTS,
  getHardcodedArtifact,
  getBroadcasterArtifact,
} from "@obsidion/contracts"
import { getClaimFPCArtifact } from "../utils/claimFpc/claimFpcFixture.js"
import { getTokenArtifact, setupTest } from "../utils/helper.js"

/**
 * Publishes the classes that sandbox files deploy before their workers start. Files running side
 * by side would otherwise race to publish the same class, and all but the first fail on its
 * nullifier; a deploy skips publication once the class is public.
 */
export default async function publishSandboxClasses() {
  const { wallet, accounts, sponsoredFeePaymentMethod } = await setupTest()
  const artifacts = [
    await getTokenArtifact(),
    await getClaimFPCArtifact(),
    await getHardcodedArtifact(DEFAULT_CONTRACTS.oxideToken),
    await getHardcodedArtifact(DEFAULT_CONTRACTS.oidcKeyRegistry),
    await getBroadcasterArtifact(),
  ]
  for (const artifact of artifacts) {
    const { id } = await getContractClassFromArtifact(artifact)
    if ((await wallet.getContractClassMetadata(id)).isContractClassPubliclyRegistered) continue
    await (
      await publishContractClass(wallet, artifact)
    ).send({ from: accounts[0]!.getAddress(), fee: { paymentMethod: sponsoredFeePaymentMethod } })
  }
}
