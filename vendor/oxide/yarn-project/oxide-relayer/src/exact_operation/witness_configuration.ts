import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const configurationSchema = z.strictObject({
  schema: z.literal('oxide-relayer.witness-config.v2'),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  region: z.string().regex(/^[a-z0-9-]+$/),
  expectedOwner: z.string().regex(/^[0-9]{12}$/),
  prefix: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/),
  principalArn: z.string().min(1),
  accessKeyOpRef: z.string().min(1),
  secretKeyOpRef: z.string().min(1),
  policySha256: sha256,
  objectLockEnabledAtCreation: z.literal(true),
  retainUntil: z.literal('9999-12-31T23:59:59.000Z'),
  serverSideEncryption: z.literal('AES256'),
  aztecNodeUrl: z.string().url(),
  signerKeystoreOpRef: z.string().min(1),
  signerPasswordOpRef: z.string().min(1),
  authorityCommitment: sha256,
  configurationDigest: sha256,
});

export type WitnessConfiguration = z.infer<typeof configurationSchema>;

export async function loadWitnessConfiguration(): Promise<WitnessConfiguration> {
  const filename = requiredFileEnvironment('OXIDE_EXACT_WITNESS_CONFIG_FILE');
  let input: unknown;
  try {
    input = JSON.parse(await readFile(filename, 'utf8'));
  } catch (cause) {
    throw new Error('Private witness configuration is malformed', { cause });
  }
  const configuration = configurationSchema.parse(input);
  const authority = {
    expectedOwner: configuration.expectedOwner,
    principalArn: configuration.principalArn,
    policySha256: configuration.policySha256,
    objectLockEnabledAtCreation: configuration.objectLockEnabledAtCreation,
    retainUntil: configuration.retainUntil,
    serverSideEncryption: configuration.serverSideEncryption,
  };
  const authorityCommitment = digest('oxide-relayer/witness-authority/v1\0', canonicalJson(authority));
  const { configurationDigest: _configurationDigest, ...withoutConfigurationDigest } = configuration;
  const configurationDigest = digest('oxide-relayer/witness-config/v2\0', canonicalJson(withoutConfigurationDigest));
  if (
    configuration.authorityCommitment !== authorityCommitment ||
    configuration.configurationDigest !== configurationDigest
  ) {
    throw new Error('Private witness configuration commitment does not match its reviewed authority');
  }
  return configuration;
}

export async function loadWitnessCredentials(): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const [accessKeyId, secretAccessKey] = await Promise.all([
    readSecretFile('OXIDE_EXACT_WITNESS_ACCESS_KEY_ID_FILE'),
    readSecretFile('OXIDE_EXACT_WITNESS_SECRET_ACCESS_KEY_FILE'),
  ]);
  return { accessKeyId, secretAccessKey };
}

export async function loadAztecNodeUrl(): Promise<string> {
  const value = process.env.AZTEC_NODE_URL_FILE
    ? await readSecretFile('AZTEC_NODE_URL_FILE')
    : requiredEnvironment('AZTEC_NODE_URL');
  try {
    return new URL(value).toString();
  } catch (cause) {
    throw new Error('Private Aztec node URL is malformed', { cause });
  }
}

async function readSecretFile(name: string): Promise<string> {
  const value = (await readFile(requiredFileEnvironment(name), 'utf8')).trim();
  if (!value || Buffer.byteLength(value) > 64 * 1024) throw new Error('Root-opened runtime input is empty or oversized');
  return value;
}

function requiredFileEnvironment(name: string): string {
  const value = process.env[name];
  if (!/^\/proc\/self\/fd\/[0-9]+$/.test(value ?? '')) {
    throw new Error('Runtime credential descriptor was not installed by the root initializer');
  }
  return value!;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required runtime configuration is missing ${name}`);
  return value;
}

function digest(domain: string, value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(domain).update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
