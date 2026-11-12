import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { genericRuntimePaths, statePathForPortal } from './path.js';

const PORTAL = EthAddress.fromString('0x00000000000000000000000000000000000000ab');

describe('statePathForPortal', () => {
  it('expands every portal placeholder using the normalized address', () => {
    expect(statePathForPortal('/data/{portal}/relayer-{portal}.sqlite3', PORTAL, 3)).toBe(
      `/data/${PORTAL.toString().toLowerCase()}/relayer-${PORTAL.toString().toLowerCase()}.sqlite3`,
    );
  });

  it('preserves a fixed path for one deployment', () => {
    expect(statePathForPortal('/data/state.sqlite3', PORTAL, 1)).toBe('/data/state.sqlite3');
  });

  it('rejects a fixed path for multiple deployments', () => {
    expect(() => statePathForPortal('/data/state.sqlite3', PORTAL, 2)).toThrow(/must contain \{portal\}/);
  });
});

describe('genericRuntimePaths', () => {
  it('keeps the journal and clean handoff beside the state, and the lease in the control directory', () => {
    expect(genericRuntimePaths('/srv/relayer/state-{portal}.sqlite3', '/srv/control')).toEqual({
      dataDirectory: '/srv/relayer',
      controlDirectory: '/srv/control',
      submissionJournal: '/srv/relayer/generic-submission.sqlite3',
      runtimeLease: '/srv/control/oxide-relayer.runtime-lease.sqlite3',
      cleanHandoff: '/srv/relayer/oxide-relayer.runtime-lease.sqlite3.clean-handoff.json',
      exactHandoff: false,
    });
  });

  it('places the image layout handoff where the exact runtime reads it under /canonical', () => {
    expect(genericRuntimePaths('/data/oxide-relayer-{portal}.sqlite3', '/control')).toMatchObject({
      submissionJournal: '/data/generic-submission.sqlite3',
      runtimeLease: '/control/oxide-relayer.runtime-lease.sqlite3',
      cleanHandoff: '/data/oxide-relayer.runtime-lease.sqlite3.clean-handoff.json',
      exactHandoff: true,
    });
    expect(genericRuntimePaths('/data/custom-{portal}.sqlite3', '/control').exactHandoff).toBe(false);
    expect(genericRuntimePaths('/data/oxide-relayer-{portal}.sqlite3', '/srv/control').exactHandoff).toBe(false);
  });

  it('rejects a portal placeholder in the state directory', () => {
    expect(() => genericRuntimePaths('/data/{portal}/state.sqlite3', '/control')).toThrow(/must not contain/);
  });
});
