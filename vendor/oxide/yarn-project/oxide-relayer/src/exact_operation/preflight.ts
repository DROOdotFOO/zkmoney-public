import {
  EXACT_AZTEC_NODE_URL_PATH,
  EXACT_CANONICAL_DIRECTORY,
  EXACT_CONTROL_DIRECTORY,
  EXACT_SIGNER_KEYSTORE_PATH,
  EXACT_SIGNER_PASSWORD_PATH,
  EXACT_WITNESS_ACCESS_KEY_ID_PATH,
  EXACT_WITNESS_CONFIG_PATH,
  EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
} from './paths.js';
import { loadExactRuntimeIdentity, loadPreparedCleanHandoffDigest } from './runtime_identity.js';
import {
  consumePreparedInheritedBundle,
  hasPreparedRuntimeInput,
} from './runtime_sandbox.js';

export interface PreflightExactOperationConfig {
  bundleFd: number;
  canonicalState: string;
  controlDir: string;
}

const CREDENTIAL_PATHS = [
  EXACT_SIGNER_KEYSTORE_PATH,
  EXACT_SIGNER_PASSWORD_PATH,
  EXACT_WITNESS_ACCESS_KEY_ID_PATH,
  EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
  EXACT_WITNESS_CONFIG_PATH,
  EXACT_AZTEC_NODE_URL_PATH,
] as const;

/**
 * Exercises the immutable exact-operation startup contract without network, credentials, mutation, signing, or send.
 * The root initializer has already validated mounts and canonical inventory and dropped permanently to UID/GID 65532.
 */
export async function preflightExactOperation(
  config: PreflightExactOperationConfig,
  dependencies: {
    loadRuntimeIdentity: typeof loadExactRuntimeIdentity;
    loadCleanHandoffDigest: typeof loadPreparedCleanHandoffDigest;
  } = {
    loadRuntimeIdentity: loadExactRuntimeIdentity,
    loadCleanHandoffDigest: loadPreparedCleanHandoffDigest,
  },
): Promise<void> {
  if (config.canonicalState !== EXACT_CANONICAL_DIRECTORY || config.controlDir !== EXACT_CONTROL_DIRECTORY) {
    throw new Error('Exact-operation preflight paths differ from the fixed runtime mount contract');
  }
  if (CREDENTIAL_PATHS.some(hasPreparedRuntimeInput)) {
    throw new Error('Exact-operation preflight must not prepare signer or witness credentials');
  }

  const input = consumePreparedInheritedBundle(config.bundleFd);
  try {
    let bundle: unknown;
    try {
      bundle = JSON.parse(input.toString('utf8').trim());
    } catch (cause) {
      throw new Error('Exact-operation preflight bundle is malformed JSON', { cause });
    }
    if (
      typeof bundle !== 'object' ||
      bundle === null ||
      Array.isArray(bundle) ||
      Object.keys(bundle).join(',') !== 'schema' ||
      (bundle as Record<string, unknown>).schema !== 'oxide-relayer.preflight-exact.v1'
    ) {
      throw new Error('Exact-operation preflight bundle is invalid');
    }
  } finally {
    input.fill(0);
  }

  await dependencies.loadRuntimeIdentity();
  dependencies.loadCleanHandoffDigest();
}
