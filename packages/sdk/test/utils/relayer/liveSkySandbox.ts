/** The sandbox's DAI and Sky savings bridges, from the Sky feature of the manifest it serves, with read-only L1 checks. */
import { createPublicClient, erc20Abi, http, type Address } from "viem"
import { foundry } from "viem/chains"
import { featureBridge, oxideManifestEntries, pinnedOxideDeployment } from "@obsidion/core/oxide"

export async function liveSkySandbox() {
  const url = process.env.OXIDE_MANIFEST_URL ?? "http://localhost:8083/oxide/sandbox.json"
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Sandbox manifest ${url}: HTTP ${response.status}`)
  const manifest = await response.json()
  const entries = oxideManifestEntries(manifest) as { portal: string }[]
  const { deployment } = pinnedOxideDeployment(manifest, {
    portal: process.env.OXIDE_PORTAL ?? entries.at(-1)!.portal,
  })
  const feature = deployment.features?.find((f) => f.project === "sky")
  if (!feature)
    throw new Error(
      "The sandbox deployment lists no Sky feature; bring the sandbox up from this branch",
    )
  const daiBridge = featureBridge(deployment, feature, "dai")
  const skyBridge = featureBridge(deployment, feature, "sUsds")
  if (!daiBridge || !skyBridge)
    throw new Error(`Sky feature ${feature.id} binds no DAI or sUSDS bridge`)
  const dai = daiBridge.tuple
  const sky = skyBridge.tuple
  if (!dai.l2Broadcaster || !sky.l2Broadcaster)
    throw new Error("Sandbox manifest has no L2 broadcaster")
  const factory = feature.contracts.skyEscrowFactory as Address
  const skyExecutor = feature.contracts.skyWithdrawalExecutor as Address
  const client = createPublicClient({
    chain: foundry,
    transport: http(process.env.L1_RPC_URL ?? "http://localhost:8545"),
  })
  const balance = (token: Address, holder: Address) =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    })
  return { dai, sky, factory, skyExecutor, sUsds: skyBridge.underlying as Address, client, balance }
}
