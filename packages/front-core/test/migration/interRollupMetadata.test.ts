// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { keccak256, toHex, zeroHash, type Address, type Hex } from "viem"
import {
  decodeMetadataUpdateIntentData,
  decodeUserRecordMetadata,
  userRecordStateHash,
} from "@oxide/l1-contracts"
import {
  MetadataMigrationService,
  type MetadataMigrationServiceOptions,
} from "../../../sdk/src/services/migration/MetadataMigrationService.js"
import {
  FrozenMetadataMigrationSource,
  type FrozenMigrationRuntime,
  type FrozenRefundCandidate,
} from "../../../sdk/src/services/migration/FrozenMetadataMigrationSource.js"
import { SipaSelfResolver } from "../../../sdk/src/services/sipa/sipaSelfResolve.js"
import { selfSipaResolverKeys } from "../../src/oxide/oxideAccountKeys"
import { MetadataMigrationController } from "../../src/core/migration/MetadataMigrationController"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"

// Real wallet codecs, bootstrap assembly, source adapter and durable driver. Contract responses
// and source proofs are synthetic. This does not implement or claim compatibility with Aztec v6.
const chain = vi.hoisted(() => ({
  recurring: false,
  attestation: false,
  /** The SIPAs, and direct deposits' commitments, whose every deposit the rail has claimed. */
  received: new Set<string>(),
  subscribe: vi.fn(async (args) => ({ calls: args.innerCalls, gate: args.gate })),
  sponsor: vi.fn(async (args) => ({ calls: args.innerCalls })),
}))
vi.mock("../../../sdk/src/feePaymentMethod/claimFpc/claimSponsoredCall.js", () => ({
  buildClaimSubscribePayload: chain.subscribe,
  buildClaimSponsorPayload: chain.sponsor,
}))
vi.mock("../../../sdk/src/feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))
vi.mock("../../../sdk/src/services/claimFpc/claimSponsor.js", () => ({
  claimFpcSubscriptionUses: async () => (chain.recurring ? 10 : 0),
  hasClaimFpcSubscription: async () => chain.recurring,
}))
vi.mock("../../../sdk/src/services/name/registrationMessage.js", () => ({
  registrationInbox: () => ({}),
  findRegistrationMessage: async () =>
    chain.attestation ? { status: "ready", leafIndex: 3n } : undefined,
}))
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const field = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const token = addr(50),
  metadataSipa = addr(60),
  depositSipa = addr(61),
  sourcePortal = addr(70),
  depositSubsidy = addr(71),
  executor = addr(74),
  migrationSubsidy = addr(75)

function fixture() {
  const destination = {
    chainId: 31337n,
    rollupVersion: 60001n,
    nameRegistry: addr(1),
    metadataRegistry: addr(2),
    controller: addr(3),
    factory: addr(4),
    forwardingTable: addr(73),
    portal: addr(5),
    implementation: addr(6),
    namePortal: addr(7),
    token,
    depositSubsidy,
    operationExecutor: addr(72),
  }
  const user = AztecAddress.fromStringUnsafe(field(12)),
    fpcAddress = AztecAddress.fromStringUnsafe(field(14))
  const resolver = new SipaSelfResolver(selfSipaResolverKeys(new Fr(123n)))
  const record = {
    l2Address: field(12),
    rollupVersion: 60001n,
    publicKey: resolver.userPublicKey,
    resolverOperator: addr(13),
  }
  const passkey = { qx: field(20), qy: field(21) }
  const state = {
    hash: zeroHash as Hex,
    registry: destination.metadataRegistry,
    bootstrapSpent: false,
    nonce: 0n,
  }
  const readContract = vi.fn(
    async ({ functionName, args }: { functionName: string; args?: any[] }) => {
      switch (functionName) {
        case "accountMetadataRegistry":
          return state.registry
        case "registrationController":
          return destination.controller
        case "NAME_REGISTRY":
          return destination.nameRegistry
        case "getAuthKeys":
          return [{ key: passkey, metadata: "0x" }]
        case "getNonce":
          return state.nonce
        case "getUserOpHash":
          return keccak256(toHex(`${args![0].callData}/${args![0].nonce}`))
        case "implementationFor":
          return args?.[0] === 3 ? destination.implementation : addr(8)
        case "nameOf":
          return field(9)
        case "bootstrapOwner":
          return addr(10)
        case "metadataStateHash":
          return state.hash
        case "predictSIPA":
          return args?.[0] === destination.implementation ? metadataSipa : depositSipa
        // The table routes every intent to the destination portal; a metadata update tips more.
        case "rowFor":
          return [destination.portal, addr(0), 0n, args?.[1] === 3 ? 5n : 2n]
        case "TX_AMOUNT_CAP":
          return 10n ** 30n
        // The deposit subsidy deploys and sweeps the SIPA it derives from these.
        case "PORTAL":
          return destination.portal
        case "SIPA_FACTORY":
          return destination.factory
        case "ROLLUP_VERSION":
          return destination.rollupVersion
        case "isValidSignature":
          return "0x1626ba7e"
        default:
          throw new Error(`Unexpected destination read ${functionName}`)
      }
    },
  )
  const client = {
    getChainId: async () => 31337,
    getBlockNumber: async () => 1n,
    readContract,
    getCode: async () => "0x",
    getLogs: vi.fn(async () => []),
    call: vi.fn(async () => ({})),
  }
  const sends: any[] = []
  const wallet = {
    node: {
      getNodeInfo: vi.fn(async () => ({
        rollupVersion: 60001,
        l1ContractAddresses: {
          rollupAddress: EthAddress.fromString(addr(90)),
          inboxAddress: EthAddress.fromString(addr(91)),
        },
      })),
      findLeavesIndexes: async () => [state.bootstrapSpent ? { index: 1n } : undefined],
      // A send resolves once its transaction is included.
      getTxReceipt: async () => ({
        status: TxStatus.PROVEN,
        executionResult: TxExecutionResult.SUCCESS,
      }),
    },
    sendTx: vi.fn(async (payload, options) => {
      await options.onTxHash(field(80 + sends.length))
      sends.push(payload)
      return { txHash: field(79 + sends.length) }
    }),
  }
  const calls = {
    methods: new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          (...args: any[]) => ({ request: async () => ({ calls: [{ name, args }] }) }),
      },
    ),
  }
  const spent = new Set<string>()
  const candidates: FrozenRefundCandidate[] = [
    { id: "first", amount: String(30n * TIP), kind: "note" },
    { id: "last", amount: String(20n * TIP), kind: "note" },
  ]
  const route = {
    executor,
    subsidy: migrationSubsidy,
    payoutToken: token,
    sourcePortal,
    destinationPortal: destination.portal,
  }
  const runtime: FrozenMigrationRuntime = {
    // A frozen source moves only through its destination's migration executor.
    migration: route,
    minimumMigratedAmount: vi.fn(async () => 0n),
    assertMigrationReady: vi.fn(async () => {}),
    identity: JSON.stringify({
      rollup: addr(92),
      rollupVersion: 50001,
      portal: sourcePortal,
      generation: "source-test-runtime",
    }),
    validate: vi.fn(async () => {}),
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 1,
      maxBatchAmount: 1000n * TIP,
      candidates: candidates.filter((c) => !spent.has(c.id)),
    })),
    build: vi.fn(async ({ ids }, _recipient, _tip) => ({
      amount: BigInt(candidates.find((c) => c.id === ids[0])!.amount),
      operation: {
        target: EthAddress.fromString(migrationSubsidy),
        payoutToken: EthAddress.fromString(token),
        calldata: Buffer.from(field(ids[0] === "first" ? 100 : 101).slice(2), "hex"),
        condition: L1OperationCondition.immediate(),
      },
    })),
    refunded: vi.fn(async (ids: string[]) => ids.every((id) => spent.has(id))),
  }
  const batches = new Map<string, MigrationFundingBatch>()
  const tokenService = { ensureSweptDeposit: vi.fn(async () => {}) }
  // This chain claims a sweep as it lands.
  const registered = { user, fpcAddress, railId: 2, policy: {}, fpcArtifact: {} }
  const makeSource = () =>
    new FrozenMetadataMigrationSource({
      runtime,
      destinationAsset: token,
      client,
      wallet,
      destination,
      owner: addr(11),
      selfResolver: resolver,
      token: calls,
      tokenService,
      broadcaster: calls,
      registered,
      // The rail claimed a received batch's whole amount, or nothing.
      directDepositClaimed: async (commitment: Hex) =>
        chain.received.has(commitment) ? 10n ** 30n : 0n,
      batches: {
        get: async (id: string) => structuredClone(batches.get(id)),
        set: async (id: string, batch: MigrationFundingBatch) => {
          batches.set(id, structuredClone(batch))
        },
      },
    } as unknown as ConstructorParameters<typeof FrozenMetadataMigrationSource>[0])
  const signRecordUpdate = vi.fn(async () => ({
    r: field(1),
    s: field(2),
    challengeIndex: 23n,
    typeIndex: 1n,
    authenticatorData: field(3),
    clientDataJSON: "{}",
  }))
  const options = {
    client,
    wallet,
    destination,
    owner: addr(11),
    record,
    selfResolver: resolver,
    token: calls,
    broadcaster: calls,
    tokenService,
    bootstrap: { ...registered, railId: 1 },
    registered,
    nameClaim: async () => ({ kind: "nameClaim" }),
    registrationKeyProof: () => ({} as never),
    recordPasskey: passkey,
    signRecordUpdate,
  }
  let raw: string | null = null
  const storage = {
    getItem: async () => raw,
    setItem: async (_key: string, value: string) => {
      raw = value
    },
  }
  // The registration run: its source is this version, which holds nothing to move.
  const externalSource = {
    identity: "external",
    state: async () => "empty" as const,
    recoverRemaining: async () => {},
    remainingComplete: async () => true,
  }
  const make = (o: { external?: boolean; recoveryOnly?: boolean } = { recoveryOnly: true }) => {
    const source = o.external ? externalSource : makeSource()
    const service = new MetadataMigrationService({
      ...options,
      ...(o.recoveryOnly ? { recoveryOnly: true } : {}),
      source,
    } as unknown as MetadataMigrationServiceOptions)
    return {
      source,
      service,
      controller: new MetadataMigrationController(storage, service, "future-rollup"),
    }
  }
  return {
    ...make(),
    make,
    state,
    options,
    runtime,
    batches,
    spent,
    candidates,
    sends,
    tokenService,
    signRecordUpdate,
    readContract,
    wallet,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  chain.recurring = chain.attestation = false
  chain.received.clear()
})

