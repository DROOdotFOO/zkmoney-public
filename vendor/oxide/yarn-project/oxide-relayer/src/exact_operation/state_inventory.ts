import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const artifactSchema = z.strictObject({
  path: z.string().regex(/^[A-Za-z0-9._/-]{1,512}$/),
  present: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  sha256: sha256.optional(),
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
  mode: z.string().regex(/^[0-7]{4}$/).optional(),
});
const mountSchema = z.strictObject({
  destination: z.string().min(1),
  mode: z.string(),
  propagation: z.string(),
  source: z.string().min(1),
  type: z.enum(['bind', 'volume', 'tmpfs']),
  readOnly: z.boolean(),
});
const environmentSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  valueSha256: sha256,
});
const inventorySchema = z.strictObject({
  schema: z.literal('oxide-relayer.state-inventory.v3'),
  container: z.strictObject({
    capAdd: z.array(z.string()),
    capDrop: z.array(z.string()),
    command: z.array(z.string()).nullable(),
    entrypoint: z.array(z.string()).nullable(),
    environment: z.array(environmentSchema),
    image: z.string().min(1),
    ipcMode: z.string(),
    labels: z.record(z.string(), z.string()),
    mounts: z.array(mountSchema).min(1),
    name: z.string().min(1),
    networkMode: z.string(),
    pidMode: z.string(),
    pidsLimit: z.number().int().nullable(),
    privileged: z.boolean(),
    project: z.string().min(1),
    readOnlyRootfs: z.boolean(),
    restartPolicy: z.strictObject({
      Name: z.string(),
      MaximumRetryCount: z.number().int().nonnegative(),
    }),
    securityOptions: z.array(z.string()),
    service: z.string().min(1),
    user: z.string(),
    workingDirectory: z.string(),
  }),
  artifacts: z.array(artifactSchema).min(1),
  canonicalStateDigest: sha256,
});

type StateInventory = z.infer<typeof inventorySchema>;

export async function verifyStateInventory(
  manifestPath: string,
  dataDirectory: string,
): Promise<{ stateInventoryDigest: `sha256:${string}`; canonicalStateDigest: `sha256:${string}` }> {
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.nlink !== 1) {
    throw new Error('State inventory manifest is not one regular file');
  }
  const input = await readFile(manifestPath, 'utf8');
  let inventory: StateInventory;
  try {
    inventory = inventorySchema.parse(JSON.parse(input));
  } catch (cause) {
    throw new Error('State inventory manifest is malformed', { cause });
  }
  if (`${canonicalJson(inventory)}\n` !== input) {
    throw new Error('State inventory manifest is not canonical JSON');
  }
  validateContainer(inventory.container);
  validateArtifacts(inventory.artifacts);

  const actualPaths = await listFiles(dataDirectory);
  const approvedPaths = new Set(inventory.artifacts.map(artifact => artifact.path));
  const unknown = actualPaths.find(filename => !approvedPaths.has(filename));
  if (unknown) throw new Error(`Unrecognized relayer state artifact: ${unknown}`);

  for (const artifact of inventory.artifacts) {
    const filename = path.join(dataDirectory, artifact.path);
    const present = actualPaths.includes(artifact.path);
    if (present !== artifact.present) {
      throw new Error(`Canonical relayer state artifact presence changed: ${artifact.path}`);
    }
    if (present) {
      const metadata = await lstat(filename);
      const digest = await fileDigest(filename);
      const mode = (metadata.mode & 0o7777).toString(8).padStart(4, '0');
      if (
        metadata.size !== artifact.size ||
        metadata.uid !== artifact.uid ||
        metadata.gid !== artifact.gid ||
        mode !== artifact.mode ||
        digest !== artifact.sha256
      ) {
        throw new Error(`Canonical relayer state artifact changed: ${artifact.path}`);
      }
    }
  }

  const canonicalStateDigest = canonicalDigest(inventory.artifacts);
  if (canonicalStateDigest !== inventory.canonicalStateDigest) {
    throw new Error('Canonical relayer state digest does not match the inventory manifest');
  }
  return {
    stateInventoryDigest: `sha256:${createHash('sha256')
      .update('oxide-relayer-state-inventory-v3\0')
      .update(input)
      .digest('hex')}`,
    canonicalStateDigest,
  };
}

function validateContainer(container: StateInventory['container']): void {
  if (
    container.labels['com.docker.compose.project'] !== container.project ||
    container.labels['com.docker.compose.service'] !== container.service
  ) {
    throw new Error('State inventory Compose identity is missing or inconsistent');
  }
  const environmentNames = container.environment.map(variable => variable.name);
  if (
    new Set(environmentNames).size !== environmentNames.length ||
    [...environmentNames].sort().some((value, index) => value !== environmentNames[index])
  ) {
    throw new Error('State inventory environment commitments must be unique and sorted');
  }
}


function validateArtifacts(artifacts: StateInventory['artifacts']): void {
  const paths = artifacts.map(artifact => artifact.path);
  if (new Set(paths).size !== paths.length || [...paths].sort().some((value, index) => value !== paths[index])) {
    throw new Error('State inventory artifacts must be unique and sorted');
  }
  for (const artifact of artifacts) {
    if (artifact.path.startsWith('/') || artifact.path.split('/').includes('..')) {
      throw new Error('State inventory artifact path escapes the state directory');
    }
    const metadata = [artifact.size, artifact.sha256, artifact.uid, artifact.gid, artifact.mode];
    if (artifact.present !== metadata.every(value => value !== undefined)) {
      throw new Error('State inventory artifact presence metadata is inconsistent');
    }
  }
  if (!artifacts.some(artifact => /^oxide-relayer-.*\.sqlite3$/.test(artifact.path))) {
    throw new Error('State inventory contains no canonical portal database');
  }
}

async function listFiles(root: string): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  const files: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Relayer state contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) await walk(filename, relative);
      else if (entry.isFile()) {
        const metadata = await lstat(filename);
        if (metadata.nlink !== 1 || !(await realpath(filename)).startsWith(`${canonicalRoot}/`)) {
          throw new Error(`Relayer state artifact is not one contained regular file: ${relative}`);
        }
        files.push(relative);
      } else throw new Error(`Relayer state contains an unsupported artifact: ${relative}`);
    }
  }
  await walk(canonicalRoot, '');
  return files.sort();
}

async function fileDigest(filename: string): Promise<`sha256:${string}`> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}

function canonicalDigest(artifacts: StateInventory['artifacts']): `sha256:${string}` {
  const digest = createHash('sha256').update('oxide-relayer-canonical-state-v2\0');
  for (const artifact of artifacts) {
    digest.update(
      `${artifact.path}\0${artifact.present ? artifact.size : '-'}\0${artifact.sha256 ?? '-'}\0` +
        `${artifact.uid ?? '-'}\0${artifact.gid ?? '-'}\0${artifact.mode ?? '-'}\0`,
    );
  }
  return `sha256:${digest.digest('hex')}`;
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
