import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { ACCOUNT_SECRET_KEY_LABEL } from "@obsidion/core/constants"

/** The account's Aztec secret key: the root PXE derives the account's key set from. */
export function deriveAccountSecretKey(masterSecretKey: Fr): Fr {
  return sha256ToField([masterSecretKey.toBuffer(), Buffer.from(ACCOUNT_SECRET_KEY_LABEL, "utf8")])
}
