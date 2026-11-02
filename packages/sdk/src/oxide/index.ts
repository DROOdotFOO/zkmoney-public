// Internal-only barrel for SDK-vendored oxide types. NOT re-exported from
// `packages/sdk/src/index.ts` — external consumers go through
// `@oxide/oxide-client` directly. See R1/R2 + the file-level headers on
// the source files for what is vendored vs. re-exported and why.
export type { L2SubmitContext, Operation } from "./token/l2_operations.js"

// The collector is upstream verbatim: accounting effects are namespaced by a leading
// `ACCOUNTING_EFFECT_IDENTIFIER` field, so upstream's filter already skips the token's
// other offchain emissions and no local patch is needed.
export {
  collectAccountingEffects,
  buildTokenOperation,
  NoteStage,
} from "@oxide/oxide-client/token_operations_collector.js"

export { computeStealthRecipientHash } from "./token/contentHash.js"

export type {
  CollectedAccountingEffects,
  SpendMetadata,
  SpendMetadataResolver,
  DepositSpendMetadata,
  DepositSpendMetadataResolver,
  NullificationEffectData,
  InsertionEffectData,
} from "@oxide/oxide-client/token_operations_collector.js"
