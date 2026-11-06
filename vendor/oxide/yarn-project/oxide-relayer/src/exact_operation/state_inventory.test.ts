import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { verifyStateInventory } from './state_inventory.js';

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oxide-state-inventory-'));
  directories.push(directory);
  const dataDirectory = join(directory, 'data');
  await mkdir(dataDirectory, { mode: 0o700 });
  const databaseName = `oxide-relayer-0x${'11'.repeat(20)}.sqlite3`;
  const database = Buffer.from('canonical database');
  await writeFile(join(dataDirectory, databaseName), database, { mode: 0o600 });
  const metadata = await lstat(join(dataDirectory, databaseName));
  const artifacts = [
    {
      path: databaseName,
      present: true,
      size: database.length,
      sha256: digest(database),
      uid: metadata.uid,
      gid: metadata.gid,
      mode: (metadata.mode & 0o7777).toString(8).padStart(4, '0'),
    },
  ];
  const canonicalStateDigest = canonicalDigest(artifacts);
  const inventory = {
    schema: 'oxide-relayer.state-inventory.v3',
    container: {
      capAdd: [],
      capDrop: ['ALL'],
      command: ['node', '/app/dest/bin/oxide-relayer.js', 'run'],
      entrypoint: ['/usr/bin/tini', '--'],
      environment: [
        {
          name: 'DISABLE_SUBMISSION',
          valueSha256: digest(
            Buffer.from('oxide-relayer-container-environment-v1\0DISABLE_SUBMISSION=true'),
          ),
        },
      ],
      image: `example/relayer@sha256:${'22'.repeat(32)}`,
      ipcMode: 'private',
      labels: {
        'com.docker.compose.project': 'oxide-relayer',
        'com.docker.compose.service': 'relayer',
      },
      mounts: [
        {
          destination: '/data',
          mode: 'rw',
          propagation: 'rprivate',
          source: dataDirectory,
          type: 'bind',
          readOnly: false,
        },
      ],
      name: 'oxide-relayer',
      networkMode: 'oxide-relayer',
      pidMode: '',
      pidsLimit: 256,
      privileged: false,
      project: 'oxide-relayer',
      readOnlyRootfs: true,
      restartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      securityOptions: ['no-new-privileges:true'],
      service: 'relayer',
      user: '1000:1000',
      workingDirectory: '/app',
    },
    artifacts,
    canonicalStateDigest,
  };
  const input = `${canonicalJson(inventory)}\n`;
  const manifest = join(directory, 'state-inventory.json');
  await writeFile(manifest, input, { mode: 0o400 });
  return { dataDirectory, databaseName, manifest, inventory, input };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('state inventory', () => {
  it('binds complete mount and canonical-state evidence', async () => {
    const { dataDirectory, manifest, inventory, input } = await fixture();
    await expect(verifyStateInventory(manifest, dataDirectory)).resolves.toEqual({
      stateInventoryDigest: `sha256:${createHash('sha256')
        .update('oxide-relayer-state-inventory-v3\0')
        .update(input)
        .digest('hex')}`,
      canonicalStateDigest: inventory.canonicalStateDigest,
    });
  });

  it('refuses an unknown state artifact', async () => {
    const { dataDirectory, manifest } = await fixture();
    await writeFile(join(dataDirectory, 'unreviewed.sqlite3'), 'unknown');
    await expect(verifyStateInventory(manifest, dataDirectory)).rejects.toThrow('Unrecognized relayer state artifact');
  });

  it('refuses an exact journal beside canonical state', async () => {
    const { dataDirectory, manifest } = await fixture();
    await writeFile(join(dataDirectory, 'exact-operation.sqlite3'), 'misplaced control state');
    await expect(verifyStateInventory(manifest, dataDirectory)).rejects.toThrow(
      'Unrecognized relayer state artifact',
    );
  });

  it('refuses any byte change to unrelated canonical state', async () => {
    const { dataDirectory, databaseName, manifest } = await fixture();
    await writeFile(join(dataDirectory, databaseName), 'changed');
    await expect(verifyStateInventory(manifest, dataDirectory)).rejects.toThrow('Canonical relayer state artifact changed');
  });
});

function digest(input: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function canonicalDigest(artifacts: Array<Record<string, unknown>>): `sha256:${string}` {
  const digestValue = createHash('sha256').update('oxide-relayer-canonical-state-v2\0');
  for (const artifact of artifacts) {
    digestValue.update(
      `${artifact.path}\0${artifact.present ? artifact.size : '-'}\0${artifact.sha256 ?? '-'}\0` +
        `${artifact.uid ?? '-'}\0${artifact.gid ?? '-'}\0${artifact.mode ?? '-'}\0`,
    );
  }
  return `sha256:${digestValue.digest('hex')}`;
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
