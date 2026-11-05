import { type KeyLike, createHash, sign, verify } from 'node:crypto';

import type { ExactOperationApproval } from './contract.js';

const APPROVAL_DOMAIN = 'oxide-relayer/exact-operation-approval/v1\0';
const SIGNATURE_PREFIX = 'ed25519:';

export function exactApprovalDigest(approval: ExactOperationApproval): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(approvalMessage(approval)).digest('hex')}`;
}

export function signExactApproval(approval: ExactOperationApproval, privateKey: KeyLike): string {
  return `${SIGNATURE_PREFIX}${sign(null, approvalMessage(approval), privateKey).toString('base64url')}`;
}

export function assertExactApprovalToken(
  approval: ExactOperationApproval,
  received: string,
  publicKey: KeyLike,
): void {
  const token = received.trim();
  if (!token.startsWith(SIGNATURE_PREFIX)) {
    throw new Error('Exact-operation approval signature is malformed');
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(token.slice(SIGNATURE_PREFIX.length), 'base64url');
  } catch {
    throw new Error('Exact-operation approval signature is malformed');
  }
  if (signature.length !== 64 || !verify(null, approvalMessage(approval), publicKey, signature)) {
    throw new Error('Exact-operation approval signature is not valid for the reviewed authority');
  }
}

function approvalMessage(approval: ExactOperationApproval): Buffer {
  return Buffer.from(`${APPROVAL_DOMAIN}${stableJson(approval)}`, 'utf8');
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
