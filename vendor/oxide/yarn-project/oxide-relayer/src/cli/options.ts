import { type EnvVar, enumConfigHelper, getValueFromEnvWithFallback } from '@aztec-labs/foundation/config';
import { schemas } from '@aztec-labs/foundation/schemas';

import { OFAC_SDN_LIST_URL } from '@oxide/watcher-lib/sanctions';

import { type Command, InvalidArgumentError, Option } from 'commander';

import { DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS } from '../fpc_funding/fpc_funder_caller.js';
import { DEFAULT_FLASHBOTS_BLOCK_RANGE } from '../l1/flashbots_protect.js';
import {
  DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS,
  DEFAULT_LOG_SCAN_WINDOW,
} from '../l1_operations/l1_operation_relayer.js';
import { PROVER_ENV_VARS, PROVER_RUN_OPTIONS } from '../prover/cli.js';
import { EXACT_CONTROL_DIRECTORY } from '../exact_operation/paths.js';
import { EXACT_HANDOFF_STATE_TEMPLATE } from '../state/path.js';
import { SIGNER_BACKENDS, urlOrigin } from './config.js';

const DEFAULT_SQLITE_PATH = EXACT_HANDOFF_STATE_TEMPLATE;
const DEFAULT_L1_OPERATIONS_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_L1_OPERATIONS_MAX_PENDING_AGE_SECONDS = 2 * 7 * 24 * 60 * 60;

export const RELAYER_ENV_VARS = [
  'OXIDE_DEPLOYMENT_ENV_MANIFEST_URL',
  'OXIDE_PORTAL',
  'OXIDE_RELAYER_EXCLUDE_PORTALS',
  'READ_L1_RPC_URL',
  'L1_RPC_URL',
  'ETHEREUM_HOST',
  'OXIDE_RELAYER_FLASHBOTS_BLOCK_RANGE',
  'OXIDE_RELAYER_L1_MAX_FEE_PER_GAS_GWEI',
  'AZTEC_NODE_URL',
  'OXIDE_AZTEC_NODE_URL',
  'AZTEC_NODE_API_KEY',
  'OXIDE_AZTEC_NODE_API_KEY',
  ...PROVER_ENV_VARS,
  'OXIDE_RELAYER_MODES',
  'OXIDE_RELAYER_SIGNER',
  'OXIDE_RELAYER_PRIVATE_KEY_ENV',
  'OXIDE_RELAYER_KEYSTORE',
  'OXIDE_RELAYER_KEYSTORE_PASSWORD',
  'OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE',
  'OXIDE_RELAYER_STATE_BACKEND',
  'OXIDE_RELAYER_STATE_PATH',
  'OXIDE_RELAYER_CONTROL_DIR',
  'OXIDE_RELAYER_SDN_URL',
  'OXIDE_RELAYER_LOG_SCAN_WINDOW',
  'DISABLE_SUBMISSION',
  'OXIDE_RELAYER_L1_OPERATIONS_POLL_INTERVAL_MS',
  'OXIDE_RELAYER_FPC_FUNDING_POLL_INTERVAL_MS',
  'OXIDE_RELAYER_L1_OPERATIONS_RETRY_BACKOFF_MS',
  'OXIDE_RELAYER_L1_OPERATIONS_MAX_PENDING_AGE_SECONDS',
  'OXIDE_RELAYER_L1_OPERATIONS_PAYOUT_TOKENS',
  'OXIDE_RELAYER_ALLOW_UNPROFITABLE',
  'OXIDE_RELAYER_PREDICATE_API_KEY',
  'OXIDE_RELAYER_PREDICATE_VERIFICATION_HASH',
  'OXIDE_RELAYER_PREDICATE_CHAIN',
] as const;

export type RelayerEnvVar = (typeof RELAYER_ENV_VARS)[number];

export interface CliOptionSpec {
  flags: string;
  description: string;
  env?: RelayerEnvVar;
  fallback?: RelayerEnvVar[];
  defaultValue?: unknown;
  parseVal?: (value: string | boolean) => unknown;
  /** Accepted, but not shown in `--help`. */
  hidden?: boolean;
  /** `--help` shows `<redacted>` instead of the value that the environment sets. */
  secret?: boolean;
  /** `--help` shows only the origin of the URL that the environment sets; RPC providers put API keys in the path. */
  url?: boolean;
}

