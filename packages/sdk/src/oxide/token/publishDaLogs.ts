/**
 * Mirror of `publish_da`'s private-log emission layout in
 * `oxide_token_contract/src/da.nr` (`chunk_to_log_payloads` +
 * `emit_private_log_vec_unsafe`).
 *
 * Per component (teeNotes / requiredNullifiers / withdrawalMessageHashes, one
 * capsule field per item):
 *   - items are chunked into item-only payloads of at most
 *     `PRIVATE_LOG_CIPHERTEXT_LEN` fields (`DA_COMPONENT_LOG_PAYLOAD_LENGTH`
 *     in `da.nr`);
 *   - `emit_private_log_unsafe(componentDaTag, payload)` prepends the single
 *     siloed tag field, so a log's `emittedLength` is `1 + chunkSize`;
 *   - an EMPTY component emits NO log — `chunk_to_log_payloads` pushes
 *     nothing when there are no items.
 *
 * The TEE metadata component is a single unchunked log of
 * `1 + metadataFields` (`[metadataDaTag, ...serialize()]`).
 *
 * A leaf module: the staged-send gas delta (`teeOperation`), the ClaimFPC gas
 * model, and the sandbox-free unit tests all need it, and only the first of
 * those can afford the TEE client's import graph.
 */
import { PRIVATE_LOG_CIPHERTEXT_LEN } from "@aztec-labs/constants"

export function computePublishDaLogEmittedLengths(counts: {
  teeNotes: number
  requiredNullifiers: number
  withdrawalMessageHashes: number
  metadataFields: number
}): number[] {
  const componentLogEmittedLengths = (numItems: number): number[] => {
    if (numItems === 0) {
      return []
    }
    const itemsPerLog = PRIVATE_LOG_CIPHERTEXT_LEN
    const lengths: number[] = []
    for (let remaining = numItems; remaining > 0; remaining -= itemsPerLog) {
      lengths.push(1 + Math.min(remaining, itemsPerLog))
    }
    return lengths
  }
  return [
    ...componentLogEmittedLengths(counts.teeNotes),
    ...componentLogEmittedLengths(counts.requiredNullifiers),
    ...componentLogEmittedLengths(counts.withdrawalMessageHashes),
    1 + counts.metadataFields,
  ]
}
