import { enumConfigHelper } from '@aztec-labs/foundation/config';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { Command } from 'commander';

import type { RunExactOperationConfig } from '../exact_operation/run.js';

import type { PredicateScreenerConfig } from '../l1_operations/predicate_screener.js';
import { toProverRunConfig } from '../prover/cli.js';
import { relayerVersion } from '../version.js';
import {
  type CommanderRunOptions,
  type L1OperationsSubmissionConfig,
  RELAYER_MODES,
  type RelayerMode,
  type RunConfig,
  type SignerBackend,
} from './config.js';
import { RUN_OPTIONS, addOptions } from './options.js';
import { parseCsv, parseEthAddresses } from './parse.js';

/**
 * Build the public `oxide-relayer` CLI.
 *
 * Runtime callers should use Commander directly (`program.parseAsync()`), which defaults to `process.argv`.
 * The injected runner keeps process startup thin and lets tests capture the normalized config without
 * starting the long-running relayer loop.
 */
export function createCliProgram(
  run: (config: RunConfig) => Promise<void> | void,
  runExact?: (config: RunExactOperationConfig) => Promise<unknown> | void,
): Command {
  const program = new Command();
  program
    .name('oxide-relayer')
    .description('Oxide relayer')
    .version(relayerVersion())
    .showHelpAfterError()
    .action(() => {
      program.help();
    })
    .addCommand(
      createRunCommand().action(async (options: CommanderRunOptions) => {
        const config = runOptionsToConfig(options);
        await run(config);
      }),
    );
  if (runExact) {
    program.addCommand(
      new Command('relay-exact')
        .description('submit one approved finalized L1 operation without discovery or retry')
        .requiredOption('--bundle-fd <fd>', 'inherited descriptor containing the signed one-run approval', integerFd)
        .allowExcessArguments(false)
        .action(async options => {
          await runExact(exactConfigFromEnvironment(options));
        }),
    );
  }
  return program;
}

/** Build the `run` subcommand from the declarative option table. */
function createRunCommand(): Command {
  const command = new Command('run')
    .description('watch Oxide state and submit profitable L1 relayer transactions')
    .allowExcessArguments(false);

  addOptions(command, RUN_OPTIONS);
  return command;
}

/**
 * Convert Commander's raw option bag into the stable relayer config.
 *
 * This is where cross-field rules live: state backend support, signer defaulting, and submission disable flag.
 */
// Environment only: a command-line option would put the key in argv, readable by any process.
function aztecNodeApiKeyFromEnv(): string | undefined {
  return process.env.AZTEC_NODE_API_KEY?.trim() || process.env.OXIDE_AZTEC_NODE_API_KEY?.trim() || undefined;
}

function runOptionsToConfig(opts: CommanderRunOptions): RunConfig {
  const disableSubmission = opts.disableSubmission ?? false;
  const privateKeyEnvVar = opts.privateKeyEnv!;
  const stateBackend = opts.stateBackend!;
  if (stateBackend !== 'sqlite') {
    throw new Error(`unsupported --state-backend '${stateBackend}'. Only sqlite is implemented in this package.`);
  }

  const modes = parseModes(opts.modes!);
  // only the first prover can claim tips.
  if (disableSubmission && modes.includes('epoch-proofs')) {
    throw new Error('epoch-proofs mode cannot run with --disable-submission');
  }
  const prover = toProverRunConfig(opts, modes);

  const l1OperationsSubmission = modes.includes('l1-operations') ? toL1OperationsSubmissionConfig(opts) : undefined;

  return {
    deploymentEnvManifestUrl:
      opts.deploymentEnvManifest ?? missing('--deployment-env-manifest or OXIDE_DEPLOYMENT_ENV_MANIFEST_URL'),
    portal: opts.portal ? EthAddress.fromString(opts.portal) : missing('--portal or OXIDE_PORTAL'),
    excludePortals:
      opts.excludePortals === undefined ? [] : parseEthAddresses(opts.excludePortals, '--exclude-portals'),
    readL1RpcUrl: opts.readL1Rpc ?? missing('--read-l1-rpc, READ_L1_RPC_URL, L1_RPC_URL, or ETHEREUM_HOST'),
    flashbotsBlockRange: opts.flashbotsBlockRange!,
    l1MaxFeePerGasGwei: opts.l1MaxFeePerGasGwei,
    aztecNodeUrl: opts.aztecNode ?? missing('--aztec-node, AZTEC_NODE_URL, or OXIDE_AZTEC_NODE_URL'),
    aztecNodeApiKey: aztecNodeApiKeyFromEnv(),
    ...prover,
    modes,
    signer: {
      backend: opts.signer ?? defaultSignerBackend(privateKeyEnvVar),
      privateKeyEnvVar,
      keystorePath: opts.keystore,
      keystorePassword: opts.keystorePassword,
      keystorePasswordFile: opts.keystorePasswordFile,
    },
    state: {
      backend: 'sqlite',
      sqlitePath: opts.state!,
    },
    sdnUrl: opts.sdnUrl,
    logScanWindow: BigInt(opts.logScanWindow!),
    disableSubmission,
    allowUnprofitable: opts.allowUnprofitable!,
    l1OperationsPollIntervalMs: opts.l1OperationsPollIntervalMs!,
    l1OperationsPayoutTokens:
      opts.l1OperationsPayoutTokens === undefined
        ? undefined
        : parseEthAddresses(opts.l1OperationsPayoutTokens, '--l1-operations-payout-tokens'),
    l1OperationsSubmission,
    fpcFundingPollIntervalMs: opts.fpcFundingPollIntervalMs!,
    predicate: toPredicateConfig(opts),
  };
}

