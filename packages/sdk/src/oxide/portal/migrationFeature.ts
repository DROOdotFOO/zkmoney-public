import type { OxideDeployment } from "@obsidion/core/oxide"
import {
  findMigrationFeature,
  type DeploymentFeature,
  type MigrationFeature,
} from "@oxide/l1-contracts/migration.js"
import type { Address } from "viem"

export type { MigrationFeature }

/**
 * The migration feature of `deployment` that serves the old portal `sourcePortal`: its `MigrationExecutor`, its
 * `MigrationSubsidy`, the token the subsidy pays in, and the bridge id of the new portal. Undefined when the deployment
 * cannot migrate funds from that portal. Throws when more than one feature serves the portal, or when the feature
 * that serves it does not list all of its contracts, variables and bridges.
 */
export function migrationFeatureFor(
  deployment: Pick<OxideDeployment, "features">,
  sourcePortal: Address,
): MigrationFeature | undefined {
  const features: Record<string, DeploymentFeature> = Object.fromEntries(
    (deployment.features ?? []).map((feature) => [
      feature.id,
      {
        project: feature.project,
        bridges: { ...feature.bridges },
        contracts: { ...feature.contracts },
        variables: { ...feature.variables },
      },
    ]),
  )
  return findMigrationFeature(features, sourcePortal)
}
