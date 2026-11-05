import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';

import { OxidePortalContract, depositTokensFor } from '@oxide/l1-contracts';
import { priceFeedForChainId } from '@oxide/oxide-client/eth_usd_price_feed.js';
import { FleetSigner } from '@oxide/oxide-client/fleet_signer.js';
import { readOperationExecutorVersion } from '@oxide/oxide-client/l1_operation_quote.js';
import type { RegisteredTeeSigner } from '@oxide/oxide-client/types.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';
import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { initTelemetry } from '@oxide/telemetry';
import { OFAC_SDN_LIST_URL, OfacSdnList } from '@oxide/watcher-lib/sanctions';

import { type PublicClient, zeroAddress } from 'viem';

import { type RunConfig, redactRunConfig } from './cli/config.js';
import {
  type ResolvedManifestDeployment,
  describeSkip,
  resolveDeploymentEnvManifest,
} from './config/deployment_env_manifest.js';
import { DeploymentManifestRefresher } from './config/deployment_manifest_refresher.js';
import { RuntimeLease, runtimeLeasePath } from './exact_operation/runtime_lease.js';

import { FpcFunderCaller } from './fpc_funding/fpc_funder_caller.js';
import { HistoricalDeploymentSupervisor } from './historical_deployment_supervisor.js';
import { getL1PublicClient } from './l1/client.js';
import { assertNotFlashbots } from './l1/flashbots_protect.js';
import { createL1TxQueue } from './l1/l1_tx_queue.js';
import { L1OperationRelayer } from './l1_operations/l1_operation_relayer.js';
import { L1OperationRouter } from './l1_operations/l1_operation_router.js';
import { PayoutTokenRegistry } from './l1_operations/payout_token_registry.js';
import { WithdrawalCompletion } from './l1_operations/withdrawal_completion.js';
import { UsdPeggedPriceOracle } from './price_oracle/usd_pegged_price_oracle.js';
import { startEpochProofs } from './prover/index.js';
import { RelayerTelemetry } from './relayer_telemetry.js';
import { createEphemeralSigner, hasSignerKey, loadSigner } from './signers/index.js';
import { statePathForPortal } from './state/path.js';
import { type SqliteStateStore, openSqliteStateStore } from './state/sqlite_store.js';
import { relayerVersion } from './version.js';

/**
 * Bootstrap the long-running relayer process.
 */
export interface RunRelayerOptions {
  shutdownSignal?: AbortSignal;
  teeSigner?: RegisteredTeeSigner;
  /** The signer of one deployment's portal, before `teeSigner`. A test with several portals gives each its own. */
  teeSignerFor?: (portal: EthAddress) => RegisteredTeeSigner | undefined;
}

/** Bounded final telemetry flush on shutdown, so a hung exporter cannot block exit. */
const TELEMETRY_STOP_MS = 5_000;

