import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { exactStateSetDigest } from './state_set.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oxide-state-set-'));
  directories.push(directory);
  return directory;
}

describe('exactStateSetDigest', () => {
  it('binds generic SQLite and WAL bytes but excludes exact control state', async () => {
    const directory = await stateDirectory();
    const database = join(directory, `oxide-relayer-0x${'11'.repeat(20)}.sqlite3`);
    await writeFile(database, 'database');
    await writeFile(`${database}-wal`, 'wal');
    const before = await exactStateSetDigest(directory);

    await writeFile(join(directory, 'exact-operation.sqlite3'), 'journal');
    await writeFile(join(directory, 'oxide-relayer-{portal}.sqlite3.runtime-lease.sqlite3'), 'lease');
    await expect(exactStateSetDigest(directory)).resolves.toBe(before);

    await writeFile(`${database}-wal`, 'changed');
    await expect(exactStateSetDigest(directory)).resolves.not.toBe(before);
  });
  it('rejects symlinked generic state instead of omitting it', async () => {
    const directory = await stateDirectory();
    const target = join(directory, 'state-target');
    await writeFile(target, 'database');
    await symlink(target, join(directory, `oxide-relayer-0x${'11'.repeat(20)}.sqlite3`));
    await expect(exactStateSetDigest(directory)).rejects.toThrow('is not a regular file');
  });


  it('rejects startup without generic state', async () => {
    await expect(exactStateSetDigest(await stateDirectory())).rejects.toThrow(/No generic/);
  });
});
