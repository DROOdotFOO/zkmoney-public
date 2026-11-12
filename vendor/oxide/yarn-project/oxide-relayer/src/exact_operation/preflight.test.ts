import { describe, expect, it, jest } from '@jest/globals';

import { preflightExactOperation } from './preflight.js';
import { closeRetainedSecretDescriptors, installInheritedBundleBuffer } from './runtime_sandbox.js';
import { exactApprovalFixture } from './test_fixture.js';

describe('preflightExactOperation', () => {
  it('consumes only the nonsecret bundle and exercises prepared immutable evidence without side effects', async () => {
    const input = Buffer.from('{"schema":"oxide-relayer.preflight-exact.v1"}\n');
    installInheritedBundleBuffer(['preflight-exact', '--bundle-fd', '0'], () => input);
    const loadRuntimeIdentity = jest.fn(async () => exactApprovalFixture().runtime);
    const loadCleanHandoffDigest = jest.fn(() => `sha256:${'12'.repeat(32)}` as const);

    await expect(
      preflightExactOperation(
        { bundleFd: 0, canonicalState: '/canonical', controlDir: '/control' },
        { loadRuntimeIdentity, loadCleanHandoffDigest },
      ),
    ).resolves.toBeUndefined();

    expect(loadRuntimeIdentity).toHaveBeenCalledTimes(1);
    expect(loadCleanHandoffDigest).toHaveBeenCalledTimes(1);
    expect(input.every(byte => byte === 0)).toBe(true);
  });

  it('refuses alternate paths before consuming the inherited bundle', async () => {
    const input = Buffer.from('{"schema":"oxide-relayer.preflight-exact.v1"}');
    installInheritedBundleBuffer(['preflight-exact', '--bundle-fd', '3'], () => input);
    await expect(
      preflightExactOperation(
        { bundleFd: 3, canonicalState: '/tmp/canonical', controlDir: '/control' },
        {
          loadRuntimeIdentity: jest.fn(async () => exactApprovalFixture().runtime),
          loadCleanHandoffDigest: jest.fn(() => `sha256:${'12'.repeat(32)}` as const),
        },
      ),
    ).rejects.toThrow(/fixed runtime mount contract/);
    closeRetainedSecretDescriptors();
  });
});
