import type { Fr } from '@aztec-labs/aztec.js/fields';
import { DomainSeparator } from '@aztec-labs/constants';
import { keccak256 } from '@aztec-labs/foundation/crypto/keccak';
import { sha256 } from '@aztec-labs/foundation/crypto/sha256';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { EventSelector, FunctionSelector } from '@aztec-labs/stdlib/abi';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { computeLogTag } from '@aztec-labs/stdlib/hash';
import { Tag } from '@aztec-labs/stdlib/logs';
import type { Tx, TxHash } from '@aztec-labs/stdlib/tx';

import { BYTES_PER_FIELD, packBytesToFields, unpackFieldsToBytes } from './field_bytes.js';
import {
  L1_OPERATION_CALLDATA_FIELDS_2K,
  L1_OPERATION_CALLDATA_FIELDS_4K,
  L1_OPERATION_CALLDATA_FIELDS_16K,
  L1_OPERATION_CALLDATA_FIELDS_32K,
  L1_OPERATION_CALLDATA_FIELDS_64K,
  L1_OPERATION_CALLDATA_FIELDS_128K,
  L1_OPERATION_METADATA_FIELDS,
} from './oxide_constants.gen.js';

/** Mirrors `Condition` in `noir-projects/broadcaster_contract/src/condition.nr`. */
export enum L1OperationConditionKind {
  Immediate = 0,
  Balance = 1,
  MessageInOutbox = 2,
}

export class L1OperationCondition {
  private constructor(
    readonly kind: L1OperationConditionKind,
    readonly token: EthAddress,
    readonly recipient: EthAddress,
  ) {}

  static immediate(): L1OperationCondition {
    return new L1OperationCondition(L1OperationConditionKind.Immediate, EthAddress.ZERO, EthAddress.ZERO);
  }

  static balance(token: EthAddress, recipient: EthAddress): L1OperationCondition {
    return new L1OperationCondition(L1OperationConditionKind.Balance, token, recipient);
  }

  static messageInOutbox(): L1OperationCondition {
    return new L1OperationCondition(L1OperationConditionKind.MessageInOutbox, EthAddress.ZERO, EthAddress.ZERO);
  }

  static decode(kind: number, token?: EthAddress, recipient?: EthAddress): L1OperationCondition {
    const usedToken = token === undefined || token.isZero() ? undefined : token;
    const usedRecipient = recipient === undefined || recipient.isZero() ? undefined : recipient;
    const rejectUnused = (name: string) => {
      if (usedToken !== undefined || usedRecipient !== undefined) {
        throw new Error(`A ${name} condition carries no token or recipient.`);
      }
    };
    switch (kind as L1OperationConditionKind) {
      case L1OperationConditionKind.Immediate:
        rejectUnused('Immediate');
        return L1OperationCondition.immediate();
      case L1OperationConditionKind.Balance:
        if (usedToken === undefined || usedRecipient === undefined) {
          throw new Error('A Balance condition needs both a token and a recipient.');
        }
        return L1OperationCondition.balance(usedToken, usedRecipient);
      case L1OperationConditionKind.MessageInOutbox:
        rejectUnused('MessageInOutbox');
        return L1OperationCondition.messageInOutbox();
      default:
        throw new Error(`Unknown L1 operation condition kind ${kind}.`);
    }
  }
}

export const L1_OPERATION_BROADCAST_TIERS = [
  { method: 'broadcast_l1_operation_2k', fields: L1_OPERATION_CALLDATA_FIELDS_2K },
  { method: 'broadcast_l1_operation_4k', fields: L1_OPERATION_CALLDATA_FIELDS_4K },
  { method: 'broadcast_l1_operation_16k', fields: L1_OPERATION_CALLDATA_FIELDS_16K },
  { method: 'broadcast_l1_operation_32k', fields: L1_OPERATION_CALLDATA_FIELDS_32K },
  { method: 'broadcast_l1_operation_64k', fields: L1_OPERATION_CALLDATA_FIELDS_64K },
  { method: 'broadcast_l1_operation_128k', fields: L1_OPERATION_CALLDATA_FIELDS_128K },
] as const;
export type L1OperationBroadcastTier = (typeof L1_OPERATION_BROADCAST_TIERS)[number];

/** An Ethereum tx's maximum calldata; the 128k tier is sized to carry exactly this. */
export const MAX_L1_OPERATION_CALLDATA_BYTES = 128 * 1024;

/** The dispatched function selector plus the broadcast metadata, preceding `l1_calldata`. */
export const L1_OPERATION_EVENT_PREFIX_FIELDS = 1 + L1_OPERATION_METADATA_FIELDS;

/**
 * Pack L1 calldata into the broadcast layout — big-endian 31-byte chunks, zero-padded to the smallest
 * tier that fits. The exact byte length travels as a separate argument, and `tier` names the broadcast
 * method to call.
 */
export function encodeL1OperationCalldata(calldata: Buffer): {
  tier: L1OperationBroadcastTier;
  bytesLen: number;
  fields: Fr[];
} {
  if (calldata.length > MAX_L1_OPERATION_CALLDATA_BYTES) {
    throw new Error(`L1 operation calldata is ${calldata.length} bytes (max ${MAX_L1_OPERATION_CALLDATA_BYTES}).`);
  }
  const tier = L1_OPERATION_BROADCAST_TIERS.find(t => calldata.length <= t.fields * BYTES_PER_FIELD)!;
  return { tier, bytesLen: calldata.length, fields: packBytesToFields(calldata, tier.fields) };
}

