import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { type ResolveDeploymentEnvManifestOptions, resolveDeploymentEnvManifest } from './deployment_env_manifest.js';

const URL = 'https://manifest.example/v1/prod/releases.json';
const PORTAL = '0x0000000000000000000000000000000000000001';
const OTHER_PORTAL = '0x0000000000000000000000000000000000000010';
const THIRD_PORTAL = '0x0000000000000000000000000000000000000011';
const L2_TOKEN = '0x' + '11'.repeat(32);
const TOKEN = '0x0000000000000000000000000000000000000006';
const OTHER_TOKEN = '0x0000000000000000000000000000000000000016';
const BROADCASTER = '0x' + '22'.repeat(32);
const OPERATION_EXECUTOR = '0x0000000000000000000000000000000000000004';
const PLAIN_WITHDRAWAL_EXECUTOR = '0x0000000000000000000000000000000000000009';
const ENCLAVE_URL = 'https://enclave.example/rpc';
const PROVER_SUBSIDY = '0x000000000000000000000000000000000000000a';
const FPC_FUNDER = '0x0000000000000000000000000000000000000007';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'v4',
    withdrawalProtocol: 'l1-operation',
    portal: PORTAL,
    l2Token: L2_TOKEN,
    token: TOKEN,
    rollupVersion: '4',
    enclaveUrl: ENCLAVE_URL,
    l2Broadcaster: BROADCASTER,
    proverSubsidy: PROVER_SUBSIDY,
    plainWithdrawalExecutor: PLAIN_WITHDRAWAL_EXECUTOR,
    operationExecutor: OPERATION_EXECUTOR,
    fpcFunder: FPC_FUNDER,
    ...overrides,
  };
}

/** The fields that select the entries the relayer watches. */
const SELECTION_FIELDS = ['portal', 'rollupVersion', 'withdrawalProtocol'];

/** The fields that each bridge of a deployment has. The other fields are shared by the deployment. */
const BRIDGE_FIELDS = ['portal', 'l2Token', 'token', 'proverSubsidy', 'plainWithdrawalExecutor', 'fpcFunder'];

/** A schema v5 deployment with one bridge for each entry. The shared fields come from the first entry. */
function deployment(...entries: Record<string, unknown>[]): Record<string, unknown> {
  const pick = (fields: Record<string, unknown>, bridge: boolean) =>
    Object.fromEntries(Object.entries(fields).filter(([key]) => BRIDGE_FIELDS.includes(key) === bridge));
  return { ...pick(entries[0]!, false), bridges: entries.map(item => pick(item, true)) };
}

function releases(...deployments: Record<string, unknown>[]): string {
  return JSON.stringify({ schemaVersion: '5', deployments });
}

/** A document with one single-bridge deployment for each entry. */
function document(...entries: Record<string, unknown>[]): string {
  return releases(...entries.map(item => deployment(item)));
}

type Policy = Pick<ResolveDeploymentEnvManifestOptions, 'excludePortals' | 'acceptedPayoutTokens'>;

function resolve(body: string, portal = PORTAL, policy: Policy = {}) {
  const fetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));
  return resolveDeploymentEnvManifest({
    deploymentEnvManifestUrl: URL,
    portal: EthAddress.fromString(portal),
    ...policy,
    fetch: fetchImpl as typeof fetch,
  });
}

const addresses = (list: string[]) => list.map(address => EthAddress.fromString(address));

