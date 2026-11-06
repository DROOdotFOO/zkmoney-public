import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { readFile } from 'node:fs/promises';

/**
 * Reader for the published schema v5 `v<major>/<deployment-env>/releases.json` deployment env manifest
 * (writer: deployer/src/composer/publish_deployment_manifest.ts). Each deployment lists its bridges, and the reader
 * makes one entry for each bridge: the deployment's shared fields and the bridge's fields. A bridge that stays in a
 * later deployment is listed under both, so one portal can have several entries; they must agree on the fields the
 * relayer reads. The relayer pins one entry by portal and watches one entry for each other portal among the
 * L1-operation entries on the same rollup version, minus the entries its policy skips.
 */

/** The deployment-env-manifest fields the relayer uses for one deployment. */
export interface DeploymentEnvManifestPublicConfig {
  /** This deployment's Portal; SIPAs settle straight into it, and it is the key their implementations are
   *  blessed under. */
  portal: EthAddress;
  l2Token: AztecAddress;
  token: EthAddress;
  rollupVersion: bigint;
  enclaveUrl: string;
  broadcaster: AztecAddress;
  proverSubsidy: EthAddress;
  operationExecutor: EthAddress;
  fpcFunder: EthAddress;
}

/** One manifest entry (one bridge of a deployment) and the label of its deployment. */
export interface ResolvedManifestDeployment {
  label: string;
  publicConfig: DeploymentEnvManifestPublicConfig;
}

/** Why the policy gives an entry on the pinned rollup no worker. */
export type SkipReason = 'excluded' | 'payout-token';

/** An L1-operation entry on the pinned rollup that the policy skips. `portal` is lower-case. */
export interface SkippedManifestDeployment {
  label: string;
  portal: string;
  reason: SkipReason;
}

export interface ResolvedDeploymentEnvManifest {
  /** The pinned entry. It is listed in `skipped` too when the policy gives it no worker. */
  current: ResolvedManifestDeployment;
  /** The other entries that get a worker. */
  historical: ResolvedManifestDeployment[];
  /** Entries on the pinned rollup that the policy skips, the pinned entry included. */
  skipped: SkippedManifestDeployment[];
  /** Why this relayer cannot read each historical entry that it would watch. */
  unreadable: string[];
}

/** Inputs for deployment-env-manifest resolution. Tests inject `fetch` to avoid network access. */
export interface ResolveDeploymentEnvManifestOptions {
  deploymentEnvManifestUrl: string;
  portal: EthAddress;
  /** Entries that get no worker, by portal. */
  excludePortals?: EthAddress[];
  /** When set, only entries whose `token` is listed get a worker. */
  acceptedPayoutTokens?: EthAddress[];
  fetch?: typeof fetch;
  /** Exact raw response bytes, before JSON parsing. Used only by immutable-operation approval evidence. */
  onManifestBytes?: (bytes: Buffer) => void;
}

interface RawDeployment {
  withdrawalProtocol?: unknown;
  portal?: unknown;
  label?: unknown;
  rollupVersion?: unknown;
  l2Token?: unknown;
  token?: unknown;
  enclaveUrl?: unknown;
  l2Broadcaster?: unknown;
  proverSubsidy?: unknown;
  operationExecutor?: unknown;
  fpcFunder?: unknown;
}

/** A schema v5 deployment: the shared fields and one item for each bridge. */
interface RawDeploymentGroup extends RawDeployment {
  bridges?: unknown;
}

interface DeploymentEnvManifestDocument {
  schemaVersion?: unknown;
  deployments?: unknown;
}

/**
 * Fetch the releases list, pin one entry by portal and select the historical entries to watch: the other
 * L1-operation entries on the pinned entry's rollup, minus the entries that the policy skips. Only these entries
 * are parsed. An older entry can lack a field that this relayer reads, and it stays a supported deployment for
 * other consumers.
 */
