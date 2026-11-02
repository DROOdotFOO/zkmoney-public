/** Registers resolver senders and the Broadcaster so a PXE can discover SIPA notifications. */

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import type { Address, PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  type Network,
  ensureContractRegisteredInPXE,
  fetchHistoricalSipaResolverOperators,
  getBroadcasterArtifact,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  type SipaResolverOperatorRecord,
} from "@obsidion/sdk"
import { deploymentScanRange } from "./deploymentScanRange"
import { readResolverOperatorRecords } from "./resolverOperatorRecords"

/** The narrow PXE surface the setup drives. Registration shape is per-generation:
 * the 4.3.0 PXE takes the combined `{ instance, artifact }`, the v5 PXE splits
 * class and instance registration. */
export interface SipaDiscoveryPxe {
  /** 4.3.0 sender registration; the v5 PXE replaced it with registerTaggingSecretSource. */
  registerSender?(sender: AztecAddress): Promise<unknown>
  registerTaggingSecretSource?(source: {
    kind: "address-derived"
    sender: AztecAddress
  }): Promise<unknown>
  registerContractClass(artifact: ContractArtifact): Promise<unknown>
  registerContract(
    contract:
      | ContractInstanceWithAddress
      | { instance: ContractInstanceWithAddress; artifact: ContractArtifact },
  ): Promise<unknown>
  getContractInstance?(address: AztecAddress): Promise<unknown>
  getContractArtifact?(classId: unknown): Promise<unknown>
}

/** The narrow node surface the setup drives. */
export interface SipaDiscoveryNode {
  getContract(address: AztecAddress): Promise<ContractInstanceWithAddress | undefined>
}

export interface SipaDiscoverySetup {
  /** The selected resolver-operator record (l2Address = the registered sender). */
  resolver: SipaResolverOperatorRecord
  /** The registered Broadcaster address (= the manifest `l2Broadcaster`). */
  broadcaster: AztecAddress
}

/**
 * Wire SIPA event discovery into the PXE against the resolved oxide env tuple.
 * Idempotent: `registerSender` / `registerContract` are PXE upserts, so
 * re-running on a later boot is safe.
 */
export async function setupSipaDiscovery(deps: {
  pxe: SipaDiscoveryPxe
  node: SipaDiscoveryNode
  publicClient: PublicClient
  tuple: OxideEnvTuple
  network: Network
  /** Recovers all historical senders for the tuple's deployment. */
  historical?: boolean
  /**
   * The ClaimFPC that sponsors this wallet's own broadcasts. Sponsored calls run with the FPC as
   * `msg_sender`, so the events they emit are tagged with it — a PXE that did not emit them locally
   * discovers them only once the FPC is a registered sender.
   */
  artifactFor?: (address: AztecAddress) => Promise<ContractArtifact>
  sponsorFpc?: AztecAddress
  /**
   * Upper bound for the operator scan. A caller running several scans over one deployment passes
   * the head it bounded the others by, so one pass reports against one tip; absent, the head is
   * read here.
   */
  scanHead?: bigint
}): Promise<SipaDiscoverySetup> {
  const { pxe, node, publicClient, tuple, network } = deps
  const { accountMetadataRegistry, portal, l2Broadcaster } = tuple
  if (!accountMetadataRegistry || !portal || !l2Broadcaster) {
    throw new Error(
      "oxide manifest lacks the SIPA surface " +
        "(accountMetadataRegistry / portal / l2Broadcaster) — " +
        "SIPA discovery requires a dev.json-shaped deployment",
    )
  }

  if (!tuple.forwardingTable)
    throw new Error(`oxide manifest entry ${tuple.version} lacks forwardingTable`)
  const manifest = {
    forwardingTable: tuple.forwardingTable,
    resolverGatewayUrl: tuple.resolverGatewayUrl,
    ...resolverSelectionPolicy(network),
  }
  const records = deps.historical
    ? await fetchHistoricalSipaResolverOperators(
        publicClient,
        accountMetadataRegistry as Address,
        await deploymentScanRange(publicClient, tuple, deps.scanHead),
        manifest,
      )
    : [
        selectManifestResolverOperator(
          await readResolverOperatorRecords(
            publicClient,
            accountMetadataRegistry as Address,
            tuple,
            deps.scanHead,
          ),
          manifest,
        ),
      ]
  const resolver = records[records.length - 1]!
  for (const record of records)
    await registerSender(pxe, AztecAddress.fromStringUnsafe(record.l2Address))
  if (deps.sponsorFpc) await registerSender(pxe, deps.sponsorFpc)

  const broadcaster = AztecAddress.fromStringUnsafe(l2Broadcaster)
  await ensureContractRegisteredInPXE(pxe, node, broadcaster, () =>
    deps.artifactFor ? deps.artifactFor(broadcaster) : getBroadcasterArtifact(),
  )

  return { resolver, broadcaster }
}

// Duck-typed like registerContractInPXE: the v5 PXE registers senders via
// registerTaggingSecretSource; the 4.3.0 PXE via registerSender.
async function registerSender(pxe: SipaDiscoveryPxe, sender: AztecAddress): Promise<void> {
  if (typeof pxe.registerTaggingSecretSource === "function") {
    await pxe.registerTaggingSecretSource({ kind: "address-derived", sender })
  } else if (typeof pxe.registerSender === "function") {
    await pxe.registerSender(sender)
  } else {
    throw new Error(
      "SIPA discovery: PXE exposes neither registerTaggingSecretSource nor registerSender",
    )
  }
}
