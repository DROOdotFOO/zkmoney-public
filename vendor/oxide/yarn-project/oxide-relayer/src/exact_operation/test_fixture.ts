import type { ExactOperationApproval } from './contract.js';

export function exactApprovalFixture(now = new Date()): ExactOperationApproval {
  const second = Math.floor(now.getTime() / 1000) * 1000;
  const notBefore = new Date(second - 60_000).toISOString().replace('.000Z', 'Z');
  const frozenAt = new Date(second - 30_000).toISOString().replace('.000Z', 'Z');
  const sourceBlockTimestamp = new Date(second - 15_000).toISOString().replace('.000Z', 'Z');
  const expiresAt = new Date(second + 60 * 60_000).toISOString().replace('.000Z', 'Z');
  return {
    schema: 'oxide-relayer.exact-operation.v4',
    approvalNonce: `0x${'aa'.repeat(32)}`,
    notBefore,
    expiresAt,
    stageA: {
      approvalDigest: `sha256:${'01'.repeat(32)}`,
      intentWitnessVersionId: 'intent-version',
      intentWitnessChecksumSha256: `sha256:${'02'.repeat(32)}`,
      witnessVersionId: 'completion-version',
      witnessChecksumSha256: `sha256:${'03'.repeat(32)}`,
      completionWitnessBodySha256: `sha256:${'04'.repeat(32)}`,
      handoffMarkerDigest: `sha256:${'05'.repeat(32)}`,
      exitIntentCommitment: `0x${'06'.repeat(32)}`,
      frozenAt,
    },
    runtime: {
      host: 'reviewed-exact-host',
      sourceCommit: '1'.repeat(40),
      imageDigest: `sha256:${'22'.repeat(32)}`,
      runtimeUid: 65532,
      runtimeGid: 65532,
      signerAddress: `0x${'33'.repeat(20)}`,
      schemaIdentity: 'oxide-relayer.sqlite.portal-v4+exact-v3+generic-v2+lease-v1+runtime-v2',
      stateInventoryDigest: `sha256:${'44'.repeat(32)}`,
      canonicalStateDigest: `sha256:${'55'.repeat(32)}`,
      expectedNonce: 7,
    },
    witness: {
      configurationDigest: `sha256:${'07'.repeat(32)}`,
      authorityCommitment: `sha256:${'08'.repeat(32)}`,
      retentionMode: 'COMPLIANCE',
      retainUntil: '9999-12-31T23:59:59.000Z',
    },
    deployment: {
      label: 'oxide-v6',
      chainId: '1',
      rollupVersion: '2',
      portal: `0x${'66'.repeat(20)}`,
      registry: `0x${'67'.repeat(20)}`,
      manifestDigest: `sha256:${'09'.repeat(32)}`,
      l2Token: `0x${'77'.repeat(32)}`,
      broadcaster: `0x${'88'.repeat(32)}`,
      operationExecutor: `0x${'99'.repeat(20)}`,
    },
    operation: {
      id: `0x${'ab'.repeat(32)}`,
      kind: 'withdrawal_finalization',
      sourceTxHash: `0x${'bc'.repeat(32)}`,
      sourceBlockNumber: '123',
      sourceBlockHash: `0x${'cd'.repeat(32)}`,
      sourceBlockTimestamp,
      sourceFinalized: true,
      sourceEventCount: 1,
      target: `0x${'66'.repeat(20)}`,
      payoutToken: `0x${'de'.repeat(20)}`,
      calldataSha256: `0x${'ef'.repeat(32)}`,
      broadcasterEvent: {
        contract: `0x${'88'.repeat(32)}`,
        eventSignature: `0x${'10'.repeat(32)}`,
        logIndex: '0',
        callSha256: `0x${'11'.repeat(32)}`,
      },
      outboxWitness: {
        root: `0x${'12'.repeat(32)}`,
        leafIndex: '0',
        proofDigest: `sha256:${'13'.repeat(32)}`,
      },
    },
    withdrawal: {
      executor: `0x${'aa'.repeat(20)}`,
      recipientCommitment: `0x${'bb'.repeat(32)}`,
      amount: '1000',
      proverTip: '10',
      relayerTip: '20',
    },
    economics: {
      executorVersion: 'legacy',
      minimumPayout: '900',
      minimumProceeds: '900',
      executorFeeCeiling: '1000000000000000',
      maximumGasToCover: '0',
      tokenWeiPerEth: '0',
      maximumGas: '500000',
      maximumFeePerGas: '1000000000',
      maximumPriorityFeePerGas: '100000000',
      maximumTotalFee: '1000000000000000',
    },
  };
}
