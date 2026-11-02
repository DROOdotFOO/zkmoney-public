import {
  bridgeByPortal,
  featureBridge,
  isAllZeroHex,
  type OxideDeployment,
  type OxideFeature,
} from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { SkyEscrowFactoryAbi } from "@oxide/experiments/sky/sky_savings.js"
import type { Address, PublicClient } from "viem"
import { logger } from "../../../utils/logger"
import type { SavingsDirection } from "./types"

/** The Etherplan project of oxide's Sky savings feature. */
export const SKY_PROJECT = "sky"

/** The roles a Sky feature binds its bridges in: the sUSDS bridge, and the DAI bridge an unstake deposits into. */
export const SKY_ROLES = { savings: "sUsds", main: "dai" } as const

/** Main is the DAI bridge; Savings the sUSDS one. */
export interface SavingsDeployments {
  main: OxideEnvTuple
  savings: OxideEnvTuple
  /** The Sky withdrawal executor: a move out's burn pays it, and it redeems the shares to DAI. */
  skyExecutor: Address
}

export interface SkyFactory {
  address: Address
  dai: Address
  sUsds: Address
}

/** Sky savings on one deployment. */
export interface SkySavings {
  deployments: SavingsDeployments
  factory: SkyFactory
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The deployment's Sky feature, if it lists one. */
export function skyFeature(deployment: OxideDeployment): OxideFeature | undefined {
  return deployment.features?.find((feature) => feature.project === SKY_PROJECT)
}

const isUsableAddress = (value: string | undefined): value is Address =>
  !!value && /^0x[0-9a-fA-F]{40}$/.test(value) && !isAllZeroHex(value)

/**
 * The Sky savings `feature` lists. Undefined, with the reason logged, where it binds no bridge of the deployment in a
 * role or lists no usable contract: Savings then stays hidden.
 */
function featureSkySavings(
  deployment: OxideDeployment,
  feature: OxideFeature,
): SkySavings | undefined {
  const main = featureBridge(deployment, feature, SKY_ROLES.main)
  const savings = featureBridge(deployment, feature, SKY_ROLES.savings)
  const factory = feature.contracts.skyEscrowFactory
  const executor = feature.contracts.skyWithdrawalExecutor
  const unusable = (what: string) => {
    logger.warn(
      `[savings] Sky feature ${feature.id} of deployment ${deployment.label} has no usable ${what}; no Savings there`,
    )
    return undefined
  }
  if (!main) return unusable(`${SKY_ROLES.main} bridge`)
  if (!savings) return unusable(`${SKY_ROLES.savings} bridge`)
  if (!isUsableAddress(factory)) return unusable("skyEscrowFactory")
  if (!isUsableAddress(executor)) return unusable("skyWithdrawalExecutor")
  return {
    deployments: { main: main.tuple, savings: savings.tuple, skyExecutor: executor },
    factory: {
      address: factory,
      dai: main.underlying as Address,
      sUsds: savings.underlying as Address,
    },
  }
}

/** One of a Sky escrow factory's address immutables. */
const readFactoryAddress = (
  client: Pick<PublicClient, "readContract">,
  factory: Address,
  functionName: "DAI_PORTAL" | "SUSDS_PORTAL",
): Promise<Address> =>
  client.readContract({
    address: factory,
    abi: SkyEscrowFactoryAbi,
    functionName,
  }) as Promise<Address>

/**
 * The Sky savings of a `skyEscrowFactory` published beside the deployment's fields: its bridges are those of the
 * portals the factory deposits into, and the Sky executor is the sUSDS bridge's executor. A schema v4 manifest lists
 * each portal as a deployment of its own, so a portal `deployment` lacks is looked up in `others`. Undefined, logged,
 * where no bridge has one of the portals.
 */
async function factorySkySavings(
  client: Pick<PublicClient, "readContract">,
  deployment: OxideDeployment,
  address: Address,
  others: () => Promise<readonly OxideDeployment[]>,
): Promise<SkySavings | undefined> {
  const { daiPortal, sUsdsPortal } = await readSkyFactoryPortals(client, address)
  let pool: readonly OxideDeployment[] = [deployment]
  const find = (portal: string) =>
    pool.map((candidate) => bridgeByPortal(candidate, portal)).find((bridge) => !!bridge)
  if (!find(daiPortal) || !find(sUsdsPortal)) pool = [deployment, ...(await others())]
  const main = find(daiPortal)
  const savings = find(sUsdsPortal)
  if (!main || !savings) {
    logger.warn(
      `[savings] The Sky escrow factory ${address} deposits into ${daiPortal} and ${sUsdsPortal}, not portals of the manifest`,
    )
    return undefined
  }
  return {
    deployments: {
      main: main.tuple,
      savings: savings.tuple,
      skyExecutor: tupleField(savings.tuple, "plainWithdrawalExecutor"),
    },
    factory: { address, dai: main.underlying as Address, sUsds: savings.underlying as Address },
  }
}

const publishedFactory = (deployment: OxideDeployment): Address | undefined =>
  deployment.bridges.find((bridge) => bridge.tuple.skyEscrowFactory)?.tuple.skyEscrowFactory as
    | Address
    | undefined

/**
 * Sky savings on `deployment`: the escrow factory and withdrawal executor its Sky feature lists, between the bridges
 * the feature binds by role. A deployment without the feature falls back to a `skyEscrowFactory` published beside
 * its fields, whose bridges may sit in `others`, the manifest's other deployments. Undefined where the deployment
 * names no usable Sky savings.
 */
export async function resolveSkySavings(
  client: Pick<PublicClient, "readContract">,
  deployment: OxideDeployment,
  others: () => Promise<readonly OxideDeployment[]> = async () => [],
): Promise<SkySavings | undefined> {
  const feature = skyFeature(deployment)
  if (feature) return featureSkySavings(deployment, feature)
  const address = publishedFactory(deployment)
  return address ? factorySkySavings(client, deployment, address, others) : undefined
}

/**
 * The bridges `factory` moves between, in any of `deployments`: where an older move's escrow deposits. A Sky feature
 * that lists the factory names them; else a deployment that publishes it beside its fields. Undefined where none does.
 */
export async function skyBridgesOfFactory(
  client: Pick<PublicClient, "readContract">,
  deployments: readonly OxideDeployment[],
  factory: string,
): Promise<{ main: OxideEnvTuple; savings: OxideEnvTuple } | undefined> {
  for (const deployment of deployments) {
    for (const feature of deployment.features ?? []) {
      const listed = feature.contracts.skyEscrowFactory
      if (feature.project !== SKY_PROJECT || !listed || !sameAddress(listed, factory)) continue
      const sky = featureSkySavings(deployment, feature)
      if (sky) return { main: sky.deployments.main, savings: sky.deployments.savings }
    }
  }
  for (const deployment of deployments) {
    const published = publishedFactory(deployment)
    if (!published || !sameAddress(published, factory)) continue
    const sky = await factorySkySavings(client, deployment, published, async () => deployments)
    if (sky) return { main: sky.deployments.main, savings: sky.deployments.savings }
  }
  return undefined
}

/** The two portals a Sky escrow factory's escrows deposit into: DAI's for a move out, sUSDS's for a move in. */
export interface SkyFactoryPortals {
  daiPortal: Address
  sUsdsPortal: Address
}

/** `factory`'s `DAI_PORTAL()` and `SUSDS_PORTAL()`. Immutables, so a front reads them once per session. */
export async function readSkyFactoryPortals(
  client: Pick<PublicClient, "readContract">,
  factory: Address,
): Promise<SkyFactoryPortals> {
  const [daiPortal, sUsdsPortal] = await Promise.all([
    readFactoryAddress(client, factory, "DAI_PORTAL"),
    readFactoryAddress(client, factory, "SUSDS_PORTAL"),
  ])
  return { daiPortal, sUsdsPortal }
}

/** The factory's escrows would deposit into other portals than the bridges the manifest pairs. */
export class SkyFactoryMismatchError extends Error {
  constructor(readonly factory: Address, readonly portals: SkyFactoryPortals) {
    super(
      `Savings is misconfigured on this network: the escrow factory ${factory} moves between ` +
        `${portals.daiPortal} and ${portals.sUsdsPortal}, not this wallet's Main and Savings. Nothing was sent.`,
    )
  }
}

/** Throws unless `portals`, the factory's own, are the portals of the Main and Savings bridges. */
export function assertSkyFactoryPortals(
  portals: SkyFactoryPortals,
  deployments: Pick<SavingsDeployments, "main" | "savings">,
  factory: Address,
): void {
  if (
    !sameAddress(portals.daiPortal, deployments.main.portal) ||
    !sameAddress(portals.sUsdsPortal, deployments.savings.portal)
  ) {
    throw new SkyFactoryMismatchError(factory, portals)
  }
}

export const tupleField = (tuple: OxideEnvTuple, field: keyof OxideEnvTuple): Address => {
  const value = tuple[field]
  if (typeof value !== "string" || !value) throw new Error(`oxide manifest lacks ${field}`)
  return value as Address
}

/** The executor a move's burn pays: Main's plain executor for a move in, the Sky executor for a move out. */
export const savingsSourceExecutor = (
  deployments: SavingsDeployments,
  direction: SavingsDirection,
): Address =>
  direction === "in"
    ? tupleField(deployments.main, "plainWithdrawalExecutor")
    : deployments.skyExecutor
