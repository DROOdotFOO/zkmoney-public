import { describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import {
  CANONICAL_ENTRY_POINT_V08,
  depositPayoutTokenFor,
  encodeExecuteBatch,
  encodeSetUserRecord,
  type UserRecordArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import { recordUpdateCalls } from "@oxide/oxide-client/record_update.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { keccak256, toHex, zeroHash, type Address, type Hex, type PublicClient } from "viem"
import {
  checkRecordUpdate,
  prepareRecordUpdate,
  restoreRecordUpdate,
  serializeRecordUpdate,
  StalePlanError,
  type MetadataDestination,
  type PreparedRecordUpdate,
} from "../../../src/services/migration/metadataMigration.js"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const field = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const destination: MetadataDestination = {
  chainId: 31337n,
  rollupVersion: 5n,
  nameRegistry: addr(1),
  metadataRegistry: addr(2),
  controller: addr(3),
  factory: addr(4),
  forwardingTable: addr(20),
  portal: addr(5),
  namePortal: addr(7),
  token: addr(17),
  depositSubsidy: addr(18),
  operationExecutor: addr(19),
}
const owner = addr(11)
const fpc = AztecAddress.fromBigIntUnsafe(14n)
const record: UserRecordArg = {
  l2Address: field(12),
  rollupVersion: 5n,
  publicKey: { x: 21n, y: 22n },
  resolverOperator: addr(13),
}
const passkey = { qx: field(31), qy: field(32) }
const assertion: WebAuthnAuthArg = {
  r: field(41),
  s: field(42),
  challengeIndex: 23n,
  typeIndex: 1n,
  authenticatorData: "0x05",
  clientDataJSON: '{"type":"webauthn.get"}',
}

type Signed = Omit<PreparedRecordUpdate, "operation">

function fixture() {
  const state = { registry: destination.metadataRegistry, hash: zeroHash as Hex, nonce: 3n }
  const readContract = vi.fn(
    async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      switch (functionName) {
        case "NAME_REGISTRY":
          return destination.nameRegistry
        case "accountMetadataRegistry":
          return state.registry
        case "registrationController":
          return destination.controller
        case "nameOf":
          return field(9)
        case "metadataStateHash":
          return state.hash
        case "getAuthKeys":
          return [
            { key: { qx: field(33), qy: field(34) }, metadata: "0x" },
            { key: passkey, metadata: "0x" },
          ]
        case "getNonce":
          return state.nonce
        case "getUserOpHash":
          return keccak256(
            toHex(JSON.stringify(args![0], (_, v) => (typeof v === "bigint" ? `${v}` : v))),
          )
        default:
          throw new Error(`Unexpected read: ${functionName}`)
      }
    },
  )
  const call = vi.fn(async () => ({ data: "0x" as Hex }))
  const client = { getChainId: async () => 31337, readContract, call } as unknown as PublicClient
  const sign = vi.fn<(userOpHash: Hex, expectedStateHash: Hex) => Promise<WebAuthnAuthArg>>(
    async () => assertion,
  )
  const context = { client, destination, owner, record, fpc }
  const prepare = (overrides: Partial<typeof context> = {}) =>
    prepareRecordUpdate({ ...context, ...overrides, passkey, sign })
  const signed = async (): Promise<Signed> => {
    const rest: Partial<PreparedRecordUpdate> = { ...(await prepare()) }
    delete rest.operation
    return rest as Signed
  }
  return { state, readContract, call, sign, client, context, prepare, signed }
}

describe("preparing a record update", () => {
  it.each([zeroHash, field(99)])(
    "signs a zero-fee update over destination state %s, reading no legacy record or SIPA route",
    async (hash) => {
      const f = fixture()
      f.state.hash = hash
      const prepared = await f.prepare()
      const { update } = prepared
      expect(f.sign).toHaveBeenCalledWith(update.userOpHash, hash)
      expect(prepared).toMatchObject({ expectedStateHash: hash, assertion })
      expect(update).toMatchObject({
        owner,
        nameRegistry: destination.nameRegistry,
        metadataRegistry: destination.metadataRegistry,
        namePortal: destination.namePortal,
        rollupVersion: 5n,
        record,
        keyIndex: 1n,
      })
      expect(BigInt(update.namePortalRecipient)).toBe(fpc.toBigInt())
      expect(update.userOp).toMatchObject({
        sender: owner,
        nonce: 3n,
        initCode: "0x",
        paymasterAndData: "0x",
        preVerificationGas: 0n,
        gasFees: field(0),
      })
      const { operation } = prepared
      expect(operation.target.equals(EthAddress.fromString(CANONICAL_ENTRY_POINT_V08))).toBe(true)
      expect(
        operation.payoutToken.equals(
          depositPayoutTokenFor(destination.chainId, EthAddress.fromString(destination.token)),
        ),
      ).toBe(true)
      expect(operation.condition).toEqual(L1OperationCondition.immediate())
      const reads = f.readContract.mock.calls.map(([request]) => request.functionName)
      for (const read of ["userRecords", "implementationFor", "rowFor"])
        expect(reads).not.toContain(read)
    },
  )

  it("refuses a record for another rollup before signing", async () => {
    const f = fixture()
    await expect(f.prepare({ record: { ...record, rollupVersion: 6n } })).rejects.toThrow(
      "disagree",
    )
    expect(f.sign).not.toHaveBeenCalled()
  })

  it("is stale when the registry changes during the signing ceremony", async () => {
    const f = fixture()
    f.sign.mockImplementationOnce(async () => {
      f.state.registry = addr(90)
      return assertion
    })
    await expect(f.prepare()).rejects.toBeInstanceOf(StalePlanError)
  })

  it("refuses a signed update that no longer runs", async () => {
    const f = fixture()
    f.call.mockRejectedValue(new Error("execution reverted"))
    await expect(f.prepare()).rejects.toThrow("account call reverts")
  })
})

describe("checking a signed update before publication", () => {
  it("rebuilds the same operation while nothing changed", async () => {
    const f = fixture()
    const { operation, ...signed } = await f.prepare()
    expect(await checkRecordUpdate(f.client, destination, signed)).toEqual({
      ...signed,
      operation,
    })
  })

  it("is stale once the record changed, though the nonce did not", async () => {
    const f = fixture()
    const signed = await f.signed()
    f.state.hash = field(98)
    const check = checkRecordUpdate(f.client, destination, signed)
    await expect(check).rejects.toBeInstanceOf(StalePlanError)
    await expect(check).rejects.toThrow("record changed")
  })

  it("is stale once the account used the update's nonce", async () => {
    const f = fixture()
    const signed = await f.signed()
    f.state.nonce = 4n
    const check = checkRecordUpdate(f.client, destination, signed)
    await expect(check).rejects.toBeInstanceOf(StalePlanError)
    await expect(check).rejects.toThrow("another operation")
  })
})

describe("a saved record update", () => {
  it("round-trips through its serialized form", async () => {
    const f = fixture()
    const signed = await f.signed()
    expect(await restoreRecordUpdate(serializeRecordUpdate(signed), f.context)).toEqual(signed)
  })

  const other = { ...record, resolverOperator: addr(90) }
  it.each<[string, (s: Signed) => void]>([
    ["owner", (s) => void (s.update.owner = addr(90))],
    ["sender", (s) => void (s.update.userOp.sender = addr(90))],
    ["name registry", (s) => void (s.update.nameRegistry = addr(90))],
    ["metadata registry", (s) => void (s.update.metadataRegistry = addr(90))],
    ["name portal", (s) => void (s.update.namePortal = addr(90))],
    ["recipient FPC", (s) => void (s.update.namePortalRecipient = field(90))],
    ["rollup version", (s) => void (s.update.rollupVersion = 6n)],
    ["record", (s) => void (s.update.record = other)],
    ["write data", (s) => void (s.update.write.data = encodeSetUserRecord(owner, other))],
    ["write state hash", (s) => void (s.update.write.stateHash = field(90))],
    ["gas fees", (s) => void (s.update.userOp.gasFees = field(1))],
    ["pre-verification gas", (s) => void (s.update.userOp.preVerificationGas = 1n)],
    ["paymaster", (s) => void (s.update.userOp.paymasterAndData = addr(90))],
    ["initCode", (s) => void (s.update.userOp.initCode = addr(90))],
    [
      "callData",
      (s) =>
        void (s.update.userOp.callData = encodeExecuteBatch(
          recordUpdateCalls({
            owner,
            metadataRegistry: destination.metadataRegistry,
            writeData: s.update.write.data,
            namePortal: destination.namePortal,
            namePortalRecipient: field(90),
            rollupVersion: destination.rollupVersion,
          }),
        )),
    ],
  ])("is stale with a substituted %s", async (_, substitute) => {
    const f = fixture()
    const signed = structuredClone(await f.signed())
    substitute(signed)
    const restore = restoreRecordUpdate(serializeRecordUpdate(signed), f.context)
    await expect(restore).rejects.toBeInstanceOf(StalePlanError)
    await expect(restore).rejects.toThrow("does not match the destination")
  })

  it("is stale when its hash is not its operation's", async () => {
    const f = fixture()
    const signed = await f.signed()
    signed.update.userOpHash = field(95)
    const restore = restoreRecordUpdate(serializeRecordUpdate(signed), f.context)
    await expect(restore).rejects.toBeInstanceOf(StalePlanError)
    await expect(restore).rejects.toThrow("does not match its hash")
  })
})
