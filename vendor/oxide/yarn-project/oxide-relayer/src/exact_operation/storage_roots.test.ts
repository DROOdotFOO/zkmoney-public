import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { resolveExactStorageRoots } from './storage_roots.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('exact-operation storage roots', () => {
  it('refuses caller-selected storage roots', async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'oxide-exact-roots-')));
    directories.push(parent);
    const canonical = path.join(parent, 'canonical');
    const control = path.join(parent, 'control');
    await Promise.all([mkdir(canonical), mkdir(control)]);

    await expect(resolveExactStorageRoots(canonical, control)).rejects.toThrow(/immutable runtime interface/);
  });
});
