/**
 * Paylink processor module
 * Provides type-specific processors for handling different paylink commitments
 */

export { PaylinkProcessorFactory } from "./create/PaylinkProcessorFactory.js"
export { BasePaylinkProcessor } from "./create/processors/BasePaylinkProcessor.js"
export type {
  DepositArg,
  PaylinkConstructorArgs,
} from "./create/processors/BasePaylinkProcessor.js"
export { DirectPaylinkProcessor } from "./create/processors/DirectPaylinkProcessor.js"
export { EmailPaylinkProcessor } from "./create/processors/EmailPaylinkProcessor.js"
export {
  assertLinkChain,
  assertLinkClass,
  encodePaylinkInline,
  decodePaylinkInline,
  LINK_CLASS_REFUSAL,
} from "./link/paylinkInlineCodec.js"
export { resolveShortPaylink } from "./link/shortPaylink.js"
export { buildOperationCall } from "./claim/paylinkClaimSubmit.js"
export { paylinkL1Caller } from "./claim/paylinkL1Claim.js"
export type { PaylinkL1Payout, PaylinkL1Proof } from "./claim/paylinkL1Claim.js"
export {
  exitPaylinkWithVoucher,
  paylinkVoucherUses,
  readPaylinkEscrowNote,
  type PaylinkExitArgs,
  type PaylinkVoucherDeps,
} from "./claim/paylinkVoucher.js"
export { makePaylinkSpendMetadataResolver } from "./claim/paylinkSpendMetadata.js"
export { discoverFrozenEscrows, paylinkRefundOwner } from "./escrow/frozenEscrows.js"
export {
  assertPaylinkTerms,
  buildPaylinkNoteView,
  packPaylinkData,
  PAYLINK_TERMS_REFUSAL,
  paylinkTerms,
  unpackPaylinkData,
  type PaylinkClaimWindowStatus,
  type PaylinkNoteData,
  type PaylinkNoteView,
  type RawPaylinkNote,
} from "./escrow/paylinkNoteData.js"
export {
  buildPaylinkCompleteAddress,
  deriveDeterministicPaylinkKeys,
  derivePaylinkKeys,
  derivePaylinkFallbackSecretKey,
  MAX_PAYLINK_NONCES_PER_DAY,
  reconstructPaylinkPublicKeys,
  registerPaylinkContractWithKeys,
  type PaylinkDerivedKeyMaterial,
  type PaylinkKeyMaterial,
} from "./escrow/paylinkKeys.js"
export {
  findDepositTxHash,
  findEscrowDepositTx,
  PAYLINK_NONCE_EPOCH_DAY,
  scanPaylinkEscrows,
  type PaylinkScanNode,
  type RecoveredPaylinkEscrow,
} from "./escrow/paylinkRecovery.js"
export type {
  CommitmentInput,
  DirectClaimInput,
  EmailCommitmentInput,
  ClaimInput,
  BaseClaimInput,
  ZkProofClaimInput,
  isZkProofClaimInput,
  ClaimService,
  ClaimTransactionResult,
} from "./types.js"
export * from "./goldenTicket.js"
