import { describe, expect, it, jest } from '@jest/globals';

import { ExactExecutionLimits, ExactL1Execution } from './execution.js';
import { exactApprovalFixture } from './test_fixture.js';

describe('exact execution limits', () => {
  it('independently permits at most one TEE request, one L1 signing, and one send', async () => {
    const limits = new ExactExecutionLimits();
    const tee = jest.fn(() => Promise.resolve('tee-signature'));
    const signing = jest.fn(() => Promise.resolve('signed-l1-transaction'));
    const send = jest.fn(() => Promise.resolve('transaction-hash'));

    await expect(limits.requestTeeSignature(tee)).resolves.toBe('tee-signature');
    await expect(limits.signL1Transaction(signing)).resolves.toBe('signed-l1-transaction');
    await expect(limits.sendRawTransaction(send)).resolves.toBe('transaction-hash');

    await expect(limits.requestTeeSignature(tee)).rejects.toThrow('TEE finalization signature request limit is one');
    await expect(limits.signL1Transaction(signing)).rejects.toThrow('L1 transaction signing limit is one');
    await expect(limits.sendRawTransaction(send)).rejects.toThrow('eth_sendRawTransaction call limit is one');
    expect(tee).toHaveBeenCalledTimes(1);
    expect(signing).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rechecks approval immediately before requesting TEE finalization', async () => {
    const approval = exactApprovalFixture();
    approval.deployment.broadcaster = `0x${'08'.repeat(32)}`;
    const resolveCalldata = jest.fn(async () => '0xfinalization');
    const loadCompletion = jest.fn(async () => ({ resolveCalldata }));
    const observer = {
      exactOperation: () => ({
        target: { toString: () => approval.operation.target },
        payoutToken: { toString: () => approval.operation.payoutToken },
        calldata: '0x',
        condition: {},
      }),
    };
    const execution = new ExactL1Execution(
      observer as never,
      loadCompletion as never,
      {} as never,
      (async () => ({ address: approval.runtime.signerAddress })) as never,
      Number(approval.deployment.chainId),
      approval.economics.executorVersion,
    );

    await expect(
      execution.signOnce(approval, () => {
        throw new Error('approval execution window expired');
      }),
    ).rejects.toThrow(/execution window/);
    expect(loadCompletion).toHaveBeenCalledTimes(1);
    expect(resolveCalldata).not.toHaveBeenCalled();
  });
});