export const RUN_OPTIONS: readonly CliOptionSpec[] = [
  {
    flags: '--deployment-env-manifest <url>',
    description: 'deployment env manifest URL',
    env: 'OXIDE_DEPLOYMENT_ENV_MANIFEST_URL',
  },
  { flags: '--portal <address>', description: 'portal of the manifest deployment to run', env: 'OXIDE_PORTAL' },
  {
    flags: '--exclude-portals <addresses>',
    description: 'comma-separated portals of manifest deployments that get no L1-operations worker',
    env: 'OXIDE_RELAYER_EXCLUDE_PORTALS',
  },
  {
    flags: '--read-l1-rpc <url>',
    description: 'L1 read RPC; L1 operations require eth_simulateV1; Sepolia also submits here; must not be Protect',
    env: 'READ_L1_RPC_URL',
    fallback: ['L1_RPC_URL', 'ETHEREUM_HOST'],
    url: true,
  },
  {
    flags: '--flashbots-block-range <blocks>',
    description: 'block window of an L1 tx on every chain: the Flashbots Protect drop window, and the relayer expiry',
    env: 'OXIDE_RELAYER_FLASHBOTS_BLOCK_RANGE',
    defaultValue: DEFAULT_FLASHBOTS_BLOCK_RANGE,
    parseVal: value => parsePositiveInteger(value, 'Flashbots block range'),
  },
  {
    flags: '--l1-max-fee-per-gas-gwei <gwei>',
    description: 'cap on the L1 max fee per gas; a tx whose fee ceiling is above it is deferred, not sent',
    env: 'OXIDE_RELAYER_L1_MAX_FEE_PER_GAS_GWEI',
    parseVal: value => parsePositiveGwei(value, 'L1 max fee per gas'),
  },
  {
    flags: '--aztec-node <url>',
    description: 'Aztec node URL',
    env: 'AZTEC_NODE_URL',
    fallback: ['OXIDE_AZTEC_NODE_URL'],
    url: true,
  },
  ...PROVER_RUN_OPTIONS,
  {
    flags: '--modes <list>',
    description: 'comma-separated modes',
    env: 'OXIDE_RELAYER_MODES',
    defaultValue: 'l1-operations',
  },
  {
    flags: '--signer <backend>',
    description: `signer backend (${SIGNER_BACKENDS.join('|')})`,
    env: 'OXIDE_RELAYER_SIGNER',
    parseVal: parseEnum(SIGNER_BACKENDS, 'signer backend'),
  },
  {
    flags: '--private-key-env <name>',
    description: 'env var containing the raw L1 private key',
    env: 'OXIDE_RELAYER_PRIVATE_KEY_ENV',
    defaultValue: 'L1_PRIVATE_KEY',
  },
  { flags: '--keystore <path>', description: 'JSON keystore path', env: 'OXIDE_RELAYER_KEYSTORE' },
  {
    flags: '--keystore-password <password>',
    description: 'JSON keystore password',
    env: 'OXIDE_RELAYER_KEYSTORE_PASSWORD',
    secret: true,
  },
  {
    flags: '--keystore-password-file <path>',
    description: 'file containing the JSON keystore password',
    env: 'OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE',
  },
  {
    flags: '--state-backend <backend>',
    description: 'state backend (currently sqlite)',
    env: 'OXIDE_RELAYER_STATE_BACKEND',
    defaultValue: 'sqlite',
    parseVal: parseEnum(['sqlite'] as const, 'state backend'),
    // Hidden while SQLite is the only backend.
    hidden: true,
  },
  {
    flags: '--state <path>',
    description: "SQLite state path; {portal} expands to each worker's portal",
    env: 'OXIDE_RELAYER_STATE_PATH',
    defaultValue: DEFAULT_SQLITE_PATH,
  },
  {
    flags: '--control-dir <path>',
    description: 'existing owner-only directory of the runtime lease that the exact-operation runtime shares',
    env: 'OXIDE_RELAYER_CONTROL_DIR',
    defaultValue: EXACT_CONTROL_DIRECTORY,
  },
  {
    flags: '--sdn-url <url>',
    description: 'OFAC SDN list (SDN.XML) that L1 operations screen addresses against',
    env: 'OXIDE_RELAYER_SDN_URL',
    defaultValue: OFAC_SDN_LIST_URL,
  },
  {
    flags: '--log-scan-window <blocks>',
    description: "blocks per L1 eth_getLogs call of the balance watcher's transfer scan",
    env: 'OXIDE_RELAYER_LOG_SCAN_WINDOW',
    defaultValue: Number(DEFAULT_LOG_SCAN_WINDOW),
    parseVal: value => parsePositiveInteger(value, 'log scan window'),
  },
  {
    flags: '--disable-submission [value]',
    description: 'run all checks but skip each L1 tx send, and continue as if it was mined',
    env: 'DISABLE_SUBMISSION',
    defaultValue: false,
    parseVal: value => parseBoolean(value, 'DISABLE_SUBMISSION'),
  },
  {
    flags: '--l1-operations-poll-interval-ms <ms>',
    description: 'interval between L1 operation poll cycles',
    env: 'OXIDE_RELAYER_L1_OPERATIONS_POLL_INTERVAL_MS',
    defaultValue: DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS,
    parseVal: value => parsePositiveInteger(value, 'L1 operations poll interval'),
  },
  {
    flags: '--fpc-funding-poll-interval-ms <ms>',
    description: 'interval between FPC funder bounty checks',
    env: 'OXIDE_RELAYER_FPC_FUNDING_POLL_INTERVAL_MS',
    defaultValue: DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS,
    parseVal: value => parsePositiveInteger(value, 'FPC funding poll interval'),
  },
  {
    flags: '--l1-operations-retry-backoff-ms <ms>',
    description:
      'backoff before re-checking a deferred L1 operation; doubles on each reverting simulation, up to 15 min',
    env: 'OXIDE_RELAYER_L1_OPERATIONS_RETRY_BACKOFF_MS',
    defaultValue: DEFAULT_L1_OPERATIONS_RETRY_BACKOFF_MS,
    parseVal: value => parsePositiveInteger(value, 'L1 operations retry backoff'),
  },
  {
    flags: '--l1-operations-max-pending-age-seconds <seconds>',
    description: 'age after which a deferred L1 operation is dropped, whatever the defer cause',
    env: 'OXIDE_RELAYER_L1_OPERATIONS_MAX_PENDING_AGE_SECONDS',
    defaultValue: DEFAULT_L1_OPERATIONS_MAX_PENDING_AGE_SECONDS,
    parseVal: value => parsePositiveInteger(value, 'L1 operations max pending age'),
  },
  {
    flags: '--l1-operations-payout-tokens <addresses>',
    description:
      'comma-separated 18-decimal USD tokens that L1 operations can pay out in; default: the tokens of the served ' +
      'deployments and the tokens that their deposit sweeps pay out in',
    env: 'OXIDE_RELAYER_L1_OPERATIONS_PAYOUT_TOKENS',
  },
  {
    flags: '--allow-unprofitable [value]',
    description: 'submit L1 operations and FPC funding even when unprofitable; does not apply to epoch proofs',
    env: 'OXIDE_RELAYER_ALLOW_UNPROFITABLE',
    defaultValue: false,
    parseVal: value => parseBoolean(value, 'OXIDE_RELAYER_ALLOW_UNPROFITABLE'),
  },
  {
    flags: '--predicate-api-key <key>',
    description: 'Predicate API key; with verification hash and chain, adds screening to the OFAC checks',
    env: 'OXIDE_RELAYER_PREDICATE_API_KEY',
    secret: true,
  },
  {
    flags: '--predicate-verification-hash <hash>',
    description: 'Predicate managed policy id sent as verification_hash',
    env: 'OXIDE_RELAYER_PREDICATE_VERIFICATION_HASH',
  },
  {
    flags: '--predicate-chain <name>',
    description: 'Predicate chain name, e.g. ethereum-mainnet',
    env: 'OXIDE_RELAYER_PREDICATE_CHAIN',
  },
];

