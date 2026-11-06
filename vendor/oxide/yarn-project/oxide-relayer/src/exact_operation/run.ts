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
import { assertExactApprovalToken, exactApprovalTokenCommitment } from './approval.js';
import { assertExactApprovalWindow, assertExactOperationMatches, parseExactOperationApproval } from './contract.js';
import { ExactL1Execution } from './execution.js';
import { ExactOperationJournal } from './journal.js';
import { S3ExactApprovalClaimStore } from './monotonic_claim.js';
import { ExactOperationObserver } from './observer.js';
import { EXACT_APPROVAL_AUTHORITY_PATH } from './paths.js';
import { loadExactRuntimeIdentity, loadPreparedCleanHandoffDigest } from './runtime_identity.js';
import { relayExactOperation } from './runner.js';
import { RuntimeLease } from './runtime_lease.js';
import { resolveExactStorageRoots } from './storage_roots.js';
import { loadWitnessConfiguration, loadWitnessCredentials } from './witness_configuration.js';

export interface RunExactOperationConfig {
  bundleFd: number;
  canonicalState: string;
  controlDir: string;
  deploymentEnvManifestUrl: string;
  portal: EthAddress;
  readL1RpcUrl: string;
  submissionL1RpcUrl?: string;
  aztecNodeUrl: string;
  aztecNodeApiKey?: string;
  signer: SignerConfig;
}

export async function runExactOperation(config: RunExactOperationConfig): Promise<{ l1TxHash: string }> {
  const storage = await resolveExactStorageRoots(config.canonicalState, config.controlDir);
  const material = await readApprovalMaterial(config.bundleFd);
  const approval = parseExactOperationApproval(material.approval);
  const approvalToken = material.approvalToken;
  const authority = await readFile(EXACT_APPROVAL_AUTHORITY_PATH, 'utf8');
  assertExactApprovalToken(approval, approvalToken, authority);
  assertExactApprovalWindow(approval);
  const approvalCommitment = exactApprovalTokenCommitment(approvalToken);
  const handoffDigest = loadPreparedCleanHandoffDigest();
  if (handoffDigest !== approval.stageA.handoffMarkerDigest) {
    throw new Error('Canonical clean handoff differs from the signed Stage A identity');
  }
  const lease = await RuntimeLease.acquire(storage.runtimeLease, 'exact-operation', {
    prevalidatedExactHandoffDigest: handoffDigest,
  });
  let journal: ExactOperationJournal | undefined;
  try {
    const runtime = await loadExactRuntimeIdentity();
    assertExactOperationMatches(approval, { ...approval, runtime });
    await lease.activateExactHandoff(handoffDigest);
    // Fixed journal schema validation precedes manifest, enclave and signer work.
    journal = await ExactOperationJournal.open(storage.exactJournal);
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
      registry: approval.deployment.registry,
      manifestDigest: approval.deployment.manifestDigest,
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
    const execution = new ExactL1Execution(observer, loadCompletion, publicClient, loadAccount, Number(chainId), executorVersion);
    const configuredWitness = await loadWitnessConfiguration();
    if (
      approval.witness.configurationDigest !== configuredWitness.configurationDigest ||
      approval.witness.authorityCommitment !== configuredWitness.authorityCommitment ||
      config.aztecNodeUrl !== new URL(configuredWitness.aztecNodeUrl).toString()
    ) {
      throw new Error('Approved witness authority does not match reviewed runtime configuration');
    }
    const claimStore = new S3ExactApprovalClaimStore(configuredWitness, {
      credentials: await loadWitnessCredentials(),
    });
    return await relayExactOperation({ approval, approvalCommitment, journal, execution, claimStore });
  } finally {
    await journal?.close();
    await lease.close();
  }
}


async function readApprovalMaterial(bundleFd: number): Promise<{
  approval: unknown;
  approvalToken: string;
}> {
  const bundle = await readJsonFd(bundleFd, 'approval bundle');
  if (
    typeof bundle !== 'object' ||
    bundle === null ||
    Array.isArray(bundle) ||
    Object.keys(bundle).sort().join(',') !== 'approval,approvalToken'
  ) {
    throw new Error('Exact-operation approval bundle must contain only approval and approvalToken');
  }
  const record = bundle as Record<string, unknown>;
  if (typeof record.approvalToken !== 'string') {
    throw new Error('Exact-operation approval bundle token is malformed');
  }
  return {
    approval: record.approval,
    approvalToken: record.approvalToken.trim(),
  };
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
