import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { ExactApprovalCommitment } from './approval.js';
import type { ExactOperationApproval } from './contract.js';

const CLAIM_DOMAIN = 'oxide-relayer/exact-operation-consumption/v2\0';
const CLAIM_SCHEMA = 'oxide-relayer.exact-operation-consumption.v2' as const;

export interface ExactApprovalClaim {
  schema: typeof CLAIM_SCHEMA;
  approvalCommitment: ExactApprovalCommitment;
  stageAApprovalDigest: string;
  chainId: string;
  rollupVersion: string;
  deploymentLabel: string;
  portal: string;
  operationId: string;
  sourceCommit: string;
  imageDigest: string;
  targetHost: string;
  signerAddress: string;
  schemaIdentity: string;
  stateInventoryDigest: string;
  canonicalStateDigest: string;
}

export interface ExactApprovalClaimReceipt {
  key: string;
  versionId: string;
  checksumSha256: string;
  retainUntil: string;
  body: string;
}

export interface ExactApprovalClaimStore {
  readonly claimPrefix?: string;
  assertComplianceRetention(): Promise<void>;
  createIfAbsent(args: {
    key: string;
    body: string;
    checksumSha256: string;
    retainUntil: Date;
  }): Promise<{ versionId: string }>;
  verify(args: {
    key: string;
    versionId: string;
    checksumSha256: string;
    retainUntil: Date;
  }): Promise<void>;
}

export class ExactApprovalClaimCollisionError extends Error {
  constructor() {
    super('Exact-operation approval already has an external consumption claim');
  }
}

export function exactApprovalClaim(
  approval: ExactOperationApproval,
  approvalCommitment: ExactApprovalCommitment,
): ExactApprovalClaim {
  return {
    schema: CLAIM_SCHEMA,
    approvalCommitment,
    stageAApprovalDigest: approval.stageA.approvalDigest,
    chainId: approval.deployment.chainId,
    rollupVersion: approval.deployment.rollupVersion,
    deploymentLabel: approval.deployment.label,
    portal: approval.deployment.portal,
    operationId: approval.operation.id,
    sourceCommit: approval.runtime.sourceCommit,
    imageDigest: approval.runtime.imageDigest,
    signerAddress: approval.runtime.signerAddress,
    targetHost: approval.runtime.host,
    schemaIdentity: approval.runtime.schemaIdentity,
    stateInventoryDigest: approval.runtime.stateInventoryDigest,
    canonicalStateDigest: approval.runtime.canonicalStateDigest,
  };
}

export function exactApprovalClaimKey(
  approval: ExactOperationApproval,
  approvalCommitment: ExactApprovalCommitment,
  prefix = 'exact-operation',
): string {
  const claim = exactApprovalClaim(approval, approvalCommitment);
  const identity = canonicalJson({
    chainId: claim.chainId,
    deploymentLabel: claim.deploymentLabel,
    operationId: claim.operationId,
    portal: claim.portal,
    rollupVersion: claim.rollupVersion,
  });
  const digest = createHash('sha256').update(CLAIM_DOMAIN).update(identity).digest('hex');
  return `${prefix}/exact-operation-consumption/${digest}.json`;
}

export async function consumeExactApprovalExternally(
  approval: ExactOperationApproval,
  approvalCommitment: ExactApprovalCommitment,
  store: ExactApprovalClaimStore,
): Promise<ExactApprovalClaimReceipt> {
  await store.assertComplianceRetention();
  const body = canonicalJson(exactApprovalClaim(approval, approvalCommitment));
  const checksumSha256 = createHash('sha256').update(body).digest('base64');
  const retainUntil = new Date(approval.witness.retainUntil);
  const key = exactApprovalClaimKey(approval, approvalCommitment, store.claimPrefix);
  const { versionId } = await store.createIfAbsent({ key, body, checksumSha256, retainUntil });
  await store.verify({ key, versionId, checksumSha256, retainUntil });
  return {
    key,
    versionId,
    checksumSha256,
    retainUntil: retainUntil.toISOString(),
    body,
  };
}

export class S3ExactApprovalClaimStore implements ExactApprovalClaimStore {
  readonly claimPrefix: string;
  private readonly client: S3Client;

  constructor(
    private readonly config: {
      bucket: string;
      region: string;
      expectedOwner: string;
      prefix?: string;
    },
    options: {
      credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
      client?: S3Client;
    } = {},
  ) {
    this.claimPrefix = config.prefix ?? 'exact-operation';
    this.client =
      options.client ??
      new S3Client({
        region: config.region,
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      });
  }

  async assertComplianceRetention(): Promise<void> {
    const response = await this.client.send(
      new GetObjectLockConfigurationCommand({
        Bucket: this.config.bucket,
        ExpectedBucketOwner: this.config.expectedOwner,
      }),
    );
    if (response.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
      throw new Error('Exact-operation witness authority does not have Object Lock enabled');
    }
  }

