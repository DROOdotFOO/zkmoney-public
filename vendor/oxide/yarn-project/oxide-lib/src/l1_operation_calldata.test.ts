import { Fr } from '@aztec-labs/aztec.js/fields';
import { DomainSeparator } from '@aztec-labs/constants';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { EventSelector, FunctionSelector } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { computeLogTag } from '@aztec-labs/stdlib/hash';
import { TxHash } from '@aztec-labs/stdlib/tx';
import type { Tx } from '@aztec-labs/stdlib/tx';

import { describe, expect, it, test } from '@jest/globals';

import { BYTES_PER_FIELD } from './field_bytes.js';
import {
  L1OperationCondition,
  L1OperationConditionKind,
  L1_OPERATION_BROADCAST_TIERS,
  MAX_L1_OPERATION_CALLDATA_BYTES,
  computeL1OperationId,
  decodeL1OperationCalldata,
  encodeL1OperationCalldata,
  extractL1OperationCalls,
  extractL1Operations,
  l1OperationEventSelector,
  l1OperationLogTag,
} from './l1_operation_calldata.js';

const [TIER_2K, TIER_4K, TIER_16K, TIER_32K, , TIER_128K] = L1_OPERATION_BROADCAST_TIERS;

function patterned(len: number): Buffer {
  const calldata = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    calldata[i] = (i * 7 + 1) % 256;
  }
  return calldata;
}

describe('l1 operation calldata codec', () => {
  it.each([0, 1, 30, 31, 32, 100, 2_000, 4_000, 20_000, 40_000, 70_000, MAX_L1_OPERATION_CALLDATA_BYTES])(
    'round-trips %i bytes',
    len => {
      const calldata = patterned(len);
      const { tier, bytesLen, fields } = encodeL1OperationCalldata(calldata);
      expect(bytesLen).toBe(len);
      expect(fields.length).toBe(tier.fields);
      expect(decodeL1OperationCalldata(bytesLen, fields).equals(calldata)).toBe(true);
    },
  );

  it('dispatches to the smallest tier that fits', () => {
    const capacity = (tier: { fields: number }) => tier.fields * BYTES_PER_FIELD;
    expect(capacity(TIER_2K)).toBeGreaterThanOrEqual(2 * 1024);
    expect(capacity(TIER_4K)).toBeGreaterThanOrEqual(4 * 1024);
    expect(encodeL1OperationCalldata(Buffer.alloc(0)).tier).toBe(TIER_2K);
    expect(encodeL1OperationCalldata(Buffer.alloc(capacity(TIER_2K))).tier).toBe(TIER_2K);
    expect(encodeL1OperationCalldata(Buffer.alloc(capacity(TIER_2K) + 1)).tier).toBe(TIER_4K);
    expect(encodeL1OperationCalldata(Buffer.alloc(capacity(TIER_4K) + 1)).tier).toBe(TIER_16K);
    expect(encodeL1OperationCalldata(Buffer.alloc(capacity(TIER_16K) + 1)).tier).toBe(TIER_32K);
    expect(encodeL1OperationCalldata(Buffer.alloc(MAX_L1_OPERATION_CALLDATA_BYTES)).tier).toBe(TIER_128K);
  });

  it('round-trips through unpadded fields', () => {
    const calldata = Buffer.from('deadbeef00c0ffee', 'hex');
    const { bytesLen, fields } = encodeL1OperationCalldata(calldata);
    expect(decodeL1OperationCalldata(bytesLen, fields.slice(0, 1)).equals(calldata)).toBe(true);
  });

  it('rejects oversized calldata', () => {
    expect(() => encodeL1OperationCalldata(Buffer.alloc(MAX_L1_OPERATION_CALLDATA_BYTES + 1))).toThrow(/max/);
    expect(() => decodeL1OperationCalldata(MAX_L1_OPERATION_CALLDATA_BYTES + 1, [])).toThrow(/max/);
  });

  it('rejects a byte length longer than the provided fields', () => {
    expect(() => decodeL1OperationCalldata(32, encodeL1OperationCalldata(Buffer.alloc(1)).fields.slice(0, 1))).toThrow(
      /needs/,
    );
  });
});

