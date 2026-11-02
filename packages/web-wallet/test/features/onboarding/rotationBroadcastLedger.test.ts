/**
 * A backup passkey rotation's deposit-address broadcast through the wallet's ledger: the real
 * scheduler, ledger, operation store and rotation store, with fakes at the edges a test cannot run
 * (the prover, the chain, the unlock check and the sponsorship).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  OperationStore,
  persistedRotation,
  PUBLISH_BOUND,
  publishLanded,
  sipaDeployArgCandidates,
  SIPADepositStore,
} from "@obsidion/front-core"
import { getActiveStorageId } from "../../../src/platform/storage/activeStorage"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { OWNER, PLAN, SIPA, signedRecord, storedRotation } from "../../support/backupAdd"

const h = vi.hoisted(() => ({
  keys: undefined as unknown,
  sent: [] as { hashSavedFirst: boolean }[],
  chain: new Map<string, "included" | "pending" | "dropped">(),
  block: 42,
  /** Whether the node's receipt shows the broadcast in a block. */
  inBlock: true,
  sendFails: undefined as Error | undefined,
}))

const TUPLE = {
  l2Token: `0x${"01".repeat(32)}`,
  sipaFactory: "0x00000000000000000000000000000000000000fa",
  operationExecutor: "0x00000000000000000000000000000000000000fe",
  token: "0x00000000000000000000000000000000000000d4",
}
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getFeeTokenBridgeTuple: async () => TUPLE,
  l1PublicClient: () => ({}),
}))
vi.mock("../../../src/config/classArtifacts", () => ({ getWebOxideToken: async () => ({}) }))
vi.mock("../../../src/features/onboarding/registrationResume", () => ({
  unlockedSessionKeys: async () => h.keys,
}))
vi.mock("../../../src/features/onboarding/webRegistrationBroadcast", () => ({
  registeredBroadcaster: async () => ({}),
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({
    fpcAddress: "fpc",
    fpcArtifact: "fpc-artifact",
    railId: 1,
    policy: {},
  }),
  noteSubscribed: () => {},
}))
vi.mock("../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
vi.mock("../../../src/features/deposit/sipaSweep", () => ({ readSipaDeployed: async () => false }))
vi.mock("../../../src/features/deposit/sipaSweepRoutes", () => ({ getSipaSweepRoutes: async () => [] }))
vi.mock("../../../src/features/broadcasts/broadcastState", () => ({
  broadcastState: async (_wallet: unknown, txHash: string) => h.chain.get(txHash) ?? "pending",
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  ContractService: { getInstance: () => ({}) },
  buildSipaSweepBroadcasts: () => [{ request: async () => ({ calls: ["sweep"] }) }],
  buildClaimSponsorPayload: async (common: unknown) => ({ common }),
  buildClaimSubscribePayload: async (common: unknown) => ({ common }),
  claimFpcSponsoredFee: () => ({}),
}))
vi.mock("@oxide/l1-contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxide/l1-contracts")>()),
  encodeUserOpIntentData: () => "0x01",
  encodeUserOpProofs: () => "0x02",
}))

const { getBroadcastLedger, resetBroadcastsForTests, startBroadcasts } = await import(
  "../../../src/features/broadcasts/broadcasts"
)
const { rotationExecutor } = await import("../../../src/features/broadcasts/rotationBroadcastExecutor")
const { getBackupRotationStore, resetBackupRotationStoreForTests } = await import(
  "../../../src/features/backupPasskey/backupRotationStore"
)
const { publishRotationAddress, republishRotationAddress, seedRotationDeposit } = await import(
  "../../../src/features/backupPasskey/rotationPublish"
)
const { maybeRefuelFpc } = await import("../../../src/features/fees/fpcRefuel")

const unlocked = () => ({ account: { getAddress: () => ({ toString: () => "0x22" }) } })
const wallet = {
  sendTx: async (_payload: unknown, opts: { onTxHash: (h: string) => Promise<void> }) => {
    if (h.sendFails) throw h.sendFails
    const txHash = `0x${(h.sent.length + 1).toString(16).padStart(64, "0")}`
    await opts.onTxHash(txHash)
    const record = await getBackupRotationStore().get(OWNER)
    h.sent.push({ hashSavedFirst: record?.publish?.txHash === txHash })
    h.chain.set(txHash, "included")
    return { receipt: { txHash: { toString: () => txHash } } }
  },
  node: { getTxReceipt: async () => (h.inBlock ? { blockNumber: h.block } : {}) },
} as never
const config = { l1ChainId: 31337 } as never

let stop: (() => void) | undefined
const start = () => (stop = startBroadcasts(wallet, { rotation: rotationExecutor(wallet, config) }))
const address = SIPA.toLowerCase()
const job = () => getBroadcastLedger().get(address)
const owe = () =>
  getBroadcastLedger().enqueue({
    address,
    kind: "deposit",
    scope: getActiveStorageId(),
    source: { type: "rotation", owner: OWNER },
  })

