import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { readPrivilegedCleanHandoffDigest } from './runtime_identity.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('privileged canonical-state preflight', () => {
  it('reads an owner-only legacy handoff once without mutating canonical bytes', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'oxide-canonical-preflight-')));
    directories.push(directory);
    const marker = join(directory, 'oxide-relayer.runtime-lease.sqlite3.clean-handoff.json');
    const contents = Buffer.from(JSON.stringify({ schema: 1, kind: 'generic', clean: true }));
    await writeFile(marker, contents, { mode: 0o600 });

    await expect(readPrivilegedCleanHandoffDigest(marker)).resolves.toBe(
      `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    );
    await expect(readFile(marker)).resolves.toEqual(contents);
  });
});