export async function resolveDeploymentEnvManifest(
  opts: ResolveDeploymentEnvManifestOptions,
): Promise<ResolvedDeploymentEnvManifest> {
  const url = opts.deploymentEnvManifestUrl;
  const document = await readDocument(url, opts.fetch ?? fetch);
  opts.onManifestBytes?.(document.raw);
  const entries = document.entries;
  const portal = opts.portal.toString().toLowerCase();
  const pinned = entries.find(entry => typeof entry.portal === 'string' && entry.portal.toLowerCase() === portal);
  if (!pinned) {
    const available = entries.map(nameOf).join(', ') || '(none)';
    throw new Error(
      `deployment env manifest ${url} has no deployment with portal ${opts.portal} (available: ${available}).`,
    );
  }
  const current = parseDeployment(url, pinned);
  const skipReason = policyOf(opts);
  const historical: ResolvedManifestDeployment[] = [];
  const skipped: SkippedManifestDeployment[] = [];
  const unreadable: string[] = [];
  const pinnedSkip = skipReason(pinned);
  if (pinnedSkip) {
    skipped.push(skippedOf(pinned, pinnedSkip));
  }
  // A portal listed under several deployments gets one worker.
  const seen = new Set([portal]);
  for (const entry of entries) {
    const entryPortal = typeof entry.portal === 'string' ? entry.portal.toLowerCase() : undefined;
    if (
      (entryPortal !== undefined && seen.has(entryPortal)) ||
      entry.withdrawalProtocol !== 'l1-operation' ||
      entry.rollupVersion !== pinned.rollupVersion
    ) {
      continue;
    }
    if (entryPortal !== undefined) {
      seen.add(entryPortal);
    }
    const reason = skipReason(entry);
    if (reason) {
      skipped.push(skippedOf(entry, reason));
      continue;
    }
    try {
      historical.push(parseDeployment(url, entry));
    } catch (err: unknown) {
      unreadable.push(message(err));
    }
  }
  return { current, historical, skipped, unreadable };
}

/** One log line for a skipped entry, the same at startup and on every refresh. */
export function describeSkip({ label, portal, reason }: SkippedManifestDeployment): string {
  return `Not serving deployment ${label}:${portal} (${reason})`;
}

/**
 * The selection policy: an excluded portal gets no worker, and with an accepted payout-token list, neither does an
 * entry whose `token` is not listed. An entry without a `token` string is left to the parser, which reports it.
 */
function policyOf(opts: ResolveDeploymentEnvManifestOptions): (entry: RawDeployment) => SkipReason | undefined {
  const excluded = new Set((opts.excludePortals ?? []).map(lower));
  const accepted = opts.acceptedPayoutTokens && new Set(opts.acceptedPayoutTokens.map(lower));
  return entry => {
    if (typeof entry.portal === 'string' && excluded.has(entry.portal.toLowerCase())) {
      return 'excluded';
    }
    if (accepted && typeof entry.token === 'string' && !accepted.has(entry.token.toLowerCase())) {
      return 'payout-token';
    }
    return undefined;
  };
}

function lower(address: EthAddress): string {
  return address.toString().toLowerCase();
}

function skippedOf(entry: RawDeployment, reason: SkipReason): SkippedManifestDeployment {
  return { label: String(entry.label), portal: String(entry.portal).toLowerCase(), reason };
}

function nameOf(entry: RawDeployment): string {
  return `${String(entry.label)}:${String(entry.portal)}`;
}

function parseDeployment(url: string, raw: unknown): ResolvedManifestDeployment {
  const entry = (raw ?? {}) as RawDeployment;
  const portal = typeof entry.portal === 'string' ? entry.portal : '(no portal)';
  const label = typeof entry.label === 'string' ? entry.label : '(no label)';
  try {
    return {
      label,
      publicConfig: {
        portal: field(entry, 'portal', v => EthAddress.fromString(v)),
        l2Token: field(entry, 'l2Token', v => AztecAddress.fromStringUnsafe(v)),
        token: field(entry, 'token', v => EthAddress.fromString(v)),
        rollupVersion: field(entry, 'rollupVersion', rollupVersionOf),
        enclaveUrl: field(entry, 'enclaveUrl', v => v),
        broadcaster: field(entry, 'l2Broadcaster', v => AztecAddress.fromStringUnsafe(v)),
        proverSubsidy: field(entry, 'proverSubsidy', v => EthAddress.fromString(v)),
        operationExecutor: field(entry, 'operationExecutor', v => EthAddress.fromString(v)),
        fpcFunder: field(entry, 'fpcFunder', v => EthAddress.fromString(v)),
      },
    };
  } catch (err: unknown) {
    throw new Error(`deployment env manifest ${url}: deployment ${portal} (${label}): ${message(err)}`);
  }
}
function rollupVersionOf(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('not a decimal integer');
  }
  return BigInt(value);
}