describe('l1 operation condition codec', () => {
  const token = EthAddress.random();
  const recipient = EthAddress.random();

  it.each<L1OperationCondition>([
    L1OperationCondition.immediate(),
    L1OperationCondition.balance(token, recipient),
    L1OperationCondition.messageInOutbox(),
  ])('round-trips %j', condition => {
    expect(L1OperationCondition.decode(condition.kind, condition.token, condition.recipient)).toEqual(condition);
  });

  it('zeroes the fields a kind does not use', () => {
    for (const condition of [L1OperationCondition.immediate(), L1OperationCondition.messageInOutbox()]) {
      expect(condition.token.isZero()).toBe(true);
      expect(condition.recipient.isZero()).toBe(true);
    }
  });

  it('rejects a Balance condition with no token or recipient', () => {
    expect(() => L1OperationCondition.decode(L1OperationConditionKind.Balance)).toThrow(/needs both/);
    expect(() => L1OperationCondition.decode(L1OperationConditionKind.Balance, token)).toThrow(/needs both/);
    expect(() => L1OperationCondition.decode(L1OperationConditionKind.Balance, token, EthAddress.ZERO)).toThrow(
      /needs both/,
    );
  });

  it('rejects a kind that carries a field it does not use', () => {
    for (const kind of [L1OperationConditionKind.Immediate, L1OperationConditionKind.MessageInOutbox]) {
      expect(() => L1OperationCondition.decode(kind, token)).toThrow(/carries no token or recipient/);
      expect(() => L1OperationCondition.decode(kind, undefined, recipient)).toThrow(/carries no token or recipient/);
      expect(L1OperationCondition.decode(kind, EthAddress.ZERO, EthAddress.ZERO).kind).toBe(kind);
    }
  });

  it('rejects a kind outside the enum', () => {
    expect(() => L1OperationCondition.decode(7, token, recipient)).toThrow(/Unknown/);
  });
});

