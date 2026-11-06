import { z } from 'zod';

export const EXACT_DATABASE_SCHEMA_IDENTITY =
  'oxide-relayer.sqlite.portal-v4+exact-v2+generic-v2+lease-v1+runtime-v2' as const;

export interface ExactStageAIdentity {
  approvalDigest: string;
  intentWitnessVersionId: string;
  intentWitnessChecksumSha256: string;
  witnessVersionId: string;
  witnessChecksumSha256: string;
  completionWitnessBodySha256: string;
  handoffMarkerDigest: string;
  exitIntentCommitment: string;
  frozenAt: string;
}

export interface ExactOperationRuntimeIdentity {
  host: string;
  sourceCommit: string;
  imageDigest: string;
  runtimeUid: 65532;
  runtimeGid: 65532;
  signerAddress: string;
  schemaIdentity: typeof EXACT_DATABASE_SCHEMA_IDENTITY;
  stateInventoryDigest: string;
  canonicalStateDigest: string;
  expectedNonce: number;
}

export interface ExactDeploymentIdentity {
  label: string;
  chainId: string;
  rollupVersion: string;
  portal: string;
  registry: string;
  manifestDigest: string;
  l2Token: string;
  broadcaster: string;
  operationExecutor: string;
}

export interface ExactWitnessAuthority {
  configurationDigest: string;
  authorityCommitment: string;
  retentionMode: 'COMPLIANCE';
  retainUntil: '9999-12-31T23:59:59.000Z';
}

export interface ExactOperationIdentity {
  id: string;
  kind: 'withdrawal_finalization';
  sourceTxHash: string;
  sourceBlockNumber: string;
  sourceBlockHash: string;
  sourceBlockTimestamp: string;
  sourceFinalized: true;
  sourceEventCount: 1;
  target: string;
  payoutToken: string;
  calldataSha256: string;
  broadcasterEvent: {
    contract: string;
    eventSignature: string;
    logIndex: string;
    callSha256: string;
  };
  outboxWitness: {
    root: string;
    leafIndex: string;
    proofDigest: string;
  };
}

export interface ExactWithdrawalIdentity {
  executor: string;
  recipientCommitment: string;
  amount: string;
  proverTip: string;
  relayerTip: string;
}

export interface ExactOperationEconomics {
  executorVersion: 'legacy' | 'gas-to-cover';
  minimumPayout: string;
  minimumProceeds: string;
  executorFeeCeiling: string;
  maximumGasToCover: string;
  tokenWeiPerEth: string;
  maximumGas: string;
  maximumFeePerGas: string;
  maximumPriorityFeePerGas: string;
  maximumTotalFee: string;
}

export interface ExactOperationApproval {
  schema: 'oxide-relayer.exact-operation.v4';
  approvalNonce: string;
  notBefore: string;
  expiresAt: string;
  stageA: ExactStageAIdentity;
  runtime: ExactOperationRuntimeIdentity;
  witness: ExactWitnessAuthority;
  deployment: ExactDeploymentIdentity;
  operation: ExactOperationIdentity;
  withdrawal: ExactWithdrawalIdentity;
  economics: ExactOperationEconomics;
}

