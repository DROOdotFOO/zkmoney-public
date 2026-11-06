import type { EthAddress } from '@aztec-labs/foundation/eth-address';

export const PORTAL_STATE_PLACEHOLDER = '{portal}';
export const EXACT_HANDOFF_STATE_TEMPLATE = '/data/oxide-relayer-{portal}.sqlite3';

export function supportsExactOperationHandoff(template: string): boolean {
  return template === EXACT_HANDOFF_STATE_TEMPLATE;
}

/** Resolve one deployment's SQLite file without allowing multiple portals to share a database. */
export function statePathForPortal(template: string, portal: EthAddress, deploymentCount: number): string {
  if (template.includes(PORTAL_STATE_PLACEHOLDER)) {
    return template.replaceAll(PORTAL_STATE_PLACEHOLDER, portal.toString().toLowerCase());
  }
  if (deploymentCount > 1) {
    throw new Error(
      `SQLite state path must contain ${PORTAL_STATE_PLACEHOLDER} when the manifest contains multiple deployments.`,
    );
  }
  return template;
}
