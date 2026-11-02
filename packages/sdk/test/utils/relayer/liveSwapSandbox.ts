/** Read-only L1 assertions shared by the SDK and browser relayer tests. */
import { createPublicClient, http, erc20Abi, type Address } from "viem"
import { foundry } from "viem/chains"
import { SwapEscrowAbi, SwapEscrowFactoryAbi } from "@oxide/l1-contracts"
import { extractPinnedOxideEnvTuple, oxideManifestEntries } from "@obsidion/core/oxide"

export async function liveSwapSandbox() {
  const url = process.env.OXIDE_MANIFEST_URL ?? "http://localhost:8083/oxide/sandbox.json"
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Sandbox manifest ${url}: HTTP ${response.status}`)
  const manifest = await response.json()
  const portal =
    process.env.OXIDE_PORTAL ?? (oxideManifestEntries(manifest).at(-1)?.portal as string)
  if (!portal)
    throw new Error(
      "Expected a current sandbox manifest with a deployments array; rebuild the sandbox from this branch",
    )
  const { tuple } = extractPinnedOxideEnvTuple(manifest, { portal })
  const client = createPublicClient({
    chain: foundry,
    transport: http(process.env.L1_RPC_URL ?? "http://localhost:8545"),
  })
  if ((await client.getChainId()) !== foundry.id)
    throw new Error("Expected the local Anvil sandbox")
  if (!tuple.l2Broadcaster) throw new Error("Sandbox manifest has no L2 broadcaster")
  const addresses = {
    portal: tuple.portal as Address,
    token: tuple.token as Address,
    broadcaster: tuple.l2Broadcaster,
  }
  const factory = tuple.swapEscrowFactoryV2 as Address
  if (!factory) throw new Error("Sandbox manifest has no swap escrow factory")
  const implementation = (await client.readContract({
    address: factory,
    abi: SwapEscrowFactoryAbi,
    functionName: "IMPLEMENTATION",
  })) as Address
  const usdc = (await client.readContract({
    address: implementation,
    abi: SwapEscrowAbi,
    functionName: "USDC",
  })) as Address
  const balance = (token: Address, holder: Address) =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    })
  return { tuple, ...addresses, client, factory, usdc, balance }
}
