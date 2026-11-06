import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';

import { RuntimeLease, cleanHandoffPath } from './runtime_lease.js';

const directories: string[] = [];
const PREVALIDATED_HANDOFF_DIGEST = `sha256:${'11'.repeat(32)}` as const;

const acquireExact = (filename: string) =>
  RuntimeLease.acquire(filename, 'exact-operation', {
    prevalidatedExactHandoffDigest: PREVALIDATED_HANDOFF_DIGEST,
  });


async function leasePath(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-runtime-lease-')));
  directories.push(directory);
  return join(directory, 'runtime.sqlite3');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('RuntimeLease', () => {
  it('prevents generic and exact runtimes from running concurrently', async () => {
    const path = await leasePath();
    const generic = await RuntimeLease.acquire(path, 'generic');
    await expect(acquireExact(path)).rejects.toThrow(/already held/);
    await generic.close({ cleanHandoff: true });

    const exact = await acquireExact(path);
    await exact.activateExactHandoff();
    await exact.close();
    await expect(readFile(cleanHandoffPath(path), 'utf8')).resolves.toBe(
      JSON.stringify({ schema: 1, kind: 'generic', clean: true }),
    );
  });
  it('preserves clean handoff until exact runtime identity passes', async () => {
    const path = await leasePath();
    const generic = await RuntimeLease.acquire(path, 'generic');
    await generic.close({ cleanHandoff: true });

    const rejectedIdentity = await acquireExact(path);
    await rejectedIdentity.close();
    const correctedIdentity = await acquireExact(path);
    await correctedIdentity.activateExactHandoff();
    await correctedIdentity.close();
  });
  it('recovers a complete interrupted handoff marker write', async () => {
    const path = await leasePath();
    const generic = await RuntimeLease.acquire(path, 'generic');
    await writeFile(
      `${cleanHandoffPath(path)}.tmp`,
      JSON.stringify({ schema: 1, kind: 'generic', clean: true }),
      { mode: 0o600 },
    );
    await generic.close({ cleanHandoff: true });

    const exact = await acquireExact(path);
    await exact.activateExactHandoff();
    await exact.close();
  });
  it('replaces a torn handoff temp only while the generic lease is held', async () => {
    const path = await leasePath();
    const generic = await RuntimeLease.acquire(path, 'generic');
    await writeFile(`${cleanHandoffPath(path)}.tmp`, '', { mode: 0o600 });
    await generic.close({ cleanHandoff: true });

    const exact = await acquireExact(path);
    await exact.activateExactHandoff();
    await exact.close();
  });





  it('refuses exact-operation startup without privileged prevalidated handoff evidence', async () => {
    const path = await leasePath();
    await expect(RuntimeLease.acquire(path, 'exact-operation')).rejects.toThrow(/privileged prevalidated/);
  });

  it('rejects an unknown existing lease schema before runtime startup', async () => {
    const path = await leasePath();
    const database = await open({ filename: path, driver: sqlite3Driver.Database });
    await database.exec('CREATE TABLE unrelated (value TEXT)');
    await database.close();
    await chmod(path, 0o600);

    await expect(RuntimeLease.acquire(path, 'generic')).rejects.toThrow(/canonical runtime lease schema/);
  });

  it('rejects a substituted lease symlink', async () => {
    const path = await leasePath();
    const target = `${path}.target`;
    await writeFile(target, '', { mode: 0o600 });
    await symlink(target, path);
    await expect(RuntimeLease.acquire(path, 'generic')).rejects.toThrow(/owner-only regular file/);
  });
});
