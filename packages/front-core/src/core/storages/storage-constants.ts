export const CONTACT_STORAGE_KEY = "obsidion_contacts"
export const NETWORK_STORAGE_KEY = "obsidion_network"
export const TOKENS_LOCAL_STORAGE_KEY = "obsidion_tokens"
export const ISSUED_CONNECT_STORAGE_KEY = "obsidion_issued_connects"
export const PENDING_CONNECT_BACK_STORAGE_KEY = "obsidion_pending_connect_backs"
export const NAME_CLAIM_STORAGE_KEY = "obsidion_name_claims"
export const BACKUP_ROTATION_STORAGE_KEY = "obsidion_backup_rotation"
export const PREVIOUS_ACCOUNT_WATCH_STORAGE_KEY = "obsidion_previous_account_watch"
export const REQUEST_STORAGE_KEY = "obsidion.payment-requests.v1"

/**
 * Default local prune horizon (7 days). Bounds how long after minting a code a
 * connect-back can still be matched — generous so an offline scanner's
 * eventually-delivered connect-back still lands.
 */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
