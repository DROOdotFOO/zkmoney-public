import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';

import { RuntimeLease } from './runtime_lease.js';

const directories: string[] = [];
const PREVALIDATED_HANDOFF_DIGEST = `sha256:${'11'.repeat(32)}` as const;
const CLEAN_HANDOFF = JSON.stringify({ schema: 1, kind: 'generic', clean: true });

const acquireExact = (filename: string) =>
  RuntimeLease.acquire(filename, 'exact-operation', {
    prevalidatedExactHandoffDigest: PREVALIDATED_HANDOFF_DIGEST,
  });

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

/** A lease in its own control directory, and the handoff marker beside separate generic state. */
async function leasePaths(): Promise<{ lease: string; marker: string }> {
  const [control, data] = await Promise.all([
    temporaryDirectory('oxide-runtime-lease-'),
    temporaryDirectory('oxide-runtime-data-'),
  ]);
  return { lease: join(control, 'runtime.sqlite3'), marker: join(data, 'runtime.sqlite3.clean-handoff.json') };
}

const acquireGeneric = ({ lease, marker }: { lease: string; marker: string }) =>
  RuntimeLease.acquire(lease, 'generic', { cleanHandoffPath: marker });

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('RuntimeLease', () => {
  it('prevents generic and exact runtimes from running concurrently', async () => {
    const paths = await leasePaths();
    const generic = await acquireGeneric(paths);
    await expect(acquireExact(paths.lease)).rejects.toThrow(/already held/);
    await generic.close({ cleanHandoff: true });

    const exact = await acquireExact(paths.lease);
    await exact.activateExactHandoff(PREVALIDATED_HANDOFF_DIGEST);
    await exact.close();
    await expect(readFile(paths.marker, 'utf8')).resolves.toBe(CLEAN_HANDOFF);
  });

  it('writes the clean handoff marker at the configured path beside generic state, not beside the lease', async () => {
    const paths = await leasePaths();
    const generic = await acquireGeneric(paths);
    await generic.close({ cleanHandoff: true });
    await expect(readFile(paths.marker, 'utf8')).resolves.toBe(CLEAN_HANDOFF);
    await expect(readFile(`${paths.lease}.clean-handoff.json`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // The next generic start withdraws the marker before it can sign anything.
    const restarted = await acquireGeneric(paths);
    await expect(readFile(paths.marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();
  });

  it('requires the marker path for the generic runtime', async () => {
    const { lease } = await leasePaths();
    await expect(RuntimeLease.acquire(lease, 'generic')).rejects.toThrow(/clean handoff marker path/);
  });

  it('preserves clean handoff until exact runtime identity passes', async () => {
    const paths = await leasePaths();
    const generic = await acquireGeneric(paths);
    await generic.close({ cleanHandoff: true });

    const rejectedIdentity = await acquireExact(paths.lease);
    await expect(rejectedIdentity.activateExactHandoff(`sha256:${'22'.repeat(32)}`)).rejects.toThrow(
      /evidence changed/,
    );
    await rejectedIdentity.close();
    const correctedIdentity = await acquireExact(paths.lease);
    await correctedIdentity.activateExactHandoff(PREVALIDATED_HANDOFF_DIGEST);
    await correctedIdentity.close();
    await expect(readFile(paths.marker, 'utf8')).resolves.toBe(CLEAN_HANDOFF);
  });

  it('recovers a complete interrupted handoff marker write', async () => {
    const paths = await leasePaths();
    const generic = await acquireGeneric(paths);
    await writeFile(`${paths.marker}.tmp`, CLEAN_HANDOFF, { mode: 0o600 });
    await generic.close({ cleanHandoff: true });
    await expect(readFile(paths.marker, 'utf8')).resolves.toBe(CLEAN_HANDOFF);
  });

  it('replaces a torn handoff temp only while the generic lease is held', async () => {
    const paths = await leasePaths();
    const generic = await acquireGeneric(paths);
    await writeFile(`${paths.marker}.tmp`, '', { mode: 0o600 });
    await generic.close({ cleanHandoff: true });
    await expect(readFile(paths.marker, 'utf8')).resolves.toBe(CLEAN_HANDOFF);
  });

  it('refuses exact-operation startup without privileged prevalidated handoff evidence', async () => {
    const { lease } = await leasePaths();
    await expect(RuntimeLease.acquire(lease, 'exact-operation')).rejects.toThrow(/privileged prevalidated/);
  });

  it('rejects an unknown existing lease schema before runtime startup', async () => {
    const paths = await leasePaths();
    const database = await open({ filename: paths.lease, driver: sqlite3Driver.Database });
    await database.exec('CREATE TABLE unrelated (value TEXT)');
    await database.close();
    await chmod(paths.lease, 0o600);

    await expect(acquireGeneric(paths)).rejects.toThrow(/canonical runtime lease schema/);
  });

  it('rejects a substituted lease symlink', async () => {
    const paths = await leasePaths();
    const target = `${paths.lease}.target`;
    await writeFile(target, '', { mode: 0o600 });
    await symlink(target, paths.lease);
    await expect(acquireGeneric(paths)).rejects.toThrow(/owner-only regular file/);
  });
});
