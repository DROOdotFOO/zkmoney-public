import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import path from 'node:path';

import {
  CLEAN_HANDOFF_FILE,
  EXACT_CONTROL_DIRECTORY,
  GENERIC_SUBMISSION_JOURNAL_FILE,
  RUNTIME_LEASE_FILE,
} from '../exact_operation/paths.js';

export const PORTAL_STATE_PLACEHOLDER = '{portal}';
export const EXACT_HANDOFF_STATE_TEMPLATE = '/data/oxide-relayer-{portal}.sqlite3';

/** Where one generic run keeps its files, derived from the state path and the control directory. */
export interface GenericRuntimePaths {
  /** The directory of the per-portal state files. */
  dataDirectory: string;
  /** The directory of the runtime lease that the generic and exact runtimes share. */
  controlDirectory: string;
  submissionJournal: string;
  runtimeLease: string;
  /** Beside the state, so the exact runtime reads it under its read-only canonical mount. */
  cleanHandoff: string;
  /** True only for the image layout, where an exact runtime can take over from this run. */
  exactHandoff: boolean;
}

export function genericRuntimePaths(stateTemplate: string, controlDirectory: string): GenericRuntimePaths {
  const dataDirectory = path.dirname(path.resolve(stateTemplate));
  if (dataDirectory.includes(PORTAL_STATE_PLACEHOLDER)) {
    throw new Error(`The directory of the SQLite state path must not contain ${PORTAL_STATE_PLACEHOLDER}`);
  }
  const control = path.resolve(controlDirectory);
  return {
    dataDirectory,
    controlDirectory: control,
    submissionJournal: path.join(dataDirectory, GENERIC_SUBMISSION_JOURNAL_FILE),
    runtimeLease: path.join(control, RUNTIME_LEASE_FILE),
    cleanHandoff: path.join(dataDirectory, CLEAN_HANDOFF_FILE),
    exactHandoff: stateTemplate === EXACT_HANDOFF_STATE_TEMPLATE && control === EXACT_CONTROL_DIRECTORY,
  };
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
