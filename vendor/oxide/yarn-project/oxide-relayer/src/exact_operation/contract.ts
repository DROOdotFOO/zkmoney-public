import { z } from 'zod';

export const EXACT_DATABASE_SCHEMA_IDENTITY =
  'oxide-relayer.sqlite.portal-v4+exact-v2+generic-v1+lease-v1' as const;


export interface ExactOperationRuntimeIdentity {
  host: string;
  sourceCommit: string;
  imageDigest: string;
  schemaIdentity: typeof EXACT_DATABASE_SCHEMA_IDENTITY;
  stateInventoryDigest: string;
  canonicalStateDigest: string;
}

export interface ExactDeploymentIdentity {
  label: string;
  chainId: string;
  rollupVersion: string;
  portal: string;
  l2Token: string;
  broadcaster: string;
  operationExecutor: string;
}

export interface ExactWitnessAuthority {
  bucket: string;
  region: string;
  expectedOwner: string;
  prefix: string;
  retentionMode: 'COMPLIANCE';
  retainUntil: '9999-12-31T23:59:59.000Z';
}

export interface ExactOperationIdentity {
  id: string;
  kind: 'withdrawal_finalization';
  sourceTxHash: string;
  sourceBlockNumber: string;
  sourceBlockHash: string;
  sourceFinalized: true;
  sourceEventCount: number;
  target: string;
  payoutToken: string;
  calldataSha256: string;
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
  maximumGasToCover: string;
  tokenWeiPerEth: string;
  maximumGas: string;
  maximumFeePerGas: string;
  maximumPriorityFeePerGas: string;
  maximumTotalFee: string;
}

export interface ExactOperationApproval {
  schema: 'oxide-relayer.exact-operation.v2';
  approvalNonce: string;
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
const exactOperationRuntimeIdentitySchema: z.ZodType<ExactOperationRuntimeIdentity> = z.strictObject({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  imageDigest: sha256,
  schemaIdentity: z.literal(EXACT_DATABASE_SCHEMA_IDENTITY),
  stateInventoryDigest: sha256,
  canonicalStateDigest: sha256,
});


const exactOperationApprovalSchema: z.ZodType<ExactOperationApproval> = z.strictObject({
  schema: z.literal('oxide-relayer.exact-operation.v2'),
  approvalNonce: lowercaseHex(32),
  runtime: exactOperationRuntimeIdentitySchema,
  witness: z.strictObject({
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    region: z.string().regex(/^[a-z0-9-]+$/),
    expectedOwner: z.string().regex(/^[0-9]{12}$/),
    prefix: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/),
    retentionMode: z.literal('COMPLIANCE'),
    retainUntil: z.literal('9999-12-31T23:59:59.000Z'),
  }),
  deployment: z.strictObject({
    label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    chainId: positiveDecimal,
    rollupVersion: positiveDecimal,
    portal: lowercaseHex(20),
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
    sourceFinalized: z.literal(true),
    sourceEventCount: z.literal(1),
    target: lowercaseHex(20),
    payoutToken: lowercaseHex(20),
    calldataSha256: lowercaseHex(32),
  }),
  withdrawal: z.strictObject({
    executor: lowercaseHex(20),
    recipientCommitment: lowercaseHex(32),
    amount: positiveDecimal,
    proverTip: decimal,
    relayerTip: decimal,
  }),
  economics: z
    .strictObject({
      executorVersion: z.enum(['legacy', 'gas-to-cover']),
      minimumPayout: decimal,
      maximumGasToCover: decimal,
      tokenWeiPerEth: decimal,
      maximumGas: positiveDecimal,
      maximumFeePerGas: positiveDecimal,
      maximumPriorityFeePerGas: decimal,
      maximumTotalFee: positiveDecimal,
    })
    .superRefine((economics, context) => {
      const maximumGasToCover = BigInt(economics.maximumGasToCover);
      const tokenWeiPerEth = BigInt(economics.tokenWeiPerEth);
      if (economics.executorVersion === 'legacy' && (maximumGasToCover !== 0n || tokenWeiPerEth !== 0n)) {
        context.addIssue({ code: 'custom', message: 'legacy executor gas-cost arguments must be zero' });
      }
      if (economics.executorVersion === 'gas-to-cover' && (maximumGasToCover === 0n || tokenWeiPerEth === 0n)) {
        context.addIssue({ code: 'custom', message: 'gas-to-cover executor requires nonzero gas-cost arguments' });
      }
    }),
});

export function parseExactOperationApproval(input: unknown): ExactOperationApproval {
  return exactOperationApprovalSchema.parse(input);
}

export function parseExactOperationRuntimeIdentity(input: unknown): ExactOperationRuntimeIdentity {
  return exactOperationRuntimeIdentitySchema.parse(input);
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
