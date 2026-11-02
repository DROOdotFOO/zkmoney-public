import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import {
  BroadcasterContract,
  DEFAULT_CONTRACTS,
  ensureContractRegisteredInPXE,
  getBroadcasterArtifact,
  OxideTokenContract,
  type ContractService,
} from "@obsidion/contracts"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import { loadClaimFpcPolicy, registerSponsorFpc } from "../claimFpc/claimSponsor.js"

/** Bind both gates, the token and the broadcaster to one destination deployment before any signing. */
export async function metadataMigrationContext(
  wallet: ObsidionWallet,
  contracts: ContractService,
  tuple: OxideEnvTuple,
  user: AztecAddress,
) {
  const rail = async (name: string, gate: "nameClaim" | "registration") => {
    const { rail, fpcAddress } = await loadClaimFpcPolicy(contracts, name)
    if (!fpcAddress || rail.gate !== gate)
      throw new Error(`Destination ${name} sponsorship is unavailable`)
    const sponsor = {
      fpcAddress,
      fpcArtifact: await contracts.getArtifactForContract(DEFAULT_CONTRACTS.claimFpc, fpcAddress),
      railId: rail.railId,
      gate: rail.gate,
      policy: rail.policy,
    }
    return { ...sponsor, fpcArtifact: await registerSponsorFpc(wallet, sponsor), user }
  }
  const bootstrap = await rail("registration-broadcast", "nameClaim")
  const registered = await rail("registered", "registration")
  if (!tuple.l2Broadcaster) throw new Error("Destination broadcaster is missing")
  const address = AztecAddress.fromStringUnsafe(tuple.l2Broadcaster)
  const artifact = await contracts.getArtifactForInstance(address, getBroadcasterArtifact)
  await ensureContractRegisteredInPXE(wallet.pxe, wallet.node, address, () =>
    Promise.resolve(artifact),
  )
  const tokenAddress = AztecAddress.fromStringUnsafe(tuple.l2Token)
  const tokenArtifact = await contracts.getArtifactForContract(
    DEFAULT_CONTRACTS.oxideToken,
    tokenAddress,
  )
  await ensureContractRegisteredInPXE(wallet.pxe, wallet.node, tokenAddress, async () => tokenArtifact)
  return {
    bootstrap,
    registered,
    token: OxideTokenContract.at(tokenAddress, tokenArtifact, wallet),
    broadcaster: BroadcasterContract.at(address, artifact, wallet),
  }
}
