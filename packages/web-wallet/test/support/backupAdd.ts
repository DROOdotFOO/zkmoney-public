import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import {
  BackupRotationStore,
  fundingLocalId,
  moveProgress,
  persistedRotation,
  type BackupRotationRecord,
  type BackupRotationStored,
  type FundingRow,
  type SIPADepositRecord,
  type SweepSeen,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import type { PersistedRotationVerdict, SpendShape } from "@obsidion/sdk"
import type { Address } from "viem"
import { vi } from "vitest"
import type { BackupAddDeps } from "../../src/features/backupPasskey/backupPasskeyAdd"
import type { BackupFlowDeps } from "../../src/features/backupPasskey/backupPasskeyRuntime"
import type { BackupCreationDriver } from "../../src/platform/auth/backupCreation"
import { FakePasskeyCeremony, MemoryStorage } from "./fakePasskeyCeremony"

export const OWNER = `0x${"11".repeat(20)}` as Address
export const MASTER_KEY = new Uint8Array(32).fill(7)
export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
export const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`
export const SIPA = addr(20)
export const TWO_KEY = word(0x2b)
const DAI = 10n ** 18n

/** Creates on the fake and hands back the PRF the creation returned, kept aside for the test. */
export const fakeDriver =
  (seen: { prf?: Uint8Array }): BackupCreationDriver =>
  async (ceremony, options) => {
    const created = await ceremony.create({
      rpId: options.rpId,
      rpName: options.rpName,
      userName: options.userName,
      prfFirstSalt: MSK_PRF_SALT,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!created.prfFirst) throw new Error("fake returned no PRF")
    seen.prf = new Uint8Array(created.prfFirst)
    return {
      created,
      slot: "first",
      prfOutput: created.prfFirst,
      securityKey: false,
      facts: { provider: "unknown" },
    }
  }

export function makeBackupAddDeps(
  opts: {
    driver?: BackupCreationDriver
    seal?: BackupAddDeps["seal"]
    storage?: MemoryStorage
    store?: BackupRotationStore
  } = {},
) {
  const storage = opts.storage ?? new MemoryStorage()
  const store = opts.store ?? new BackupRotationStore(storage)
  const ceremony = new FakePasskeyCeremony()
  const seen: { prf?: Uint8Array } = {}
  const outcomes: ("succeeded" | "failed")[] = []
  const driver = opts.driver ?? fakeDriver(seen)
  let now = 1_000
  const deps: BackupAddDeps = {
    owner: OWNER,
    masterKey: () => new Uint8Array(MASTER_KEY),
    create: (c, observe, signal) =>
      driver(c, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "brave-otter-42",
        challengeForChained: () => new Uint8Array(32),
        observe,
        ...(signal ? { signal } : {}),
      }),
    track: async (run) => {
      try {
        const result = await run(ceremony, () => {})
        outcomes.push("succeeded")
        return result
      } catch (err) {
        outcomes.push("failed")
        throw err
      }
    },
    store,
    ...(opts.seal ? { seal: opts.seal } : {}),
    now: () => ++now,
    attemptId: () => "attempt-1",
  }
  return { deps, store, storage, ceremony, seen, outcomes }
}

/** A signed change as the store keeps it. */
export const storedRotation = (over: Partial<BackupRotationStored> = {}): BackupRotationStored => ({
  owner: OWNER,
  intent: {
    rollupVersion: "6",
    precondition: { target: addr(2), data: "0x1234", resultHash: word(3) },
    postcondition: { target: addr(2), data: "0x1234", resultHash: word(4) },
    recipientCommitment: word(5),
    owner: OWNER,
    nonce: "7",
    callData: "0xabcd",
    accountGasLimits: word(8),
  },
  sharedSecretSalt: word(9),
  nonce: "7",
  builtOver: {
    l2Address: word(10),
    rollupVersion: "6",
    publicKey: { x: "11", y: "12" },
    resolverOperator: addr(13),
  },
  expectedKeys: [{ key: { qx: word(14), qy: word(15) }, metadata: "0x" }],
  implementation: addr(16),
  deployArgs: {
    implementation: addr(16),
    intentHash: word(17),
    recoveryCommitment: word(18),
    rollupVersion: "6",
    resweepable: false,
    forwardingTable: addr(19),
  },
  sipa: SIPA,
  add: { pubkey: { qx: word(21), qy: word(22) }, credentialId: "0x2324", envelope: "0x25" },
  signature: "0x26",
  ...over,
})

export const PLAN = {
  address: TWO_KEY,
  fundingAmount: (2n * DAI).toString(),
  deposited: ((18n * DAI) / 10n).toString(),
  credited: ((14n * DAI) / 10n).toString(),
  approvals: 1,
  moves: 2,
}

export const createdRecord = (over: Partial<BackupRotationRecord> = {}): BackupRotationRecord => ({
  owner: OWNER,
  attemptId: "attempt-1",
  phase: "created",
  backup: {
    credentialId: "backup-credential",
    pubkeyHex: "bb".repeat(64),
    envelopeHex: "01".repeat(62),
    userHandle: "YnJhdmUtb3R0ZXI",
    prfSlot: "first",
    securityKey: false,
  },
  fundings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

export const signedRecord = (over: Partial<BackupRotationRecord> = {}): BackupRotationRecord =>
  createdRecord({ phase: "signed", plan: PLAN, rotation: storedRotation(), fromBlock: 50, ...over })

/** A record whose funding was sent at `sentAt`, with the hash the fake world mints first. */
export const sent = (
  sentAt = 5,
  over: Partial<BackupRotationRecord["fundings"][number]> = {},
): Pick<BackupRotationRecord, "fundings"> => ({
  fundings: [
    {
      attemptId: "attempt-1",
      localId: fundingLocalId("attempt-1"),
      sentAt,
      session: "life-1",
      txHash: word(0x101),
      expiresAtMs: 5000,
      outcome: "pending",
      ...over,
    },
  ],
})

/** The phase with the move's progress, as the tests list what a resume wrote. */
export const phaseLine = (r: BackupRotationRecord): string => {
  const moved = moveProgress(r)
  return moved ? `${r.phase} ${moved.included}/${moved.total}` : r.phase
}

export const receipt = (status: TxStatus, reverted = false, block = 9) => ({
  status,
  executionResult: reverted ? TxExecutionResult.REVERTED : TxExecutionResult.SUCCESS,
  blockNumber: block,
  blockHash: `0xb${block}`,
})

/** The chain and the other stores, as the fake flow dependencies read them. */
export interface World {
  clock: { t: number }
  receipts: Map<string, ReturnType<typeof receipt>>
  finalizedAt: number
  rows: Map<string, FundingRow>
  balance: bigint
  sweep?: SweepSeen
  recovery?: `0x${string}`
  final: boolean
  releaseFinal: boolean
  shape: SpendShape
  hashes: number
  route: "ok" | "route"
  verdict: PersistedRotationVerdict
}

const VERIFIED = { verdict: "verified" } as unknown as PersistedRotationVerdict

/**
 * Flow dependencies over an in-memory world: the sign, publish and fund steps record what they were
 * asked and move the world on; the re-root succeeds at once and the move sends over the fake node.
 */
export function makeFlowDeps(
  opts: { storage?: MemoryStorage; store?: BackupRotationStore; world?: Partial<World> } = {},
) {
  const world: World = {
    clock: { t: 2000 },
    receipts: new Map(),
    finalizedAt: 0,
    rows: new Map(),
    balance: 0n,
    final: true,
    releaseFinal: true,
    shape: { notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI },
    hashes: 0,
    route: "ok",
    verdict: VERIFIED,
    ...opts.world,
  }
  const storage = opts.storage ?? new MemoryStorage()
  const store = opts.store ?? new BackupRotationStore(storage)
  const nextHash = () => word(0x100 + ++world.hashes)
  const { signature: _signature, ...prepared } = persistedRotation(storedRotation())
  const deps: BackupFlowDeps = {
    store,
    now: () => world.clock.t,
    mintAttemptId: () => `attempt-${world.hashes + 2}`,
    activeSince: 1000,
    session: "life-1",
    verify: vi.fn(async () => world.verdict),
    fundability: vi.fn(async () => "fundable" as const),
    route: vi.fn(async () => world.route),
    l1: {
      finalizedBlock: vi.fn(async () => ({ number: 100, hash: word(0xf1) })),
      isFinal: vi.fn(async () => world.final),
      sipaBalance: vi.fn(async () => world.balance),
      sweep: vi.fn(async () => world.sweep),
      recovery: vi.fn(async () => world.recovery),
      releaseFinal: vi.fn(async () => world.releaseFinal),
    },
    node: {
      getTxReceipt: vi.fn(
        async (hash: string) => world.receipts.get(hash) ?? receipt(TxStatus.DROPPED),
      ),
      finalizedTimestampMs: vi.fn(async () => world.finalizedAt),
    },
    tracker: {
      row: vi.fn(async (localId: string) => world.rows.get(localId)),
      stamp: vi.fn(async (localId: string, txHash: string) => {
        const row = world.rows.get(localId)
        if (row) world.rows.set(localId, { ...row, phase: "submitting", l2TxHash: txHash })
      }),
    },
    prepare: vi.fn(async () => ({ prepared, plan: PLAN, fromBlock: 50 })),
    strandedDeposit: vi.fn(async () => ({
      record: { sipaAddress: SIPA } as SIPADepositRecord,
      token: { address: SIPA, symbol: "DAI", decimals: 18 },
      balance: "1.4",
    })),
    sign: vi.fn(async () => "0x26" as const),
    publish: vi.fn(async () => undefined),
    republish: vi.fn(async () => undefined),
    // The node takes the funding only once the checkpoint ran, as the sdk's `onTxHash` contract says.
    fund: vi.fn(async (_r, _f, onTxHash) => {
      const hash = nextHash()
      await onTxHash(hash, { expiresAtMs: 5000 })
      world.receipts.set(hash, receipt(TxStatus.PENDING))
    }),
    reroot: vi.fn(async () => ({ switched: true, rebound: true })),
    move: {
      tokens: vi.fn(async () => ["tok"]),
      shape: vi.fn(async () => world.shape),
      deposits: vi.fn(async () => ({ kind: "exact" as const, amounts: [] })),
      cap: 2n * DAI,
      usesLeft: vi.fn(async () => true),
      // The one-key balance leaves with each chunk, as one note.
      send: vi.fn(async (_token: string, amount: bigint, onTxHash) => {
        const hash = nextHash()
        await onTxHash(hash, { expiresAtMs: 5000 })
        world.receipts.set(hash, receipt(TxStatus.PENDING))
        const left = world.shape.balance - amount
        world.shape = { notes: left > 0n ? [left] : [], depositTotal: 0n, balance: left }
      }),
      declined: vi.fn(isPasskeyCancelled),
    },
  }
  return { deps, world, store, storage }
}
