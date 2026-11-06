import { describe, expect, it } from '@jest/globals';

import {
  EXACT_WITNESS_ACCESS_KEY_ID_PATH,
  EXACT_WITNESS_CONFIG_PATH,
  EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
} from './paths.js';
import { assertCanonicalHandoffArtifact } from './runtime_identity.js';
import {
  assertCanonicalRootObject,
  assertDistinctRuntimeMounts,
  assertFinalPrivilegeState,
  assertStartupPrivilegeState,
  consumePreparedInheritedBundle,
  consumePreparedRuntimeInput,
  installInheritedBundleBuffer,
  prepareRootOnlyRuntimeInputs,
  parseDedicatedIdentity,
  parseMountInfo,
  rejectRawSecretEnvironment,
  runtimeProfileFromArguments,
} from './runtime_sandbox.js';

const DEDICATED_IDENTITY = 65532;

function status(overrides: Partial<Record<string, string>> = {}): string {
  const values = {
    Uid: `${DEDICATED_IDENTITY}\t${DEDICATED_IDENTITY}\t${DEDICATED_IDENTITY}\t${DEDICATED_IDENTITY}`,
    Gid: `${DEDICATED_IDENTITY}\t${DEDICATED_IDENTITY}\t${DEDICATED_IDENTITY}\t${DEDICATED_IDENTITY}`,
    Groups: '',
    CapInh: '0000000000000000',
    CapPrm: '0000000000000000',
    CapEff: '0000000000000000',
    CapBnd: '00000000000000c4',
    CapAmb: '0000000000000000',
    NoNewPrivs: '1',
    ...overrides,
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}:\t${value}`)
    .join('\n');
}

describe('runtime sandbox', () => {
  it('assigns exact, preflight, and restore commands to privileged-drop profiles', () => {
    expect(runtimeProfileFromArguments(['relay-exact'])).toBe('exact');
    expect(runtimeProfileFromArguments(['preflight-exact'])).toBe('preflight-exact');
    expect(runtimeProfileFromArguments(['authorize-generic-restore'])).toBe('restore');
    expect(runtimeProfileFromArguments(['run'], { OXIDE_RUNTIME_PROFILE: 'generic-restore' })).toBe('generic-restore');
    expect(() => runtimeProfileFromArguments(['run'])).toThrow(
      'Root initializer permits only reviewed exact, preflight, or restore runtime modes',
    );
  });

  it('reads inherited standard input into memory before logical privilege drop and never reopens it', () => {
    const input = Buffer.from('{\"schema\":\"oxide-relayer.preflight-exact.v1\"}');
    let reads = 0;
    let closed = false;
    expect(
      installInheritedBundleBuffer(
        ['preflight-exact', '--bundle-fd', '0'],
        fd => {
          reads++;
          expect(fd).toBe(0);
          return input;
        },
        fd => {
          expect(fd).toBe(0);
          closed = true;
        },
      ),
    ).toEqual(['preflight-exact', '--bundle-fd', '0']);
    expect(reads).toBe(1);
    expect(closed).toBe(true);

    const prepared = consumePreparedInheritedBundle(0);
    expect(prepared.toString('utf8')).toContain('preflight-exact.v1');
    prepared.fill(0);
    expect(reads).toBe(1);
    expect(input.every(byte => byte === 0)).toBe(true);
  });

  it('refuses empty or oversized inherited approval input', () => {
    expect(() =>
      installInheritedBundleBuffer(
        ['preflight-exact', '--bundle-fd', '0'],
        () => Buffer.alloc(0),
        () => {},
      ),
    ).toThrow('Inherited approval bundle is empty or exceeds 64 KiB');
    expect(() =>
      installInheritedBundleBuffer(
        ['preflight-exact', '--bundle-fd', '0'],
        () => Buffer.alloc(64 * 1024 + 1, 0x61),
        () => {},
      ),
    ).toThrow('Inherited approval bundle is empty or exceeds 64 KiB');
  });
  it('consumes root-only inputs from memory without reopening their paths after logical drop', () => {
    let dropped = false;
    let reads = 0;
    prepareRootOnlyRuntimeInputs('restore', filename => {
      if (dropped) throw new Error(`post-drop reopen attempted: ${filename}`);
      reads++;
      return Buffer.from(`prepared:${filename}`);
    });
    dropped = true;

    for (const filename of [
      EXACT_WITNESS_ACCESS_KEY_ID_PATH,
      EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
      EXACT_WITNESS_CONFIG_PATH,
    ]) {
      const prepared = consumePreparedRuntimeInput(filename);
      expect(prepared.toString('utf8')).toBe(`prepared:${filename}`);
      prepared.fill(0);
    }
    expect(reads).toBe(3);
  });


  it('requires the dedicated identity and prohibits root and UID/GID 1000', () => {
    expect(parseDedicatedIdentity(String(DEDICATED_IDENTITY), 'UID')).toBe(DEDICATED_IDENTITY);
    for (const prohibited of ['0', '1000', '65531', '', 'not-a-number']) {
      expect(() => parseDedicatedIdentity(prohibited, 'UID')).toThrow();
      expect(() => parseDedicatedIdentity(prohibited, 'GID')).toThrow();
    }
  });

  it('rejects raw credentials in the environment', () => {
    expect(() => rejectRawSecretEnvironment({ AWS_SECRET_ACCESS_KEY: 'private' })).toThrow(
      'Raw credential environment variables are prohibited',
    );
    expect(() => rejectRawSecretEnvironment({ OXIDE_SIGNER_PRIVATE_KEY: 'private' })).toThrow(
      'Raw credential environment variables are prohibited',
    );
    expect(() => rejectRawSecretEnvironment({ AZTEC_NODE_URL_FILE: '/proc/self/fd/3' })).toThrow(
      'Raw credential environment variables are prohibited',
    );
    expect(() => rejectRawSecretEnvironment({ AZTEC_NODE_URL: 'https://credential@example.invalid' })).toThrow(
      'Raw credential environment variables are prohibited',
    );
  });

  it('accepts only the dedicated final identity with no active capabilities', () => {
    expect(() => assertFinalPrivilegeState(status(), DEDICATED_IDENTITY, DEDICATED_IDENTITY)).not.toThrow();
    expect(() => assertFinalPrivilegeState(status({ Groups: '1000' }), DEDICATED_IDENTITY, DEDICATED_IDENTITY)).toThrow(
      'Final runtime process retains supplementary groups',
    );
    for (const capability of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']) {
      expect(() =>
        assertFinalPrivilegeState(status({ [capability]: '0000000000000001' }), DEDICATED_IDENTITY, DEDICATED_IDENTITY),
      ).toThrow('Final runtime process retains Linux capabilities');
    }
    expect(() =>
      assertFinalPrivilegeState(status({ CapBnd: '00000000000000c1' }), DEDICATED_IDENTITY, DEDICATED_IDENTITY),
    ).toThrow('Runtime capability bound differs');
    expect(() => assertFinalPrivilegeState(status({ NoNewPrivs: '0' }), DEDICATED_IDENTITY, DEDICATED_IDENTITY)).toThrow(
      'Final runtime process is missing no-new-privileges',
    );
  });
  it('requires exactly DAC_READ_SEARCH, SETGID, and SETUID at startup', () => {
    const startup = status({
      Uid: '0\t0\t0\t0',
      Gid: '0\t0\t0\t0',
      CapPrm: '00000000000000c4',
      CapEff: '00000000000000c4',
    });
    expect(() => assertStartupPrivilegeState(startup)).not.toThrow();
    expect(() => assertStartupPrivilegeState(startup.replaceAll('00000000000000c4', '00000000000000c0'))).toThrow(
      /DAC_READ_SEARCH/,
    );
  });

  it('accepts a distinct read-only canonical bind backed by legacy UID/GID 1000 mode 0700 state', () => {
    const legacyCanonical = {
      uid: 1000,
      gid: 1000,
      mode: 0o40700,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
    expect(() => assertCanonicalRootObject(legacyCanonical)).not.toThrow();
  });

  it('accepts a legacy UID/GID 1000 mode 0600 handoff during privileged preflight', () => {
    const marker = {
      uid: 1000,
      gid: 1000,
      mode: 0o100600,
      nlink: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    expect(() => assertCanonicalHandoffArtifact(marker)).not.toThrow();
  });

  it('refuses path, bind, and inode aliases across runtime storage classes', () => {
    const canonical = { candidate: '/canonical', mountIdentity: '8:1:/:/dev/a', objectIdentity: '8:1' };
    const distinct = { candidate: '/control', mountIdentity: '8:2:/:/dev/b', objectIdentity: '8:2' };
    expect(() => assertDistinctRuntimeMounts([canonical, distinct])).not.toThrow();
    expect(() =>
      assertDistinctRuntimeMounts([
        canonical,
        { ...distinct, candidate: '/canonical/control' },
      ]),
    ).toThrow('must not alias');
    expect(() =>
      assertDistinctRuntimeMounts([
        canonical,
        { ...distinct, mountIdentity: canonical.mountIdentity },
      ]),
    ).toThrow('must not alias');
    expect(() =>
      assertDistinctRuntimeMounts([
        canonical,
        { ...distinct, objectIdentity: canonical.objectIdentity },
      ]),
    ).toThrow('must not alias');
  });

  it('parses canonical, control, secret, and tmpfs mount properties', () => {
    const entries = parseMountInfo(
      [
        '1 0 8:1 /canonical /canonical ro,nosuid,nodev,noexec - ext4 /dev/root ro',
        '2 0 8:2 /control /control rw,nosuid,nodev,noexec - ext4 /dev/control rw',
        '3 0 0:50 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw',
      ].join('\n'),
    );
    expect(entries[0]).toMatchObject({ mountPoint: '/canonical', options: new Set(['ro', 'nosuid', 'nodev', 'noexec']) });
    expect(entries[1]).toMatchObject({ mountPoint: '/control', options: new Set(['rw', 'nosuid', 'nodev', 'noexec']) });
    expect(entries[2]).toMatchObject({
      mountPoint: '/tmp',
      type: 'tmpfs',
      options: new Set(['rw', 'nosuid', 'nodev', 'noexec']),
    });
  });
});