describe('l1 operation broadcast decoder', () => {
  const target = EthAddress.random();
  const payoutToken = EthAddress.random();
  const calldata = Buffer.from('deadbeef00c0ffee', 'hex');
  const balance = L1OperationCondition.balance(EthAddress.random(), EthAddress.random());
  const broadcaster = AztecAddress.fromNumberUnsafe(1);

  function callValues(
    selector: FunctionSelector,
    operation: {
      target: EthAddress;
      payoutToken: EthAddress;
      calldata: Buffer;
      condition: L1OperationCondition;
    } = { target, payoutToken, calldata, condition: L1OperationCondition.immediate() },
  ): Fr[] {
    const { bytesLen, fields } = encodeL1OperationCalldata(operation.calldata);
    const condition = operation.condition;
    return [
      selector.toField(),
      operation.target.toField(),
      operation.payoutToken.toField(),
      new Fr(bytesLen),
      new Fr(condition.kind),
      condition.token.toField(),
      condition.recipient.toField(),
      ...fields,
    ];
  }

  function txWith(...calls: Fr[][]): Tx {
    return txFrom(calls.map(calldata => ({ contractAddress: broadcaster, calldata })));
  }

  function txFrom(calls: { contractAddress: AztecAddress; calldata: Fr[] }[]): Tx {
    return {
      getPublicCallRequestsWithCalldata: () =>
        calls.map(({ contractAddress, calldata }) => ({ request: { contractAddress }, calldata })),
    } as unknown as Tx;
  }

  it('recovers every operation the tx enqueued, whichever tier carried it', async () => {
    const selector = await l1OperationEventSelector();
    const large = { target, payoutToken, calldata: patterned(20_000), condition: balance };
    const operations = extractL1Operations(
      txWith(callValues(selector), callValues(selector, large)),
      selector,
      broadcaster,
    );
    expect(operations).toHaveLength(2);
    expect(operations[0].target.equals(target)).toBe(true);
    expect(operations[0].payoutToken.equals(payoutToken)).toBe(true);
    expect(operations[0].calldata.equals(calldata)).toBe(true);
    expect(operations[0].condition).toEqual(L1OperationCondition.immediate());
    expect(operations[1].calldata.equals(large.calldata)).toBe(true);
    expect(operations[1].condition).toEqual(balance);
  });
  it('adds deterministic observed call identity without changing generic extraction', async () => {
    const selector = await l1OperationEventSelector();
    const other = AztecAddress.fromNumberUnsafe(2);
    const tx = txFrom([
      { contractAddress: other, calldata: callValues(selector) },
      { contractAddress: broadcaster, calldata: callValues(selector) },
    ]);
    const [observed] = extractL1OperationCalls(tx, selector, broadcaster);
    const [repeated] = extractL1OperationCalls(tx, selector, broadcaster);
    const [generic] = extractL1Operations(tx, selector, broadcaster);

    expect(observed).toMatchObject({
      broadcasterContract: broadcaster.toString().toLowerCase(),
      eventSelector: selector.toField().toString().toLowerCase(),
      callIndex: 1,
      callSha256: repeated.callSha256,
    });
    expect(observed.callSha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(generic.calldata).toEqual(observed.operation.calldata);
  });


  it('recovers only the operations that the given broadcaster enqueued', async () => {
    const selector = await l1OperationEventSelector();
    const other = { target: payoutToken, payoutToken, calldata, condition: balance };
    const tx = txFrom([
      { contractAddress: AztecAddress.fromNumberUnsafe(2), calldata: callValues(selector, other) },
      { contractAddress: broadcaster, calldata: callValues(selector) },
    ]);
    const operations = extractL1Operations(tx, selector, broadcaster);
    expect(operations).toHaveLength(1);
    expect(operations[0].target.equals(target)).toBe(true);
  });

  it('skips calls of another selector, another length, or with a garbage byte length', async () => {
    const selector = await l1OperationEventSelector();
    const other = await FunctionSelector.fromSignature('sipa_broadcast_event()');
    const garbage = callValues(selector);
    garbage[3] = new Fr(MAX_L1_OPERATION_CALLDATA_BYTES);
    const tx = txWith(callValues(other), callValues(selector).slice(0, 10), garbage, callValues(selector));
    expect(extractL1Operations(tx, selector, broadcaster)).toHaveLength(1);
  });

  it('skips a call whose condition kind is outside the table', async () => {
    const selector = await l1OperationEventSelector();
    const unknownKind = callValues(selector);
    unknownKind[4] = new Fr(7);
    expect(extractL1Operations(txWith(unknownKind, callValues(selector)), selector, broadcaster)).toHaveLength(1);
  });

  it('keys an operation by the packed content of its tuple, condition included', () => {
    const operation = { target, payoutToken, calldata, condition: L1OperationCondition.immediate() };
    const id = computeL1OperationId(operation);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeL1OperationId({ ...operation, calldata: Buffer.from(calldata) })).toBe(id);
    expect(computeL1OperationId({ ...operation, target: payoutToken, payoutToken: target })).not.toBe(id);
    expect(computeL1OperationId({ ...operation, calldata: Buffer.from('deadbeef', 'hex') })).not.toBe(id);
    expect(computeL1OperationId({ ...operation, condition: balance })).not.toBe(id);
    expect(
      computeL1OperationId({ ...operation, condition: L1OperationCondition.messageInOutbox() }, TxHash.random()),
    ).not.toBe(id);
  });

  it('pins the id of a fixed tuple', () => {
    expect(
      computeL1OperationId({
        target: EthAddress.fromString('0x1111111111111111111111111111111111111111'),
        payoutToken: EthAddress.fromString('0x2222222222222222222222222222222222222222'),
        calldata: Buffer.from('deadbeef', 'hex'),
        condition: L1OperationCondition.balance(
          EthAddress.fromString('0x3333333333333333333333333333333333333333'),
          EthAddress.fromString('0x4444444444444444444444444444444444444444'),
        ),
      }),
    ).toBe('0xa953d2a7fa10b520a3832622a0967f2f9a5f5d7844157146c23262eb4894ae82');
  });
});

test('withdrawal identities require and retain the initiation tx while other operations retain content identity', () => {
  const operation = {
    target: EthAddress.random(),
    payoutToken: EthAddress.random(),
    calldata: Buffer.from('deadbeef', 'hex'),
    condition: L1OperationCondition.messageInOutbox(),
  };
  const first = TxHash.random();
  const second = TxHash.random();
  expect(() => computeL1OperationId(operation)).toThrow('initiation transaction');
  expect(computeL1OperationId(operation, first)).toBe(computeL1OperationId(operation, first));
  expect(computeL1OperationId(operation, second)).not.toBe(computeL1OperationId(operation, first));
  const immediate = { ...operation, condition: L1OperationCondition.immediate() };
  expect(computeL1OperationId(immediate, first)).toBe(computeL1OperationId(immediate, second));
});

describe('l1OperationLogTag', () => {
  it('derives the tag from the L1Operation event selector the generated Broadcaster binding pins', async () => {
    const selector = await EventSelector.fromSignature('L1Operation()');
    expect(selector.toString()).toBe('0x103c3e90');

    const tag = await l1OperationLogTag();

    expect(tag.value).toEqual(await computeLogTag(selector.toField(), DomainSeparator.EVENT_LOG_TAG));
  });
});