function field<T>(entry: RawDeployment, key: keyof RawDeployment, convert: (value: string) => T): T {
  const value = entry[key];
  if (typeof value !== 'string') {
    throw new Error(`${key} missing`);
  }
  try {
    return convert(value);
  } catch (err: unknown) {
    throw new Error(`${key} ${JSON.stringify(value)}: ${message(err)}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readDocument(url: string, fetchFn: typeof fetch): Promise<{ entries: RawDeployment[]; raw: Buffer }> {
  const raw = await fetchRaw(url, fetchFn);
  let doc: DeploymentEnvManifestDocument;
  try {
    doc = JSON.parse(raw.toString('utf8')) as DeploymentEnvManifestDocument;
  } catch (err: unknown) {
    throw new Error(`deployment env manifest ${url} is not valid JSON: ${message(err)}`);
  }
  if (doc?.schemaVersion !== '5') {
    throw new Error(
      `deployment env manifest ${url} has unsupported schemaVersion ${JSON.stringify(doc?.schemaVersion)} (want \"5\").`,
    );
  }
  if (!Array.isArray(doc.deployments)) {
    throw new Error(`deployment env manifest ${url} has no deployments array.`);
  }
  const deployments = doc.deployments as RawDeploymentGroup[];
  rejectDuplicateLabels(url, deployments);
  const entries = deployments.flatMap((deployment, index) => bridgesOf(url, deployment, index));
  rejectDuplicates(url, entries);
  return { entries, raw };
}

/** One entry for each bridge of a deployment. The bridges of one deployment share its label. */
function bridgesOf(url: string, deployment: RawDeploymentGroup, index: number): RawDeployment[] {
  if (!Array.isArray(deployment?.bridges)) {
    throw new Error(`deployment env manifest ${url}: deployments[${index}] has no bridges array.`);
  }
  const { bridges, ...shared } = deployment;
  return (bridges as unknown[]).map(bridge => ({ ...shared, ...(bridge as RawDeployment), label: shared.label }));
}

function rejectDuplicateLabels(url: string, deployments: RawDeploymentGroup[]): void {
  const labels = new Set<string>();
  for (const deployment of deployments) {
    const label = deployment?.label;
    if (typeof label !== 'string') {
      continue;
    }
    if (labels.has(label)) {
      throw new Error(`deployment env manifest ${url} has two deployments with label ${label}.`);
    }
    labels.add(label);
  }
}

function rejectDuplicates(url: string, entries: RawDeployment[]): void {
  const byPortal = new Map<string, RawDeployment>();
  const byLabelToken = new Map<string, RawDeployment>();
  for (const entry of entries) {
    const portal = typeof entry.portal === 'string' ? entry.portal.toLowerCase() : undefined;
    const labelToken =
      typeof entry.label === 'string'
        ? `${entry.label}/${typeof entry.token === 'string' ? entry.token.toLowerCase() : ''}`
        : undefined;
    const samePortal = portal === undefined ? undefined : byPortal.get(portal);
    const differs = samePortal && SERVED_FIELDS.find(key => !sameValue(samePortal[key], entry[key]));
    if (samePortal && (samePortal.label === entry.label || differs)) {
      const reason = differs ? `disagree on ${differs}` : 'share a label';
      throw new Error(
        `deployment env manifest ${url} has two bridges with portal ${portal} that ${reason}: ${nameOf(samePortal)} and ${nameOf(entry)}.`,
      );
    }
    const sameLabelToken = labelToken === undefined ? undefined : byLabelToken.get(labelToken);
    if (sameLabelToken) {
      throw new Error(
        `deployment env manifest ${url} has two bridges with label ${entry.label} and token ${entry.token}: ${nameOf(sameLabelToken)} and ${nameOf(entry)}.`,
      );
    }
    if (portal !== undefined) {
      byPortal.set(portal, entry);
    }
    if (labelToken !== undefined) {
      byLabelToken.set(labelToken, entry);
    }
  }
}

/** The fields the relayer reads, besides the portal and the label. */
const SERVED_FIELDS = [
  'withdrawalProtocol',
  'rollupVersion',
  'l2Token',
  'token',
  'enclaveUrl',
  'l2Broadcaster',
  'proverSubsidy',
  'operationExecutor',
  'fpcFunder',
] as const satisfies readonly (keyof RawDeployment)[];

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function fetchRaw(url: string, fetchFn: typeof fetch): Promise<Buffer> {
  if (url.startsWith('file://')) {
    return readFile(new URL(url));
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return readFile(url);
  }
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`deployment env manifest fetch ${url} returned HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
