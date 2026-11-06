import { describe, expect, it } from '@jest/globals';

import {
  assertDistinctRuntimeMounts,
  assertFinalPrivilegeState,
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
    CapBnd: '0000000000000000',
    CapAmb: '0000000000000000',
    NoNewPrivs: '1',
    ...overrides,
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}:\t${value}`)
    .join('\n');
}

describe('runtime sandbox', () => {
  it('assigns exact and restore commands to privileged-drop profiles', () => {
    expect(runtimeProfileFromArguments(['relay-exact'])).toBe('exact');
    expect(runtimeProfileFromArguments(['authorize-generic-restore'])).toBe('restore');
    expect(runtimeProfileFromArguments(['run'], { OXIDE_RUNTIME_PROFILE: 'generic-restore' })).toBe('generic-restore');
    expect(() => runtimeProfileFromArguments(['run'])).toThrow('Root initializer permits only reviewed exact or restore runtime modes');
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
    expect(() => rejectRawSecretEnvironment({ AZTEC_NODE_URL_FILE: '/proc/self/fd/3' })).not.toThrow();
  });

  it('accepts only the dedicated final identity with no groups or capabilities', () => {
    expect(() => assertFinalPrivilegeState(status(), DEDICATED_IDENTITY, DEDICATED_IDENTITY)).not.toThrow();
    expect(() => assertFinalPrivilegeState(status({ Groups: '1000' }), DEDICATED_IDENTITY, DEDICATED_IDENTITY)).toThrow(
      'Final runtime process retains supplementary groups',
    );
    expect(() =>
      assertFinalPrivilegeState(status({ CapEff: '0000000000000001' }), DEDICATED_IDENTITY, DEDICATED_IDENTITY),
    ).toThrow('Final runtime process retains Linux capabilities');
    expect(() => assertFinalPrivilegeState(status({ NoNewPrivs: '0' }), DEDICATED_IDENTITY, DEDICATED_IDENTITY)).toThrow(
      'Final runtime process is missing no-new-privileges',
    );
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