const lowercaseHex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`));
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const positiveDecimal = decimal.refine(value => BigInt(value) > 0n, 'must be positive');
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine(value => !Number.isNaN(Date.parse(value)), 'must be a valid UTC timestamp');
const versionId = z.string().min(1).max(1024);

const exactOperationRuntimeIdentitySchema: z.ZodType<ExactOperationRuntimeIdentity> = z.strictObject({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  imageDigest: sha256,
  runtimeUid: z.literal(65532),
  runtimeGid: z.literal(65532),
  signerAddress: lowercaseHex(20),
  schemaIdentity: z.literal(EXACT_DATABASE_SCHEMA_IDENTITY),
  stateInventoryDigest: sha256,
  canonicalStateDigest: sha256,
  expectedNonce: z.number().int().nonnegative(),
});

const exactOperationApprovalSchema: z.ZodType<ExactOperationApproval> = z
  .strictObject({
    schema: z.literal('oxide-relayer.exact-operation.v4'),
    approvalNonce: lowercaseHex(32),
    notBefore: timestamp,
    expiresAt: timestamp,
    stageA: z.strictObject({
      approvalDigest: sha256,
      intentWitnessVersionId: versionId,
      intentWitnessChecksumSha256: sha256,
      witnessVersionId: versionId,
      witnessChecksumSha256: sha256,
      completionWitnessBodySha256: sha256,
      handoffMarkerDigest: sha256,
      exitIntentCommitment: lowercaseHex(32),
      frozenAt: timestamp,
    }),
    runtime: exactOperationRuntimeIdentitySchema,
    witness: z.strictObject({
      configurationDigest: sha256,
      authorityCommitment: sha256,
      retentionMode: z.literal('COMPLIANCE'),
      retainUntil: z.literal('9999-12-31T23:59:59.000Z'),
    }),
    deployment: z.strictObject({
      label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      chainId: positiveDecimal,
      rollupVersion: positiveDecimal,
      portal: lowercaseHex(20),
      registry: lowercaseHex(20),
      manifestDigest: sha256,
      l2Token: lowercaseHex(32),
      broadcaster: lowercaseHex(32),
      operationExecutor: lowercaseHex(20),
    }),
    operation: z.strictObject({
      id: lowercaseHex(32),
      kind: z.literal('withdrawal_finalization'),
      sourceTxHash: lowercaseHex(32),
      sourceBlockNumber: positiveDecimal,
      sourceBlockHash: lowercaseHex(32),
      sourceBlockTimestamp: timestamp,
      sourceFinalized: z.literal(true),
      sourceEventCount: z.literal(1),
      target: lowercaseHex(20),
      payoutToken: lowercaseHex(20),
      calldataSha256: lowercaseHex(32),
      broadcasterEvent: z.strictObject({
        contract: lowercaseHex(32),
        eventSignature: lowercaseHex(32),
        logIndex: decimal,
        callSha256: lowercaseHex(32),
      }),
      outboxWitness: z.strictObject({
        root: lowercaseHex(32),
        leafIndex: decimal,
        proofDigest: sha256,
      }),
    }),
    withdrawal: z.strictObject({
      executor: lowercaseHex(20),
      recipientCommitment: lowercaseHex(32),
      amount: positiveDecimal,
      proverTip: decimal,
      relayerTip: decimal,
    }),
    economics: z.strictObject({
      executorVersion: z.enum(['legacy', 'gas-to-cover']),
      minimumPayout: decimal,
      minimumProceeds: decimal,
      executorFeeCeiling: decimal,
      maximumGasToCover: decimal,
      tokenWeiPerEth: decimal,
      maximumGas: positiveDecimal,
      maximumFeePerGas: positiveDecimal,
      maximumPriorityFeePerGas: decimal,
      maximumTotalFee: positiveDecimal,
    }),
  })
  .superRefine((approval, context) => {
    const economics = approval.economics;
    if (
      economics.executorVersion === 'legacy' &&
      (economics.maximumGasToCover !== '0' || economics.tokenWeiPerEth !== '0')
    ) {
      context.addIssue({ code: 'custom', message: 'legacy executor gas-cost arguments must be zero' });
    }
    if (
      economics.executorVersion === 'gas-to-cover' &&
      (economics.maximumGasToCover === '0' || economics.tokenWeiPerEth === '0')
    ) {
      context.addIssue({ code: 'custom', message: 'gas-to-cover executor requires nonzero gas-cost arguments' });
    }
    if (economics.minimumProceeds !== economics.minimumPayout) {
      context.addIssue({ code: 'custom', message: 'Stage A minimum proceeds differs from exact minimum payout' });
    }
    if (economics.executorFeeCeiling !== economics.maximumTotalFee) {
      context.addIssue({ code: 'custom', message: 'Stage A executor-fee ceiling differs from exact total-fee ceiling' });
    }
    if (approval.operation.broadcasterEvent.contract !== approval.deployment.broadcaster) {
      context.addIssue({ code: 'custom', message: 'exact broadcaster event differs from deployment' });
    }
    if (Date.parse(approval.operation.sourceBlockTimestamp) <= Date.parse(approval.stageA.frozenAt)) {
      context.addIssue({ code: 'custom', message: 'operation source evidence did not occur after Stage A freeze' });
    }
  });

export function parseExactOperationApproval(input: unknown): ExactOperationApproval {
  return exactOperationApprovalSchema.parse(input);
}

export function parseExactOperationRuntimeIdentity(input: unknown): ExactOperationRuntimeIdentity {
  return exactOperationRuntimeIdentitySchema.parse(input);
}

export function assertExactApprovalWindow(approval: ExactOperationApproval, now = new Date()): void {
  const notBefore = Date.parse(approval.notBefore);
  const expiresAt = Date.parse(approval.expiresAt);
  if (
    expiresAt <= notBefore ||
    expiresAt - notBefore > 4 * 60 * 60 * 1000 ||
    now.getTime() < notBefore ||
    now.getTime() >= expiresAt
  ) {
    throw new Error('Exact-operation approval is outside its signed execution window');
  }
}

/** Values re-derived from the pinned runtime, manifest and finalized chain evidence. */
export type ExactOperationObservation = ExactOperationApproval;

/** Refuses any drift between the reviewed approval and runtime observation. */
export function assertExactOperationMatches(
  approval: ExactOperationApproval,
  observation: ExactOperationObservation,
): void {
  compare('', approval, observation);
}

function compare(path: string, expected: unknown, actual: unknown): void {
  if (typeof expected !== 'object' || expected === null) {
    if (expected !== actual) {
      throw new Error(`Exact operation mismatch at ${path || 'root'}`);
    }
    return;
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(expected) !== Array.isArray(actual)) {
    throw new Error(`Exact operation mismatch at ${path || 'root'}`);
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const expectedKeys = Object.keys(expectedRecord).sort();
  const actualKeys = Object.keys(actualRecord).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
    throw new Error(`Exact operation mismatch at ${path || 'root'}`);
  }
  for (const key of expectedKeys) {
    compare(path ? `${path}.${key}` : key, expectedRecord[key], actualRecord[key]);
  }
}
