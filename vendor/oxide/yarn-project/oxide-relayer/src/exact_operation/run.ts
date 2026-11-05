import { readFile } from 'node:fs/promises';

import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { OxidePortalContract } from '@oxide/l1-contracts';
import { FleetSigner } from '@oxide/oxide-client/fleet_signer.js';
import { readOperationExecutorVersion } from '@oxide/oxide-client/l1_operation_quote.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';

import { createPublicClient } from 'viem';

import type { SignerConfig } from '../cli/config.js';
import { resolveDeploymentEnvManifest } from '../config/deployment_env_manifest.js';
import { chainFor, getL1PublicClient, l1Transport } from '../l1/client.js';
import { WithdrawalCompletion } from '../l1_operations/withdrawal_completion.js';
import { loadSigner } from '../signers/index.js';
import { assertExactApprovalToken } from './approval.js';
import {
  assertExactOperationMatches,
  parseExactOperationApproval,
  parseExactOperationRuntimeIdentity,
} from './contract.js';
import { ExactL1Execution } from './execution.js';
import { ExactOperationJournal } from './journal.js';
import { ExactOperationObserver } from './observer.js';
import { relayExactOperation } from './runner.js';
import { RuntimeLease } from './runtime_lease.js';

export interface RunExactOperationConfig {
  bundleFd?: number;
  approvalFd?: number;
  approvalTokenFd?: number;
  runtimeIdentityFd?: number;
  journalPath: string;
  runtimeLeasePath: string;
  deploymentEnvManifestUrl: string;
  portal: EthAddress;
  readL1RpcUrl: string;
  submissionL1RpcUrl?: string;
  aztecNodeUrl: string;
  aztecNodeApiKey?: string;
  signer: SignerConfig;
}

export async function runExactOperation(config: RunExactOperationConfig): Promise<{ l1TxHash: string }> {
  const material = await readApprovalMaterial(config);
  const approval = parseExactOperationApproval(material.approval);
  const approvalToken = material.approvalToken;
  const runtime = parseExactOperationRuntimeIdentity(material.runtimeIdentity);
  assertExactApprovalToken(approval, approvalToken);
  assertExactOperationMatches(approval, { ...approval, runtime });

  const lease = await RuntimeLease.acquire(config.runtimeLeasePath, 'exact-operation');
  let journal: ExactOperationJournal | undefined;
  try {
    // Schema validation precedes manifest, enclave, signer, or container-sensitive work.
    journal = await ExactOperationJournal.open(config.journalPath);
    const node = createNodeClient({ url: config.aztecNodeUrl, apiKey: config.aztecNodeApiKey });
    const manifest = await resolveDeploymentEnvManifest({
      deploymentEnvManifestUrl: config.deploymentEnvManifestUrl,
      portal: config.portal,
    });
    const { publicClient: identityClient, chainId, rollupVersion } = await getL1PublicClient(config.readL1RpcUrl, node);
    const publicClient = config.submissionL1RpcUrl
      ? createPublicClient({
          chain: chainFor(chainId),
          transport: l1Transport(config.readL1RpcUrl, config.submissionL1RpcUrl),
        })
      : identityClient;
    const { publicConfig } = manifest.current;
    const deployment = {
      label: manifest.current.label,
      chainId: chainId.toString(),
      rollupVersion: rollupVersion.toString(),
      portal: publicConfig.portal.toString().toLowerCase(),
      l2Token: publicConfig.l2Token.toString().toLowerCase(),
      broadcaster: publicConfig.broadcaster.toString().toLowerCase(),
      operationExecutor: publicConfig.operationExecutor.toString().toLowerCase(),
    };
    const portal = new OxidePortalContract(publicClient, publicConfig.portal);
    const observer = new ExactOperationObserver(node, portal, {
      runtime,
      deployment,
      economics: approval.economics,
    });
    const executorVersion = await readOperationExecutorVersion(
      publicClient,
      publicConfig.operationExecutor.toString(),
    );

    let account: ReturnType<typeof loadSigner> | undefined;
    const loadAccount = async () => (await (account ??= loadSigner(config.signer))).account;
    let completion: Promise<WithdrawalCompletion> | undefined;
    const loadCompletion = () =>
      (completion ??= FleetSigner.connect(publicConfig.enclaveUrl, portal, { maxAttempts: 1 }).then(
        signer =>
          new WithdrawalCompletion(
            node,
            portal,
            publicConfig.l2Token,
            signer,
            publicConfig.operationExecutor,
          ),
      ));
    const execution = new ExactL1Execution(observer, loadCompletion, publicClient, loadAccount, executorVersion);
    return await relayExactOperation({ approval, approvalToken, journal, execution });
  } finally {
    await journal?.close();
    await lease.close();
  }
}

async function readApprovalMaterial(config: RunExactOperationConfig): Promise<{
  approval: unknown;
  approvalToken: string;
  runtimeIdentity: unknown;
}> {
  if (config.bundleFd !== undefined) {
    if (
      config.approvalFd !== undefined ||
      config.approvalTokenFd !== undefined ||
      config.runtimeIdentityFd !== undefined
    ) {
      throw new Error('Exact-operation bundle descriptor cannot be combined with individual descriptors');
    }
    const bundle = await readJsonFd(config.bundleFd, 'approval bundle');
    if (
      typeof bundle !== 'object' ||
      bundle === null ||
      Array.isArray(bundle) ||
      Object.keys(bundle).sort().join(',') !== 'approval,approvalToken,runtimeIdentity'
    ) {
      throw new Error('Exact-operation approval bundle must contain only approval, approvalToken and runtimeIdentity');
    }
    const record = bundle as Record<string, unknown>;
    if (typeof record.approvalToken !== 'string') {
      throw new Error('Exact-operation approval bundle token is malformed');
    }
    return {
      approval: record.approval,
      approvalToken: record.approvalToken.trim(),
      runtimeIdentity: record.runtimeIdentity,
    };
  }
  if (
    config.approvalFd === undefined ||
    config.approvalTokenFd === undefined ||
    config.runtimeIdentityFd === undefined
  ) {
    throw new Error('Exact-operation requires one bundle descriptor or all three individual descriptors');
  }
  const [approval, approvalToken, runtimeIdentity] = await Promise.all([
    readJsonFd(config.approvalFd, 'approval'),
    readTextFd(config.approvalTokenFd, 'approval token'),
    readJsonFd(config.runtimeIdentityFd, 'runtime identity'),
  ]);
  return { approval, approvalToken, runtimeIdentity };
}

async function readJsonFd(fd: number, label: string): Promise<unknown> {
  const input = await readTextFd(fd, label);
  try {
    return JSON.parse(input);
  } catch (cause) {
    throw new Error(`Exact-operation ${label} is malformed JSON`, { cause });
  }
}

async function readTextFd(fd: number, label: string): Promise<string> {
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(`Exact-operation ${label} file descriptor must be an integer of at least 3`);
  }
  const input = await readFile(`/dev/fd/${fd}`, 'utf8');
  if (Buffer.byteLength(input) > 64 * 1024) {
    throw new Error(`Exact-operation ${label} exceeds 64 KiB`);
  }
  return input.trim();
}
