import type { createAztecNodeClient } from "@aztec-labs/aztec.js/node"

// The canonical generation's node client — the one the wallet built at boot
// (createV4BootWallet for a v4 generation, createAztecNodeClient for v5). Any
// front-core node-RPC caller must use THIS, never a fresh
// createAztecNodeClient(nodeUrl): a v4 generation's node answers only `node_*`
// RPC while the v5 client speaks `aztec_*`, so a fresh v5 client fails
// against a v4 node ("Method not found: aztec_getBlock"). Set once the wallet
// boots (the page wallet's build); mirrors setNoircGeneration /
// setHonkGeneration. Callers fall back / no-op when it is unset (pre-boot).
type GenerationNode = ReturnType<typeof createAztecNodeClient>

let activeNode: GenerationNode | undefined

export function setActiveGenerationNode(node: GenerationNode | undefined): void {
  activeNode = node
}

export function getActiveGenerationNode(): GenerationNode | undefined {
  return activeNode
}