/**
 * Build the Predicate sanctions-screening config, or `undefined` when the feature is off. Screening is opt-in:
 * it stays off unless a Predicate option is set, and once any is set the api key, verification hash, and chain
 * are all required.
 */
function toPredicateConfig(opts: CommanderRunOptions): PredicateScreenerConfig | undefined {
  const { predicateApiKey, predicateVerificationHash, predicateChain } = opts;
  const configured =
    predicateApiKey !== undefined || predicateVerificationHash !== undefined || predicateChain !== undefined;
  if (!configured) {
    return undefined;
  }
  if (!predicateApiKey || !predicateVerificationHash || !predicateChain) {
    throw new Error(
      'sanctions screening requires --predicate-api-key, --predicate-verification-hash, and --predicate-chain ' +
        '(or their OXIDE_RELAYER_PREDICATE_* env vars).',
    );
  }
  return {
    apiKey: predicateApiKey,
    verificationHash: predicateVerificationHash,
    chain: predicateChain,
  };
}

function toL1OperationsSubmissionConfig(opts: CommanderRunOptions): L1OperationsSubmissionConfig {
  return {
    retryBackoffMs: opts.l1OperationsRetryBackoffMs!,
    maxPendingAgeMs: opts.l1OperationsMaxPendingAgeSeconds! * 1000,
  };
}

function defaultSignerBackend(privateKeyEnvVar: string): SignerBackend {
  return process.env[privateKeyEnvVar] ? 'env' : 'keystore';
}

/** Parse and deduplicate the comma-separated mode list from CLI/env input. */
function parseModes(value: string): RelayerMode[] {
  const modes = parseCsv(value).map(mode => parseEnumValue(mode, RELAYER_MODES, 'relayer mode'));
  if (modes.length === 0) {
    throw new Error('--modes must include at least one mode.');
  }
  return [...new Set(modes)];
}

function parseEnumValue<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  try {
    return enumConfigHelper([...allowed]).parseEnv!(value) as T[number];
  } catch {
    throw new Error(`invalid ${label} '${value}'. Expected one of: ${allowed.join(', ')}.`);
  }
}

function missing(label: string): never {
  throw new Error(`missing required config: ${label}`);
}

function exactConfigFromEnvironment(options: { bundleFd: number }): RunExactOperationConfig {
  const signer = process.env.OXIDE_RELAYER_SIGNER ?? 'env';
  if (signer !== 'env' && signer !== 'keystore') {
    throw new Error("OXIDE_RELAYER_SIGNER must be 'env' or 'keystore' for relay-exact");
  }
  return {
    bundleFd: options.bundleFd,
    deploymentEnvManifestUrl: requiredEnv('OXIDE_DEPLOYMENT_ENV_MANIFEST_URL'),
    portal: EthAddress.fromString(requiredEnv('OXIDE_PORTAL')),
    readL1RpcUrl: requiredEnv('READ_L1_RPC_URL'),
    submissionL1RpcUrl: process.env.OXIDE_EXACT_SUBMISSION_L1_RPC_URL,
    aztecNodeUrl: requiredEnv('AZTEC_NODE_URL'),
    aztecNodeApiKey: aztecNodeApiKeyFromEnv(),
    signer: {
      backend: signer,
      privateKeyEnvVar: process.env.OXIDE_RELAYER_PRIVATE_KEY_ENV ?? 'OXIDE_RELAYER_PRIVATE_KEY',
      keystorePath: process.env.OXIDE_RELAYER_KEYSTORE,
      keystorePasswordFile: process.env.OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE,
    },
  };
}

function integerFd(value: string): number {
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error('file descriptor must be an integer of at least 3');
  }
  return fd;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required relay-exact environment variable: ${name}`);
  }
  return value;
}