/** Apply the relayer's declarative option table to a Commander command. */
export function addOptions(command: Command, options: readonly CliOptionSpec[]): void {
  for (const opt of options) {
    const value = getDefaultOrEnvValue(opt);
    const option = new Option(opt.flags, optionDescription(opt)).default(value, helpDefault(opt, value));
    if (opt.parseVal) {
      option.argParser(opt.parseVal);
    }
    if (opt.hidden) {
      option.hideHelp();
    }
    command.addOption(option);
  }
}

function helpDefault(opt: CliOptionSpec, value: unknown): string | undefined {
  if (opt.secret) {
    return '<redacted>';
  }
  if (opt.url && typeof value === 'string') {
    return JSON.stringify(urlOrigin(value));
  }
  return undefined;
}

function getDefaultOrEnvValue(opt: CliOptionSpec): unknown {
  return getValueFromEnvWithFallback(
    asAztecEnvVar(opt.env),
    opt.parseVal,
    opt.defaultValue,
    asAztecEnvVars(opt.fallback),
  );
}

function optionDescription(opt: CliOptionSpec): string {
  const details = [opt.env ? `$${opt.env}` : undefined, ...(opt.fallback ?? []).map(name => `$${name}`)].filter(
    Boolean,
  );
  return details.length === 0 ? opt.description : `${opt.description} (${details.join(', ')})`;
}

function parseBoolean(value: string | boolean, source: string): boolean {
  const result = schemas.Boolean.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError(`${source} must be one of: true, false, 1, 0.`);
  }
  return result.data;
}

function parsePositiveInteger(value: string | boolean, label: string): number {
  const result = schemas.Integer.safeParse(value);
  if (!result.success || result.data <= 0) {
    throw new InvalidArgumentError(`${label} must be a positive integer.`);
  }
  return result.data;
}

function parsePositiveGwei(value: string | boolean, label: string): number {
  const gwei = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(gwei) || Math.trunc(gwei * 1e9) < 1) {
    throw new InvalidArgumentError(`${label} must be a positive decimal gwei amount of at least one wei.`);
  }
  return gwei;
}

function parseEnum<const T extends readonly string[]>(
  values: T,
  label: string,
): (value: string | boolean) => T[number] {
  const parse = enumConfigHelper([...values]).parseEnv!;
  return value => {
    if (typeof value !== 'string') {
      throw new InvalidArgumentError(`invalid ${label} '${String(value)}'. Expected one of: ${values.join(', ')}.`);
    }
    try {
      return parse(value) as T[number];
    } catch {
      throw new InvalidArgumentError(`invalid ${label} '${value}'. Expected one of: ${values.join(', ')}.`);
    }
  };
}

function asAztecEnvVar(name: RelayerEnvVar | undefined): EnvVar | undefined {
  return name as EnvVar | undefined;
}

function asAztecEnvVars(names: readonly RelayerEnvVar[] | undefined): EnvVar[] | undefined {
  return names?.map(name => name as EnvVar);
}
