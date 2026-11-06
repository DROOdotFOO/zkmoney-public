import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { statePathForPortal, supportsExactOperationHandoff } from './path.js';

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

describe('supportsExactOperationHandoff', () => {
  it('allows only the canonical generic state inventory', () => {
    expect(supportsExactOperationHandoff('/data/oxide-relayer-{portal}.sqlite3')).toBe(true);
    expect(supportsExactOperationHandoff('/data/custom-{portal}.sqlite3')).toBe(false);
    expect(supportsExactOperationHandoff('/outside/oxide-relayer-{portal}.sqlite3')).toBe(false);
  });
});