export async function runRelayer(config: RunConfig, opts: RunRelayerOptions = {}): Promise<void> {
  const lease = await RuntimeLease.acquire(runtimeLeasePath(), 'generic');
  let cleanHandoff = false;
  try {
    await runRelayerWithLease(config, opts);
    cleanHandoff = true;
  } finally {
    await lease.close({ cleanHandoff });
  }
}
async function runRelayerWithLease(config: RunConfig, opts: RunRelayerOptions): Promise<void> {
  const log = createLogger('oxide-relayer');
  log.info(`oxide-relayer version ${relayerVersion()}`);
  log.info('Starting relayer', { config: redactRunConfig(config) });

  // Assert read URL is not mistakenly set to Flashbots
  assertNotFlashbots(config.readL1RpcUrl);

  const manifest = await resolveDeploymentEnvManifest({
    deploymentEnvManifestUrl: config.deploymentEnvManifestUrl,
    portal: config.portal,
    excludePortals: config.excludePortals,
    acceptedPayoutTokens: config.l1OperationsPayoutTokens,
  });
  const currentPublicConfig = manifest.current.publicConfig;
  for (const skipped of manifest.skipped) {
    log.info(describeSkip(skipped));
  }
  const pinnedSkip = manifest.skipped.find(s => s.portal === currentPublicConfig.portal.toString().toLowerCase());
  const historical = config.modes.includes('l1-operations') ? manifest.historical : [];
  const currentStatePath = statePathForPortal(
    config.state.sqlitePath,
    currentPublicConfig.portal,
    historical.length + 1,
  );
  const historicalPaths = historical.map(deployment => ({
    deployment,
    path: statePathForPortal(config.state.sqlitePath, deployment.publicConfig.portal, historical.length + 1),
  }));

  const node = createNodeClient({ url: config.aztecNodeUrl, apiKey: config.aztecNodeApiKey });
  const { publicClient, chainId, rollupVersion } = await getL1PublicClient(config.readL1RpcUrl, node);
  // A wrong node URL must not make this process serve another L2.
  assertNodeRollupVersion(rollupVersion, manifest.current);
  const identity = ({ publicConfig }: ResolvedManifestDeployment) => ({
    chainId,
    portal: publicConfig.portal.toString(),
    l2Token: publicConfig.l2Token.toString(),
    rollupVersion: publicConfig.rollupVersion,
    ...(config.modes.includes('l1-operations') ? { broadcaster: publicConfig.broadcaster.toString() } : {}),
  });

  const signer =
    config.disableSubmission && !hasSignerKey(config.signer)
      ? createEphemeralSigner()
      : await loadSigner(config.signer);
  const l1TxQueue = createL1TxQueue({
    client: publicClient,
    account: signer.account,
    readL1RpcUrl: config.readL1RpcUrl,
    flashbotsBlockRange: config.flashbotsBlockRange,
    disableSubmission: config.disableSubmission,
    maxFeePerGasCap:
      config.l1MaxFeePerGasGwei === undefined ? undefined : BigInt(Math.trunc(config.l1MaxFeePerGasGwei * 1e9)),
  });

  // Endpoint arrives through the standard OTel env vars set by the deploy; external operators set nothing
  // and every instrument is a no-op. The pinned entry's label is service.version.
  const telemetryClient = await initTelemetry({
    serviceName: 'oxide-relayer',
    serviceVersion: manifest.current.label,
    // Lets dashboards tell the fisherman (submission disabled) from relayers that send txs.
    resourceAttributes: { 'oxide.relayer.submission': config.disableSubmission ? 'disabled' : 'enabled' },
  });
  const telemetry = new RelayerTelemetry(telemetryClient);

  let sdn: OfacSdnList | undefined;
  let state: SqliteStateStore | undefined;
  const historicalSupervisors: HistoricalDeploymentSupervisor[] = [];
  let manifestRefresher: DeploymentManifestRefresher | undefined;
  const operationStores = new Set<SqliteStateStore>();
  const currentServices: Array<{ stop(): Promise<void> }> = [];
  try {
    state = await openSqliteStateStore(currentStatePath, identity(manifest.current));
    const priceOracle = await UsdPeggedPriceOracle.create(publicClient, { chainId, tokens: [] });
    console.log(
      [
        `oxide-relayer starting label=${manifest.current.label}`,
        `modes=${config.modes.join(',')}`,
        // Hostnames only: the read RPC URL embeds a provider API key.
        `l1ReadRpc=${rpcHost(config.readL1RpcUrl)}`,
        `portal=${currentPublicConfig.portal}`,
        `rollupVersion=${currentPublicConfig.rollupVersion}`,
        `aztecNodeUrl=${rpcHost(config.aztecNodeUrl)}`,
        `aztecNodeApiKey=${config.aztecNodeApiKey ? '(configured)' : '(none)'}`,
        `enclaveUrl=${currentPublicConfig.enclaveUrl || '(none)'}`,
        `state=${currentStatePath}`,
        `signer=${signer.backend}:${signer.address}`,
        `submission=${config.disableSubmission ? 'disabled' : 'enabled'}`,
        `l1MaxFeePerGasGwei=${config.l1MaxFeePerGasGwei ?? '(none)'}`,
        `priceFeed=${priceFeedForChainId(chainId).toString()}`,
        `sdn=${config.modes.includes('l1-operations') ? rpcHost(config.sdnUrl ?? OFAC_SDN_LIST_URL) : '(none)'}`,
        `l1OperationScreening=${config.modes.includes('l1-operations') ? 'enabled' : 'disabled'}`,
      ].join(' '),
    );

    if (config.disableSubmission) {
      console.log('submission is disabled; relayer will skip L1 transaction sends and treat them as mined.');
    }
    // The ephemeral key holds no ETH, so its balance tells nothing.
    if (signer.backend !== 'ephemeral') {
      telemetry.observeSignerBalance(() => publicClient.getBalance({ address: signer.address }));
    }
    if (config.modes.includes('l1-operations')) {
      const { l1OperationsSubmission } = config;
      if (!l1OperationsSubmission) {
        throw new Error('l1-operations mode requires the L1 operation submission policy');
      }
      const sanctionsList = await OfacSdnList.start(config.sdnUrl);
      sdn = sanctionsList;
      telemetry.observeSdnListAge(() => sanctionsList.lastRefreshedAt);
      const sum = async (counts: Iterable<Promise<number>>) => (await Promise.all(counts)).reduce((a, b) => a + b, 0);
      telemetry.observeL1OperationBacklog(() =>
        sum([...operationStores].map(async store => (await store.listPendingL1Operations()).length)),
      );
      telemetry.observeL1OperationWaiting(() =>
        sum(
          [...operationStores].map(async store => {
            const [balance, outbox] = await Promise.all([
              store.listWaitingL1Operations(L1OperationConditionKind.Balance),
              store.listWaitingL1Operations(L1OperationConditionKind.MessageInOutbox),
            ]);
            return balance.length + outbox.length;
          }),
        ),
      );
      await assertSimulateV1Supported(publicClient, config.readL1RpcUrl);
      // All startup deployments are added to the router before any worker is started, so the priority order is fixed:
      // the pinned deployment first, which is always running, then the manifest order. The owner of an operation can
      // change; a worker that saved the operation then gives way to the new owner before it submits.
      const router = new L1OperationRouter(log);
      const payoutTokenRegistry = await PayoutTokenRegistry.create(priceOracle, config.l1OperationsPayoutTokens, {
        chainId,
        log,
      });
      // Every startup deployment is also registered for its payout tokens before any worker starts, so each worker
      // accepts their tokens from its first poll.
      const startupDeployments = [...(pinnedSkip ? [] : [manifest.current]), ...historical];
      for (const deployment of startupDeployments) {
        router.addWorker(deployment);
        await payoutTokenRegistry.addDeployment({ label: deployment.label, token: deployment.publicConfig.token });
      }
      log.info(`L1 operations accept payout in ${payoutTokenRegistry.list().join(', ')}`);
      for (const line of priceOracle.describe()) {
        log.info(`L1 operation gas pricing: ${line}`);
      }
      const start = async (deployment: ResolvedManifestDeployment, store: SqliteStateStore) => {
        const { publicConfig, label } = deployment;
        const portal = new OxidePortalContract(publicClient, publicConfig.portal);
        await payoutTokenRegistry.addDeployment({ label, token: publicConfig.token });
        const teeSigner = opts.teeSignerFor?.(publicConfig.portal) ?? opts.teeSigner;
        if (!teeSigner && !publicConfig.enclaveUrl) {
          throw new Error(`no enclave is published for deployment ${label}:${publicConfig.portal}`);
        }
        const withdrawalSigner = teeSigner ?? (await FleetSigner.connect(publicConfig.enclaveUrl, portal));
        // An entry keeps the executor that it was deployed with, so an older entry can have the legacy `execute`.
        const executorVersion = await readOperationExecutorVersion(
          publicClient,
          publicConfig.operationExecutor.toString(),
        );
        const worker = L1OperationRelayer.create({
          node,
          publicClient,
          store,
          broadcaster: publicConfig.broadcaster,
          ownership: router.ownershipFor(deployment),
          payoutTokens: payoutTokenRegistry,
          watchedTokens: depositTokensFor(chainId, publicConfig.token),
          l1OperationsSubmission,
          allowUnprofitable: config.allowUnprofitable,
          executor: publicConfig.operationExecutor,
          executorVersion,
          l1TxQueue,
          sanctionsList,
          withdrawalCompletion: new WithdrawalCompletion(
            node,
            portal,
            publicConfig.l2Token,
            withdrawalSigner,
            publicConfig.operationExecutor,
          ),
          predicate: config.predicate,
          logScanWindow: config.logScanWindow,
          priceOracle,
          telemetry,
          pollIntervalMs: config.l1OperationsPollIntervalMs,
          logger: createLogger(`oxide-relayer:${label}:${publicConfig.portal.toString().toLowerCase()}`),
        });
        router.attachStore(deployment, store);
        worker.start();
        operationStores.add(store);
        // One line per worker, the pinned one included, for deploy checks.
        console.log(`deployment worker started label=${label} portal=${publicConfig.portal}`);
        return worker;
      };
      if (pinnedSkip) {
        log.warn(
          `the pinned entry ${manifest.current.label}:${currentPublicConfig.portal} gets no L1-operations worker ` +
            `(${pinnedSkip.reason}); fpc-funding and epoch proofs still run for it when enabled`,
        );
      } else {
        currentServices.push(await start(manifest.current, state));
      }
      const discover = (deployment: ResolvedManifestDeployment, path: string) => {
        // A deployment that the manifest refresher finds is added here; a startup deployment is added already.
        router.addWorker(deployment);
        const supervisor = new HistoricalDeploymentSupervisor({
          label: deployment.label,
          portal: deployment.publicConfig.portal.toString(),
          start: async () => {
            const historicalState = await openSqliteStateStore(path, identity(deployment));
            try {
              const worker = await start(deployment, historicalState);
              return {
                stop: () => worker.stop(),
                close: async () => {
                  router.detachStore(deployment);
                  operationStores.delete(historicalState);
                  await historicalState.close();
                },
              };
            } catch (error) {
              router.detachStore(deployment);
              await historicalState.close();
              throw error;
            }
          },
        });
        historicalSupervisors.push(supervisor);
        supervisor.start();
      };
      for (const { deployment, path } of historicalPaths) {
        discover(deployment, path);
      }
      manifestRefresher = new DeploymentManifestRefresher({
        deploymentEnvManifestUrl: config.deploymentEnvManifestUrl,
        initial: manifest,
        excludePortals: config.excludePortals,
        acceptedPayoutTokens: config.l1OperationsPayoutTokens,
        discover: deployment =>
          discover(deployment, statePathForPortal(config.state.sqlitePath, deployment.publicConfig.portal, 2)),
      });
    }

    if (config.modes.includes('epoch-proofs')) {
      currentServices.push(
        await startEpochProofs(config, manifest, { client: publicClient, node, l1TxQueue, teeSigner: opts.teeSigner }),
      );
    }

    if (config.modes.includes('fpc-funding')) {
      const fpcFunding = FpcFunderCaller.create({
        fpcFunder: currentPublicConfig.fpcFunder,
        executor: currentPublicConfig.operationExecutor,
        executorVersion: await readOperationExecutorVersion(
          publicClient,
          currentPublicConfig.operationExecutor.toString(),
        ),
        client: publicClient,
        l1TxQueue,
        priceOracle,
        allowUnprofitable: config.allowUnprofitable,
        pollIntervalMs: config.fpcFundingPollIntervalMs,
      });
      fpcFunding.start();
      currentServices.push(fpcFunding);
    }

    manifestRefresher?.start();
    await waitForShutdown(opts.shutdownSignal);
  } finally {
    await manifestRefresher?.stop();
    // Stop the L1 tx queue together with the workers. A worker run can wait on a queue hold that only the queue stop
    // ends.
    const stopResults = await Promise.allSettled(
      [...historicalSupervisors, ...currentServices, l1TxQueue].map(service => service.stop()),
    );
    // stop() with a timeout so shutdown does not hang if the exporter stalls.
    await Promise.allSettled([
      Promise.race([
        telemetryClient.stop(),
        new Promise<void>(resolve => setTimeout(resolve, TELEMETRY_STOP_MS).unref()),
      ]),
    ]);
    const closeResults = await Promise.allSettled(historicalSupervisors.map(supervisor => supervisor.close()));
    await state?.close();
    sdn?.stop();
    const shutdownFailures = [...stopResults, ...closeResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (shutdownFailures.length > 0) {
      throw new AggregateError(shutdownFailures, 'Relayer shutdown was not clean; exact-operation handoff is forbidden');
    }
  }
}

/** The hostname of an L1 RPC URL, for logs that must not leak the provider API key the URL embeds. */
function rpcHost(url: string): string {
  return new URL(url).hostname;
}

/**
 * The pinned entry's rollup version selects the L2 this process serves. An Aztec node follows one rollup, so a
 * node on another rollup would serve another L2; refuse to start instead.
 */
export function assertNodeRollupVersion(nodeRollupVersion: bigint, current: ResolvedManifestDeployment): void {
  const expected = current.publicConfig.rollupVersion;
  if (nodeRollupVersion !== expected) {
    throw new Error(
      `node reports rollup version ${nodeRollupVersion}, but the pinned entry ` +
        `${current.label}:${current.publicConfig.portal} is on ${expected}`,
    );
  }
}

/**
 * The l1-operations screen reads the logs of an `eth_simulateV1` run, so a read RPC without the method cannot
 * execute an operation. One trivial simulation at startup fails the process instead of deferring every operation
 * forever. Providers answer an unsupported method in different ways (`-32601`, custom messages, plain-text HTTP
 * bodies), so every error counts as unsupported.
 */
export async function assertSimulateV1Supported(
  client: Pick<PublicClient, 'simulateBlocks'>,
  readL1RpcUrl: string,
): Promise<void> {
  try {
    await client.simulateBlocks({ blocks: [{ calls: [{ to: zeroAddress }] }] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `l1-operations mode needs a read RPC that supports eth_simulateV1; ${rpcHost(readL1RpcUrl)} answered: ${message}`,
    );
  }
}

function waitForShutdown(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      signal?.removeEventListener('abort', shutdown);
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    signal?.addEventListener('abort', shutdown, { once: true });
  });
}
