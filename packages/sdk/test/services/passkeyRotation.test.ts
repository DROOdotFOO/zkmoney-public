/**
 * The rotation over a scripted L1: a history of account snapshots the fake client serves by block
 * number, tag or hash, with the factory, the registry and the subsidy answering as deployed ones do.
 */
import { describe, expect, it } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  AccountMetadataRegistryAbi,
  DepositSubsidyAbi,
  ForwardingTableAbi,
  SipaIntent,
  conditionHash,
  encodeR1UserOpSignature,
  encodeUserOpIntentData,
  encodeUserOpProofs,
  type AuthKeyEntry,
  type R1PublicKeyArg,
  type UserRecordArg,
} from "@oxide/l1-contracts"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import { computeSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeFunctionResult,
  hexToBytes,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import {
  AccountRecordMismatchError,
  AccountStateReorgedError,
  BACKUP_FUNDING_MARGIN,
  BackupCredentialIdLengthError,
  BackupSetConflictError,
  MAX_BACKUP_CREDENTIAL_ID_BYTES,
  RootKeyNotInstalledError,
  RotationRouteNotLiveError,
  VerificationUnavailableError,
  backupKeyEntry,
  backupKeyPayload,
  buildBackupSweep,
  fundingAmount,
  prepareBackupRotation,
  readAccountState,
  readRotationFundability,
  verifyPersistedRotation,
  verifyWebAuthnUserOpSignature,
  type BackupRotationTuple,
  type PersistedRotation,
  type PreparedBackupRotation,
  type RotationLocalTruth,
} from "../../src/services/passkeyRotation.js"
import { SoftwareWebauthnKey } from "../utils/wallet/softwareWebauthn.js"
import { r1Key, signUserOpHash, webAuthnAuthArg } from "../utils/wallet/userOpSignature.js"

const addr = (tag: string) => `0x${tag.padStart(40, "0")}` as Address
const OWNER = addr("a0")
const REGISTRY = addr("4e6")
const FACTORY = addr("fac")
const TABLE = addr("7ab1e")
const NAME_PORTAL = addr("4a4e")
const PORTAL = addr("90")
const TOKEN = addr("70")
const SUBSIDY = addr("5b5")
const EXECUTOR = addr("e0")
const PLAIN_EXECUTOR = addr("91a")
const IMPL = addr("1491")
const OTHER_IMPL = addr("1492")
const OPERATOR = addr("09")
const BENEFICIARY = addr("be")
const ZERO = addr("")
const ROLLUP_VERSION = 7n
const TIP = 5n * 10n ** 17n
const ONE_ETH = 10n ** 18n

const ONE_KEY = AztecAddress.fromBigIntUnsafe(0x1111n)
const TWO_KEY = AztecAddress.fromBigIntUnsafe(0x2222n)
const PUBLIC_KEY = { x: 11n, y: 22n }
const RECORD: UserRecordArg = {
  l2Address: ONE_KEY.toString() as Hex,
  rollupVersion: ROLLUP_VERSION,
  publicKey: PUBLIC_KEY,
  resolverOperator: OPERATOR,
}

const A = new SoftwareWebauthnKey()
const B = new SoftwareWebauthnKey()
const C = new SoftwareWebauthnKey()
const ROOT: AuthKeyEntry = { key: r1Key(A), metadata: "0x" }
const ADD = {
  pubkey: r1Key(B),
  credentialId: toHex("backup-credential"),
  envelope: `0x${"ab".repeat(48)}` as Hex,
}
const TUPLE: BackupRotationTuple = {
  rollupVersion: ROLLUP_VERSION,
  metadataRegistry: REGISTRY,
  factory: FACTORY,
  forwardingTable: TABLE,
  namePortal: NAME_PORTAL,
  portal: PORTAL,
  token: TOKEN,
  depositSubsidy: SUBSIDY,
  operationExecutor: EXECUTOR,
}
const TRUTH: RotationLocalTruth = {
  derive: (keys: readonly R1PublicKeyArg[]) => (keys.length === 1 ? ONE_KEY : TWO_KEY),
  publicKey: PUBLIC_KEY,
}
const PREPARE = {
  tuple: TUPLE,
  owner: OWNER,
  rootKey: r1Key(A),
  recordExpected: { l2Address: RECORD.l2Address, rollupVersion: ROLLUP_VERSION },
  add: ADD,
  recipient: TWO_KEY,
}

interface Snapshot {
  nonce: bigint
  keys: AuthKeyEntry[]
  record: UserRecordArg | undefined
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function fakeChain(initial: Partial<Snapshot> = {}) {
  const history: Snapshot[] = [{ nonce: 3n, keys: [ROOT], record: RECORD, ...initial }]
  /** How many times each height was replaced: a replaced block has another hash. */
  const forks = new Map<number, number>()
  const hashOf = (n: number) => keccak256(toHex(n + 1_000 * (forks.get(n) ?? 0)))
  const state = {
    finalized: 0,
    /** Watches every contract read; a test replaces a block from here. */
    onRead: undefined as ((functionName: string) => void) | undefined,
    /** The first block the account, registry and entry point have code at. */
    deployedAt: 0,
    implementationFor: IMPL as Address,
    blessed: new Map<string, SipaIntent>([[IMPL.toLowerCase(), SipaIntent.UserOp]]),
    config: [TIP, 10_000n * ONE_ETH, ONE_ETH] as [bigint, bigint, bigint],
    subsidyBalance: 1000n * ONE_ETH,
    subsidyPortal: PORTAL as Address,
    row: [PORTAL, BENEFICIARY, 0n, TIP] as [Address, Address, bigint, bigint] | undefined,
    withdrawalFee: ONE_ETH / 10n,
    failing: new Set<string>(),
  }
  const latest = () => history[history.length - 1]!
  const at = (blockNumber?: bigint) =>
    history[blockNumber === undefined ? history.length - 1 : Number(blockNumber)]!
  const client = {
    getBlock: async (params: { blockTag?: string; blockHash?: Hex; blockNumber?: bigint } = {}) => {
      const n = params.blockHash
        ? history.findIndex((_, i) => hashOf(i) === params.blockHash)
        : params.blockNumber !== undefined
        ? Number(params.blockNumber)
        : params.blockTag === "finalized"
        ? state.finalized
        : history.length - 1
      if (n < 0 || n >= history.length) throw new Error("unknown block")
      return { number: BigInt(n), hash: hashOf(n), timestamp: 0n, baseFeePerGas: 7n }
    },
    getBlockNumber: async () => BigInt(history.length - 1),
    getCode: async ({ blockNumber }: { address: Address; blockNumber?: bigint }) =>
      blockNumber !== undefined && Number(blockNumber) < state.deployedAt
        ? undefined
        : ("0x60" as Hex),
    call: async ({ to }: { to: Address }) => {
      const record = latest().record
      if (!same(to, REGISTRY) || !record) return { data: "0x" as Hex }
      return {
        data: encodeFunctionResult({
          abi: AccountMetadataRegistryAbi,
          functionName: "getUserRecord",
          result: record,
        }),
      }
    },
    readContract: async ({
      functionName,
      args = [],
      blockNumber,
    }: {
      functionName: string
      args?: readonly unknown[]
      blockNumber?: bigint
    }) => {
      if (state.failing.has(functionName)) throw new Error(`${functionName} is down`)
      state.onRead?.(functionName)
      const snapshot = at(blockNumber)
      switch (functionName) {
        case "getNonce":
          return snapshot.nonce
        case "getAuthKeys":
          return snapshot.keys
        case "hasUserRecord":
          return snapshot.record !== undefined
        case "getUserRecord":
          if (!snapshot.record) throw new Error("no record")
          return snapshot.record
        case "implementationFor":
          return Number(args[0]) === SipaIntent.UserOp ? state.implementationFor : ZERO
        case "intentOf":
          return state.blessed.get(String(args[0]).toLowerCase()) ?? SipaIntent.None
        case "predictSIPA": {
          const [
            implementation,
            intentHash,
            recoveryCommitment,
            rollupVersion,
            resweepable,
            table,
          ] = args as [Address, Hex, Hex, bigint, boolean, Address]
          return computeSIPAAddress({
            sipaFactory: EthAddress.fromString(FACTORY),
            implementation: EthAddress.fromString(implementation),
            intentHash: Buffer.from(hexToBytes(intentHash)),
            recoveryCommitment: Fr.fromHexString(recoveryCommitment),
            rollupVersion,
            resweepable,
            forwardingTable: EthAddress.fromString(table),
          }).toString()
        }
        case "getUserOpHash":
          return keccak256(
            stringToHex(
              JSON.stringify(args[0], (_, v) => (typeof v === "bigint" ? v.toString() : v)),
            ),
          )
        case "$depositConfig":
          return state.config
        case "rowFor":
          if (!state.row) {
            throw new ContractFunctionRevertedError({
              abi: ForwardingTableAbi,
              functionName: "rowFor",
            })
          }
          return state.row
        case "balanceOf":
          return state.subsidyBalance
        case "PORTAL":
          return state.subsidyPortal
        case "SIPA_FACTORY":
          return FACTORY
        case "ROLLUP_VERSION":
          return ROLLUP_VERSION
        case "FEE":
          return state.withdrawalFee
        default:
          throw new Error(`unexpected read ${functionName}`)
      }
    },
  }
  return {
    client: client as unknown as PublicClient,
    state,
    history,
    hashOf,
    advance(change: Partial<Snapshot>) {
      history.push({ ...latest(), ...change })
    },
    /** Another block takes height `n`: its state and its hash change under any read in flight. */
    replace(n: number, change: Partial<Snapshot>) {
      history[n] = { ...history[n]!, ...change }
      forks.set(n, (forks.get(n) ?? 0) + 1)
    },
  }
}

const applied = (prepared: PreparedBackupRotation): Partial<Snapshot> => ({
  nonce: prepared.rotation.intent.nonce + 1n,
  keys: [...prepared.expectedKeys, backupKeyEntry(prepared.add)],
  record: prepared.rotation.newRecord,
})

const persisted = (prepared: PreparedBackupRotation, signature: Hex): PersistedRotation => ({
  owner: OWNER,
  intent: prepared.rotation.intent,
  sharedSecretSalt: prepared.rotation.sharedSecretSalt,
  nonce: prepared.rotation.intent.nonce,
  builtOver: prepared.builtOver,
  expectedKeys: prepared.expectedKeys,
  implementation: prepared.implementation,
  deployArgs: prepared.rotation.deployArgs,
  sipa: prepared.rotation.sipa,
  add: prepared.add,
  signature,
})

async function preparedAndSigned(chain = fakeChain()) {
  const prepared = await prepareBackupRotation(chain.client, PREPARE)
  const signature = await signUserOpHash(A, prepared.rotation.userOpHash)
  return { chain, prepared, signature, record: persisted(prepared, signature) }
}

describe("prepareBackupRotation", () => {
  it("refuses an account with no record, or a record that names another address or version", async () => {
    await expect(
      prepareBackupRotation(fakeChain({ record: undefined }).client, PREPARE),
    ).rejects.toBeInstanceOf(AccountRecordMismatchError)
    const moved = fakeChain({ record: { ...RECORD, l2Address: TWO_KEY.toString() as Hex } })
    await expect(prepareBackupRotation(moved.client, PREPARE)).rejects.toThrow(/names/)
    const other = fakeChain({ record: { ...RECORD, rollupVersion: ROLLUP_VERSION + 1n } })
    await expect(prepareBackupRotation(other.client, PREPARE)).rejects.toBeInstanceOf(
      AccountRecordMismatchError,
    )
  })

  it("refuses an account with no key, two keys, or a key that is not the root key", async () => {
    await expect(
      prepareBackupRotation(fakeChain({ keys: [] }).client, PREPARE),
    ).rejects.toBeInstanceOf(RootKeyNotInstalledError)
    const two = fakeChain({ keys: [ROOT, { key: r1Key(C), metadata: "0x" }] })
    await expect(prepareBackupRotation(two.client, PREPARE)).rejects.toBeInstanceOf(
      BackupSetConflictError,
    )
    const notRoot = fakeChain({ keys: [{ key: r1Key(C), metadata: "0x" }] })
    const refusal = await prepareBackupRotation(notRoot.client, PREPARE).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(BackupSetConflictError)
    expect((refusal as BackupSetConflictError).expected).toEqual([r1Key(A)])
    expect((refusal as BackupSetConflictError).live).toEqual([{ key: r1Key(C), metadata: "0x" }])
  })

  it("refuses a factory with no user-op implementation", async () => {
    const chain = fakeChain()
    chain.state.implementationFor = ZERO
    await expect(prepareBackupRotation(chain.client, PREPARE)).rejects.toThrow(/user-op/)
  })

  it("carries a credential id up to the cap, and refuses one outside 16..cap before any intent", async () => {
    const id = (bytes: number): Hex => `0x${"5e".repeat(bytes)}`
    const longest = { ...ADD, credentialId: id(MAX_BACKUP_CREDENTIAL_ID_BYTES) }
    expect(backupKeyPayload(longest)).toBe(`${ADD.envelope}${longest.credentialId.slice(2)}`)
    for (const bytes of [MAX_BACKUP_CREDENTIAL_ID_BYTES + 1, 15]) {
      const add = { ...ADD, credentialId: id(bytes) }
      expect(() => backupKeyPayload(add)).toThrow(BackupCredentialIdLengthError)
      await expect(
        prepareBackupRotation(fakeChain().client, { ...PREPARE, add }),
      ).rejects.toBeInstanceOf(BackupCredentialIdLengthError)
    }
  })
})

describe("readRotationFundability", () => {
  it("is fundable while the account is as the intent was built", async () => {
    const { chain, prepared } = await preparedAndSigned()
    expect(await readRotationFundability(chain.client, prepared)).toBe("fundable")
    expect(await readRotationFundability(chain.client, prepared, { at: "finalized" })).toBe(
      "fundable",
    )
  })

  it("is applied-pending once the operation ran at the latest block, applied once finalized", async () => {
    const { chain, prepared } = await preparedAndSigned()
    chain.advance(applied(prepared))

    expect(await readRotationFundability(chain.client, prepared)).toBe("applied-pending")
    expect(await readRotationFundability(chain.client, prepared, { at: "finalized" })).toBe(
      "applied-pending",
    )

    chain.state.finalized = 1
    expect(await readRotationFundability(chain.client, prepared)).toBe("applied")
    expect(await readRotationFundability(chain.client, prepared, { at: "finalized" })).toBe(
      "applied",
    )
  })

  it("stays applied-pending while the finalized block predates the account and registry", async () => {
    const { chain, prepared } = await preparedAndSigned()
    chain.state.deployedAt = 1
    chain.advance(applied(prepared))

    expect(await readRotationFundability(chain.client, prepared)).toBe("applied-pending")
    expect(await readRotationFundability(chain.client, prepared, { at: "finalized" })).toBe(
      "applied-pending",
    )

    chain.state.finalized = 1
    expect(await readRotationFundability(chain.client, prepared)).toBe("applied")
  })

  it("names what moved when the account is neither as built nor as applied", async () => {
    const { chain, prepared } = await preparedAndSigned()
    const keys = () => chain.history[chain.history.length - 1]!.keys

    chain.advance({ nonce: 4n })
    await expect(readRotationFundability(chain.client, prepared)).rejects.toThrow(/nonce is 4/)

    chain.advance({ nonce: 3n, keys: [ROOT, { key: r1Key(C), metadata: "0x" }] })
    const conflict = await readRotationFundability(chain.client, prepared).catch((e: unknown) => e)
    expect(conflict).toBeInstanceOf(BackupSetConflictError)
    expect((conflict as Error).message).toMatch(/keys changed/)
    expect((conflict as BackupSetConflictError).expected).toEqual([r1Key(A)])
    expect((conflict as BackupSetConflictError).live).toEqual(keys())

    chain.advance({ keys: [ROOT], record: { ...RECORD, resolverOperator: BENEFICIARY } })
    await expect(readRotationFundability(chain.client, prepared)).rejects.toThrow(/record changed/)

    chain.advance({ record: undefined })
    await expect(readRotationFundability(chain.client, prepared)).rejects.toThrow(/record changed/)
  })

  it("does not take a key installed with other metadata for the applied rotation", async () => {
    const { chain, prepared } = await preparedAndSigned()
    chain.advance({ ...applied(prepared), keys: [ROOT, { key: ADD.pubkey, metadata: "0x01" }] })
    await expect(readRotationFundability(chain.client, prepared)).rejects.toThrow(/nonce is 4/)
  })

  it("is superseded once the factory clones another implementation, until the operation ran", async () => {
    const { chain, prepared } = await preparedAndSigned()
    chain.state.implementationFor = OTHER_IMPL
    expect(await readRotationFundability(chain.client, prepared)).toBe("superseded")
    expect(await readRotationFundability(chain.client, prepared, { at: "finalized" })).toBe(
      "superseded",
    )

    chain.advance(applied(prepared))
    expect(await readRotationFundability(chain.client, prepared)).toBe("applied-pending")
    chain.state.finalized = 1
    expect(await readRotationFundability(chain.client, prepared)).toBe("applied")
  })
})

describe("readAccountState", () => {
  it("reads nonce, keys and record at the latest block, a tag, or a block hash", async () => {
    const chain = fakeChain()
    const before = await readAccountState(chain.client, OWNER, { metadataRegistry: REGISTRY })
    expect(before).toEqual({
      blockNumber: 0n,
      blockHash: chain.hashOf(0),
      nonce: 3n,
      keys: [ROOT],
      record: RECORD,
    })

    chain.advance({ nonce: 4n, keys: [ROOT, { key: r1Key(B), metadata: "0x" }], record: undefined })
    const after = await readAccountState(chain.client, OWNER, { metadataRegistry: REGISTRY })
    expect(after).toMatchObject({ blockNumber: 1n, nonce: 4n, record: undefined })
    expect(after.keys).toHaveLength(2)

    const pinned = await readAccountState(chain.client, OWNER, {
      metadataRegistry: REGISTRY,
      at: before.blockHash,
    })
    expect(pinned).toEqual(before)
    const finalized = await readAccountState(chain.client, OWNER, {
      metadataRegistry: REGISTRY,
      at: "finalized",
    })
    expect(finalized).toEqual(before)
  })

  it("reads a block before the account and registry existed as empty", async () => {
    const chain = fakeChain()
    chain.state.deployedAt = 1
    chain.advance({ nonce: 4n })
    expect(
      await readAccountState(chain.client, OWNER, { metadataRegistry: REGISTRY, at: "finalized" }),
    ).toEqual({
      blockNumber: 0n,
      blockHash: chain.hashOf(0),
      nonce: 0n,
      keys: [],
      record: undefined,
    })
    expect(
      await readAccountState(chain.client, OWNER, { metadataRegistry: REGISTRY }),
    ).toMatchObject({ blockNumber: 1n, nonce: 4n, record: RECORD })
  })

  it("refuses a hash whose block the chain replaced while it read", async () => {
    const chain = fakeChain()
    chain.advance({ nonce: 4n })
    const named = chain.hashOf(1)
    chain.state.onRead = (functionName) => {
      if (functionName === "getNonce") chain.replace(1, { nonce: 8n })
    }
    const refusal = await readAccountState(chain.client, OWNER, {
      metadataRegistry: REGISTRY,
      at: named,
    }).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(AccountStateReorgedError)
    expect(refusal).toMatchObject({ blockNumber: 1n, expected: named, canonical: chain.hashOf(1) })
  })

  it("follows a tag to the block that replaced the one it started reading", async () => {
    const chain = fakeChain()
    chain.advance({ nonce: 4n })
    let replaced = false
    chain.state.onRead = (functionName) => {
      if (functionName !== "getNonce" || replaced) return
      replaced = true
      chain.replace(1, { nonce: 8n })
    }
    expect(
      await readAccountState(chain.client, OWNER, { metadataRegistry: REGISTRY }),
    ).toMatchObject({ blockNumber: 1n, blockHash: chain.hashOf(1), nonce: 8n })
  })

  it("follows a tag when the read failed under the block that replaced it", async () => {
    const chain = fakeChain()
    chain.advance({ nonce: 4n })
    let replaced = false
    chain.state.onRead = (functionName) => {
      if (functionName !== "getNonce" || replaced) return
      replaced = true
      chain.replace(1, { nonce: 8n })
      throw new Error("the block went away")
    }
    expect(
      await readAccountState(chain.client, OWNER, { metadataRegistry: REGISTRY }),
    ).toMatchObject({ blockNumber: 1n, blockHash: chain.hashOf(1), nonce: 8n })
  })

  it("refuses a hash whose read failed under the block that replaced it", async () => {
    const chain = fakeChain()
    chain.advance({ nonce: 4n })
    const named = chain.hashOf(1)
    chain.state.onRead = (functionName) => {
      if (functionName !== "getNonce") return
      chain.replace(1, { nonce: 8n })
      throw new Error("the block went away")
    }
    const refusal = await readAccountState(chain.client, OWNER, {
      metadataRegistry: REGISTRY,
      at: named,
    }).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(AccountStateReorgedError)
  })

  it("surfaces a failed read when the block held", async () => {
    const chain = fakeChain()
    chain.state.failing.add("getAuthKeys")
    await expect(
      readAccountState(chain.client, OWNER, { metadataRegistry: REGISTRY }),
    ).rejects.toThrow("getAuthKeys is down")
  })
})

describe("verifyPersistedRotation", () => {
  it("verifies a record it rebuilt, and hands back the rotation with its recipient and key", async () => {
    const { chain, prepared, record } = await preparedAndSigned()

    const verdict = await verifyPersistedRotation(chain.client, record, TUPLE, TRUTH)

    if (verdict.verdict !== "verified") throw new Error(verdict.reason)
    expect(verdict.keyIndex).toBe(0n)
    expect(verdict.rootKey).toEqual(ROOT)
    expect(verdict.recipient.equals(TWO_KEY)).toBe(true)
    expect(verdict.rotation.intent).toBe(record.intent)
    expect(verdict.rotation.userOpHash).toBe(prepared.rotation.userOpHash)
    expect(verdict.rotation.sipa).toBe(prepared.rotation.sipa)
    expect(verdict.rotation.newRecord).toEqual(prepared.rotation.newRecord)
  })

  it("does not judge the live account: a moved record or nonce still verifies", async () => {
    const { chain, record } = await preparedAndSigned()
    chain.advance({ nonce: 9n, record: { ...RECORD, l2Address: TWO_KEY.toString() as Hex } })
    const verdict = await verifyPersistedRotation(chain.client, record, TUPLE, TRUTH)
    expect(verdict.verdict).toBe("verified")
  })

  it("follows the root key to its live index", async () => {
    const { chain, prepared } = await preparedAndSigned()
    chain.advance({ keys: [{ key: r1Key(C), metadata: "0x" }, ROOT] })
    const signature = await signUserOpHash(A, prepared.rotation.userOpHash, 1n)
    const verdict = await verifyPersistedRotation(
      chain.client,
      persisted(prepared, signature),
      TUPLE,
      TRUTH,
    )
    expect(verdict).toMatchObject({ verdict: "verified", keyIndex: 1n })
    const stale = await verifyPersistedRotation(
      chain.client,
      persisted(prepared, await signUserOpHash(A, prepared.rotation.userOpHash, 0n)),
      TUPLE,
      TRUTH,
    )
    expect(stale).toEqual({ verdict: "corrupt", reason: "the signature's key index" })
  })

  it("accepts an implementation the factory blessed after this one", async () => {
    const { chain, record } = await preparedAndSigned()
    chain.state.blessed.set(OTHER_IMPL.toLowerCase(), SipaIntent.UserOp)
    chain.state.implementationFor = OTHER_IMPL
    const verdict = await verifyPersistedRotation(chain.client, record, TUPLE, TRUTH)
    expect(verdict.verdict).toBe("verified")
  })

  it("verifies a rotation over the account's own resolver operator and keeps it", async () => {
    const { chain, record } = await preparedAndSigned(
      fakeChain({ record: { ...RECORD, resolverOperator: BENEFICIARY } }),
    )
    const verdict = await verifyPersistedRotation(chain.client, record, TUPLE, TRUTH)
    if (verdict.verdict !== "verified") throw new Error(verdict.reason)
    expect(verdict.rotation.newRecord.resolverOperator.toLowerCase()).toBe(
      BENEFICIARY.toLowerCase(),
    )
  })

  it("calls out each field a corrupt record disagrees on", async () => {
    const { chain, prepared, record } = await preparedAndSigned()
    const corrupt = async (
      change: Partial<PersistedRotation>,
      tuple = TUPLE,
      truth = TRUTH,
    ): Promise<string> => {
      const verdict = await verifyPersistedRotation(
        chain.client,
        { ...record, ...change },
        tuple,
        truth,
      )
      return verdict.verdict === "corrupt" ? verdict.reason : "verified"
    }
    const { intent, deployArgs } = record

    expect(await corrupt({ expectedKeys: [ROOT, ROOT] })).toBe(
      "the expected key set is not one root key",
    )
    expect(await corrupt({ expectedKeys: [{ key: r1Key(C), metadata: "0x" }] })).toBe(
      "the root key is not on the account",
    )
    expect(await corrupt({ expectedKeys: [{ ...ROOT, metadata: "0xdeadbeef" }] })).toBe(
      "the root key's metadata is not the account's",
    )
    expect(await corrupt({ owner: "0x12" as Address })).toBe("the record's shape")
    expect(await corrupt({ builtOver: { ...RECORD, rollupVersion: 1n << 256n } })).toBe(
      "the record's shape",
    )
    expect(await corrupt({ add: { ...ADD, pubkey: { qx: "0x01", qy: ADD.pubkey.qy } } })).toBe(
      "the record's shape",
    )
    expect(await corrupt({ expectedKeys: [{ ...ROOT, key: { ...ROOT.key, qx: "0x01" } }] })).toBe(
      "the record's shape",
    )
    expect(await corrupt({ intent: { ...intent, nonce: 1n << 64n }, nonce: 1n << 64n })).toBe(
      "the record's shape",
    )
    expect(
      await corrupt({ deployArgs: { ...deployArgs, resweepable: null as unknown as boolean } }),
    ).toBe("the record's shape")
    expect(await corrupt({ sipa: "0x12" as Address })).toBe("the record's shape")
    expect(await corrupt({ signature: "0xzz" as Hex })).toBe("the record's shape")
    // One nibble short: the bytes it decodes to depend on who pads it.
    expect(await corrupt({ signature: `0x${record.signature.slice(3)}` as Hex })).toBe(
      "the record's shape",
    )
    expect(await corrupt({ implementation: OTHER_IMPL })).toBe(
      "the implementation is not a blessed user-op clone",
    )
    expect(await corrupt({}, { ...TUPLE, rollupVersion: 8n })).toBe("the rollup version")
    expect(await corrupt({ intent: { ...intent, owner: OTHER_IMPL } })).toBe("the owner")
    expect(await corrupt({ add: { ...ADD, envelope: `0x${"cd".repeat(48)}` } })).toBe(
      "the call data",
    )
    expect(await corrupt({ add: { ...ADD, credentialId: toHex("other-credential") } })).toBe(
      "the call data",
    )
    expect(await corrupt({}, { ...TUPLE, metadataRegistry: OTHER_IMPL })).toBe("the call data")
    expect(await corrupt({ intent: { ...intent, accountGasLimits: `0x${"01".repeat(32)}` } })).toBe(
      "the gas limits",
    )
    expect(
      await corrupt({
        intent: { ...intent, precondition: { ...intent.precondition, data: "0x1234" } },
      }),
    ).toBe("the precondition call")
    expect(
      await corrupt({
        intent: {
          ...intent,
          postcondition: { ...intent.postcondition, resultHash: `0x${"02".repeat(32)}` },
        },
      }),
    ).toBe("the postcondition")
    expect(await corrupt({ nonce: intent.nonce + 1n })).toBe("the nonce")
    expect(await corrupt({ builtOver: { ...RECORD, l2Address: TWO_KEY.toString() as Hex } })).toBe(
      "the record built over names another address",
    )
    // The precondition hash rewritten to agree with the forged record changes nothing.
    const forged = { ...RECORD, l2Address: TWO_KEY.toString() as Hex }
    expect(
      await corrupt({
        builtOver: forged,
        intent: {
          ...intent,
          precondition: {
            ...intent.precondition,
            resultHash: conditionHash(
              encodeFunctionResult({
                abi: AccountMetadataRegistryAbi,
                functionName: "getUserRecord",
                result: forged,
              }),
            ),
          },
        },
      }),
    ).toBe("the record built over names another address")
    expect(await corrupt({ builtOver: { ...RECORD, rollupVersion: 8n } })).toBe("the call data")
    // No local truth names the operator, so the rebuilt call data is what binds the saved one.
    expect(await corrupt({ builtOver: { ...RECORD, resolverOperator: BENEFICIARY } })).toBe(
      "the call data",
    )
    expect(await corrupt({}, TUPLE, { ...TRUTH, publicKey: { x: 1n, y: 2n } })).toBe(
      "the record built over names another public key",
    )
    expect(
      await corrupt({
        intent: {
          ...intent,
          precondition: { ...intent.precondition, resultHash: `0x${"00".repeat(32)}` },
        },
      }),
    ).toBe("the precondition hash")
    expect(
      await corrupt({
        intent: {
          ...intent,
          precondition: {
            ...intent.precondition,
            resultHash: conditionHash(
              encodeFunctionResult({
                abi: AccountMetadataRegistryAbi,
                functionName: "getUserRecord",
                result: { ...RECORD, resolverOperator: BENEFICIARY },
              }),
            ),
          },
        },
      }),
    ).toBe("the precondition hash")
    expect(
      await corrupt({ intent: { ...intent, recipientCommitment: `0x${"03".repeat(32)}` } }),
    ).toBe("the recipient commitment")
    expect(await corrupt({ sharedSecretSalt: Fr.random() })).toBe("the recipient commitment")
    expect(
      await corrupt({
        deployArgs: { ...deployArgs, recoveryCommitment: `0x00${"04".repeat(31)}` },
      }),
    ).toBe("the recovery commitment")
    expect(await corrupt({ deployArgs: { ...deployArgs, implementation: OTHER_IMPL } })).toBe(
      "the deploy args' implementation",
    )
    expect(
      await corrupt({ deployArgs: { ...deployArgs, intentHash: `0x${"05".repeat(32)}` } }),
    ).toBe("the intent hash")
    expect(await corrupt({ deployArgs: { ...deployArgs, resweepable: true } })).toBe(
      "the deploy args' plumbing",
    )
    const sipaOf = (args: typeof deployArgs) =>
      computeSIPAAddress({
        sipaFactory: EthAddress.fromString(FACTORY),
        implementation: EthAddress.fromString(args.implementation),
        intentHash: Buffer.from(hexToBytes(args.intentHash)),
        recoveryCommitment: Fr.fromHexString(args.recoveryCommitment),
        rollupVersion: args.rollupVersion,
        resweepable: args.resweepable,
        forwardingTable: EthAddress.fromString(args.forwardingTable),
      }).toString() as Address
    // Another forwarding table with the SIPA recomputed over it: the tuple names the one table.
    const onOtherTable = { ...deployArgs, forwardingTable: OTHER_IMPL }
    expect(await corrupt({ deployArgs: onOtherTable, sipa: sipaOf(onOtherTable) })).toBe(
      "the deploy args' plumbing",
    )
    expect(await corrupt({ sipa: OTHER_IMPL })).toBe("the SIPA address")
    // A new salt with both commitments, the intent hash and the SIPA recomputed over it: the same
    // recipient and owner-bound recovery, and the signed operation untouched.
    const salt = Fr.random()
    const resalted = {
      ...intent,
      recipientCommitment: (await computeRecipientCommitment(salt, TWO_KEY)).toString() as Hex,
    }
    const resaltedArgs = {
      ...deployArgs,
      recoveryCommitment: deriveRecoveryCommitment(
        salt,
        EthAddress.fromString(OWNER),
      ).toString() as Hex,
      intentHash: keccak256(encodeUserOpIntentData(resalted)),
    }
    expect(
      await corrupt({
        sharedSecretSalt: salt,
        intent: resalted,
        deployArgs: resaltedArgs,
        sipa: sipaOf(resaltedArgs),
      }),
    ).toBe("verified")
    expect(
      await corrupt({ signature: await signUserOpHash(B, prepared.rotation.userOpHash) }),
    ).toBe("the signature: the signature does not verify")
    expect(await corrupt({ signature: "0x1234" })).toBe("the signature: no key index")
    expect(
      await corrupt({ signature: await signUserOpHash(A, prepared.rotation.userOpHash, 1n) }),
    ).toBe("the signature's key index")
    expect(await corrupt({})).toBe("verified")
  })

  it("leaves the record unjudged when a read does not complete", async () => {
    const { chain, record } = await preparedAndSigned()
    chain.state.failing.add("getAuthKeys")
    const refusal = await verifyPersistedRotation(chain.client, record, TUPLE, TRUTH).catch(
      (e: unknown) => e,
    )
    expect(refusal).toBeInstanceOf(VerificationUnavailableError)
    expect((refusal as VerificationUnavailableError).step).toBe("the account's keys")
    expect((refusal as Error).cause).toBeInstanceOf(Error)

    chain.state.failing.clear()
    chain.state.failing.add("intentOf")
    await expect(verifyPersistedRotation(chain.client, record, TUPLE, TRUTH)).rejects.toThrow(
      /the factory's blessing/,
    )
    chain.state.failing.clear()
    chain.state.failing.add("getUserOpHash")
    await expect(verifyPersistedRotation(chain.client, record, TUPLE, TRUTH)).rejects.toThrow(
      /the rotation's rebuild/,
    )
  })
})

describe("verifyWebAuthnUserOpSignature", () => {
  const hash = keccak256("0x1234")

  it("names what an assertion fails on: flags, type, challenge, range, or a malformed blob", async () => {
    const auth = await webAuthnAuthArg(A, hash)
    const reason = (change: Partial<typeof auth>) =>
      verifyWebAuthnUserOpSignature(
        encodeR1UserOpSignature(0n, { ...auth, ...change }),
        r1Key(A),
        hash,
      )
    const withFlags = (flags: number) =>
      `${auth.authenticatorData.slice(0, 66)}${flags
        .toString(16)
        .padStart(2, "0")}${auth.authenticatorData.slice(68)}` as Hex
    expect(reason({ authenticatorData: withFlags(0x01) })).toMatchObject({ reason: "the flags" })
    expect(reason({ authenticatorData: withFlags(0x04) })).toMatchObject({ reason: "the flags" })
    expect(reason({ authenticatorData: withFlags(0x15) })).toMatchObject({ reason: "the flags" })
    expect(reason({ authenticatorData: withFlags(0x1d) })).toMatchObject({
      reason: "the signature does not verify",
    })
    expect(reason({ authenticatorData: auth.authenticatorData.slice(0, 74) as Hex })).toMatchObject(
      { reason: "the authenticator data is short" },
    )
    expect(reason({ typeIndex: auth.typeIndex + 1n })).toMatchObject({ reason: "the type" })
    // The account slices the client data's bytes: a byte-order mark a string decoder drops moves the type.
    expect(reason({ clientDataJSON: `\uFEFF${auth.clientDataJSON}` })).toMatchObject({
      reason: "the type",
    })
    expect(reason({ challengeIndex: auth.challengeIndex + 1n })).toMatchObject({
      reason: "the challenge",
    })
    expect(reason({ challengeIndex: 2n ** 200n })).toMatchObject({ reason: "the challenge" })
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
    expect(reason({ s: toHex(n - BigInt(auth.s), { size: 32 }) })).toMatchObject({
      reason: "the signature's range",
    })
    expect(reason({ r: `0x${"00".repeat(32)}` })).toMatchObject({ reason: "the signature's range" })
    expect(verifyWebAuthnUserOpSignature(`0x${"00".repeat(32)}dead`, r1Key(A), hash)).toEqual({
      keyIndex: 0n,
      valid: false,
      reason: "the assertion does not decode",
    })
    expect(verifyWebAuthnUserOpSignature("0x", r1Key(A), hash)).toEqual({
      valid: false,
      reason: "no key index",
    })
    const whole = encodeR1UserOpSignature(0n, auth)
    expect(verifyWebAuthnUserOpSignature(`0x${whole.slice(3)}` as Hex, r1Key(A), hash)).toEqual({
      valid: false,
      reason: "not whole bytes",
    })
  })

  it("reads the type field through the length word at the index wrap, as the account does", async () => {
    const auth = await webAuthnAuthArg(A, hash)
    const atWrap = (1n << 256n) - 1n
    expect(
      verifyWebAuthnUserOpSignature(
        encodeR1UserOpSignature(0n, { ...auth, typeIndex: atWrap }),
        r1Key(A),
        hash,
      ),
    ).toMatchObject({ reason: "the type" })
    // The index lands on the length word's last byte, so a length ending in the type field's
    // opening quote followed by the rest of the field reads as the field.
    const challengeField = auth.clientDataJSON.match(/"challenge":"[^"]*"/)![0]
    const wrapped = Buffer.alloc(0x122, 0x20)
    wrapped.write(`type":"webauthn.get",${challengeField}`)
    const signedAt = async (clientData: Buffer) => {
      const signed = await A.signClientData(clientData)
      return encodeR1UserOpSignature(0n, {
        r: toHex(signed.signature.subarray(0, 32)),
        s: toHex(signed.signature.subarray(32)),
        challengeIndex: 21n,
        typeIndex: atWrap,
        authenticatorData: toHex(signed.authenticatorData),
        clientDataJSON: clientData.toString("latin1"),
      })
    }
    expect(verifyWebAuthnUserOpSignature(await signedAt(wrapped), r1Key(A), hash)).toEqual({
      keyIndex: 0n,
      valid: true,
    })
    expect(
      verifyWebAuthnUserOpSignature(await signedAt(wrapped.subarray(0, 0x121)), r1Key(A), hash),
    ).toMatchObject({ reason: "the type" })
  })
})

describe("buildBackupSweep", () => {
  it("builds the subsidy's deploy-and-sweep, paid in the token, conditioned on the SIPA's balance", async () => {
    const { chain, prepared, signature } = await preparedAndSigned()

    const operation = await buildBackupSweep(chain.client, prepared.rotation, signature, TUPLE)

    expect(operation.target.toString().toLowerCase()).toBe(SUBSIDY)
    expect(operation.payoutToken.toString().toLowerCase()).toBe(TOKEN)
    expect(operation.condition.token.toString().toLowerCase()).toBe(TOKEN)
    expect(operation.condition.recipient.toString().toLowerCase()).toBe(
      prepared.rotation.sipa.toLowerCase(),
    )
    const call = decodeFunctionData({ abi: DepositSubsidyAbi, data: toHex(operation.calldata) })
    expect(call.functionName).toBe("deployAndSweepForSubsidy")
    const [table, intent, recovery, resweepable, token, relayer, intentData, proofs] =
      call.args as readonly unknown[] as [Address, number, Hex, boolean, Address, Address, Hex, Hex]
    expect([table, token, relayer].map((a) => a.toLowerCase())).toEqual([TABLE, TOKEN, EXECUTOR])
    expect(intent).toBe(SipaIntent.UserOp)
    expect(recovery).toBe(prepared.rotation.deployArgs.recoveryCommitment)
    expect(resweepable).toBe(false)
    expect(intentData).toBe(encodeUserOpIntentData(prepared.rotation.intent))
    expect(proofs).toBe(encodeUserOpProofs(signature))
  })

  it("refuses a subsidy that serves another portal", async () => {
    const { chain, prepared, signature } = await preparedAndSigned()
    chain.state.subsidyPortal = OTHER_IMPL
    await expect(
      buildBackupSweep(chain.client, prepared.rotation, signature, TUPLE),
    ).rejects.toThrow(/would not sweep/)
  })
})

describe("fundingAmount", () => {
  const args = { tuple: TUPLE, plainWithdrawalExecutor: PLAIN_EXECUTOR, proverTip: 3n * 10n ** 16n }

  it("adds every charge on the way to L2 to a credit above the subsidy's minimum", async () => {
    const chain = fakeChain()
    chain.state.row = [PORTAL, BENEFICIARY, 2n * 10n ** 16n, TIP]

    const funding = await fundingAmount(chain.client, args)

    const credited = ONE_ETH + BACKUP_FUNDING_MARGIN
    expect(funding.credited).toBe(credited)
    expect(funding.amount).toBe(
      ONE_ETH / 10n + args.proverTip + WITHDRAW_RELAYER_TIP + TIP + 2n * 10n ** 16n + credited,
    )
    expect(funding.breakdown).toEqual({
      withdrawalFee: ONE_ETH / 10n,
      proverTip: args.proverTip,
      relayerTip: WITHDRAW_RELAYER_TIP,
      sweepTip: TIP,
      beneficiaryFee: 2n * 10n ** 16n,
      minCredited: ONE_ETH,
      margin: BACKUP_FUNDING_MARGIN,
    })
  })

  it("credits at least one unit when the subsidy sets no minimum", async () => {
    const chain = fakeChain()
    chain.state.config = [TIP, ONE_ETH, 0n]
    const funding = await fundingAmount(chain.client, args)
    expect(funding.breakdown.minCredited).toBe(1n)
    expect(funding.credited).toBe(1n + BACKUP_FUNDING_MARGIN)
  })

  it("refuses a route no relayer is paid to sweep, by its reason", async () => {
    const dead = async (chain: ReturnType<typeof fakeChain>) => {
      const refusal = await fundingAmount(chain.client, args).catch((e: unknown) => e)
      expect(refusal).toBeInstanceOf(RotationRouteNotLiveError)
      return (refusal as RotationRouteNotLiveError).reason
    }
    const noRow = fakeChain()
    noRow.state.row = undefined
    expect(await dead(noRow)).toBe("the forwarding table has no row for the token and intent")
    const unfunded = fakeChain()
    unfunded.state.subsidyBalance = 0n
    expect(await dead(unfunded)).toBe("the subsidy holds none of the token")
    const capped = fakeChain()
    capped.state.config = [TIP, 0n, ONE_ETH]
    expect(await dead(capped)).toBe("the subsidy's cap is zero")
  })
})
