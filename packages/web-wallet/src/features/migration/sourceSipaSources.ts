/**
 * A retired deployment's SIPAs and their swept deposits, found from chain data alone: the source
 * rollup's `SIPA` events, the account's registration commitments and the L1 `Sweep` and `Deposit`
 * logs. A new device finds them too.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { OxideEnvTuple, SourceSipaScan as SourceSipaScanParams } from "@obsidion/core/types"
import {
  composeWireNameHash,
  deploymentScanRange,
  deriveBootstrapKey,
  deriveRefundableSipaSources,
  deriveStealthKey,
  directDepositKey,
  registrationCommitments,
  scanSweptDeposits,
  setupSipaDiscovery,
  type RefundableSipaSource,
} from "@obsidion/front-core"
import {
  fetchHistoricalResolverPublicKeys,
  fetchHistoricalSipaResolverOperators,
  resolverSelectionPolicy,
  fetchSipaEvents,
  predictAccountAddress,
} from "@obsidion/sdk"
import type { Address, Hex, PublicClient } from "viem"
import { getWebBroadcasterArtifact } from "../../config/classArtifacts"
import { getConfig } from "../../config/env"
import { loadWalletIdentity } from "../identity/walletIdentity"
import type { SourceChain } from "./historicTokenContext"

export interface SourceSipaScan {
  /** Where the deployment's rollup is read. */
  chain: SourceChain
  tuple: OxideEnvTuple
  publicClient: PublicClient
  masterSecret: Parameters<typeof deriveStealthKey>[0]
  /** One L1 head bounds every scan of one pass. */
  scanHead: bigint
}

/** The owner's L1 account, which an account-protocol deployment's SIPAs commit to. */
async function sipaRecoveryAccount(o: Omit<SourceSipaScan, "chain">) {
  const { tuple, publicClient } = o
  return tuple.sipaRecoveryProtocol === "account" && tuple.accountFactory
    ? await predictAccountAddress(
        publicClient,
        tuple.accountFactory as Address,
        deriveBootstrapKey(o.masterSecret).address,
      )
    : undefined
}

/** What another generation's session needs to find the deployment's SIPAs, in plain data. */
export async function sourceSipaScanParams(
  o: Omit<SourceSipaScan, "chain">,
): Promise<SourceSipaScanParams> {
  const { tuple, publicClient } = o
  if (!tuple.accountMetadataRegistry)
    throw new Error("The source deployment has no resolver registry")
  const stealthPublicKey = deriveStealthKey(o.masterSecret).publicKey
  const senders = (
    await fetchHistoricalSipaResolverOperators(
      publicClient,
      tuple.accountMetadataRegistry as Address,
      await deploymentScanRange(publicClient, tuple, o.scanHead),
      {
        forwardingTable: tuple.forwardingTable ?? tuple.portal,
        resolverGatewayUrl: tuple.resolverGatewayUrl,
        ...resolverSelectionPolicy(getConfig().network),
      },
    )
  ).map((record) => record.l2Address)
  return {
    tuple,
    resolverL2Addresses: senders,
    stealthPublicKey: { x: stealthPublicKey.x.toString(), y: stealthPublicKey.y.toString() },
    recoveryAccount: await sipaRecoveryAccount(o),
  }
}

/**
 * The account's registration addresses, by the commitment their sweeps deposit to. An address the
 * wallet never announced has no `SIPA` event, but its funds wait in the portal all the same.
 */
async function registrationSources(
  o: Omit<SourceSipaScan, "chain">,
  recipient: string,
): Promise<RefundableSipaSource[]> {
  const handle = loadWalletIdentity()?.handle
  const { tuple, publicClient } = o
  if (!handle || !tuple.ensDomain || !tuple.registrationSIPAImplementation) return []
  if (!tuple.accountMetadataRegistry)
    throw new Error("The source deployment has no resolver registry")
  const found = await registrationCommitments(
    o.masterSecret,
    composeWireNameHash(handle, tuple.ensDomain),
    recipient as Hex,
    await fetchHistoricalResolverPublicKeys(
      publicClient,
      tuple.accountMetadataRegistry as Address,
      await deploymentScanRange(publicClient, tuple, o.scanHead),
    ),
  )
  return found.map(({ salt, commitment }) => ({
    sipaAddress: directDepositKey(commitment),
    recipientL2Address: recipient,
    messageSecret: salt,
    recipientCommitment: commitment,
    direct: true,
  }))
}

export async function sourceSipaSources(o: SourceSipaScan) {
  const { chain, tuple } = o
  // A deployment without SIPAs, such as Sky savings, has no resolver record to look up.
  if (!tuple.depositSIPAImplementation && !tuple.registrationSIPAImplementation) return []
  let recipient: string
  let announced: RefundableSipaSource[]
  if (chain.kind === "generation") {
    recipient = chain.session.address
    announced = (await chain.session.sipaSources(await sourceSipaScanParams(o))).map((source) => ({
      ...source,
      origin: "sipa-event" as const,
    }))
  } else {
    const synced = await pxeSipaEvents({ ...o, chain })
    recipient = synced.recipient
    announced = await deriveRefundableSipaSources({
      events: synced.events,
      recipientL2Address: recipient,
      stealthPublicKey: deriveStealthKey(o.masterSecret).publicKey,
      tuple,
      recoveryAccount: await sipaRecoveryAccount(o),
    })
  }
  return [...announced, ...(await registrationSources(o, recipient))]
}

/** The `SIPA` events on a rollup this release's PXE reads. */
async function pxeSipaEvents(o: SourceSipaScan & { chain: Extract<SourceChain, { kind: "pxe" }> }) {
  const { chain, tuple, publicClient } = o
  // Registers the senders the deployment's `SIPA` events are tagged with: the resolver, and the
  // deployment's ClaimFPC for the broadcasts it sponsored.
  await setupSipaDiscovery({
    artifactFor: (address) => getWebBroadcasterArtifact(chain.wallet, address),
    pxe: chain.wallet.pxe as never,
    node: chain.wallet.node as never,
    publicClient,
    tuple,
    network: getConfig().network,
    historical: true,
    sponsorFpc: tuple.fpcBeneficiary
      ? AztecAddress.fromStringUnsafe(tuple.fpcBeneficiary)
      : undefined,
    scanHead: o.scanHead,
  })
  const recipient = chain.account.getAddress()
  const events = await fetchSipaEvents(
    chain.wallet,
    AztecAddress.fromStringUnsafe(tuple.l2Token),
    recipient as never,
  )
  return {
    recipient: recipient.toString(),
    events: events.map((event) => ({
      messageSecret: event.sharedSecretSalt.toString(),
      resweepable: event.resweepable,
      intentHash: event.intentHash,
    })),
  }
}

/** Every swept deposit of the deployment's SIPAs, plus those still holding L1 funds. Any gap throws. */
export async function sourceSweptDeposits(o: SourceSipaScan) {
  const sources = await sourceSipaSources(o)
  const range = await deploymentScanRange(o.publicClient, o.tuple, o.scanHead)
  return scanSweptDeposits(
    {
      publicClient: o.publicClient,
      portal: o.tuple.portal as Address,
      token: o.tuple.token as Address,
      fromBlock: range.fromBlock,
      head: range.toBlock,
    },
    sources,
  )
}