describe("inter-rollup wallet behavior against a synthetic future destination", () => {
  it("plans a frozen source as funds only, even when the run is not marked so", async () => {
    const f = fixture()
    const plan = JSON.parse(await f.make({}).service.prepare())
    expect(plan).toMatchObject({ recoveryOnly: true, sourceState: "frozen" })
    expect(plan.sourceBatch).toBeUndefined()
    expect(f.signRecordUpdate).not.toHaveBeenCalled()
  })

  it("proves every batch up front and sends each straight into the destination portal", async () => {
    const f = fixture()
    f.state.hash = userRecordStateHash(f.options.record)
    chain.recurring = true
    const quoted = await f.service.quote()
    expect(quoted).toMatchObject({ movable: 50n * TIP, stranded: 0n, waiting: 0n, batches: 2 })
    await f.controller.advance(true)
    expect(f.controller.getSnapshot()?.error).toBeUndefined()
    expect(f.controller.getSnapshot()?.bootstrapTx).toBeUndefined()
    expect(f.runtime.build).toHaveBeenCalledTimes(2)
    // No record update: a funds-only run updates no registration.
    expect(f.signRecordUpdate).not.toHaveBeenCalled()
    expect(f.sends).toHaveLength(2)
    for (const [i, send] of f.sends.entries()) {
      // Each refund's L1 operation calls the subsidy, with no tip, and its deposit is announced.
      const operation = send.calls.find((call: any) =>
        String(call.name).includes("broadcast_l1_operation"),
      )
      expect(operation.args[0].toString()).toBe(migrationSubsidy)
      expect(send.calls.map((call: any) => call.name)).toContain("notify_sipa_recipient")
      const batch = f.batches.get(`remaining-${i}`)!
      expect(batch.direct).toMatchObject({ executor, subsidy: migrationSubsidy })
      expect(batch.exitFee).toBe("0")
    }
    expect(vi.mocked(f.runtime.build).mock.calls.every(([, , tip]) => tip === 0n)).toBe(true)
    const refunded = new Set(vi.mocked(f.runtime.build).mock.calls.flatMap(([batch]) => batch.ids))
    const amount = (id: string) => BigInt(f.candidates.find((c) => c.id === id)!.amount)
    expect([...refunded].reduce((sum, id) => sum + amount(id), 0n)).toBe(quoted.movable)
  })

  it("rejects a destination node mismatch before the record update or source proving", async () => {
    const f = fixture()
    const { service } = f.make({ external: true })
    f.wallet.node.getNodeInfo.mockResolvedValue({ rollupVersion: 50001 } as never)
    await expect(service.prepare()).rejects.toThrow("different destination rollup")
    expect(f.signRecordUpdate).not.toHaveBeenCalled()
    expect(f.runtime.build).not.toHaveBeenCalled()
  })
  it("rejects a changed registry before publishing a prepared record update", async () => {
    const f = fixture()
    const { service } = f.make({ external: true })
    const plan = await service.prepare()
    f.state.registry = addr(200)
    await expect(service.broadcast(plan, vi.fn())).rejects.toThrow("registry or controller changed")
    expect(f.sends).toHaveLength(0)
  })
  it("does not use a new registry to renew the spent bootstrap allowance", async () => {
    const f = fixture()
    f.state.bootstrapSpent = true
    const { controller } = f.make({ external: true })
    await controller.advance(true)
    expect(controller.getSnapshot()?.error).toContain("allowance is already spent")
    expect(f.sends).toHaveLength(0)
  })
  it("rejects a saved plan when the destination metadata coordinates change", async () => {
    const f = fixture()
    const plan = await f.make({ external: true }).service.prepare()
    f.options.record.resolverOperator = addr(200)
    await expect(f.make({ external: true }).service.broadcast(plan, vi.fn())).rejects.toThrow(
      "account or deployment changed",
    )
    expect(f.sends).toHaveLength(0)
  })
})