describe('resolveDeploymentEnvManifest', () => {
  it('pins the entry by portal (any case) and reads every field from the entry itself', async () => {
    const { current } = await resolve(document(entry()), PORTAL.toUpperCase().replace('0X', '0x'));
    const { publicConfig } = current;

    expect(current.label).toBe('v4');
    expect(publicConfig.portal).toBeInstanceOf(EthAddress);
    expect(publicConfig.portal.toString()).toBe(PORTAL);
    expect(publicConfig.l2Token).toBeInstanceOf(AztecAddress);
    expect(publicConfig.token.toString()).toBe(TOKEN);
    expect(publicConfig.rollupVersion).toBe(4n);
    expect(publicConfig.enclaveUrl).toBe(ENCLAVE_URL);
    expect(publicConfig.broadcaster.toString()).toBe(BROADCASTER);
    expect(publicConfig.proverSubsidy.toString()).toBe(PROVER_SUBSIDY);
    expect(publicConfig.operationExecutor.toString()).toBe(OPERATION_EXECUTOR);
    expect(publicConfig.fpcFunder.toString()).toBe(FPC_FUNDER);
  });
  it('exposes the exact fetched bytes to immutable-operation evidence callers', async () => {
    const body = `${document(entry())}\n`;
    let observed: Buffer | undefined;
    await resolveDeploymentEnvManifest({
      deploymentEnvManifestUrl: URL,
      portal: EthAddress.fromString(PORTAL),
      fetch: (() => Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch,
      onManifestBytes: bytes => {
        observed = bytes;
      },
    });
    expect(observed).toEqual(Buffer.from(body));
  });


  it.each([undefined, 'not an address'])(
    'does not require or interpret withdrawal executor addresses (%s)',
    async executor => {
      const result = await resolve(document(entry({ plainWithdrawalExecutor: executor })));
      expect(result.current.publicConfig.portal.toString()).toBe(PORTAL);
      expect(result.current.publicConfig).not.toHaveProperty('plainWithdrawalExecutor');
    },
  );

  it('throws when the pinned portal is absent, listing the available deployments', async () => {
    await expect(resolve(document(entry()), OTHER_PORTAL)).rejects.toThrow(
      new RegExp(`no deployment with portal ${OTHER_PORTAL} \\(available: v4:${PORTAL}\\)`),
    );
  });

  it.each([
    ['3', { schemaVersion: '3', shared: {}, versions: {} }],
    ['4', { schemaVersion: '4', deployments: [entry()] }],
  ])('throws on a schema v%s document', async (version, body) => {
    await expect(resolve(JSON.stringify(body))).rejects.toThrow(`unsupported schemaVersion "${version}" (want "5").`);
  });

  it('throws on a deployment without a bridges array', async () => {
    await expect(resolve(releases(deployment(entry()), entry({ label: 'flat' })))).rejects.toThrow(
      `deployment env manifest ${URL}: deployments[1] has no bridges array.`,
    );
  });

  it('makes one entry for each bridge of a deployment, with the shared fields and the label', async () => {
    const second = entry({ portal: OTHER_PORTAL, token: OTHER_TOKEN, l2Token: '0x' + '03'.repeat(32) });
    const result = await resolve(releases(deployment(entry(), second)), OTHER_PORTAL);
    expect(result.current.label).toBe('v4');
    expect(result.current.publicConfig.token.toString()).toBe(OTHER_TOKEN);
    expect(result.current.publicConfig.l2Token.toString()).toBe('0x' + '03'.repeat(32));
    expect(result.current.publicConfig.broadcaster.toString()).toBe(BROADCASTER);
    expect(result.current.publicConfig.rollupVersion).toBe(4n);
    expect(result.historical.map(d => [d.label, d.publicConfig.portal.toString()])).toEqual([['v4', PORTAL]]);
  });

  it('rejects a document with two deployments that share a label', async () => {
    await expect(resolve(document(entry(), entry({ portal: OTHER_PORTAL, token: OTHER_TOKEN })))).rejects.toThrow(
      `deployment env manifest ${URL} has two deployments with label v4.`,
    );
  });

  it('pins the requested portal and selects historical entries on the same rollup', async () => {
    const v5 = entry({ label: 'v5', portal: OTHER_PORTAL });
    const v6 = entry({ label: 'v6', portal: THIRD_PORTAL, rollupVersion: '5' });
    const manifest = await resolve(document(v6, entry(), v5));
    expect(manifest.current.label).toBe('v4');
    expect(manifest.current.publicConfig.portal.toString()).toBe(PORTAL);
    expect(manifest.historical.map(d => d.publicConfig.portal.toString())).toEqual([OTHER_PORTAL]);
    expect(manifest.skipped).toEqual([]);
  });

  it("selects only the pinned entry's L2 from a file with entries on two L2s, without skipping the others", async () => {
    const sameL2 = entry({ label: 'same-l2', portal: OTHER_PORTAL });
    const otherL2 = entry({ label: 'other-l2', portal: THIRD_PORTAL, rollupVersion: '5' });
    const manifest = await resolve(document(entry(), sameL2, otherL2), THIRD_PORTAL);
    expect(manifest.current.label).toBe('other-l2');
    expect(manifest.current.publicConfig.rollupVersion).toBe(5n);
    expect(manifest.historical).toEqual([]);
    expect(manifest.skipped).toEqual([]);
    expect(manifest.unreadable).toEqual([]);
  });

  it('watches a portal listed under two deployments once, whatever its case', async () => {
    const upper = OTHER_PORTAL.toUpperCase().replace('0X', '0x');
    const manifest = await resolve(
      document(entry(), entry({ label: 'v5', portal: OTHER_PORTAL }), entry({ label: 'v6', portal: upper })),
    );
    expect(manifest.historical.map(d => [d.label, d.publicConfig.portal.toString()])).toEqual([['v5', OTHER_PORTAL]]);
  });

  it('does not watch the pinned portal again under another deployment', async () => {
    const manifest = await resolve(document(entry(), entry({ label: 'v5' })));
    expect(manifest.current.label).toBe('v4');
    expect(manifest.historical).toEqual([]);
  });

  it('rejects two entries for one portal that disagree on a field the relayer reads, naming both', async () => {
    const upper = OTHER_PORTAL.toUpperCase().replace('0X', '0x');
    const other = entry({ label: 'v5', portal: OTHER_PORTAL });
    const otherUpper = entry({ label: 'v6', portal: upper, rollupVersion: '9' });
    await expect(resolve(document(entry(), other, otherUpper))).rejects.toThrow(
      `deployment env manifest ${URL} has two bridges with portal ${OTHER_PORTAL} that disagree on rollupVersion: v5:${OTHER_PORTAL} and v6:${upper}.`,
    );
  });

  it("serves the pinned label's portal for another token as a historical entry", async () => {
    const manifest = await resolve(releases(deployment(entry(), entry({ portal: OTHER_PORTAL, token: OTHER_TOKEN }))));
    expect(manifest.current.publicConfig.portal.toString()).toBe(PORTAL);
    expect(manifest.historical.map(d => d.publicConfig.portal.toString())).toEqual([OTHER_PORTAL]);
  });

  it('rejects a document with two portals for one label and token, in any case, naming both', async () => {
    const token = '0x00000000000000000000000000000000000000ab';
    const upper = token.toUpperCase().replace('0X', '0x');
    const other = entry({ portal: OTHER_PORTAL, token: upper });
    await expect(resolve(releases(deployment(entry({ token }), other)))).rejects.toThrow(
      `deployment env manifest ${URL} has two bridges with label v4 and token ${upper}: v4:${PORTAL} and v4:${OTHER_PORTAL}.`,
    );
  });

  it('is fatal when the pinned entry is malformed, naming the URL, the entry and the field', async () => {
    await expect(resolve(document(entry({ rollupVersion: '' })))).rejects.toThrow(
      `deployment env manifest ${URL}: deployment ${PORTAL} (v4): rollupVersion "": not a decimal integer`,
    );
    await expect(resolve(document(entry({ operationExecutor: 'garbage' })))).rejects.toThrow(
      /deployment .* \(v4\): operationExecutor "garbage": /,
    );
    const { fpcFunder: _dropped, ...noFunder } = entry();
    await expect(resolve(document(noFunder))).rejects.toThrow(/deployment .* \(v4\): fpcFunder missing/);
  });
});

describe('historical L1-operation deployment selection', () => {
  it.each([undefined, 'legacy', 'unknown'])(
    'ignores historical protocol %s while retaining modern entries',
    async withdrawalProtocol => {
      const result = await resolve(
        document(
          entry({ withdrawalProtocol: undefined }),
          entry({ label: 'old', portal: OTHER_PORTAL, withdrawalProtocol }),
          entry({ label: 'compatible', portal: THIRD_PORTAL }),
        ),
      );
      expect(result.current.publicConfig.portal.toString()).toBe(PORTAL);
      expect(result.historical.map(d => d.publicConfig.portal.toString())).toEqual([THIRD_PORTAL]);
    },
  );

  it.each([false, true])('uses rollup and portal, not labels or entry order (reversed=%s)', async reverse => {
    const entries = [
      entry({ label: 'z-current' }),
      entry({ label: 'unrelated-name', portal: OTHER_PORTAL }),
      entry({ label: 'a-new', portal: THIRD_PORTAL, rollupVersion: '99' }),
    ];
    const result = await resolve(document(...(reverse ? entries.reverse() : entries)));
    expect(result.current.publicConfig.portal.toString()).toBe(PORTAL);
    expect(result.historical.map(d => d.publicConfig.portal.toString())).toEqual([OTHER_PORTAL]);
  });
});

describe('manifest entries from other relayer versions', () => {
  it.each(Object.keys(entry()).filter(field => !SELECTION_FIELDS.includes(field)))(
    'skips a watched entry without %s exactly when a pinned entry without it is fatal, for the same reason',
    async field => {
      const { [field]: _dropped, ...older } = entry({ label: 'older', portal: OTHER_PORTAL });
      const fatal = await resolve(document(older), OTHER_PORTAL).then(
        () => undefined,
        (err: Error) => err.message,
      );
      const result = await resolve(document(entry(), older, entry({ label: 'other', portal: THIRD_PORTAL })));
      expect(result.current.label).toBe('v4');
      expect(result.historical.map(d => d.publicConfig.portal.toString())).toEqual(
        fatal === undefined ? [OTHER_PORTAL, THIRD_PORTAL] : [THIRD_PORTAL],
      );
      expect(result.unreadable).toEqual(fatal === undefined ? [] : [fatal]);
    },
  );

  it('skips a watched entry that has only the fields that select it, and watches the rest', async () => {
    const bare = { label: 'older', portal: OTHER_PORTAL, rollupVersion: '4', withdrawalProtocol: 'l1-operation' };
    const result = await resolve(document(entry(), bare, entry({ label: 'other', portal: THIRD_PORTAL })));
    expect(result.current.label).toBe('v4');
    expect(result.historical.map(d => d.label)).toEqual(['other']);
    expect(result.unreadable).toEqual([expect.stringContaining(`deployment ${OTHER_PORTAL} (older): `)]);
  });

  it.each([
    ['has no protocol marker', {}],
    ['has another protocol', { withdrawalProtocol: 'legacy' }],
    ['is on another rollup', { withdrawalProtocol: 'l1-operation', rollupVersion: '5' }],
  ])('ignores an entry that %s, whatever fields it lacks', async (_case, overrides) => {
    const unwatched = { label: 'older', portal: OTHER_PORTAL, rollupVersion: '4', ...overrides };
    const result = await resolve(document(entry(), unwatched));
    expect(result.current.label).toBe('v4');
    expect(result.historical).toEqual([]);
    expect(result.unreadable).toEqual([]);
  });

  it('watches a newer entry that has fields the relayer does not read', async () => {
    const newer = entry({ label: 'newer', portal: OTHER_PORTAL, futureContract: '0x' + '0c'.repeat(20) });
    const result = await resolve(document(entry(), newer));
    expect(result.historical.map(d => d.label)).toEqual(['newer']);
    expect(result.unreadable).toEqual([]);
  });
});

describe('selection policy', () => {
  const other = () => entry({ label: 'other', portal: OTHER_PORTAL, token: OTHER_TOKEN });
  const third = () => entry({ label: 'third', portal: THIRD_PORTAL });

  it('skips an excluded portal, whatever its case, with reason excluded', async () => {
    const upper = OTHER_PORTAL.toUpperCase().replace('0X', '0x');
    const manifest = await resolve(document(entry(), other(), third()), PORTAL, {
      excludePortals: addresses([upper]),
    });
    expect(manifest.historical.map(d => d.label)).toEqual(['third']);
    expect(manifest.skipped).toEqual([{ label: 'other', portal: OTHER_PORTAL, reason: 'excluded' }]);
    expect(manifest.unreadable).toEqual([]);
  });

  it('skips an entry whose token is not an accepted payout token, with reason payout-token', async () => {
    const manifest = await resolve(document(entry(), other(), third()), PORTAL, {
      acceptedPayoutTokens: addresses([TOKEN.toUpperCase().replace('0X', '0x')]),
    });
    expect(manifest.historical.map(d => d.label)).toEqual(['third']);
    expect(manifest.skipped).toEqual([{ label: 'other', portal: OTHER_PORTAL, reason: 'payout-token' }]);
  });

  it('serves every entry whose token is listed, and applies no token rule without a list', async () => {
    const listed = await resolve(document(entry(), other(), third()), PORTAL, {
      acceptedPayoutTokens: addresses([TOKEN, OTHER_TOKEN]),
    });
    expect(listed.historical.map(d => d.label)).toEqual(['other', 'third']);
    expect(listed.skipped).toEqual([]);
    const unlisted = await resolve(document(entry(), other(), third()));
    expect(unlisted.historical.map(d => d.label)).toEqual(['other', 'third']);
    expect(unlisted.skipped).toEqual([]);
  });

  it('still pins a skipped pinned entry, and lists it as skipped', async () => {
    const excluded = await resolve(document(entry(), other()), PORTAL, { excludePortals: addresses([PORTAL]) });
    expect(excluded.current.label).toBe('v4');
    expect(excluded.historical.map(d => d.label)).toEqual(['other']);
    expect(excluded.skipped).toEqual([{ label: 'v4', portal: PORTAL, reason: 'excluded' }]);

    const unpaid = await resolve(document(entry(), other()), PORTAL, {
      acceptedPayoutTokens: addresses([OTHER_TOKEN]),
    });
    expect(unpaid.current.label).toBe('v4');
    expect(unpaid.historical.map(d => d.label)).toEqual(['other']);
    expect(unpaid.skipped).toEqual([{ label: 'v4', portal: PORTAL, reason: 'payout-token' }]);
  });

  it('applies the policy only to L1-operation entries on the pinned rollup', async () => {
    const elsewhere = entry({ label: 'elsewhere', portal: OTHER_PORTAL, rollupVersion: '5' });
    const legacy = entry({ label: 'legacy', portal: THIRD_PORTAL, withdrawalProtocol: 'legacy' });
    const manifest = await resolve(document(entry(), elsewhere, legacy), PORTAL, {
      excludePortals: addresses([OTHER_PORTAL, THIRD_PORTAL]),
    });
    expect(manifest.historical).toEqual([]);
    expect(manifest.skipped).toEqual([]);
  });

  it('leaves an entry without a token to the parser when a payout list is set', async () => {
    const { token: _dropped, ...noToken } = entry({ label: 'no-token', portal: OTHER_PORTAL });
    const manifest = await resolve(document(entry(), noToken), PORTAL, { acceptedPayoutTokens: addresses([TOKEN]) });
    expect(manifest.skipped).toEqual([]);
    expect(manifest.unreadable).toEqual([expect.stringContaining('(no-token): token missing')]);
  });
});
