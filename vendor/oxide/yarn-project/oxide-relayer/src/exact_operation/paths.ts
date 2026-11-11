/** File names shared by the generic and exact runtimes. Their directories differ per runtime layout. */
export const GENERIC_SUBMISSION_JOURNAL_FILE = 'generic-submission.sqlite3';
export const RUNTIME_LEASE_FILE = 'oxide-relayer.runtime-lease.sqlite3';
export const CLEAN_HANDOFF_FILE = `${RUNTIME_LEASE_FILE}.clean-handoff.json`;
export const EXACT_JOURNAL_FILE = 'exact-operation.sqlite3';
export const GENERIC_RESTORE_MARKER_FILE = 'generic-restore.json';

/**
 * The fixed layout of the image. The generic data directory is mounted writable at `/data` for the generic runtime,
 * and read-only at `/canonical` for the exact runtime. Both runtimes share `/control`.
 */
export const EXACT_CANONICAL_DIRECTORY = '/canonical';
export const EXACT_CONTROL_DIRECTORY = '/control';
export const GENERIC_DATA_DIRECTORY = '/data';
export const EXACT_JOURNAL_PATH = `${EXACT_CONTROL_DIRECTORY}/${EXACT_JOURNAL_FILE}`;
export const EXACT_RUNTIME_LEASE_PATH = `${EXACT_CONTROL_DIRECTORY}/${RUNTIME_LEASE_FILE}`;
export const EXACT_GENERIC_SUBMISSION_JOURNAL_PATH = `${EXACT_CANONICAL_DIRECTORY}/${GENERIC_SUBMISSION_JOURNAL_FILE}`;
export const EXACT_CLEAN_HANDOFF_PATH = `${EXACT_CANONICAL_DIRECTORY}/${CLEAN_HANDOFF_FILE}`;
export const EXACT_APPROVAL_AUTHORITY_PATH = '/app/approval-authority.pem';
export const EXACT_SOURCE_COMMIT_PATH = '/app/source-commit';
export const EXACT_RUNTIME_CONFIG_DIRECTORY = '/run/config/oxide-relayer';
export const EXACT_RUNTIME_IDENTITY_PATH = '/run/config/oxide-relayer/runtime-identity.json';
export const EXACT_STATE_INVENTORY_PATH = '/run/config/oxide-relayer/state-inventory.json';
export const EXACT_SECRET_DIRECTORY = '/run/secrets/oxide-relayer';
export const EXACT_SIGNER_KEYSTORE_PATH = '/run/secrets/oxide-relayer/keystore.json';
export const EXACT_SIGNER_PASSWORD_PATH = '/run/secrets/oxide-relayer/keystore_password';
export const EXACT_WITNESS_ACCESS_KEY_ID_PATH = '/run/secrets/oxide-relayer/witness_access_key_id';
export const EXACT_WITNESS_SECRET_ACCESS_KEY_PATH = '/run/secrets/oxide-relayer/witness_secret_access_key';
export const EXACT_WITNESS_CONFIG_PATH = '/run/secrets/oxide-relayer/witness_config.json';
export const EXACT_AZTEC_NODE_URL_PATH = '/run/secrets/oxide-relayer/aztec_node_url';