  async createIfAbsent(args: {
    key: string;
    body: string;
    checksumSha256: string;
    retainUntil: Date;
  }): Promise<{ versionId: string }> {
    try {
      const response = await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: args.key,
          Body: args.body,
          ContentType: 'application/json',
          ChecksumAlgorithm: 'SHA256',
          ChecksumSHA256: args.checksumSha256,
          IfNoneMatch: '*',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: args.retainUntil,
          ExpectedBucketOwner: this.config.expectedOwner,
        }),
      );
      if (!response.VersionId) {
        throw new Error('Exact-operation witness authority did not return an immutable object version');
      }
      const inventory = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.config.bucket,
          Prefix: args.key,
          ExpectedBucketOwner: this.config.expectedOwner,
        }),
      );
      const exactVersions = (inventory.Versions ?? []).filter(version => version.Key === args.key);
      if (
        inventory.IsTruncated !== false ||
        (inventory.DeleteMarkers?.length ?? 0) !== 0 ||
        exactVersions.length !== 1 ||
        exactVersions[0]?.VersionId !== response.VersionId
      ) {
        throw new ExactApprovalClaimCollisionError();
      }
      return { versionId: response.VersionId };
    } catch (cause) {
      if (cause instanceof ExactApprovalClaimCollisionError || isConditionalCollision(cause)) {
        throw new ExactApprovalClaimCollisionError();
      }
      throw new Error('Exact-operation witness conditional claim failed', { cause });
    }
  }

  async verify(args: {
    key: string;
    versionId: string;
    checksumSha256: string;
    retainUntil: Date;
  }): Promise<void> {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: args.key,
        VersionId: args.versionId,
        ChecksumMode: 'ENABLED',
        ExpectedBucketOwner: this.config.expectedOwner,
      }),
    );
    if (
      response.ObjectLockMode !== 'COMPLIANCE' ||
      response.ChecksumSHA256 !== args.checksumSha256 ||
      !(response.ObjectLockRetainUntilDate instanceof Date) ||
      response.ObjectLockRetainUntilDate.getTime() < args.retainUntil.getTime()
    ) {
      throw new Error('Exact-operation witness claim failed read-after-write verification');
    }
  }

  async readClaims(prefix: string): Promise<Array<{ claim: ExactApprovalClaim; receipt: ExactApprovalClaimReceipt }>> {
    await this.assertComplianceRetention();
    const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9._/-]{1,256}$/.test(normalizedPrefix)) {
      throw new Error('Exact-operation witness claim prefix is malformed');
    }
    const response = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.config.bucket,
        Prefix: `${normalizedPrefix}/`,
        ExpectedBucketOwner: this.config.expectedOwner,
      }),
    );
    if (response.IsTruncated !== false || (response.DeleteMarkers?.length ?? 0) !== 0) {
      throw new Error('Exact-operation witness claim inventory is incomplete or contains deletion state');
    }
    const versions = (response.Versions ?? []).map(version => {
      if (
        !version.Key ||
        !version.VersionId ||
        !version.Key.startsWith(`${normalizedPrefix}/`) ||
        !version.Key.endsWith('.json')
      ) {
        throw new Error('Exact-operation witness prefix contains an unrecognized object');
      }
      return { key: version.Key, versionId: version.VersionId };
    });
    return await Promise.all(versions.map(version => this.readClaim(version.key, version.versionId)));
  }

  private async readClaim(
    key: string,
    versionId: string,
  ): Promise<{ claim: ExactApprovalClaim; receipt: ExactApprovalClaimReceipt }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        VersionId: versionId,
        ChecksumMode: 'ENABLED',
        ExpectedBucketOwner: this.config.expectedOwner,
      }),
    );
    if (!response.Body) throw new Error('Exact-operation witness claim cannot be read');
    const body = await response.Body.transformToString('utf-8');
    const claim = parseExactApprovalClaim(body);
    const checksumSha256 = createHash('sha256').update(body).digest('base64');
    if (
      response.ChecksumSHA256 !== checksumSha256 ||
      response.ObjectLockMode !== 'COMPLIANCE' ||
      !(response.ObjectLockRetainUntilDate instanceof Date)
    ) {
      throw new Error('Exact-operation witness claim has invalid checksum or compliance retention');
    }
    const receipt = {
      key,
      versionId,
      checksumSha256,
      retainUntil: response.ObjectLockRetainUntilDate.toISOString(),
      body,
    };
    await verifyExactApprovalClaimReceipt(this, receipt);
    return { claim, receipt };
  }
}

export async function verifyExactApprovalClaimReceipt(
  store: ExactApprovalClaimStore,
  receipt: ExactApprovalClaimReceipt,
): Promise<void> {
  await store.assertComplianceRetention();
  const retainUntil = new Date(receipt.retainUntil);
  if (Number.isNaN(retainUntil.getTime())) {
    throw new Error('Local exact-operation witness receipt has an invalid retention date');
  }
  await store.verify({
    key: receipt.key,
    versionId: receipt.versionId,
    checksumSha256: receipt.checksumSha256,
    retainUntil,
  });
}



function isConditionalCollision(cause: unknown): boolean {
  const error = cause as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    error.$metadata?.httpStatusCode === 409 ||
    error.$metadata?.httpStatusCode === 412 ||
    error.name === 'PreconditionFailed' ||
    error.name === 'ConditionalRequestConflict'
  );
}

function parseExactApprovalClaim(body: string): ExactApprovalClaim {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new Error('Exact-operation witness claim is malformed JSON', { cause });
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object' || canonicalJson(value) !== body) {
    throw new Error('Exact-operation witness claim is not canonical JSON');
  }
  const record = value as Record<string, unknown>;
  const keys: Array<keyof ExactApprovalClaim> = [
    'schema',
    'approvalCommitment',
    'stageAApprovalDigest',
    'chainId',
    'rollupVersion',
    'deploymentLabel',
    'portal',
    'operationId',
    'sourceCommit',
    'imageDigest',
    'targetHost',
    'signerAddress',
    'schemaIdentity',
    'stateInventoryDigest',
    'canonicalStateDigest',
  ];
  if (
    Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0') ||
    keys.some(key => typeof record[key] !== 'string' || record[key].length === 0) ||
    record.schema !== CLAIM_SCHEMA
  ) {
    throw new Error('Exact-operation witness claim has an unrecognized schema');
  }
  return record as unknown as ExactApprovalClaim;
}


function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
