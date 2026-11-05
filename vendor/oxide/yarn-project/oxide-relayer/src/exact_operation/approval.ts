import { createHash, timingSafeEqual } from 'node:crypto';

import type { ExactOperationApproval } from './contract.js';

const APPROVAL_DOMAIN = 'oxide-relayer/exact-operation-approval/v1\0';
const APPROVAL_PREFIX = 'ENABLE-OXIDE-EXACT-OPERATION';

export function exactApprovalDigest(approval: ExactOperationApproval): `sha256:${string}` {
  const digest = createHash('sha256')
    .update(APPROVAL_DOMAIN, 'utf8')
    .update(stableJson(approval), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

export function exactApprovalToken(approval: ExactOperationApproval): string {
  return [
    APPROVAL_PREFIX,
    approval.runtime.host,
    approval.runtime.sourceCommit,
    approval.runtime.imageDigest,
    approval.runtime.stateSetDigest,
    approval.deployment.portal,
    approval.operation.id,
    exactApprovalDigest(approval),
  ].join(':');
}

export function assertExactApprovalToken(approval: ExactOperationApproval, received: string): void {
  const expectedBytes = Buffer.from(exactApprovalToken(approval), 'utf8');
  const receivedBytes = Buffer.from(received.trim(), 'utf8');
  if (expectedBytes.length !== receivedBytes.length || !timingSafeEqual(expectedBytes, receivedBytes)) {
    throw new Error('Exact-operation approval does not match the reviewed runtime and operation');
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}