/** The state a settled promise reached, without waiting on it. */
async function outcome(promise: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  const state = await Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
  ])
  return state
}

const ACCOUNT_FACTORY = "0x00000000000000000000000000000000000000af"
const factories = {
  sipaFactory: TUPLE.sipaFactory as `0x${string}`,
  accountFactory: ACCOUNT_FACTORY as `0x${string}`,
}
const publish = () =>
  publishRotationAddress({
    owner: OWNER,
    record: signedRecord(),
    rotation: persistedRotation(storedRotation()),
    l1ChainId: 31337,
    networkId: "0xnet",
    token: TUPLE.token as `0x${string}`,
    ...factories,
  })

beforeEach(async () => {
  localStorage.clear()
  resetBroadcastsForTests()
  resetBackupRotationStoreForTests()
  OperationStore.reset()
  ;(SIPADepositStore as unknown as { instance: SIPADepositStore | null }).instance = null
  h.keys = unlocked()
  h.sent = []
  h.chain.clear()
  h.block = 42
  h.inBlock = true
  h.sendFails = undefined
  vi.mocked(maybeRefuelFpc).mockClear()
  await getBackupRotationStore().put(signedRecord())
})

afterEach(() => {
  stop?.()
  stop = undefined
})

describe("a rotation's deposit-address broadcast on the ledger", () => {
  it("counts the send, saves the hash before the node takes it, writes the landing, and shows a background row", async () => {
    await owe()
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect(h.sent).toEqual([{ hashSavedFirst: true }])
    const record = (await getBackupRotationStore().get(OWNER))!
    expect(record.publish).toMatchObject({
      count: 1,
      txHash: job()!.txHash,
      l2Block: 42,
      history: [{ txHash: job()!.txHash, l2Block: 42 }],
    })
    expect(publishLanded(record, 0)).toBe(true)
    expect(OperationStore.get().get(job()!.operationId!)).toMatchObject({
      state: "settled",
      summary: "Backup passkey",
      background: true,
    })
  })

  it("waits for an unlock without counting a failure or a send", async () => {
    h.keys = undefined
    await owe()
    start()
    await vi.waitFor(() => expect(job()?.lastError).toBe("Waiting for unlock"))
    expect(job()).toMatchObject({ state: "queued", failures: 0 })
    expect(h.sent).toEqual([])
    expect((await getBackupRotationStore().get(OWNER))?.publish).toBeUndefined()
  })

  it("keeps the job owed after a send that died before its hash, and does not count it", async () => {
    h.sendFails = new Error("proving died")
    await owe()
    start()
    await vi.waitFor(() => expect(job()?.failures).toBe(1))
    expect(job()).toMatchObject({ state: "queued", lastError: "proving died" })
    expect((await getBackupRotationStore().get(OWNER))?.publish).toBeUndefined()
    expect(publishLanded((await getBackupRotationStore().get(OWNER))!, 0)).toBe(false)
    expect(maybeRefuelFpc).not.toHaveBeenCalled()
  })

  it("keeps a sent broadcast open while the node shows no block for it, and records the landing once it does", async () => {
    h.inBlock = false
    await owe()
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("sent"))
    await new Promise((r) => setTimeout(r, 20))
    expect(job()?.state).toBe("sent")
    expect((await getBackupRotationStore().get(OWNER))?.publish?.history).toEqual([])
    stop?.()
    h.inBlock = true
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect((await getBackupRotationStore().get(OWNER))?.publish?.history).toHaveLength(1)
  })

  it("publishes a landed address again from the given block, and not one still owed", async () => {
    await owe()
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    stop?.()
    const record = (await getBackupRotationStore().get(OWNER))!
    expect(await republishRotationAddress(OWNER, record, async () => 100)).toBe(true)
    expect(job()).toMatchObject({ state: "queued", republishSince: 100 })
    expect(await republishRotationAddress(OWNER, record, async () => 101)).toBe(false)
    expect(job()).toMatchObject({ state: "queued", republishSince: 100 })
    expect(
      await republishRotationAddress(OWNER, { ...record, rotation: undefined }, async () => 102),
    ).toBe(false)
  })

  it("owes a fresh broadcast when the ledger lost a funded address's job", async () => {
    await owe()
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    stop?.()
    await getBroadcastLedger().remove(address)
    const record = (await getBackupRotationStore().get(OWNER))!
    expect(await republishRotationAddress(OWNER, record, async () => 100)).toBe(true)
    expect(job()).toMatchObject({
      state: "queued",
      republishSince: 100,
      source: { type: "rotation", owner: OWNER },
    })
  })

  it("sends nothing more once the attempt's count reached the flow's bound", async () => {
    const store = getBackupRotationStore()
    const record = (await store.get(OWNER))!
    await store.put({ ...record, publish: { count: PUBLISH_BOUND, history: [] } })
    await owe()
    start()
    await vi.waitFor(() => expect(job()).toBeNull())
    expect(h.sent).toEqual([])
  })

  it("sends a republished broadcast again and counts its landing from the new block", async () => {
    await owe()
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    stop?.()
    h.block = 142
    expect(await getBroadcastLedger().republish(address, 100)).toBe(true)
    start()
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    const record = (await getBackupRotationStore().get(OWNER))!
    expect(record.publish).toMatchObject({ count: 2, l2Block: 142 })
    expect(record.publish?.history).toHaveLength(2)
    expect(publishLanded(record, 100)).toBe(true)
  })

  describe("the publish step", () => {

    it("seeds what the account's recovery signs over: the salt and the user-op origin", async () => {
      const landed = publish()
      const deposits = SIPADepositStore.get(webStorage)
      await vi.waitFor(async () => {
        await deposits.load()
        expect(deposits.get(SIPA)).not.toBeNull()
      })
      const { deployArgs, owner, sharedSecretSalt } = storedRotation()
      const record = deposits.get(SIPA)!
      expect(record.messageSecret).toBe(sharedSecretSalt)
      expect(record.origin).toEqual({
        protocol: "account",
        sipaFactory: TUPLE.sipaFactory,
        ...deployArgs,
        recoveryAccount: owner,
        accountFactory: ACCOUNT_FACTORY,
      })
      expect(sipaDeployArgCandidates(record, [])).toEqual([
        {
          protocol: "account",
          sipaFactory: TUPLE.sipaFactory,
          args: {
            implementation: deployArgs.implementation,
            intentHash: deployArgs.intentHash,
            recoveryCommitment: deployArgs.recoveryCommitment,
            rollupVersion: BigInt(deployArgs.rollupVersion),
            resweepable: false,
            forwardingTable: deployArgs.forwardingTable,
          },
        },
      ])
      start()
      await landed
    })

    it("gives the origin to the rail's record of a finished attempt whose salt has left, and creates none for it", async () => {
      const { sharedSecretSalt: _salt, signature: _signature, ...rotation } = storedRotation()
      const finished = signedRecord({ phase: "recovered", plan: undefined, rotation })
      const seed = () =>
        seedRotationDeposit({
          record: finished,
          l1ChainId: 31337,
          networkId: "0xnet",
          token: TUPLE.token as `0x${string}`,
          ...factories,
        })
      await expect(seed()).rejects.toThrow("nothing signed")
      const deposits = SIPADepositStore.get(webStorage)
      await deposits.load()
      expect(deposits.get(SIPA)).toBeNull()
      await deposits.upsert(
        SIPA,
        { phase: "recovered" },
        {
          recipientL2Address: PLAN.address,
          messageSecret: storedRotation().sharedSecretSalt!,
          recipientHash: rotation.intent.recipientCommitment,
          recoveryAddress: "",
          l1ChainId: 31337,
          networkId: "0xnet",
          amount: "0",
          tokenSymbol: "DAI",
          startTime: 7,
          tokenAddress: TUPLE.token as `0x${string}`,
          intent: "user-op",
        },
      )
      expect(await seed()).toMatchObject({
        phase: "recovered",
        messageSecret: storedRotation().sharedSecretSalt,
        origin: { protocol: "account", recoveryAccount: rotation.owner },
      })
    })

    it("waits across a failed attempt until a later one lands", async () => {
      h.sendFails = new Error("proving died")
      const landed = publish()
      start()
      await vi.waitFor(() => expect(job()?.failures).toBe(1))
      expect(await outcome(landed)).toBe("pending")
      h.sendFails = undefined
      await getBroadcastLedger().retryNow(address)
      await vi.waitFor(() => expect(job()?.state).toBe("landed"))
      expect(await outcome(landed)).toBe("resolved")
      expect(h.sent).toHaveLength(1)
    })

    it("rejects once the ledger drops the job", async () => {
      const landed = publish()
      expect(await outcome(landed)).toBe("pending")
      await getBackupRotationStore().remove(OWNER)
      start()
      await vi.waitFor(() => expect(job()).toBeNull())
      await expect(landed).rejects.toThrow("dropped")
    })

    it("publishes the same address once, however many times the step runs", async () => {
      const first = publish()
      const second = publish()
      await vi.waitFor(() => expect(job()).not.toBeNull())
      expect(
        getBroadcastLedger()
          .list()
          .filter((j) => j.address === address),
      ).toHaveLength(1)
      start()
      await Promise.all([first, second])
      expect(h.sent).toHaveLength(1)
    })
  })
})