/** Inverse of {@link encodeL1OperationCalldata}. `fields` may include the zero padding or omit it. */
export function decodeL1OperationCalldata(bytesLen: number, fields: Fr[]): Buffer {
  if (bytesLen > MAX_L1_OPERATION_CALLDATA_BYTES) {
    throw new Error(`L1 operation calldata length ${bytesLen} exceeds max ${MAX_L1_OPERATION_CALLDATA_BYTES}.`);
  }
  return unpackFieldsToBytes(bytesLen, fields);
}

const L1_OPERATION_EVENT_CALLDATA_LENS = new Set(
  L1_OPERATION_BROADCAST_TIERS.map(tier => L1_OPERATION_EVENT_PREFIX_FIELDS + tier.fields),
);

export interface BroadcastL1Operation {
  target: EthAddress;
  payoutToken: EthAddress;
  calldata: Buffer;
  condition: L1OperationCondition;
}
/**
 * Immutable public-call identity. `callSha256` hashes the NUL-terminated v1 domain, 32-byte broadcaster address,
 * 8-byte big-endian call index, 4-byte big-endian field count, and every 32-byte call field in original order.
 */
export interface BroadcastL1OperationCall {
  operation: BroadcastL1Operation;
  broadcasterContract: `0x${string}`;
  eventSelector: `0x${string}`;
  callIndex: number;
  callSha256: `0x${string}`;
}


export function l1OperationEventSelector(): Promise<FunctionSelector> {
  return FunctionSelector.fromSignature('l1_operation_event()');
}

/** The public log tag of the `L1Operation` event, the same value `BroadcasterContract.events.L1Operation` derives. */
export async function l1OperationLogTag(): Promise<Tag> {
  const selector = await EventSelector.fromSignature('L1Operation()');
  return new Tag(await computeLogTag(selector.toField(), DomainSeparator.EVENT_LOG_TAG));
}

/**
 * The L1 operations that `broadcaster` enqueued in the tx. One tx can also carry the broadcasts of another deployment,
 * and that deployment's relayer executes them. Malformed candidates (e.g. a garbage byte length) are skipped.
 */
export function extractL1Operations(
  tx: Tx,
  selector: FunctionSelector,
  broadcaster: AztecAddress,
): BroadcastL1Operation[] {
  return extractL1OperationCalls(tx, selector, broadcaster).map(call => call.operation);
}

/**
 * The same conservative extraction as {@link extractL1Operations}, with immutable source-call identity for callers
 * that must independently bind an approval to the exact observed public call.
 */
export function extractL1OperationCalls(
  tx: Tx,
  selector: FunctionSelector,
  broadcaster: AztecAddress,
): BroadcastL1OperationCall[] {
  const selectorField = selector.toField();
  const calls = tx.getPublicCallRequestsWithCalldata();
  const operations: BroadcastL1OperationCall[] = [];
  for (const [callIndex, { request, calldata: values }] of calls.entries()) {
    if (!request.contractAddress.equals(broadcaster) || !L1_OPERATION_EVENT_CALLDATA_LENS.has(values.length)) {
      continue;
    }
    const [
      calldataSelector,
      target,
      payoutToken,
      bytesLen,
      conditionKind,
      conditionToken,
      conditionRecipient,
      ...l1Calldata
    ] = values;
    if (!calldataSelector.equals(selectorField)) {
      continue;
    }
    try {
      const operation = {
        target: EthAddress.fromField(target),
        payoutToken: EthAddress.fromField(payoutToken),
        calldata: decodeL1OperationCalldata(Number(bytesLen.toBigInt()), l1Calldata),
        condition: L1OperationCondition.decode(
          Number(conditionKind.toBigInt()),
          EthAddress.fromField(conditionToken),
          EthAddress.fromField(conditionRecipient),
        ),
      };
      const index = Buffer.alloc(8);
      index.writeBigUInt64BE(BigInt(callIndex));
      const fieldCount = Buffer.alloc(4);
      fieldCount.writeUInt32BE(values.length);
      const callBytes = Buffer.concat([
        Buffer.from('oxide/l1-operation-observed-call/v1\0', 'utf8'),
        request.contractAddress.toBuffer(),
        index,
        fieldCount,
        ...values.map(value => value.toBuffer()),
      ]);
      operations.push({
        operation,
        broadcasterContract: request.contractAddress.toString().toLowerCase() as `0x${string}`,
        eventSelector: calldataSelector.toString().toLowerCase() as `0x${string}`,
        callIndex,
        callSha256: `0x${sha256(callBytes).toString('hex')}`,
      });
    } catch {
      continue;
    }
  }
  return operations;
}

export function computeL1OperationId(operation: BroadcastL1Operation, sourceTxHash?: TxHash): `0x${string}` {
  if (operation.condition.kind === L1OperationConditionKind.MessageInOutbox && !sourceTxHash) {
    throw new Error('A withdrawal operation ID requires its initiation transaction hash.');
  }
  const { kind, token, recipient } = operation.condition;
  const packed = Buffer.concat([
    operation.target.toBuffer(),
    operation.payoutToken.toBuffer(),
    Buffer.of(kind),
    token.toBuffer(),
    recipient.toBuffer(),
    operation.calldata,
    ...(kind === L1OperationConditionKind.MessageInOutbox ? [sourceTxHash!.toBuffer()] : []),
  ]);
  return `0x${keccak256(packed).toString('hex')}`;
}
