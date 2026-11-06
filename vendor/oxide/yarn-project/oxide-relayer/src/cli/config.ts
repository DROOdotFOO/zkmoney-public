import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import type { PredicateScreenerConfig } from '../l1_operations/predicate_screener.js';
import type { ProverCommanderOptions, ProverRunConfig } from '../prover/cli.js';

/** Relayer subsystems the operator can enable from the public `run` command. */
export const RELAYER_MODES = ['l1-operations', 'fpc-funding', 'epoch-proofs'] as const;
export type RelayerMode = (typeof RELAYER_MODES)[number];

/** Signer backends implemented in this scaffold. Remote signer backends can extend this union later. */
export const SIGNER_BACKENDS = ['env', 'keystore'] as const;
export type SignerBackend = (typeof SIGNER_BACKENDS)[number];

/**
 * Operator-local policy for executing broadcast L1 operations. Only present when the l1-operations mode is
 * enabled.
 *
 * Operations submit through the deployment env manifest's published OperationExecutor for the version. Wherever
 * the chain has a Flashbots Protect endpoint (see `l1/flashbots_protect.ts`) submission goes through it, so lost
 * races and unprofitable executions revert for free.
 */
export interface L1OperationsSubmissionConfig {
  /** Backoff before re-checking a deferred operation. After a reverting simulation it doubles on each revert. */
  retryBackoffMs: number;
  /** Time from when an operation is recorded until a deferral drops it, whatever the defer cause. */
  maxPendingAgeMs: number;
}

/**
 * Fully normalized runtime config for the relayer.
 *
 * Commander owns CLI/env collection; this type is the boundary the rest of the relayer should depend on.
 */
export interface RunConfig extends ProverRunConfig {
  deploymentEnvManifestUrl: string;
  /** The deployment this relayer serves: the portal of one bridge in the manifest. */
  portal: EthAddress;
  /** Manifest entries that get no L1-operations worker, by portal. Empty by default. */
  excludePortals: EthAddress[];
  /**
   * L1 RPC for every read, and for submission too on a chain with no Flashbots Protect endpoint. Rejected when
   * it points at Protect: submission picks its own endpoint and takes no configuration (`l1/flashbots_protect.ts`).
   */
  readL1RpcUrl: string;
  /** Block window of an L1 tx on every chain: the Protect drop window, and the window the relayer expires a tx on. */
  flashbotsBlockRange: number;
  /** Cap on the `maxFeePerGas` of every relayer tx. Unset means no relayer cap. */
  l1MaxFeePerGasGwei?: number;
  aztecNodeUrl: string;
  aztecNodeApiKey?: string;
  modes: RelayerMode[];
  signer: SignerConfig;
  state: StateConfig;
  sdnUrl?: string;
  /** Blocks per L1 `eth_getLogs` call of the balance watcher's transfer scan. */
  logScanWindow?: bigint;
  /**
   * Run every check up to the L1 send, then skip the send: nothing is signed or broadcast. The flows continue as if
   * the tx was mined, so metrics show what a real relayer would do. With no signer key configured, the signer is an
   * ephemeral key.
   */
  disableSubmission: boolean;
  /** Submit even when unprofitable. */
  allowUnprofitable: boolean;
  /** Interval between L1 operation poll cycles (broadcast sync, quote, submission). */
  l1OperationsPollIntervalMs?: number;
  /** Accepted payout tokens for L1 operations. Defaults to the manifest entry's `token` if unset. */
  l1OperationsPayoutTokens?: EthAddress[];
  /** Present only when the l1-operations mode is enabled. */
  l1OperationsSubmission?: L1OperationsSubmissionConfig;
  /** Interval between FPC funder bounty checks. */
  fpcFundingPollIntervalMs?: number;
  predicate?: PredicateScreenerConfig;
}

/** Local L1 signing configuration. Optional when `disableSubmission` is true: a random key is then used. */
export interface SignerConfig {
  backend: SignerBackend;
  privateKeyEnvVar: string;
  keystorePath?: string;
  keystorePassword?: string;
  keystorePasswordFile?: string;
  /** Encrypted keystore bytes prepared by the privileged initializer before dropping identity. */
  keystoreJson?: Buffer;
  /** Keystore password bytes prepared by the privileged initializer before dropping identity. */
  keystorePasswordBytes?: Buffer;
}

/** Persistent SQLite state for each deployment. */
export interface StateConfig {
  backend: 'sqlite';
  sqlitePath: string;
}

const REDACTED = '<redacted>';

/**
 * The config as a loggable object. Secrets are redacted. Only the origin of each URL is kept, because RPC
 * providers and signed URLs put credentials in the path or the query.
 */
export function redactRunConfig(config: RunConfig): Record<string, unknown> {
  const redacted = {
    ...config,
    portal: config.portal.toString(),
    excludePortals: config.excludePortals.map(portal => portal.toString()),
    l1OperationsPayoutTokens: config.l1OperationsPayoutTokens?.map(token => token.toString()),
    proverPayoutTokens: config.proverPayoutTokens?.map(token => token.toString()),
    deploymentEnvManifestUrl: urlOrigin(config.deploymentEnvManifestUrl),
    sdnUrl: config.sdnUrl && urlOrigin(config.sdnUrl),
    readL1RpcUrl: urlOrigin(config.readL1RpcUrl),
    aztecNodeUrl: urlOrigin(config.aztecNodeUrl),
    aztecNodeApiKey: config.aztecNodeApiKey && REDACTED,
    proverNodeUrl: config.proverNodeUrl && urlOrigin(config.proverNodeUrl),
    signer: {
      ...config.signer,
      keystorePassword: config.signer.keystorePassword && REDACTED,
      keystoreJson: config.signer.keystoreJson && REDACTED,
      keystorePasswordBytes: config.signer.keystorePasswordBytes && REDACTED,
    },
    predicate: config.predicate && { ...config.predicate, apiKey: REDACTED, log: undefined },
  };
  return JSON.parse(JSON.stringify(redacted, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
}

export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return REDACTED;
  }
}

/** Raw Commander option object before relayer cross-field validation is applied. */
export interface CommanderRunOptions extends ProverCommanderOptions {
  deploymentEnvManifest?: string;
  portal?: string;
  excludePortals?: string;
  readL1Rpc?: string;
  flashbotsBlockRange?: number;
  l1MaxFeePerGasGwei?: number;
  aztecNode?: string;
  modes?: string;
  signer?: SignerBackend;
  privateKeyEnv?: string;
  keystore?: string;
  keystorePassword?: string;
  keystorePasswordFile?: string;
  stateBackend?: string;
  state?: string;
  sdnUrl?: string;
  logScanWindow?: number;
  disableSubmission?: boolean;
  l1OperationsPollIntervalMs?: number;
  fpcFundingPollIntervalMs?: number;
  l1OperationsRetryBackoffMs?: number;
  l1OperationsMaxPendingAgeSeconds?: number;
  l1OperationsPayoutTokens?: string;
  allowUnprofitable?: boolean;
  predicateApiKey?: string;
  predicateVerificationHash?: string;
  predicateChain?: string;
}
