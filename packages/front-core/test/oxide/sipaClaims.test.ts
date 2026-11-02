import { beforeEach, describe, expect, it, vi } from "vitest"
import { encodeEventTopics, erc20Abi, pad, toHex, type Address } from "viem"
import { keccak256 } from "@aztec-labs/foundation/crypto/keccak"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { SipaIntent } from "@oxide/l1-contracts"
import { syncCatchUp } from "../../src/engine/catchUp"

const ZERO = "0x0000000000000000000000000000000000000000"

const mocks = vi.hoisted(() => ({
  fetchSipaEvents: vi.fn(),
  readSweepEvents: vi.fn(),
  readRecoveredEvents: vi.fn(async () => []),
  readBlockTimeMs: vi.fn(async () => undefined),
  readDepositMessageKey: vi.fn(),
  readFundingTransfers: vi.fn(),
  readSipaFundingStatus: vi.fn(),
  /** What the observation's balance read sees at a SIPA in the fee token; zero when unset. */
  observedTokenBalance: vi.fn<(sipa: string) => bigint | undefined>(),
  readDepositFee: vi.fn(),
  readTxAmountCap: vi.fn(),
  readDepositSIPAImplementation: vi.fn(),
  readRegistrationSIPAImplementation: vi.fn(),
  readBlessedImplementations: vi.fn(),
  readSipaCloneImplementation: vi.fn(),
  readSipaIntent: vi.fn(),
  readSweepEmitters: vi.fn(),
  computeStealthRecipientHash: vi.fn(),
  deriveRecoveryAddress: vi.fn(),
  computeSIPAAddress: vi.fn(),
  computeAccountSIPAAddress: vi.fn(),
  deriveRecoveryCommitment: vi.fn(),
  isL1ToL2MessageReady: vi.fn(),
  readSipaDepositsConsumed: vi.fn(),
}))

// The composition's collaborators are all unit-tested in their own modules
// (sdk reads, front-core crypto); here they are mocked so the test pins the
// ORCHESTRATION: sequencing, store patches, dedup, and failure isolation.
vi.mock("@obsidion/sdk", async () => ({
  // The sdk's formula, so the rail's check meets what a sender announces.
  directAnnouncementIntentHash: await (async () => {
    const { concat, keccak256, toHex } = await import("viem")
    const domain = keccak256(toHex("oxide.direct-migration"))
    return (c: `0x${string}`) => keccak256(concat([domain, c]))
  })(),
  isAlreadyClaimedDepositError: (await import("../../../sdk/src/services/token/depositReceipt.js"))
    .isAlreadyClaimedDepositError,
  fetchSipaEvents: mocks.fetchSipaEvents,
  readSipaDepositsConsumed: mocks.readSipaDepositsConsumed,
  // ETH comes off the client's getBalance; the fee token's balance off `observedTokenBalance`.
  readSipaBalancesMany: vi.fn(
    async (
      client: { getBalance: (p: { address: string }) => Promise<bigint> },
      sipas: string[],
      tokens: string[],
    ) =>
      new Map(
        await Promise.all(
          sipas.map(
            async (sipa) =>
              [
                sipa.toLowerCase(),
                new Map([
                  [ZERO, await client.getBalance({ address: sipa })],
                  [tokens[0]!.toLowerCase(), mocks.observedTokenBalance(sipa) ?? 0n],
                ]),
              ] as const,
          ),
        ),
      ),
  ),
  readBlockTimeMs: mocks.readBlockTimeMs,
  readSipaFundingStatus: mocks.readSipaFundingStatus,
  readDepositFee: mocks.readDepositFee,
  readDepositSIPAImplementation: mocks.readDepositSIPAImplementation,
  readRegistrationSIPAImplementation: mocks.readRegistrationSIPAImplementation,
  readBlessedImplementations: mocks.readBlessedImplementations,
  readSipaCloneImplementation: mocks.readSipaCloneImplementation,
  readSipaIntent: mocks.readSipaIntent,
  readSweepEmitters: mocks.readSweepEmitters,
}))
// The observation answered by the per-SIPA mocks, so each test pins what one SIPA's logs and
// balances were. `observeSipas` itself is covered by sipaObservation.test.ts.
vi.mock("../../src/oxide/sipaObservation", async () => {
  const { parseEventLogs } = await import("viem")
  const sdk = await import("@obsidion/sdk")
  return {
    observeSipas: vi.fn(
      async (
        client: {
          getBalance: (p: { address: string }) => Promise<bigint>
          getTransactionReceipt?: (p: { hash: string }) => Promise<{ logs: never[] }>
        },
        params: {
          portals: string[]
          tokens: string[]
          head: bigint
          subjects: { address: string; fromBlock: bigint; inflows: boolean }[]
        },
      ) => {
        const out = new Map()
        for (const subject of params.subjects) {
          const address = subject.address
          const sweeps = await Promise.all(
            (
              (await mocks.readSweepEvents(client, address, subject.fromBlock, params.head)) ?? []
            ).map(
              async (sweep: {
                index: bigint
                amount: bigint
                blockNumber: bigint
                txHash: string
              }) => {
                // The portal whose `Deposit` the sweep made, as the observation reads each portal's.
                for (const portal of params.portals) {
                  const key = await mocks.readDepositMessageKey(
                    client,
                    portal,
                    sweep.txHash,
                    sweep.index,
                  )
                  if (key) return { ...sweep, portal, messageKey: String(key) }
                }
                return { ...sweep, portal: params.portals[0], messageKey: "undefined" }
              },
            ),
          )
          const outflows = []
          for (const sweep of sweeps) {
            const receipt = await client
              .getTransactionReceipt?.({ hash: sweep.txHash })
              .catch(() => undefined)
            for (const log of parseEventLogs({
              abi: erc20Abi,
              eventName: "Transfer",
              logs: receipt?.logs ?? [],
            })) {
              if (log.args.from.toLowerCase() !== address.toLowerCase()) continue
              outflows.push({
                token: log.address,
                from: log.args.from,
                to: log.args.to,
                value: log.args.value,
                blockNumber: sweep.blockNumber,
                txHash: sweep.txHash,
                logIndex: 0,
              })
            }
          }
          const recoveries = (
            ((await mocks.readRecoveredEvents(client, address, subject.fromBlock, params.head)) ??
              []) as {
              token: string
              target: string
              amount: bigint
              txHash: string
            }[]
          ).map((r) => ({
            token: r.token,
            from: address,
            to: r.target,
            value: r.amount,
            txHash: r.txHash,
          }))
          const inflows = subject.inflows
            ? (
                await Promise.all(
                  params.tokens.map(async (token) =>
                    (
                      ((await mocks.readFundingTransfers(
                        client,
                        token,
                        address,
                        subject.fromBlock,
                        params.head,
                      )) ?? []) as {
                        from: string
                        amount: bigint
                        blockNumber: bigint
                        txHash: string
                      }[]
                    ).map((t) => ({
                      token,
                      from: t.from,
                      to: address,
                      value: t.amount,
                      blockNumber: t.blockNumber,
                      txHash: t.txHash,
                      logIndex: 0,
                    })),
                  ),
                )
              ).flat()
            : undefined
          out.set(address.toLowerCase(), {
            sweeps,
            outflows,
            recoveries,
            inflows,
            // As the observation does, a direct deposit's key is never read.
            balances: (subject as { direct?: boolean }).direct
              ? new Map()
              : (
                  await sdk.readSipaBalancesMany(
                    client as never,
                    [address as never],
                    params.tokens as never,
                  )
                ).get(address.toLowerCase()),
          })
        }
        return { observed: out, strays: [] }
      },
    ),
  }
})
vi.mock("../../src/core/services/deposits/sipa/sipaAddress", () => ({
  computeSIPAAddress: mocks.computeSIPAAddress,
}))
vi.mock("@oxide/oxide-lib/sipa_address.js", () => ({
  computeSIPAAddress: mocks.computeAccountSIPAAddress,
}))
vi.mock("@oxide/oxide-lib/sipa_recovery.js", () => ({
  deriveRecoveryCommitment: mocks.deriveRecoveryCommitment,
}))
vi.mock("../../src/core/services/deposits/sipa/stealth", () => ({
  computeStealthRecipientHash: mocks.computeStealthRecipientHash,
  deriveRecoveryAddress: mocks.deriveRecoveryAddress,
}))
vi.mock("@aztec-labs/aztec.js/messaging", () => ({
  isL1ToL2MessageReady: mocks.isL1ToL2MessageReady,
}))
vi.mock("@aztec-labs/foundation/eth-address", () => ({
  EthAddress: { fromString: (value: string) => ({ toString: () => value.toLowerCase() }) },
}))

import * as sdk from "@obsidion/sdk"
import { observeSipas } from "../../src/oxide/sipaObservation"
import { syncSipaDeposits, type SipaDepositSyncDeps } from "../../src/oxide/sipaClaims"
import type { SipaFundingToken } from "../../src/oxide/sipaFunding"
import type { SipaRow } from "../../src/oxide/sipaRows"
import { isStuckSweep, STUCK_SWEEP_MS } from "../../src/core/services/deposits/sipaStuck"
import {
  directDepositKey,
  isUnfundedSipaDeposit,
  sipaSweepsReceived,
} from "../../src/core/services/deposits/SIPADepositStore"

const SIPA_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address
const SIPA_B = "0xcccccccccccccccccccccccccccccccccccccccc" as Address
const SIPA_C = "0xdddddddddddddddddddddddddddddddddddddddd" as Address
/** The portal's `TX_AMOUNT_CAP()`. The funding read is mocked, so it decides sweepability itself. */
const CAP = 1_000n
/** The rollup version's blessed deposit implementation, as the factory pointer reports it. */
const IMPLEMENTATION = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address
const REGISTRATION_IMPLEMENTATION = "0x5a1e0c2f3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f" as Address
/** L1 head every run is bounded by — the block a completed scan persists. */
const HEAD = 11_390_182n
const RECIPIENT_HEX = "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456"
const TX_HASH = `0x${"ab".repeat(32)}`
/** The recovered token and where it went, as a `Recovered` log reports them. */
const TOKEN = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
const TARGET = "0x45e6000000000000000000000000000000000ed64" as Address

/** The deployment's ForwardingTable and settlement token: every fee read is a row of the one. */
const FORWARDING_TABLE = "0xfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfb" as Address
const SETTLEMENT_TOKEN = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address
const route = (intent: SipaIntent) => ({
  forwardingTable: FORWARDING_TABLE,
  token: SETTLEMENT_TOKEN,
  intent,
})

const TUPLE = {
  forwardingTable: FORWARDING_TABLE,
  token: SETTLEMENT_TOKEN,
  registry: "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f",
  sipaFactory: "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2",
  l2Token: "0x0f1c7a8b2b8a1f6de4b6a2c1c7e8d9f0a1b2c3d4e5f60718293a4b5c6d7e8f90",
  portal: "0x7992CD55908B19b60bc46926dEb9B1f1DFb6E0A9",
  rollupVersion: "4127419662",
} as unknown as OxideEnvTuple

/** Fr-like fake. `toBuffer` is a deterministic 32-byte image of the string (the derivation
 *  hashes the commitment for its intentHash; the label need not be valid hex). */
function fr(hex: string) {
  return {
    toString: () => hex,
    toBigInt: () => {
      try {
        return BigInt(hex)
      } catch {
        return 0n
      }
    },
    toBuffer: () => {
      const b = Buffer.alloc(32)
      Buffer.from(hex).copy(b, 0, 0, 32)
      return b
    },
  }
}

/** The deposit intentHash the derivation computes from a commitment: keccak256 of its 32 bytes. */
function intentHashOf(commitment: ReturnType<typeof fr>): Buffer {
  return keccak256(commitment.toBuffer())
}

function makeStore() {
  const records = new Map<string, Record<string, unknown>>()
  return {
    records,
    get: vi.fn((address: string) => records.get(address.toLowerCase()) ?? null),
    list: vi.fn(() => Array.from(records, ([sipaAddress, r]) => ({ sipaAddress, ...r }))),
    upsert: vi.fn(
      async (
        address: string,
        patch: Record<string, unknown>,
        fallback?: Record<string, unknown>,
      ) => {
        const key = address.toLowerCase()
        const existing = records.get(key)
        const next = existing ? { ...existing, ...patch } : { ...(fallback ?? {}), ...patch }
        records.set(key, next)
        return next
      },
    ),
    remove: vi.fn(async (address: string) => {
      records.delete(address.toLowerCase())
    }),
    cursor: undefined as bigint | undefined,
    observedThrough: vi.fn(async function (this: { cursor?: bigint }) {
      return this.cursor
    }),
    setObservedThrough: vi.fn(async function (
      this: { cursor?: bigint },
      _portal: string,
      _recipient: string,
      block: bigint,
    ) {
      this.cursor = block
    }),
  }
}

const DAI = {
  address: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address,
  symbol: "DAI",
  decimals: 6,
}

/** A row of the pinned table: the tuple's bridge unless overridden, accepting every intent. */
function row(token: SipaFundingToken, over: Partial<SipaRow> = {}): SipaRow {
  return {
    portal: TUPLE.portal as Address,
    l2Token: TUPLE.l2Token,
    token,
    swapped: [],
    intents: ["deposit", "registration", "metadata", "user-op"],
    ...over,
  }
}

function makeDeps(store = makeStore()) {
  const tokenService = { claimSweptDeposit: vi.fn(async () => undefined) }
  const deps = {
    publicClient: {
      getBlockNumber: vi.fn(async () => HEAD),
      getBalance: vi.fn(async () => 0n),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName !== "TX_AMOUNT_CAP") throw new Error(`unexpected read: ${functionName}`)
        return mocks.readTxAmountCap()
      }),
    } as never,
    node: {} as never,
    wallet: { getPrivateEvents: vi.fn() } as never,
    networkId: "0x00000000000000000000000000000000000000e1",
    tokenServiceFor: vi.fn(async () => tokenService),
    store,
    tuple: TUPLE,
    recipient: { toString: () => RECIPIENT_HEX } as never,
    stealthPublicKey: { x: 1n, y: 2n },
    rows: [row(DAI)],
    l1ChainId: 11155111,
  } satisfies SipaDepositSyncDeps
  return { deps, store, tokenService, token: DAI }
}

const SECRET_A = fr(`0x${"11".repeat(32)}`)
const SECRET_B = fr(`0x${"22".repeat(32)}`)
const SECRET_C = fr(`0x${"33".repeat(32)}`)

/** The commitment the mocked derivation returns for `secret`. */
function commitmentOf(secret: ReturnType<typeof fr>) {
  return fr(`0xhash${secret.toString().slice(4, 8)}`)
}

/** `SipaEvent`-shaped fake for the fetchSipaEvents mock. Plain deposits carry the deposit intentHash. */
function sipaEvent(
  secret: ReturnType<typeof fr>,
  intentHash = `0x${intentHashOf(commitmentOf(secret)).toString("hex")}`,
) {
  return { sharedSecretSalt: secret, resweepable: false, intentHash }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.computeStealthRecipientHash.mockImplementation((secret: { toString(): string }) =>
    fr(`0xhash${secret.toString().slice(4, 8)}`),
  )
  mocks.deriveRecoveryAddress.mockImplementation(() => ({
    toString: () => "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
  }))
  mocks.computeSIPAAddress.mockImplementation(() => ({ toString: () => SIPA_A }))
  mocks.isL1ToL2MessageReady.mockResolvedValue(true)
  mocks.readDepositMessageKey.mockResolvedValue(fr(`0x${"0a".repeat(32)}`))
  mocks.readDepositFee.mockResolvedValue(100n)
  mocks.readTxAmountCap.mockResolvedValue(CAP)
  mocks.readDepositSIPAImplementation.mockResolvedValue(IMPLEMENTATION)
  mocks.readRegistrationSIPAImplementation.mockResolvedValue(REGISTRATION_IMPLEMENTATION)
  // No user-op implementation blessed unless a test blesses one.
  mocks.readBlessedImplementations.mockResolvedValue([])
  // A stray's clone is a deposit SIPA unless a test says otherwise.
  mocks.readSipaIntent.mockResolvedValue(SipaIntent.Deposit)
  // No clone code at a tracked address unless a test deploys one.
  mocks.readSipaCloneImplementation.mockResolvedValue("0x0000000000000000000000000000000000000000")
  mocks.readFundingTransfers.mockResolvedValue([])
  mocks.readRecoveredEvents.mockResolvedValue([])
})

describe("syncSipaDeposits", () => {
  it("discovers an event, reads its settled Sweep, claims, and lands the record on claimed", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 1, claimed: 1, pendingSettlement: 0, failed: 0 })
    // The recipient's events are read off the manifest's L2 token.
    const [wallet, token, recipient] = mocks.fetchSipaEvents.mock.calls[0]!
    expect(wallet).toBe(deps.wallet)
    expect(token.toString()).toBe(TUPLE.l2Token)
    expect(recipient).toBe(deps.recipient)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith({
      inboxIndex: 7n,
      amount: 990_000n,
      recipient: deps.recipient,
      sharedSecretSalt: SECRET_A,
    })
    const record = store.records.get(SIPA_A)
    expect(record).toMatchObject({
      phase: "claimed",
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweeps: [{ inboxIndex: "7", sweepTxHash: TX_HASH, netAmount: "990000" }],
      netAmount: "990000",
      amount: "0.99",
      sweepTxHash: TX_HASH,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
  })

  describe("across two rows", () => {
    const SUSDS = {
      address: "0x5875eee11cf8398102fdad704c9e96607675467a" as Address,
      symbol: "sUSDS",
      decimals: 18,
    }
    const SUSDS_PORTAL = "0x5b0d0000000000000000000000000000000005d5" as Address
    const SUSDS_L2 = "0x1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff001"
    const twoRows = () => {
      const { deps, store, tokenService } = makeDeps()
      const susdsService = { claimSweptDeposit: vi.fn(async () => undefined) }
      const rows = [
        row(DAI),
        row(SUSDS, { portal: SUSDS_PORTAL, l2Token: SUSDS_L2, intents: ["deposit"] }),
      ]
      const tokenServiceFor = vi.fn(async (l2Token: string) =>
        l2Token === SUSDS_L2 ? susdsService : tokenService,
      )
      return {
        deps: { ...deps, rows, tokenServiceFor },
        store,
        daiService: tokenService,
        susdsService,
      }
    }
    // One relayer tx sweeps both rows: the DAI sweep is inbox index 7, the sUSDS one 8.
    const bothSwept = () => {
      mocks.readSweepEvents.mockResolvedValue([
        { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
        { index: 8n, amount: 4_990_000_000_000_000_000n, blockNumber: 1n, txHash: TX_HASH },
      ])
      mocks.readDepositMessageKey.mockImplementation(
        async (_client: unknown, portal: string, _tx: string, index: bigint) => {
          const own = index === 7n ? TUPLE.portal : SUSDS_PORTAL
          return portal.toLowerCase() === own.toLowerCase() ? fr(`0x${index}`) : null
        },
      )
      mocks.readDepositFee.mockImplementation(async (_client: unknown, route: { token: string }) =>
        route.token === SUSDS.address ? 10_000_000_000_000_000n : 100n,
      )
    }

    it("looks up each row's spent sweeps on that row's L2 token", async () => {
      const { deps, daiService, susdsService } = twoRows()
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      bothSwept()
      mocks.readSipaDepositsConsumed.mockImplementation(
        async (_node: unknown, scope: { l2Token: { toString(): string } }) => [
          scope.l2Token.toString().toLowerCase() === SUSDS_L2.toLowerCase(),
        ],
      )

      const result = await syncSipaDeposits({
        ...deps,
        node: { findLeavesIndexes: vi.fn() } as never,
        masterNullifierHidingKey: { secret: "nhk" } as never,
      })

      expect(mocks.readSipaDepositsConsumed).toHaveBeenCalledTimes(2)
      expect(result).toMatchObject({ claimed: 1, reconciled: 1, failed: 0 })
      expect(daiService.claimSweptDeposit).toHaveBeenCalledOnce()
      expect(susdsService.claimSweptDeposit).not.toHaveBeenCalled()
    })

    it("reads a row's history afresh while its portal has no cursor, and then moves every row's", async () => {
      const { deps, store } = twoRows()
      const cursors = new Map<string, bigint>([[TUPLE.portal.toLowerCase(), HEAD - 10n]])
      const perPortal = {
        ...store,
        observedThrough: vi.fn(async (portal: string) => cursors.get(portal.toLowerCase())),
        setObservedThrough: vi.fn(async (portal: string, _recipient: string, block: bigint) => {
          cursors.set(portal.toLowerCase(), block)
        }),
      }
      store.records.set(SIPA_A, {
        phase: "resolved",
        messageSecret: SECRET_A.toString(),
        recipientL2Address: RECIPIENT_HEX,
        startTime: 1,
        amount: "0",
        observedFrom: (HEAD - 1_000n).toString(),
      } as never)
      const historyStartBlock = vi.fn(async () => 5n)
      mocks.fetchSipaEvents.mockResolvedValue([])
      mocks.readSweepEvents.mockResolvedValue([])

      await syncSipaDeposits({ ...deps, store: perPortal as never, historyStartBlock })

      expect(historyStartBlock).toHaveBeenCalled()
      expect(cursors.get(TUPLE.portal.toLowerCase())).toBe(HEAD)
      expect(cursors.get(SUSDS_PORTAL.toLowerCase())).toBe(HEAD)
    })

    it("gives a new row's portal no cursor while its history start fails, so the next pass reads it again", async () => {
      const { deps, store } = twoRows()
      const cursors = new Map<string, bigint>([[TUPLE.portal.toLowerCase(), HEAD - 10n]])
      const perPortal = {
        ...store,
        observedThrough: vi.fn(async (portal: string) => cursors.get(portal.toLowerCase())),
        setObservedThrough: vi.fn(async (portal: string, _recipient: string, block: bigint) => {
          cursors.set(portal.toLowerCase(), block)
        }),
      }
      store.records.set(SIPA_A, {
        phase: "resolved",
        messageSecret: SECRET_A.toString(),
        recipientL2Address: RECIPIENT_HEX,
        startTime: 1,
        amount: "0",
        observedFrom: (HEAD - 1_000n).toString(),
      } as never)
      mocks.fetchSipaEvents.mockResolvedValue([])
      mocks.readSweepEvents.mockResolvedValue([])

      await syncSipaDeposits({
        ...deps,
        store: perPortal as never,
        historyStartBlock: async () => {
          throw new Error("rpc down")
        },
      })

      expect(cursors.get(TUPLE.portal.toLowerCase())).toBe(HEAD)
      expect(cursors.has(SUSDS_PORTAL.toLowerCase())).toBe(false)

      const historyStartBlock = vi.fn(async () => 5n)
      await syncSipaDeposits({ ...deps, store: perPortal as never, historyStartBlock })

      expect(historyStartBlock).toHaveBeenCalled()
      expect(cursors.get(SUSDS_PORTAL.toLowerCase())).toBe(HEAD)
    })

    it("claims each sweep of one address through its own row's token, and ledgers both", async () => {
      const { deps, store, daiService, susdsService } = twoRows()
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      bothSwept()

      const result = await syncSipaDeposits(deps)

      expect(result).toMatchObject({ discovered: 1, claimed: 2, failed: 0 })
      expect(daiService.claimSweptDeposit).toHaveBeenCalledOnce()
      expect(daiService.claimSweptDeposit).toHaveBeenCalledWith(
        expect.objectContaining({ inboxIndex: 7n, amount: 990_000n }),
      )
      expect(susdsService.claimSweptDeposit).toHaveBeenCalledOnce()
      expect(susdsService.claimSweptDeposit).toHaveBeenCalledWith(
        expect.objectContaining({ inboxIndex: 8n, amount: 4_990_000_000_000_000_000n }),
      )
      const record = store.records.get(SIPA_A)!
      expect(record.sweeps).toEqual([
        expect.objectContaining({
          inboxIndex: "7",
          portal: TUPLE.portal,
          l2Token: TUPLE.l2Token,
          tokenAddress: DAI.address,
          tokenSymbol: "DAI",
          tokenDecimals: 6,
          fee: "100",
          netAmount: "990000",
        }),
        expect.objectContaining({
          inboxIndex: "8",
          portal: SUSDS_PORTAL,
          l2Token: SUSDS_L2,
          tokenAddress: SUSDS.address,
          tokenSymbol: "sUSDS",
          tokenDecimals: 18,
          fee: "10000000000000000",
          netAmount: "4990000000000000000",
        }),
      ])
      // The record reads as its latest sweep, in that row's token and units.
      expect(record).toMatchObject({
        phase: "claimed",
        claimedInboxIndexes: ["7", "8"],
        tokenSymbol: "sUSDS",
        tokenDecimals: 18,
        amount: "4.99",
        fee: "10000000000000000",
      })
    })

    it("rebuilds both credited deposits on a fresh device from the event on either row's token", async () => {
      const { deps, store, daiService, susdsService } = twoRows()
      // A resolver broadcast notifies each row's L2 token, so both carry the one event.
      mocks.fetchSipaEvents.mockImplementation(
        async (_wallet: unknown, token: { toString(): string }) =>
          [TUPLE.l2Token, SUSDS_L2].includes(token.toString()) ? [sipaEvent(SECRET_A)] : [],
      )
      bothSwept()

      const result = await syncSipaDeposits(deps)

      expect(mocks.fetchSipaEvents.mock.calls.map(([, token]) => token.toString()).sort()).toEqual(
        [TUPLE.l2Token, SUSDS_L2].map((t) => t.toLowerCase()).sort(),
      )
      expect(result).toMatchObject({ discovered: 1, claimed: 2 })
      expect(daiService.claimSweptDeposit).toHaveBeenCalledOnce()
      expect(susdsService.claimSweptDeposit).toHaveBeenCalledOnce()
      expect(store.records.get(SIPA_A)!.sweeps!.map((s) => s.tokenSymbol)).toEqual(["DAI", "sUSDS"])
    })

    /** The sUSDS portal's cap read fails; every other read answers. */
    const susdsCapDown = (deps: SipaDepositSyncDeps) => {
      ;(deps.publicClient as { readContract: unknown }).readContract = vi.fn(
        async ({ address }: { address: string }) => {
          if (address === SUSDS_PORTAL) throw new Error("cap read down")
          return CAP
        },
      )
    }
    /** `balance` of `token` at the SIPA, nothing of the other; sweepable when it clears its fee. */
    const holds = (token: Address, balance: bigint) =>
      mocks.readSipaFundingStatus.mockImplementation(
        async (_client: unknown, p: { token: string; fee: bigint; txAmountCap: bigint }) => {
          const own = p.token === token ? balance : 0n
          return {
            balance: own,
            scaledBalance: own,
            fee: p.fee,
            sweepable: own > p.fee && own - p.fee <= p.txAmountCap,
          }
        },
      )

    it("prices a balance on its own row though another row cannot be priced", async () => {
      const { deps, store } = twoRows()
      susdsCapDown(deps)
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([])
      holds(DAI.address, 500n)

      await syncSipaDeposits(deps)

      expect(store.records.get(SIPA_A)).toMatchObject({
        phase: "sweeping",
        tokenSymbol: "DAI",
        fee: "100",
      })
    })

    it("drops a fee priced on another row when new funds sit on an unpriced row", async () => {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "claimed",
        messageSecret: SECRET_A.toString(),
        recipientL2Address: RECIPIENT_HEX,
        recipientHash: "0xset",
        recoveryAddress: "0xset",
        tokenAddress: DAI.address,
        tokenSymbol: "DAI",
        fee: "100",
        netAmount: "900",
        inboxIndex: "7",
        claimedInboxIndexes: ["7"],
        endTime: 1,
        lastScanAt: 0,
      })
      const { deps } = twoRows()
      susdsCapDown(deps)
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([])
      holds(SUSDS.address, 2n * 10n ** 18n)

      await syncSipaDeposits({ ...deps, store: store as never })

      const record = store.records.get(SIPA_A)!
      expect(record).toMatchObject({ tokenSymbol: "sUSDS", tokenDecimals: 18 })
      expect(record.fee).toBeUndefined()
    })

    it("drops a fee priced on another row when the sweep lands on a row it cannot price", async () => {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "sweeping",
        messageSecret: SECRET_A.toString(),
        recipientL2Address: RECIPIENT_HEX,
        recipientHash: "0xset",
        recoveryAddress: "0xset",
        tokenAddress: DAI.address,
        tokenSymbol: "DAI",
        fee: "100",
        amount: "1",
        lastScanAt: 0,
      })
      const { deps, susdsService } = twoRows()
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([
        { index: 8n, amount: 4_990_000_000_000_000_000n, blockNumber: 1n, txHash: TX_HASH },
      ])
      mocks.readDepositMessageKey.mockImplementation(async (_c: unknown, portal: string) =>
        portal === SUSDS_PORTAL ? fr("0x8") : null,
      )
      mocks.readDepositFee.mockImplementation(async (_c: unknown, route: { token: string }) => {
        if (route.token === SUSDS.address) throw new Error("fee read down")
        return 100n
      })

      await syncSipaDeposits({ ...deps, store: store as never })

      expect(susdsService.claimSweptDeposit).toHaveBeenCalledOnce()
      const record = store.records.get(SIPA_A)!
      expect(record).toMatchObject({ phase: "claimed", tokenSymbol: "sUSDS" })
      expect(record.fee).toBeUndefined()
      expect(record.sweeps![0]!.fee).toBeUndefined()
    })

    it("reads a SIPA whose intent no row prices, holding it unpriced", async () => {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "broadcast",
        intent: "registration",
        messageSecret: SECRET_A.toString(),
        recipientL2Address: RECIPIENT_HEX,
        recipientHash: "0xset",
        recoveryAddress: "0xset",
      })
      const { deps } = makeDeps(store)
      mocks.fetchSipaEvents.mockResolvedValue([])
      mocks.readSweepEvents.mockResolvedValue([])
      holds(DAI.address, 500n)

      const result = await syncSipaDeposits({
        ...deps,
        rows: [row(DAI, { intents: ["deposit"] })],
      })

      expect(result.failed).toBe(0)
      const record = store.records.get(SIPA_A)!
      expect(record).toMatchObject({ phase: "broadcast", tokenSymbol: "DAI" })
      expect(record.fee).toBeUndefined()
    })

    it("names the row a swapped balance settles in", async () => {
      const usdc = {
        address: "0x00000000000000000000000000000000000000c6" as Address,
        symbol: "USDC",
        decimals: 6,
      }
      const { deps, store } = makeDeps()
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([])
      holds(usdc.address, 5_000_000n)

      await syncSipaDeposits({ ...deps, rows: [row(DAI, { swapped: [usdc] })] })

      expect(store.records.get(SIPA_A)).toMatchObject({
        tokenAddress: usdc.address,
        rowToken: DAI.address,
      })
    })

    it("holds a registration's balance to the rows it settles on, so sUSDS alone does not fund it", async () => {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "broadcast",
        intent: "registration",
        messageSecret: SECRET_A.toString(),
        recipientL2Address: RECIPIENT_HEX,
        recipientHash: "0xset",
        recoveryAddress: "0xset",
      })
      const { deps } = twoRows()
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([])
      holds(SUSDS.address, 2n * 10n ** 18n)
      const balances = vi.mocked(sdk.readSipaBalancesMany)
      const original = balances.getMockImplementation()!
      balances.mockImplementation(
        async () => new Map([[SIPA_A, new Map([[SUSDS.address, 2n * 10n ** 18n]])]]),
      )

      try {
        await syncSipaDeposits({ ...deps, store: store as never })
      } finally {
        balances.mockImplementation(original)
      }

      expect(store.records.get(SIPA_A)?.heldBalance).toBe("0")
    })

    it.each([
      ["DAI first", () => [DAI.address, SUSDS.address]],
      ["sUSDS first", () => [SUSDS.address, DAI.address]],
    ])(
      "prices each sweep on its own row whichever funding is seen first (%s)",
      async (_, order) => {
        const { deps, store } = twoRows()
        const [first, second] = order()
        mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
        mocks.readDepositFee.mockImplementation(async (_c: unknown, route: { token: string }) =>
          route.token === SUSDS.address ? 260n : 250n,
        )
        // Pass 1: only the first token has arrived; the probe prices it on its row.
        mocks.readSweepEvents.mockResolvedValue([])
        holds(first!, 1000n)
        await syncSipaDeposits(deps)
        expect(store.records.get(SIPA_A)).toMatchObject({
          tokenAddress: first,
          fee: first === SUSDS.address ? "260" : "250",
        })
        // Pass 2: both swept in one tx, in either log order, while attribution names the other
        // token's transfer as the first funding.
        mocks.readFundingTransfers.mockImplementation(async (_c: unknown, token: string) =>
          token === second
            ? [
                {
                  from: "0x00000000000000000000000000000000000000f1",
                  amount: 1000n,
                  txHash: "0xf2",
                  blockNumber: 1n,
                },
              ]
            : [],
        )
        store.records.get(SIPA_A)!.fundingFromAddress = undefined
        store.records.get(SIPA_A)!.lastScanAt = 0
        const sweeps = [
          { index: 7n, amount: 750n, blockNumber: 2n, txHash: TX_HASH },
          { index: 8n, amount: 740n, blockNumber: 2n, txHash: TX_HASH },
        ]
        mocks.readSweepEvents.mockResolvedValue(first === DAI.address ? sweeps : sweeps.reverse())
        mocks.readDepositMessageKey.mockImplementation(
          async (_c: unknown, portal: string, _tx: string, index: bigint) =>
            (index === 7n) === (portal.toLowerCase() === TUPLE.portal.toLowerCase())
              ? fr(`0x${index}`)
              : null,
        )
        await syncSipaDeposits(deps)

        const record = store.records.get(SIPA_A)!
        const fees = Object.fromEntries(record.sweeps!.map((s) => [s.tokenSymbol, s.fee]))
        expect(fees).toEqual({ DAI: "250", sUSDS: "260" })
        const latest = record.sweeps!.find((s) => s.inboxIndex === record.inboxIndex)!
        expect(record.fee).toBe(latest.fee)
      },
    )

    it("prices an unswept SIPA on the row of the token it holds", async () => {
      const { deps, store } = twoRows()
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([])
      mocks.readDepositFee.mockImplementation(async (_client: unknown, route: { token: string }) =>
        route.token === SUSDS.address ? 10_000_000_000_000_000n : 100n,
      )
      mocks.readSipaFundingStatus.mockImplementation(
        async (_client: unknown, p: { token: string; fee: bigint }) => {
          const balance = p.token === SUSDS.address ? 2n * 10n ** 18n : 0n
          return { balance, scaledBalance: balance, fee: p.fee, sweepable: balance > p.fee }
        },
      )

      await syncSipaDeposits(deps)

      expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ token: SUSDS.address, fee: 10_000_000_000_000_000n }),
      )
      expect(store.records.get(SIPA_A)).toMatchObject({
        phase: "sweeping",
        tokenSymbol: "sUSDS",
        tokenDecimals: 18,
        amount: "2",
        fee: "10000000000000000",
      })
      // Each row's portal cap is read once.
      expect(mocks.readTxAmountCap).toHaveBeenCalledTimes(2)
    })
  })

  /** A receipt in which the sweep moved `value` of `token` off the SIPA. */
  const sweepReceipt = (token: Address, value: bigint) => ({
    logs: [
      {
        address: token,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
        }),
        data: pad(toHex(value)),
      },
    ],
  })

  it("ledgers a claimed sweep with what its receipt took off the SIPA, dated at its block", async () => {
    const { deps, store } = makeDeps()
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async () => sweepReceipt(DAI.address, 1_000_140n),
    )
    mocks.readBlockTimeMs.mockResolvedValue(1_700_000_000_000)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 1_000_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      sweeps: [
        {
          inboxIndex: "7",
          sweepTxHash: TX_HASH,
          settledAt: 1_700_000_000_000,
          netAmount: "1000000",
          grossAmount: "1000140",
          fundingTokenSymbol: "DAI",
          fundingTokenDecimals: 6,
        },
      ],
    })
  })

  it("a failed receipt read with one accepted token still claims, leaving the gross unknown", async () => {
    const { deps, store } = makeDeps()
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async () => {
        throw new Error("rpc down")
      },
    )
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 1_000_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 0 })
    const [entry] = store.records.get(SIPA_A)!.sweeps as Record<string, unknown>[]
    expect(entry).toMatchObject({ inboxIndex: "7", netAmount: "1000000" })
    expect(entry!.grossAmount).toBeUndefined()
  })

  it("ledgers the sweeps of a record claimed before the ledger existed, scanning from the history start whatever earlier scans covered", async () => {
    const START = HEAD - 400_000n
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      inboxIndex: "9",
      claimedInboxIndexes: ["7", "9"],
      netAmount: "4000000",
      sweepTxHash: "0xsweep9",
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: (HEAD - 10n).toString(),
      historyScanned: true,
      lastScanAt: 0,
    })
    const { deps, tokenService } = makeDeps(store)
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async ({ hash }: { hash: string }) =>
        sweepReceipt(DAI.address, hash === "0xsweep7" ? 1_000_140n : 4_000_140n),
    )
    mocks.readBlockTimeMs.mockImplementation(async (_client: unknown, block: bigint) =>
      block === START + 5n ? 1_700_000_000_000 : 1_700_000_500_000,
    )
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 1_000_000n, blockNumber: START + 5n, txHash: "0xsweep7" },
      { index: 9n, amount: 4_000_000n, blockNumber: START + 50n, txHash: "0xsweep9" },
    ])

    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    expect(mocks.readSweepEvents.mock.calls[0]![2]).toBe(START)
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
      netAmount: "4000000",
      sweeps: [
        {
          inboxIndex: "7",
          sweepTxHash: "0xsweep7",
          settledAt: 1_700_000_000_000,
          netAmount: "1000000",
          grossAmount: "1000140",
        },
        {
          inboxIndex: "9",
          sweepTxHash: "0xsweep9",
          settledAt: 1_700_000_500_000,
          netAmount: "4000000",
          grossAmount: "4000140",
        },
      ],
    })

    // Ledgered: the next scan resumes at the cursor.
    store.records.get(SIPA_A)!.lastScanAt = 0
    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })
    expect(mocks.readSweepEvents.mock.calls[1]![2]).toBeGreaterThan(START)
  })

  it("marks an unsettled sweep pendingClaim and does not claim yet", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValue(false)

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 0, pendingSettlement: 1 })
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "7",
      netAmount: "990000",
      amount: "0.99",
    })
  })

  it("skips inbox indexes already claimed; a NEW sweep on the same SIPA claims independently", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result.claimed).toBe(1)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 9n }),
    )
    expect(store.records.get(SIPA_A)).toMatchObject({ claimedInboxIndexes: ["7", "9"] })
  })

  it("prices a claimed record whose fee never landed, and reads nothing once it has", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      netAmount: "990000",
      amount: "0.99",
      startTime: Date.now() - 86_400_000,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", fee: "100" })

    // Off the slow lane's near side, so the second pass scans rather than skips.
    store.records.get(SIPA_A)!.lastScanAt = Date.now() - 6 * 60_000
    mocks.readDepositFee.mockClear()

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).not.toHaveBeenCalled()
  })

  it("backfills a fee the claiming pass lost on a later tick that reads no sweep", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 1_000n, txHash: TX_HASH },
    ])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
    mocks.readDepositFee.mockRejectedValueOnce(new Error("temporary RPC failure"))

    await syncSipaDeposits(deps)

    const claimed = store.records.get(SIPA_A)!
    expect(claimed).toMatchObject({ phase: "claimed", observedFrom: HEAD.toString() })
    expect(claimed.fee).toBeUndefined()

    // The cursor sits past the sweep: nothing in this window carries the fee, so only the
    // per-pass backfill can land it.
    mocks.readSweepEvents.mockResolvedValue([])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", fee: "100" })
  })

  it("flips a funding outside the sweep window to recoverable at either end; in-window stays sweeping", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_B),
      sipaEvent(SECRET_C),
    ])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_C }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus
      .mockResolvedValueOnce({
        balance: 50n,
        scaledBalance: 50n,
        fee: 100n,
        sweepable: false,
      })
      .mockResolvedValueOnce({
        balance: 500n,
        scaledBalance: 500n,
        fee: 100n,
        sweepable: true,
      })
      // Past the window's top: the credited amount is `balance − fee`, so the ceiling sits the fee
      // above `CAP`.
      .mockResolvedValueOnce({
        balance: CAP + 101n,
        scaledBalance: CAP + 101n,
        fee: 100n,
        sweepable: false,
      })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 3, recoverable: 2 })
    // The fee lands on every funding write.
    expect(store.records.get(SIPA_B)).toMatchObject({ fee: "100" })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable" })
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "sweeping" })
    expect(store.records.get(SIPA_C)).toMatchObject({ phase: "recoverable" })
  })

  it.each([0n, 1n, 10n ** 24n])(
    "finds sweepable USDC despite an unsweepable DAI balance of %s",
    async (daiBalance) => {
      const { deps, store } = makeDeps()
      const usdc = {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
        symbol: "USDC",
        decimals: 6,
      }
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([])
      mocks.readSipaFundingStatus
        .mockResolvedValueOnce({
          balance: daiBalance,
          scaledBalance: daiBalance,
          fee: 100n,
          sweepable: false,
        })
        .mockResolvedValueOnce({
          balance: 5_000_000n,
          scaledBalance: 5_000_000n * 10n ** 12n,
          fee: 100n,
          sweepable: true,
        })
      mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) =>
        token === usdc.address
          ? [{ from: "0xfeed", amount: 5_000_000n, blockNumber: 5n, txHash: "0xtx" }]
          : [],
      )

      const result = await syncSipaDeposits({
        ...deps,
        rows: [row({ ...DAI, decimals: 18 }, { swapped: [usdc] })],
      })

      expect(result).toMatchObject({ discovered: 1, active: 1 })
      expect(mocks.readSipaFundingStatus).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ token: usdc.address, balanceScale: 10n ** 12n }),
      )
      expect(store.records.get(SIPA_A)).toMatchObject({
        phase: "sweeping",
        amount: "5",
        tokenAddress: usdc.address,
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        fundingTxHash: "0xtx",
      })
    },
  )

  it("hands each funding read its batched balance and leaves a token the batch missed to its own read", async () => {
    const { deps } = makeDeps()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
    vi.mocked(sdk.readSipaBalancesMany).mockResolvedValueOnce(
      new Map([[SIPA_A, new Map([[DAI.address, 700n]])]]),
    )

    await syncSipaDeposits({
      ...deps,
      rows: [row({ ...DAI, decimals: 18 }, { swapped: [usdc] })],
    })

    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: DAI.address, balance: 700n }),
    )
    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: usdc.address, balance: undefined }),
    )
  })

  it("isolates a record whose stored secret does not parse", async () => {
    const store = makeStore()
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: "not-a-field",
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
  })

  it("targets the largest normalized balance for recovery when no token is sweepable", async () => {
    const { deps, store } = makeDeps()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus
      .mockResolvedValueOnce({
        balance: 10n ** 12n,
        scaledBalance: 10n ** 12n,
        fee: 10n ** 18n,
        sweepable: false,
      })
      .mockResolvedValueOnce({
        balance: 500_000n,
        scaledBalance: 500_000n * 10n ** 12n,
        fee: 10n ** 18n,
        sweepable: false,
      })

    await syncSipaDeposits({
      ...deps,
      rows: [row({ ...DAI, decimals: 18 }, { swapped: [usdc] })],
    })

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recoverable",
      amount: "0.5",
      tokenAddress: usdc.address,
      tokenSymbol: "USDC",
    })
  })

  it.each([true, false])(
    "preserves credited metadata after delayed attribution (settled: %s)",
    async (settled) => {
      const { deps, store } = makeDeps()
      const usdc = {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
        symbol: "USDC",
        decimals: 6,
      }
      const syncDeps = {
        ...deps,
        rows: [row({ ...DAI, decimals: 18 }, { swapped: [usdc] })],
      }
      ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
        async () => ({
          logs: [
            {
              address: usdc.address,
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
              }),
              data: pad(toHex(5_000_000n)),
            },
          ],
        }),
      )
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([
        { index: 7n, amount: 4n * 10n ** 18n, blockNumber: HEAD, txHash: TX_HASH },
      ])
      mocks.isL1ToL2MessageReady.mockResolvedValue(settled)
      // The funding transfer is not visible yet on the first pass.
      mocks.readFundingTransfers.mockResolvedValue([])
      await syncSipaDeposits(syncDeps)
      mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) =>
        token === usdc.address
          ? [{ from: "0xfeed", amount: 5_000_000n, blockNumber: HEAD, txHash: "0xfund" }]
          : [],
      )

      await syncSipaDeposits(syncDeps)

      expect(store.records.get(SIPA_A)).toMatchObject({
        phase: settled ? "claimed" : "pendingClaim",
        amount: "4",
        tokenAddress: DAI.address,
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        fundingTxHash: "0xfund",
        fundingFromAddress: "0xfeed",
        fundingTokenSymbol: "USDC",
      })
    },
  )

  it("names the token a sweep took from a re-used address, over its first funding's", async () => {
    const store = makeStore()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    // Funded in USDC once, swept and claimed; then funded again in DAI and swept before any tick.
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      netAmount: "990000",
      amount: "0.99",
      fundingTxHash: "0xusdc",
      fundingFromAddress: "0xfeed",
      fundingTokenSymbol: "USDC",
      startTime: Date.now() - 86_400_000,
      lastScanAt: 0,
    })
    const { deps } = makeDeps(store)
    const getTransactionReceipt = vi.fn(async () => ({
      logs: [
        {
          address: DAI.address,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
          }),
          data: pad(toHex(4n * 10n ** 18n)),
        },
      ],
    }))
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt =
      getTransactionReceipt
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 8n, amount: 4n * 10n ** 18n, blockNumber: HEAD, txHash: "0xresweep" },
    ])
    const syncDeps = {
      ...deps,
      rows: [row({ ...DAI, decimals: 18 }, { swapped: [usdc] })],
    }

    await syncSipaDeposits(syncDeps)

    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: "0xresweep" })
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "8"],
      sweepTxHash: "0xresweep",
      tokenSymbol: "DAI",
      fundingTokenSymbol: "DAI",
    })

    // A batched tx that moved two accepted tokens out of the SIPA names neither.
    getTransactionReceipt.mockResolvedValueOnce({
      logs: [usdc.address, DAI.address].map((address) => ({
        address,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
        }),
        data: pad(toHex(1n)),
      })),
    })
    mocks.readSweepEvents.mockResolvedValue([
      { index: 9n, amount: 1n, blockNumber: HEAD, txHash: "0xbatch" },
    ])
    store.records.get(SIPA_A)!.lastScanAt = 0
    await syncSipaDeposits(syncDeps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      claimedInboxIndexes: ["7", "8", "9"],
      sweepTxHash: "0xbatch",
      fundingTokenSymbol: "DAI",
    })
  })

  it("stamps the larger of the deposit fee and the seeded registration fee", async () => {
    const store = makeStore()
    const pinned = (secret: ReturnType<typeof fr>, registrationFee: string) => ({
      phase: "broadcast",
      intent: "registration",
      registrationFee,
      messageSecret: secret.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    store.records.set(SIPA_A, pinned(SECRET_A, "140"))
    store.records.set(SIPA_B, pinned(SECRET_B, "0"))
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping", fee: "140" })
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "sweeping", fee: "100" })
    expect(mocks.readTxAmountCap).toHaveBeenCalledTimes(1)
  })

  it("prices a registration SIPA's floor off the routed schedule fee, not the implementation's", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: "140",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 140n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fee: 140n, txAmountCap: CAP }),
    )
  })

  it.each([
    ["short of the schedule minimum", 200n, "recoverable"],
    ["at the registration floor", 340n, "sweeping"],
  ])("holds a registration deposit %s", async (_case, balance, phase) => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: "140",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    // fee 140 + min 200 = 340: what `RegistrationController._checkPayment` takes.
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      registrationScheduleFor: () => ({ min: 200n, fee: 140n }),
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance,
      scaledBalance: balance,
      fee: 140n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase })
  })

  it("leaves a plain deposit's window at the fee", async () => {
    const store = makeStore()
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      registrationScheduleFor: () => ({ min: 10_000n, fee: 10_000n }),
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
  })

  it("records a funded SIPA's amount but holds its phase when the fee read fails", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readDepositFee.mockRejectedValue(new Error("temporary RPC failure"))
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 0n,
      sweepable: true,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 1, failed: 0 })
    const record = store.records.get(SIPA_A)!
    // An unread fee prices the window at zero, under which dust reads as sweepable.
    expect(record).toMatchObject({ phase: "broadcast", amount: "0.0005" })
    expect(record.fee).toBeUndefined()
  })

  it("holds a funded SIPA's phase when the cap read fails, and rereads the cap next run", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readTxAmountCap.mockRejectedValueOnce(new Error("temporary RPC failure"))
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    const record = store.records.get(SIPA_A)!
    expect(record).toMatchObject({ phase: "broadcast", amount: "0.0005" })
    expect(record.fee).toBeUndefined()

    record.lastScanAt = Date.now() - 6 * 60_000
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readTxAmountCap).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping", fee: "100" })
  })

  it("holds a registration SIPA's phase while its own schedule is not in hand", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "recoverable",
      intent: "registration",
      registrationFee: "140",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      // Ours, but the terms that price its floor are missing or name another fee.
      registrationScheduleFor: () => null,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 140n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable", amount: "0.0005" })
  })

  it("recovers a registration SIPA no schedule can ever sweep", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: "140",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      // Ours, and closed: the claim cannot be re-issued at the fee its address commits to.
      registrationScheduleFor: () => "unsweepable",
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 140n,
      sweepable: true,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ recoverable: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable", amount: "0.0005" })
  })

  it("classifies a SIPA this wallet never registered on the fee alone", async () => {
    const store = makeStore()
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      registrationScheduleFor: () => undefined,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
  })

  it("claims a swept deposit even when the fee read fails", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    mocks.readDepositFee.mockRejectedValue(new Error("temporary RPC failure"))

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    const record = store.records.get(SIPA_A)!
    expect(record).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["7"] })
    expect(record.fee).toBeUndefined()
  })

  it("retries a rejected fee read for the next event in the same pass", async () => {
    const store = makeStore()
    const pinned = (secret: ReturnType<typeof fr>) => ({
      phase: "broadcast",
      messageSecret: secret.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    store.records.set(SIPA_A, pinned(SECRET_A))
    store.records.set(SIPA_B, pinned(SECRET_B))
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readDepositFee
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValue(100n)
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_A)!.fee).toBeUndefined()
    expect(store.records.get(SIPA_B)).toMatchObject({ fee: "100" })
  })

  it("settles a recoverable SIPA emptied without a Sweep as recovered", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, { phase: "recoverable", startTime: 1, amount: "0.4" })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    // `recoverERC20` is the only thing that empties a SIPA silently, but which transaction did it
    // is not knowable from here.
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recovered" })
    expect(store.records.get(SIPA_A)).not.toHaveProperty("recoveryTxHash")
  })

  it("marks an unswept SIPA holding only ETH recoverable in ETH", async () => {
    const store = makeStore()
    // A token fee priced on an earlier pass must not price the ETH.
    store.records.set(SIPA_A, { phase: "broadcast", startTime: 1, amount: "0", fee: "140" })
    const { deps } = makeDeps(store)
    ;(deps.publicClient.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 16n)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    expect(await syncSipaDeposits(deps)).toMatchObject({ recoverable: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recoverable",
      amount: "0.01",
      tokenAddress: "0x0000000000000000000000000000000000000000",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
    })
    expect(store.records.get(SIPA_A)?.fee).toBeUndefined()
  })

  it("never turns a claimed deposit holding leftover ETH into an ETH recovery", async () => {
    const store = makeStore()
    const claimed = {
      phase: "claimed" as const,
      startTime: 1,
      amount: "14.75",
      netAmount: "14750000000000000000",
      fee: "250000000000000000",
      tokenSymbol: "DAI",
      sweepTxHash: TX_HASH,
      inboxIndex: "4",
      claimedInboxIndexes: ["4"],
    }
    store.records.set(SIPA_A, claimed)
    const { deps } = makeDeps(store)
    // ETH sent before the sweep deployed the SIPA stays there; the sweep sits outside this window.
    ;(deps.publicClient.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 16n)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject(claimed)
  })

  it("settles a SIPA with a Recovered log as recovered, stamping its tx", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, { phase: "sweeping", startTime: 1, amount: "15" })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
    mocks.readRecoveredEvents.mockResolvedValue([
      { token: TOKEN, target: TARGET, amount: 15_000_000n, blockNumber: 9n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: TX_HASH,
    })
  })

  it("leaves an empty SIPA alone unless it was recoverable and nothing was ever claimed off it", async () => {
    const store = makeStore()
    // A `sweeping` zero balance is funds that never arrived, not funds pulled back out.
    store.records.set(SIPA_A, { phase: "sweeping", startTime: 1 })
    // A claim off this SIPA explains the empty balance without any recovery.
    store.records.set(SIPA_B, { phase: "recoverable", startTime: 1, claimedInboxIndexes: ["4"] })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "recoverable" })
  })

  it("does not clobber a recovery that landed while the funding read was in flight", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, { phase: "sweeping", startTime: 1 })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockImplementation(async () => {
      // `runSipaRecovery` settling the record inside the awaits this write straddles.
      await store.upsert(SIPA_A, { phase: "recovered", recoveryTxHash: TX_HASH })
      return { balance: 0n, scaledBalance: 0n, fee: 100n, sweepable: false }
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: TX_HASH,
    })
  })

  it("processes duplicate secrets once and isolates per-event failures", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_B),
    ])
    // SECRET_A resolves to commitment `0xhash1111` (the stealth-hash mock), so its deposit
    // intentHash is what maps to SIPA_A; every other event is SIPA_B.
    const intentHashA = intentHashOf(fr("0xhash1111"))
    mocks.computeSIPAAddress.mockImplementation((inputs: { intentHash: Buffer }) =>
      inputs.intentHash.equals(intentHashA)
        ? { toString: () => SIPA_A }
        : { toString: () => SIPA_B },
    )
    mocks.readSweepEvents.mockImplementation(async (_client: never, sipa: string) => [
      { index: sipa === SIPA_A ? 1n : 3n, amount: 100_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    tokenService.claimSweptDeposit.mockImplementation(
      async ({ inboxIndex }: { inboxIndex: bigint }) => {
        if (inboxIndex === 1n) throw new Error("pxe hiccup")
      },
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 2, claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "claimed" })
  })

  it("reports progress over the pass's unique items, failed ones included", async () => {
    const { deps, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_B),
    ])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 3n, amount: 100_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    tokenService.claimSweptDeposit.mockRejectedValueOnce(new Error("pxe hiccup"))
    const progress: [number, number][] = []
    await syncSipaDeposits({ ...deps, onProgress: (done, total) => progress.push([done, total]) })
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })

  it("backfills empty discovery-derived fields on an existing self-initiated record", async () => {
    const store = makeStore()
    // Self-initiated create: record exists before discovery, derived fields empty.
    store.records.set(SIPA_A, {
      phase: "funded",
      messageSecret: "",
      recipientHash: "",
      recoveryAddress: "",
      amount: "1.0",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "funded",
      messageSecret: SECRET_A.toString(),
      recipientHash: `0xhash1111`,
      recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
      amount: "1.0",
    })
  })

  it("never overwrites non-empty derived fields; patches only the empty ones", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "funded",
      messageSecret: "",
      recipientHash: "0xexistinghash",
      recoveryAddress: "0xexistingrecovery",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      messageSecret: SECRET_A.toString(),
      recipientHash: "0xexistinghash",
      recoveryAddress: "0xexistingrecovery",
    })
  })

  it("leaves a fully-populated existing record untouched by the backfill", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: "0xoldsecret",
      recipientHash: "0xoldhash",
      recoveryAddress: "0xoldrecovery",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.upsert).not.toHaveBeenCalledWith(
      SIPA_A,
      expect.objectContaining({ messageSecret: expect.anything() }),
      expect.anything(),
    )
    expect(store.records.get(SIPA_A)).toMatchObject({
      messageSecret: "0xoldsecret",
      recipientHash: "0xoldhash",
      recoveryAddress: "0xoldrecovery",
    })
  })

  it("fails fast on a staging-shaped tuple (no SIPA surface)", async () => {
    const { deps } = makeDeps()
    const tuple = { ...TUPLE, sipaFactory: undefined } as unknown as OxideEnvTuple
    await expect(syncSipaDeposits({ ...deps, tuple })).rejects.toThrow(/SIPA surface/)
  })

  it("reconciles a deposit the PXE already holds instead of wedging the SIPA's later sweeps", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    // index 7 was claimed before the store write landed (crash) — the
    // contract rejects the retry; index 9 must still claim.
    tokenService.claimSweptDeposit
      .mockRejectedValueOnce(new Error("Assertion failed: deposit already stored"))
      .mockResolvedValueOnce(undefined)

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ reconciled: 1, claimed: 1, failed: 0 })
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
    })
  })

  it("isolates a failing sweep so the SIPA's other sweeps still claim", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    // index 7's claim fails this run; 9 claims.
    tokenService.claimSweptDeposit.mockImplementation(
      async ({ inboxIndex }: { inboxIndex: bigint }) => {
        if (inboxIndex === 7n) throw new Error("pxe hiccup")
      },
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_A)).toMatchObject({ claimedInboxIndexes: ["9"] })
  })
})

/**
 * The resumable cursor and the slow lane, plus the cases where holding either back is
 * what keeps a deposit claimable.
 */
describe("syncSipaDeposits self-initiated records", () => {
  it("claims a record with no event at its recorded address", async () => {
    const store = makeStore()
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: `0x${"22".repeat(32)}`,
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 3n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(mocks.readSweepEvents.mock.calls[0][1]).toBe(SIPA_B)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_B)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["3"],
    })
  })

  it("skips another recipient's record, and watches a settled one without claiming", async () => {
    const store = makeStore()
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: `0x${"22".repeat(32)}`,
      recipientL2Address: "0x9999999999999999999999999999999999999999999999999999999999999999",
    })
    store.records.set(SIPA_C, {
      phase: "claimed",
      messageSecret: `0x${"13".repeat(32)}`,
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
    mocks.fetchSipaEvents.mockResolvedValue([])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 0, failed: 0 })
    expect(mocks.readSweepEvents.mock.calls.map((c) => c[1])).toEqual([SIPA_C])
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
  })

  it("derives a registration event's address from its intentHash on the registration implementation and marks the record", async () => {
    const { deps, store, tokenService } = makeDeps()
    const registrationHash = `0x${"77".repeat(32)}`
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, registrationHash)])
    mocks.computeSIPAAddress.mockImplementation(
      (inputs: { implementation: { toString(): string }; intentHash: Buffer }) =>
        inputs.implementation.toString() === REGISTRATION_IMPLEMENTATION &&
        inputs.intentHash.equals(Buffer.from("77".repeat(32), "hex"))
          ? { toString: () => SIPA_C }
          : { toString: () => SIPA_A },
    )
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_C ? [{ index: 9n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toMatchObject({
      phase: "claimed",
      intent: "registration",
      claimedInboxIndexes: ["9"],
    })
    expect(store.records.get(SIPA_A)).toBeUndefined()
  })

  it("takes a pinned record's missing intent from its event: registration pricing, and backfills it", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "broadcast",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_C, `0x${"77".repeat(32)}`)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledWith(
      expect.objectContaining({ getBlockNumber: deps.publicClient.getBlockNumber }),
      route(SipaIntent.Registration),
    )
    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ getBlockNumber: deps.publicClient.getBlockNumber }),
      expect.objectContaining({ sipa: SIPA_C }),
    )
    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration" })
  })

  it("prices a registration event's funding probe off the registration implementation", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, `0x${"77".repeat(32)}`)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledWith(
      expect.objectContaining({ getBlockNumber: deps.publicClient.getBlockNumber }),
      route(SipaIntent.Registration),
    )
  })

  it("claims an event whose salt matches a local record at the recorded address, not the derived one", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "broadcast",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_C)])
    // The deposit-intent derivation points elsewhere; the recorded address must win.
    mocks.computeSIPAAddress.mockImplementation(() => ({ toString: () => SIPA_A }))
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_C ? [{ index: 5n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["5"],
    })
    expect(store.records.get(SIPA_A)).toBeUndefined()
  })

  it("scans every record sharing a salt: a restarted registration's replacement claims its own sweep", async () => {
    const store = makeStore()
    // Listed newest first: the replacement, then the recovered original it restarted from.
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
      intent: "registration",
      startTime: 2,
    })
    store.records.set(SIPA_A, {
      phase: "recovered",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
      intent: "registration",
      recoveryTxHash: TX_HASH,
      startTime: 1,
    })
    const { deps, tokenService } = makeDeps(store)
    // Both broadcasts share the salt; only their intents differ.
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_C, `0x${"0a".repeat(32)}`),
      sipaEvent(SECRET_C, `0x${"0b".repeat(32)}`),
    ])
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_B ? [{ index: 8n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    // The pinned addresses decide which records sync; the derivation only tags a record's origin.
    expect([...store.records.keys()].sort()).toEqual([SIPA_A, SIPA_B].sort())
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_B)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["8"],
    })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recovered", recoveryTxHash: TX_HASH })
  })

  it("scans two unsettled records sharing a salt when neither has an event", async () => {
    const store = makeStore()
    for (const sipa of [SIPA_B, SIPA_C]) {
      store.records.set(sipa, {
        phase: "broadcast",
        messageSecret: SECRET_B.toString(),
        recipientL2Address: RECIPIENT_HEX,
        startTime: 1,
        amount: "0",
      })
    }
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_C ? [{ index: 9n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(mocks.readSweepEvents.mock.calls.map((c) => c[1])).toEqual([SIPA_B, SIPA_C])
    // One observation for both.
    expect(vi.mocked(observeSipas)).toHaveBeenCalledOnce()
    expect(vi.mocked(observeSipas).mock.calls[0]![1].subjects.map((s) => s.address)).toEqual([
      SIPA_B,
      SIPA_C,
    ])
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toMatchObject({ phase: "claimed" })
  })
})

describe("syncSipaDeposits observation windows", () => {
  const START = HEAD - 400_000n
  /** The [fromBlock, toBlock] of every per-SIPA sweep read the observation made. */
  const scanRanges = () => mocks.readSweepEvents.mock.calls.map((c) => [c[2], c[3]])
  const empty = {
    balance: 0n,
    scaledBalance: 0n,
    fee: 100n,
    sweepable: false,
  }
  /** Sweep reader that honors the requested range. */
  const rangeSweeps =
    (sweeps: { block: bigint; index: bigint }[]) =>
    async (_client: unknown, _sipa: string, from: bigint, to: bigint) =>
      sweeps
        .filter((s) => s.block >= from && s.block <= to)
        .map((s) => ({ index: s.index, amount: 990_000n, blockNumber: s.block, txHash: TX_HASH }))

  it("reads a new SIPA's whole history, then only the blocks since the deployment's cursor", async () => {
    const { deps, store } = makeDeps()
    const historyStartBlock = vi.fn(async () => START)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({ ...deps, historyStartBlock })
    expect(store.records.get(SIPA_A)).toMatchObject({ observedFrom: HEAD.toString() })
    expect(store.cursor).toBe(HEAD)
    await syncSipaDeposits({ ...deps, historyStartBlock })

    expect(scanRanges()).toEqual([
      [START, HEAD],
      [HEAD - 128n, HEAD],
    ])
    expect(historyStartBlock).toHaveBeenCalledTimes(1)
  })

  it("takes the default look-back for a new SIPA when the history start cannot be read", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({
      ...deps,
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    expect(scanRanges()).toEqual([[HEAD - 50_000n, HEAD]])
    // A partial read marks nothing read: the next pass tries the history again.
    expect(store.records.get(SIPA_A)?.observedFrom).toBeUndefined()
  })

  it("observes the other SIPAs when one window fails, and leaves the failed one its window", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: SECRET_B.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
      observedFrom: (HEAD - 1_000n).toString(),
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD, txHash: TX_HASH },
    ])
    const real = vi.mocked(observeSipas).getMockImplementation()!
    vi.mocked(observeSipas).mockImplementationOnce(async (client, params) => {
      const result = await real(client, params)
      result.observed.delete(SIPA_B.toLowerCase())
      return result
    })

    const result = await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_B)).toMatchObject({ rescanFrom: (HEAD - 1n - 128n).toString() })
    expect(store.cursor).toBe(HEAD)
  })

  it("finds a deposit swept long before the cursor on a fresh device", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(rangeSweeps([{ block: HEAD - 300_000n, index: 7n }]))

    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", amount: "0.99" })
  })

  it("reads a record added after the cursor from the start, beside one that rides the cursor", async () => {
    const store = makeStore()
    store.cursor = HEAD - 10n
    store.records.set(SIPA_B, {
      phase: "claimed",
      messageSecret: SECRET_B.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "1",
      observedFrom: (HEAD - 1_000n).toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    const ranges = new Map(mocks.readSweepEvents.mock.calls.map((c) => [c[1], [c[2], c[3]]]))
    expect(ranges.get(SIPA_A)).toEqual([START, HEAD])
    expect(ranges.get(SIPA_B)).toEqual([HEAD - 10n - 128n, HEAD])
  })

  it("watches a settled SIPA every pass, so a second payment is seen at once", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0.99",
      fee: "140",
      observedFrom: (HEAD - 1_000n).toString(),
      sweeps: [{ inboxIndex: "7", sweepTxHash: TX_HASH, netAmount: "990000" }],
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 8n, amount: 500_000n, blockNumber: HEAD, txHash: "0xresweep" },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 8n }),
    )
    expect(store.records.get(SIPA_A)).toMatchObject({ claimedInboxIndexes: ["7", "8"] })
  })

  it("writes nothing for a quiet settled SIPA", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0.99",
      fee: "140",
      inboxIndex: "7",
      sweepTxHash: TX_HASH,
      observedFrom: (HEAD - 1_000n).toString(),
      sweeps: [{ inboxIndex: "7", sweepTxHash: TX_HASH, netAmount: "990000" }],
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
    // The first pass backfills what discovery derives; the next has nothing to write.
    await syncSipaDeposits(deps)
    store.upsert.mockClear()

    await syncSipaDeposits(deps)

    expect(store.upsert).not.toHaveBeenCalled()
    expect(store.cursor).toBe(HEAD)
  })

  it("keeps an unsettled sweep's claim inputs, and claims it on a later pass that no longer sees it", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValueOnce([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5_000n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValueOnce(false)

    await syncSipaDeposits(deps)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      pendingSweeps: [
        {
          inboxIndex: "7",
          amount: "990000",
          messageKey: `0x${"0a".repeat(32)}`,
          blockNumber: (HEAD - 5_000n).toString(),
          sweepTxHash: TX_HASH,
        },
      ],
    })

    mocks.readSweepEvents.mockResolvedValue([])
    mocks.isL1ToL2MessageReady.mockResolvedValue(true)
    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      sweeps: [expect.objectContaining({ inboxIndex: "7", messageKey: `0x${"0a".repeat(32)}` })],
    })
    expect(store.records.get(SIPA_A)?.pendingSweeps).toBeUndefined()
  })

  it("claims a pending sweep at the fee saved for it, though the row was repriced since", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValueOnce([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5_000n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValueOnce(false)

    await syncSipaDeposits(deps)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "pendingClaim", fee: "100" })

    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readDepositFee.mockResolvedValue(250n)
    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      fee: "100",
      sweeps: [expect.objectContaining({ inboxIndex: "7", fee: "100" })],
    })
  })

  it("processes a sweep that is both observed and pending once", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "pendingClaim",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0.99",
      observedFrom: (HEAD - 1_000n).toString(),
      pendingSweeps: [
        {
          inboxIndex: "7",
          amount: "990000",
          messageKey: `0x${"0a".repeat(32)}`,
          blockNumber: (HEAD - 10n).toString(),
          sweepTxHash: TX_HASH,
        },
      ],
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 10n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
  })

  it("keeps a sweep whose claim failed for the next pass", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])
    tokenService.claimSweptDeposit.mockRejectedValueOnce(new Error("pxe busy"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 0, failed: 1 })
    expect(store.records.get(SIPA_A)?.pendingSweeps).toEqual([
      expect.objectContaining({ inboxIndex: "7" }),
    ])
  })

  it("re-reads a SIPA from the window a failed pass missed, while the cursor moves on", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
      observedFrom: (HEAD - 1_000n).toString(),
      rescanFrom: (HEAD - 600n).toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits(deps)

    // The saved bound already holds the overlap.
    expect(scanRanges()).toEqual([[HEAD - 600n, HEAD]])
    expect(store.records.get(SIPA_A)?.rescanFrom).toBeUndefined()
  })

  it("leaves a SIPA whose scan threw to re-read from its window", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
      observedFrom: (HEAD - 1_000n).toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockRejectedValue(new Error("rpc down"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({ rescanFrom: (HEAD - 1n - 128n).toString() })
    expect(store.cursor).toBe(HEAD)
  })

  const observedRecord = (fields: Record<string, unknown> = {}) => ({
    phase: "broadcast",
    messageSecret: SECRET_A.toString(),
    recipientL2Address: RECIPIENT_HEX,
    startTime: 1,
    amount: "0",
    observedFrom: (HEAD - 1_000n).toString(),
    ...fields,
  })

  it("leaves a record whose plan failed the window this pass would have read", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ intent: "registration" }))
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readRegistrationSIPAImplementation.mockRejectedValue(new Error("rpc down"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({ rescanFrom: (HEAD - 1n - 128n).toString() })
    expect(store.cursor).toBe(HEAD)
  })

  it("keeps an observed record's window when a new record falls back to the look-back", async () => {
    const store = makeStore()
    store.cursor = HEAD - 200_000n
    store.records.set(SIPA_B, { ...observedRecord(), messageSecret: SECRET_B.toString() })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({
      ...deps,
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    const ranges = new Map(mocks.readSweepEvents.mock.calls.map((c) => [c[1], c[2]]))
    expect(ranges.get(SIPA_A)).toBe(HEAD - 50_000n)
    expect(ranges.get(SIPA_B)).toBe(HEAD - 200_000n - 128n)
  })

  it("drops a saved sweep that the window covers and no longer shows: reorged away", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({
        phase: "pendingClaim",
        pendingSweeps: [
          {
            inboxIndex: "7",
            amount: "990000",
            messageKey: `0x${"0a".repeat(32)}`,
            blockNumber: (HEAD - 10n).toString(),
            sweepTxHash: TX_HASH,
          },
        ],
      }),
    )
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)?.pendingSweeps).toBeUndefined()
    expect(store.records.get(SIPA_A)?.phase).toBe("sweeping")
  })

  it("keeps a delayed sweep's gross and token with its claim inputs, for a claim past its window", async () => {
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    const { deps, store } = makeDeps()
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async () => ({
        logs: [
          {
            address: usdc.address,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: "Transfer",
              args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
            }),
            data: pad(toHex(5_000_000n)),
          },
        ],
      }),
    )
    const syncDeps = {
      ...deps,
      rows: [row({ ...DAI, decimals: 18 }, { swapped: [usdc] })],
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValueOnce([
      { index: 7n, amount: 4n * 10n ** 18n, blockNumber: HEAD - 5_000n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValueOnce(false)

    await syncSipaDeposits(syncDeps)
    expect(store.records.get(SIPA_A)?.pendingSweeps).toEqual([
      expect.objectContaining({ grossAmount: "5000000", fundingToken: usdc.address }),
    ])

    mocks.readSweepEvents.mockResolvedValue([])
    mocks.isL1ToL2MessageReady.mockResolvedValue(true)
    await syncSipaDeposits(syncDeps)

    expect(store.records.get(SIPA_A)?.sweeps).toEqual([
      expect.objectContaining({
        inboxIndex: "7",
        grossAmount: "5000000",
        fundingTokenSymbol: "USDC",
      }),
    ])
  })

  it("writes strictly, and holds the cursor when a record write does not land", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])
    const upsert = store.upsert.getMockImplementation()!
    store.upsert.mockImplementation(async (address, patch, fallback, opts) => {
      if ((patch as { phase?: string }).phase === "claimed") throw new Error("quota exceeded")
      return upsert(address, patch, fallback, opts)
    })

    await syncSipaDeposits(deps)

    expect(store.upsert.mock.calls.every((c) => (c[3] as { strict?: boolean })?.strict)).toBe(true)
    expect(store.cursor).toBeUndefined()
  })

  it("publishes a funded SIPA the relayer left unswept again, at most once a day", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({ phase: "sweeping", startTime: Date.now() - 2 * 3_600_000 }),
    )
    const { deps } = makeDeps(store)
    const onSweepOverdue = vi.fn(async () => true)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweepOverdue })
    await syncSipaDeposits({ ...deps, onSweepOverdue })

    expect(onSweepOverdue).toHaveBeenCalledOnce()
    expect(onSweepOverdue).toHaveBeenCalledWith(SIPA_A)
    expect(store.records.get(SIPA_A)?.republishAskedAt).toEqual(expect.any(Number))
  })

  it("asks once a day for an address it cannot publish again, too", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({ phase: "sweeping", startTime: Date.now() - 2 * 3_600_000 }),
    )
    const { deps } = makeDeps(store)
    const onSweepOverdue = vi.fn(async () => false)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweepOverdue })
    await syncSipaDeposits({ ...deps, onSweepOverdue })

    expect(onSweepOverdue).toHaveBeenCalledOnce()
  })

  it("leaves a SIPA funded within the hour to the relayer", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ phase: "sweeping", startTime: Date.now() - 60_000 }))
    const { deps } = makeDeps(store)
    const onSweepOverdue = vi.fn(async () => true)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweepOverdue })

    expect(onSweepOverdue).not.toHaveBeenCalled()
  })

  it("records the balance it observed, in fee-token units", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord())
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
    mocks.observedTokenBalance.mockReturnValue(1_000_000n)

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)?.heldBalance).toBe("1000000")
  })

  it("records the emptied balance on a pass that sees the sweep", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ heldBalance: "1000000" }))
    const { deps } = makeDeps(store)
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
    mocks.observedTokenBalance.mockReturnValue(0n)
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])

    await syncSipaDeposits({ ...deps, tokenServiceFor: undefined, observeOnly: true })

    expect(store.records.get(SIPA_A)).toMatchObject({ heldBalance: "0", sweepTxHash: TX_HASH })
  })

  it("observe-only: reads no events or readiness and claims nothing, keeping the sweep's claim inputs", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, observedRecord({ observedFrom: undefined }))
    const { deps, tokenService } = makeDeps(store)
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])

    await syncSipaDeposits({ ...deps, tokenServiceFor: undefined, observeOnly: true })

    expect(mocks.fetchSipaEvents).not.toHaveBeenCalled()
    expect(mocks.isL1ToL2MessageReady).not.toHaveBeenCalled()
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      sweepTxHash: TX_HASH,
      pendingSweeps: [expect.objectContaining({ inboxIndex: "7" })],
    })
  })

  it("observe-only: a funded deposit address reads as funded, with its balance, token and clock", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ phase: "resolved" }))
    const { deps } = makeDeps(store)
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.observedTokenBalance.mockReturnValue(1_000_000n)
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, tokenServiceFor: undefined, observeOnly: true })

    const record = store.records.get(SIPA_A)!
    expect(record).toMatchObject({ heldBalance: "1000000", tokenAddress: DAI.address })
    expect(isUnfundedSipaDeposit(record as never)).toBe(false)
    // Its clock starts at the funds, not at the hand-out.
    expect(record.startTime).toBeGreaterThan(1)
  })

  it("observe-only: a funded address dated by its funding transfer keeps that date", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ phase: "resolved" }))
    const { deps } = makeDeps(store)
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readFundingTransfers.mockResolvedValue([
      { from: SIPA_B, amount: 1_000_000n, blockNumber: HEAD - 20n, txHash: TX_HASH },
    ])
    mocks.readBlockTimeMs.mockResolvedValue(5_000)
    mocks.observedTokenBalance.mockReturnValue(1_000_000n)
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, tokenServiceFor: undefined, observeOnly: true })

    expect(store.records.get(SIPA_A)?.startTime).toBe(5_000)
  })

  it("observe-only: reads nothing past the head while the head has not passed the cursor", async () => {
    const store = makeStore()
    store.cursor = HEAD
    store.records.set(SIPA_A, observedRecord())
    const { deps } = makeDeps(store)

    await syncSipaDeposits({ ...deps, tokenServiceFor: undefined, observeOnly: true })
    expect(mocks.readSipaFundingStatus).not.toHaveBeenCalled()

    store.records.set(SIPA_A, observedRecord({ rescanFrom: (HEAD - 50n).toString() }))
    await syncSipaDeposits({ ...deps, tokenServiceFor: undefined, observeOnly: true })
    expect(mocks.readSipaFundingStatus).toHaveBeenCalled()
  })

  it("counts an in-flight sweep as active however old the record is", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "sweeping",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      amount: "1",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    expect(await syncSipaDeposits(deps)).toMatchObject({ active: 1 })
  })

  it.each([
    ["an unfunded SIPA past its fresh window", { startTime: 1 }, 0],
    ["a replayed unfunded address", { startTime: Date.now(), replayed: true }, 0],
    ["a self-initiated record inside its fresh window", { startTime: Date.now() }, 1],
  ])("counts %s as active: %s", async (_label, fields, active) => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      amount: "0",
      ...fields,
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    expect(await syncSipaDeposits(deps)).toMatchObject({ active })
  })

  it("reads the fee floor and the cap once per run however many SIPAs reach the funding probe", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledTimes(1)
    expect(mocks.readTxAmountCap).toHaveBeenCalledTimes(1)
    expect(mocks.readSipaFundingStatus).toHaveBeenCalledTimes(2)
    // The prefetched floor rides along, so the probe spends one read (balanceOf), not two.
    expect(mocks.readSipaFundingStatus.mock.calls[1][1]).toMatchObject({
      fee: 100n,
      txAmountCap: CAP,
    })
  })

  it("prices a claimed sweep off its own row once per pass, and reads no cap", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, { phase: "claimed", startTime: 1, amount: "0.99", fee: "100" })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
      { index: 8n, amount: 500_000n, blockNumber: 11_000_001n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledTimes(1)
    expect(mocks.readTxAmountCap).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)!.sweeps!.map((s) => s.fee)).toEqual(["100", "100"])
  })

  it("stamps the fee on a deposit swept before the wallet's first scan", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    // The funding probe never ran, so the claim write is the only place the fee can land.
    expect(mocks.readSipaFundingStatus).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", fee: "100" })
  })

  it("reads the head once per run, not once per SIPA", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(
      (deps.publicClient as unknown as { getBlockNumber: ReturnType<typeof vi.fn> }).getBlockNumber,
    ).toHaveBeenCalledTimes(1)
  })
})

describe("syncSipaDeposits consumed sweeps", () => {
  const NHK = { secret: "nhk" }
  const twoSweeps = () =>
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
  const nodeWithLookup = () => ({ findLeavesIndexes: vi.fn() } as never)

  it("records a sweep another device claimed with no readiness read or claim, in one lookup", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()
    mocks.readSipaDepositsConsumed.mockResolvedValue([true, false])

    const result = await syncSipaDeposits({
      ...deps,
      node: nodeWithLookup(),
      masterNullifierHidingKey: NHK as never,
    })

    expect(result).toMatchObject({ claimed: 1, reconciled: 1, failed: 0 })
    expect(mocks.readSipaDepositsConsumed).toHaveBeenCalledOnce()
    const [, scope, hashes] = mocks.readSipaDepositsConsumed.mock.calls[0]!
    expect(scope).toMatchObject({ masterNullifierHidingKey: NHK })
    expect(hashes).toEqual([`0x${"0a".repeat(32)}`, `0x${"0a".repeat(32)}`])
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 9n }),
    )
    expect(mocks.isL1ToL2MessageReady).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
    })
  })

  it("reads a consumed sweep's block with every other read, before any claim", async () => {
    const { deps, tokenService } = makeDeps()
    const order: string[] = []
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()
    mocks.readSipaDepositsConsumed.mockResolvedValue([true, false])
    mocks.readBlockTimeMs.mockImplementation(async (_client: unknown, block: bigint) => {
      order.push(`block ${block}`)
      return undefined
    })
    tokenService.claimSweptDeposit.mockImplementation(async () => {
      order.push("claim")
    })

    await syncSipaDeposits({
      ...deps,
      node: nodeWithLookup(),
      masterNullifierHidingKey: NHK as never,
    })

    expect(order.indexOf("block 1")).toBeLessThan(order.indexOf("claim"))
    expect(order.indexOf("block 2")).toBeLessThan(order.indexOf("claim"))
  })

  it("claims every sweep when the lookup fails", async () => {
    const { deps, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()
    mocks.readSipaDepositsConsumed.mockRejectedValue(new Error("node down"))

    const result = await syncSipaDeposits({
      ...deps,
      node: nodeWithLookup(),
      masterNullifierHidingKey: NHK as never,
    })

    expect(result).toMatchObject({ claimed: 2, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
  })

  it("looks nothing up without the hiding key", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()

    await syncSipaDeposits({ ...deps, node: nodeWithLookup() })

    expect(mocks.readSipaDepositsConsumed).not.toHaveBeenCalled()
  })
})

describe("syncSipaDeposits funding attribution", () => {
  const FUNDER = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address
  const FUNDING_TX = `0x${"cd".repeat(32)}`
  const transfer = { from: FUNDER, amount: 1_000_000n, blockNumber: 5n, txHash: FUNDING_TX }

  it("stamps funder + funding tx, backfills walletAddress, and fires the hook with the bare address", async () => {
    const { deps, store } = makeDeps()
    const onFundingWalletDetected = vi.fn(async () => undefined)
    ;(deps as { onFundingWalletDetected?: unknown }).onFundingWalletDetected =
      onFundingWalletDetected
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readFundingTransfers.mockResolvedValue([transfer])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      fundingTxHash: FUNDING_TX,
      fundingFromAddress: FUNDER,
      walletAddress: FUNDER,
    })
    // Third-party deposit: no session identity to pass through.
    expect(onFundingWalletDetected).toHaveBeenCalledTimes(1)
    expect(onFundingWalletDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FUNDER,
        walletName: undefined,
        walletProvider: undefined,
      }),
    )
  })

  it("dates a deposit this device handed out by its funding transfer's block", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readFundingTransfers.mockResolvedValue([transfer])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      fee: 100n,
      sweepable: true,
    })
    mocks.readBlockTimeMs.mockImplementation(async (_client: unknown, block: bigint) =>
      block === transfer.blockNumber ? 1_700_000_000_000 : undefined,
    )

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ startTime: 1_700_000_000_000 })
  })

  it("never re-reads transfers once attributed", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "sweeping",
      fundingFromAddress: FUNDER,
      fundingTxHash: FUNDING_TX,
      messageSecret: SECRET_A.toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readFundingTransfers).not.toHaveBeenCalled()
  })

  it("keeps the connected-session identity when the on-chain funder differs, and passes it when matching", async () => {
    const sessionWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "funded",
      walletAddress: sessionWallet,
      walletName: "Rainbow",
      walletProvider: "rainbow",
      messageSecret: SECRET_A.toString(),
    })
    const { deps } = makeDeps(store)
    const onFundingWalletDetected = vi.fn(async () => undefined)
    ;(deps as { onFundingWalletDetected?: unknown }).onFundingWalletDetected =
      onFundingWalletDetected
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readFundingTransfers.mockResolvedValue([transfer])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    // Divergence: both fields kept, session identity not overwritten.
    expect(store.records.get(SIPA_A)).toMatchObject({
      walletAddress: sessionWallet,
      fundingFromAddress: FUNDER,
    })
    expect(onFundingWalletDetected).toHaveBeenCalledWith(
      expect.objectContaining({ address: FUNDER, walletName: undefined }),
    )

    // Matching funder: the record's session identity rides along.
    onFundingWalletDetected.mockClear()
    store.records.set(SIPA_A, {
      phase: "funded",
      walletAddress: FUNDER.toUpperCase().replace("0X", "0x"),
      walletName: "Rainbow",
      walletProvider: "rainbow",
      messageSecret: SECRET_A.toString(),
    })
    await syncSipaDeposits(deps)
    expect(onFundingWalletDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FUNDER,
        walletName: "Rainbow",
        walletProvider: "rainbow",
      }),
    )
  })

  it("isolates attribution failures from the claim path", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readFundingTransfers.mockResolvedValue([transfer])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits({
      ...deps,
      onFundingWalletDetected: async () => {
        throw new Error("contacts down")
      },
    })

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed" })
  })

  it("reads sweeps without waiting for the funding transfers", async () => {
    const { deps, store, tokenService } = makeDeps()
    let sweepStarted: () => void = () => {}
    const sweepRead = new Promise<void>((resolve) => {
      sweepStarted = resolve
    })
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(async () => {
      sweepStarted()
      return [{ index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH }]
    })
    // Resolves only once the sweep read has started, so a serialized pass would never finish.
    mocks.readFundingTransfers.mockImplementation(async () => {
      await sweepRead
      return [transfer]
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      fundingFromAddress: FUNDER,
    })
  })

  it("reads every funding token in one fan-out and stamps the earliest transfer", async () => {
    const { deps, store } = makeDeps()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    let usdcStarted: () => void = () => {}
    const usdcRead = new Promise<void>((resolve) => {
      usdcStarted = resolve
    })
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
    // The first token resolves only once the second has started, so a serialized pass would hang.
    mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) => {
      if (token === usdc.address) {
        usdcStarted()
        return [{ from: "0xfeed", amount: 5n, blockNumber: 3n, txHash: "0xusdc" }]
      }
      await usdcRead
      return [{ from: FUNDER, amount: 1n, blockNumber: 9n, txHash: "0xdai" }]
    })

    await syncSipaDeposits({ ...deps, rows: [row(DAI, { swapped: [usdc] })] })

    expect(store.records.get(SIPA_A)).toMatchObject({
      fundingTxHash: "0xusdc",
      fundingFromAddress: "0xfeed",
      tokenAddress: usdc.address,
      tokenSymbol: "USDC",
    })
  })

  it("breaks a tie on block number with the first listed token", async () => {
    const { deps, store } = makeDeps()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
    mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) =>
      token === usdc.address
        ? [{ from: "0xfeed", amount: 5n, blockNumber: 4n, txHash: "0xusdc" }]
        : [{ from: FUNDER, amount: 1n, blockNumber: 4n, txHash: "0xdai" }],
    )

    await syncSipaDeposits({ ...deps, rows: [row(DAI, { swapped: [usdc] })] })

    expect(store.records.get(SIPA_A)).toMatchObject({
      fundingTxHash: "0xdai",
      fundingFromAddress: FUNDER,
      tokenAddress: DAI.address,
      tokenSymbol: "DAI",
    })
  })
})

describe("account recovery protocol", () => {
  it("derives a SIPA under the deployment's table and records the table on its origin", async () => {
    const { deps, store } = makeDeps()
    const account = {
      ...deps,
      tuple: {
        ...TUPLE,
        sipaRecoveryProtocol: "account",
        accountFactory: "0xacc0acc0acc0acc0acc0acc0acc0acc0acc0acc0",
      } as OxideEnvTuple,
      recoveryAccount: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a" as Address,
    }
    mocks.deriveRecoveryCommitment.mockReturnValue(fr(`0x${"c0".repeat(31)}`))
    mocks.computeAccountSIPAAddress.mockReturnValue({ toString: () => SIPA_A })
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])

    await syncSipaDeposits(account)

    const [inputs] = mocks.computeAccountSIPAAddress.mock.calls[0]!
    expect(inputs.forwardingTable.toString()).toBe(FORWARDING_TABLE)
    expect(store.records.get(SIPA_A)?.origin).toMatchObject({
      protocol: "account",
      forwardingTable: FORWARDING_TABLE,
    })
  })

  it("refuses discovery on a deployment that names no table", async () => {
    const { deps } = makeDeps()
    const account = {
      ...deps,
      tuple: {
        ...TUPLE,
        forwardingTable: undefined,
        sipaRecoveryProtocol: "account",
        accountFactory: "0xacc0acc0acc0acc0acc0acc0acc0acc0acc0acc0",
      } as OxideEnvTuple,
      recoveryAccount: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a" as Address,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])

    const result = await syncSipaDeposits(account)

    expect(result).toMatchObject({ failed: 1, discovered: 0 })
    expect(mocks.computeAccountSIPAAddress).not.toHaveBeenCalled()
  })
})

describe("deposit implementation", () => {
  it("re-reads after a failed read instead of serving the rejection forever", async () => {
    const first = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readDepositSIPAImplementation.mockRejectedValueOnce(new Error("rpc down"))

    await expect(syncSipaDeposits(first.deps)).rejects.toThrow("rpc down")

    const second = makeDeps()
    await expect(syncSipaDeposits(second.deps)).resolves.toMatchObject({ discovered: 1 })
    expect(mocks.readDepositSIPAImplementation).toHaveBeenCalledTimes(2)
  })

  it("reads the factory's pointer on every sync, since its owner can repoint it", async () => {
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])

    await syncSipaDeposits(makeDeps().deps)
    await syncSipaDeposits(makeDeps().deps)

    expect(mocks.readDepositSIPAImplementation).toHaveBeenCalledTimes(2)
    expect(mocks.readDepositSIPAImplementation).toHaveBeenCalledWith(
      expect.anything(),
      TUPLE.sipaFactory,
    )
  })
})

describe("syncSipaDeposits balance refresh", () => {
  const sweptEvent = () => {
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
  }

  it("refreshes the chain view after a claim and holds the catch-up until it lands", async () => {
    const { deps, tokenService } = makeDeps()
    sweptEvent()
    let land: () => void = () => {}
    const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

    const pass = syncSipaDeposits({ ...deps, refreshBalance })
    await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))

    expect(refreshBalance.mock.invocationCallOrder[0]).toBeGreaterThan(
      tokenService.claimSweptDeposit.mock.invocationCallOrder[0],
    )
    expect(syncCatchUp.status.get()).toBe(true)

    land()

    expect(await pass).toMatchObject({ claimed: 1 })
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    expect(syncCatchUp.status.get()).toBe(false)
  })

  it.each([
    ["claims", () => {}],
    [
      "reconciles",
      (tokenService: ReturnType<typeof makeDeps>["tokenService"]) =>
        tokenService.claimSweptDeposit.mockRejectedValueOnce(
          new Error("Assertion failed: deposit already stored"),
        ),
    ],
  ])(
    "%s a deposit counted as arriving, and records it claimed only after the balance refresh",
    async (_, claimOutcome) => {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "pendingClaim",
        startTime: Date.now(),
        messageSecret: SECRET_A.toString(),
        netAmount: "990000",
        lastScanAt: Date.now(),
      })
      const { deps, tokenService } = makeDeps(store)
      claimOutcome(tokenService)
      sweptEvent()
      let land: () => void = () => {}
      const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

      const pass = syncSipaDeposits({ ...deps, refreshBalance })
      await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))
      expect(store.records.get(SIPA_A)).toMatchObject({
        phase: "pendingClaim",
        claimLanded: { inboxIndex: "7", at: expect.any(Number) },
      })

      land()

      await pass
      expect(store.records.get(SIPA_A)?.phase).toBe("claimed")
    },
  )

  it("reads the balance once for a pass's claims across SIPAs, and records them all after it", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) => [
      sipa === SIPA_A
        ? { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH }
        : { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    let land: () => void = () => {}
    const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

    const pass = syncSipaDeposits({ ...deps, refreshBalance })
    await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_A)?.phase).not.toBe("claimed")
    expect(store.records.get(SIPA_B)?.phase).not.toBe("claimed")

    land()

    expect(await pass).toMatchObject({ claimed: 2 })
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)?.phase).toBe("claimed")
    expect(store.records.get(SIPA_B)?.phase).toBe("claimed")
  })

  it("reads every sweep's message and readiness once, all before the first claim", async () => {
    const { deps, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    mocks.readDepositMessageKey.mockImplementation(async (...args: unknown[]) =>
      fr(`0x${(args[3] as bigint).toString(16).padStart(64, "0")}`),
    )

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 2 })

    expect(mocks.readDepositMessageKey).toHaveBeenCalledTimes(2)
    expect(mocks.isL1ToL2MessageReady).toHaveBeenCalledTimes(2)
    const firstClaim = tokenService.claimSweptDeposit.mock.invocationCallOrder[0]!
    for (const order of mocks.isL1ToL2MessageReady.mock.invocationCallOrder)
      expect(order).toBeLessThan(firstClaim)
  })

  it("keeps a newer sweep pending when an older one on the same SIPA claims in the pass", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    mocks.readDepositMessageKey.mockImplementation(async (...args: unknown[]) =>
      fr(`0x${(args[3] as bigint).toString(16).padStart(64, "0")}`),
    )
    mocks.isL1ToL2MessageReady.mockImplementation(
      async (_node: unknown, key: unknown) => BigInt(String(key)) === 7n,
    )

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, pendingSettlement: 1 })

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "9",
      netAmount: "500000",
      claimedInboxIndexes: ["7"],
    })
  })

  it("reads as received for a migration only once the rail claimed every sweep", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    mocks.readDepositMessageKey.mockImplementation(async (...args: unknown[]) =>
      fr(`0x${(args[3] as bigint).toString(16).padStart(64, "0")}`),
    )
    mocks.isL1ToL2MessageReady.mockImplementation(
      async (_node: unknown, key: unknown) => BigInt(String(key)) === 7n,
    )

    await syncSipaDeposits(deps)
    expect(sipaSweepsReceived(store.records.get(SIPA_A) as never)).toBe(false)

    mocks.isL1ToL2MessageReady.mockResolvedValue(true)
    vi.mocked(deps.publicClient.getBlockNumber).mockResolvedValue(HEAD + 1n)
    await syncSipaDeposits(deps)
    expect(sipaSweepsReceived(store.records.get(SIPA_A) as never)).toBe(true)
  })

  it("keeps the cursor where it was when a claim's record never lands", async () => {
    const store = makeStore()
    const upsert = store.upsert.getMockImplementation()!
    store.upsert.mockImplementation(async (address, patch, fallback) => {
      if (patch.phase === "claimed") throw new Error("tab closed")
      return upsert(address, patch, fallback)
    })
    const { deps } = makeDeps(store)
    sweptEvent()

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)?.lastScannedBlock).toBeUndefined()
    expect(store.records.get(SIPA_A)?.historyScanned).toBeUndefined()
  })

  it("completes a pass whose refresh rejects", async () => {
    const { deps } = makeDeps()
    sweptEvent()
    const refreshBalance = vi.fn(async () => {
      throw new Error("node unreachable")
    })

    expect(await syncSipaDeposits({ ...deps, refreshBalance })).toMatchObject({
      claimed: 1,
      failed: 0,
    })
    expect(syncCatchUp.status.get()).toBe(false)
  })

  it("begins a catch-up only for a pass that discovers an event with no local record", async () => {
    const begin = vi.spyOn(syncCatchUp, "begin")
    try {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "broadcast",
        startTime: Date.now(),
        messageSecret: SECRET_A.toString(),
        recipientL2Address: RECIPIENT_HEX,
        lastScanAt: Date.now(),
      })
      sweptEvent()

      await syncSipaDeposits(makeDeps(store).deps)
      expect(begin).not.toHaveBeenCalled()

      await syncSipaDeposits(makeDeps().deps)
      expect(begin).toHaveBeenCalledTimes(1)
    } finally {
      begin.mockRestore()
    }
  })
})

describe("syncSipaDeposits second payment to a claimed SIPA", () => {
  const funded = { balance: 500n, scaledBalance: 500n, fee: 100n, sweepable: true }

  /** Claims one sweep, then reads the same address with new funds and no new sweep. */
  async function payAgain(resweepable: boolean) {
    const { deps, store } = makeDeps()
    const onSweptAddressFunded = vi.fn(async (_sipa: Address) => {})
    const run = { ...deps, onSweptAddressFunded }
    mocks.fetchSipaEvents.mockResolvedValue([{ ...sipaEvent(SECRET_A), resweepable }])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 1_000n, txHash: TX_HASH },
    ])
    mocks.readSipaFundingStatus.mockResolvedValue({ ...funded, balance: 0n, sweepable: false })
    await syncSipaDeposits(run)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", sweepTxHash: TX_HASH })

    store.records.get(SIPA_A)!.lastScanAt = 0
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(funded)
    await syncSipaDeposits(run)
    return { run, store, onSweptAddressFunded }
  }

  it("reopens a resweepable address on a fresh stuck clock and asks for one republish", async () => {
    const before = Date.now()
    const { run, store, onSweptAddressFunded } = await payAgain(true)
    const record = store.records.get(SIPA_A)!
    expect(record).toMatchObject({
      phase: "sweeping",
      amount: "0.0005",
      claimedInboxIndexes: ["7"],
    })
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.netAmount).toBeUndefined()
    expect(record.startTime as number).toBeGreaterThanOrEqual(before)
    expect(onSweptAddressFunded.mock.calls).toEqual([[SIPA_A]])

    await syncSipaDeposits(run)
    expect(onSweptAddressFunded).toHaveBeenCalledOnce()
  })

  it("keeps the claim when the republish fails, and republishes on the next scan", async () => {
    const { run, store, onSweptAddressFunded } = await payAgain(true)
    onSweptAddressFunded.mockClear()
    store.records.get(SIPA_A)!.phase = "claimed"
    store.records.get(SIPA_A)!.sweepTxHash = TX_HASH
    store.records.get(SIPA_A)!.lastScanAt = 0
    onSweptAddressFunded.mockRejectedValueOnce(new Error("node down"))

    await syncSipaDeposits(run)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", sweepTxHash: TX_HASH })

    store.records.get(SIPA_A)!.lastScanAt = 0
    await syncSipaDeposits(run)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
    expect(onSweptAddressFunded).toHaveBeenCalledTimes(2)
  })

  it("sends a second payment to an address that refuses a second sweep to recovery", async () => {
    const { store, onSweptAddressFunded } = await payAgain(false)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable" })
    expect(onSweptAddressFunded).not.toHaveBeenCalled()
  })
})

describe("syncSipaDeposits second payment left without an exit", () => {
  it("reopens a sweeping record still stamped with its claimed sweep", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "sweeping",
      startTime: 1,
      endTime: 2,
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweepTxHash: TX_HASH,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const { deps } = makeDeps(store)
    const onSweptAddressFunded = vi.fn(async (_sipa: Address) => {})
    mocks.fetchSipaEvents.mockResolvedValue([{ ...sipaEvent(SECRET_A), resweepable: true }])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweptAddressFunded })

    const record = store.records.get(SIPA_A)!
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.endTime).toBeUndefined()
    expect(isStuckSweep(record as never, (record.startTime as number) + STUCK_SWEEP_MS)).toBe(true)
    expect(onSweptAddressFunded).toHaveBeenCalledOnce()
  })
})

describe("syncSipaDeposits user-op SIPAs", () => {
  /** The factory's current user-op implementation, and the one it blessed before it. */
  const USER_OP_IMPLEMENTATION = "0x7c2f1d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293" as Address
  const EARLIER_USER_OP_IMPLEMENTATION = "0x8d3a2e4f5b6c7d8e9f0a1b2c3d4e5f6071829304" as Address
  const USER_OP_HASH = `0x${"88".repeat(32)}`
  const SIPA_USER_OP = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address
  const SIPA_EARLIER_USER_OP = "0xabababababababababababababababababababab" as Address
  const MESSAGE_KEY = `0x${"0a".repeat(32)}`

  /** Each implementation derives its own address; the deposit implementation's is A. */
  const ADDRESS_BY_IMPLEMENTATION: Record<string, Address> = {
    [REGISTRATION_IMPLEMENTATION]: SIPA_C,
    [USER_OP_IMPLEMENTATION]: SIPA_USER_OP,
    [EARLIER_USER_OP_IMPLEMENTATION]: SIPA_EARLIER_USER_OP,
  }

  /** `swept` emitted a `Sweep`; `blessed` is what the factory reports, the current implementation first. */
  function userOpDeps(
    swept: Address[],
    store = makeStore(),
    blessed: Address[] = [USER_OP_IMPLEMENTATION],
  ) {
    const made = makeDeps(store)
    mocks.readBlessedImplementations.mockResolvedValue(blessed)
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      swept.some((s) => s.toLowerCase() === sipa.toLowerCase())
        ? [{ index: 5n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }]
        : [],
    )
    return made
  }

  /** The addresses the last pass observed. */
  const observedAddresses = () =>
    vi
      .mocked(observeSipas)
      .mock.calls.at(-1)![1]
      .subjects.map((s) => s.address)

  beforeEach(() => {
    mocks.computeSIPAAddress.mockImplementation(
      (inputs: { implementation: { toString(): string } }) => {
        const address = ADDRESS_BY_IMPLEMENTATION[inputs.implementation.toString()] ?? SIPA_A
        return { toString: () => address }
      },
    )
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
  })

  it("stores a swept user-op SIPA at its clone, prices it on the user-op row and claims it with its message key", async () => {
    const { deps, store, tokenService } = userOpDeps([SIPA_USER_OP])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(observedAddresses()).toEqual([SIPA_C, SIPA_USER_OP])
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      replayed: true,
      origin: expect.objectContaining({ implementation: USER_OP_IMPLEMENTATION }),
      sweeps: [expect.objectContaining({ inboxIndex: "5", messageKey: MESSAGE_KEY })],
    })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(mocks.readDepositFee).toHaveBeenCalledWith(expect.anything(), route(SipaIntent.UserOp))
  })

  it("reads the blessed list once per run, from the pass's history start", async () => {
    const { deps } = userOpDeps([SIPA_USER_OP])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits({ ...deps, historyStartBlock: async () => HEAD - 400_000n })

    expect(mocks.readBlessedImplementations).toHaveBeenCalledTimes(1)
    expect(mocks.readBlessedImplementations).toHaveBeenCalledWith(
      expect.anything(),
      TUPLE.sipaFactory,
      SipaIntent.UserOp,
      HEAD - 400_000n,
    )
  })

  it("scans for blesses over the default look-back without a history start", async () => {
    const { deps } = userOpDeps([SIPA_USER_OP])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits(deps)

    expect(mocks.readBlessedImplementations.mock.calls[0]![3]).toBe(HEAD - 50_000n)
  })

  it("reads no blessed list for a pass of plain deposits", async () => {
    const { deps, store } = userOpDeps([SIPA_A])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])

    await syncSipaDeposits(deps)

    expect(mocks.readBlessedImplementations).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed" })
  })

  it("reads a user-op event as a registration until its clone is swept, then moves it", async () => {
    const swept: Address[] = []
    const { deps, store } = userOpDeps(swept)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits(deps)
    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration", replayed: true })
    expect(store.records.get(SIPA_USER_OP)).toBeUndefined()

    swept.push(SIPA_USER_OP)
    await syncSipaDeposits(deps)
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({ intent: "user-op", phase: "claimed" })
  })

  it("resolves an event as a registration when the blessed list cannot be read, and re-reads its window once it can", async () => {
    const { deps, store } = userOpDeps([SIPA_A, SIPA_USER_OP])
    mocks.readBlessedImplementations.mockRejectedValueOnce(new Error("rpc down"))
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A, USER_OP_HASH),
      sipaEvent(SECRET_B),
    ])

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 0 })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed" })
    expect(store.records.get(SIPA_C)).toMatchObject({
      intent: "registration",
      observedFrom: HEAD.toString(),
      rescanFrom: (HEAD - 50_000n).toString(),
    })
    expect(store.records.get(SIPA_USER_OP)).toBeUndefined()

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 0 })
    expect(mocks.readSweepEvents).toHaveBeenCalledWith(
      expect.anything(),
      SIPA_USER_OP,
      HEAD - 50_000n,
      HEAD,
    )
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({ intent: "user-op", phase: "claimed" })
  })

  it("reads a failing blessed list once per pass, however many events need it", async () => {
    const OTHER_HASH = `0x${"99".repeat(32)}`
    const { deps, store } = userOpDeps([])
    mocks.computeSIPAAddress.mockImplementation(
      (inputs: { implementation: { toString(): string }; intentHash: Buffer }) => {
        const implementation = inputs.implementation.toString()
        const second = `0x${inputs.intentHash.toString("hex")}` === OTHER_HASH
        return {
          toString: () =>
            implementation === REGISTRATION_IMPLEMENTATION
              ? second
                ? SIPA_B
                : SIPA_C
              : ADDRESS_BY_IMPLEMENTATION[implementation] ?? SIPA_A,
        }
      },
    )
    mocks.readBlessedImplementations.mockRejectedValue(new Error("rpc down"))
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A, USER_OP_HASH),
      sipaEvent(SECRET_B, OTHER_HASH),
    ])

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 0 })

    expect(mocks.readBlessedImplementations).toHaveBeenCalledTimes(1)
    for (const address of [SIPA_C, SIPA_B])
      expect(store.records.get(address)).toMatchObject({
        intent: "registration",
        rescanFrom: (HEAD - 50_000n).toString(),
      })
  })

  it("fails only the event of a recorded user operation no blessed implementation derives", async () => {
    const store = makeStore()
    store.records.set(SIPA_EARLIER_USER_OP, {
      phase: "broadcast",
      intent: "user-op",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = userOpDeps([SIPA_A], store, [USER_OP_IMPLEMENTATION])
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A, USER_OP_HASH),
      sipaEvent(SECRET_B),
    ])

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 1 })

    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_EARLIER_USER_OP)?.origin).toBeUndefined()
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed" })

    mocks.readBlessedImplementations.mockResolvedValue([])
    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 1 })
  })

  it("lands a rotation prepared on an earlier implementation at that clone after a newer bless", async () => {
    const { deps, store } = userOpDeps([SIPA_EARLIER_USER_OP], makeStore(), [
      USER_OP_IMPLEMENTATION,
      EARLIER_USER_OP_IMPLEMENTATION,
    ])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits(deps)

    expect(observedAddresses()).toEqual([SIPA_C, SIPA_USER_OP, SIPA_EARLIER_USER_OP])
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      origin: expect.objectContaining({ implementation: EARLIER_USER_OP_IMPLEMENTATION }),
    })
    expect(store.records.get(SIPA_USER_OP)).toBeUndefined()
    expect(store.records.get(SIPA_C)).toBeUndefined()
  })

  it("records and claims every swept user-op clone of one intent, not only the first blessed", async () => {
    const { deps, store, tokenService } = userOpDeps(
      [SIPA_USER_OP, SIPA_EARLIER_USER_OP],
      makeStore(),
      [USER_OP_IMPLEMENTATION, EARLIER_USER_OP_IMPLEMENTATION],
    )
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 2, failed: 0 })
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      origin: expect.objectContaining({ implementation: USER_OP_IMPLEMENTATION }),
    })
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      origin: expect.objectContaining({ implementation: EARLIER_USER_OP_IMPLEMENTATION }),
    })
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
  })

  it("scans a swept clone whose record has no salt yet, which no plan of its own reads", async () => {
    const store = makeStore()
    store.records.set(SIPA_EARLIER_USER_OP, {
      phase: "sweeping",
      replayed: true,
      amount: "0",
      messageSecret: "",
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = userOpDeps([SIPA_USER_OP, SIPA_EARLIER_USER_OP], store, [
      USER_OP_IMPLEMENTATION,
      EARLIER_USER_OP_IMPLEMENTATION,
    ])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    const result = await syncSipaDeposits(deps)

    // The event's clone is new and the recorded one was sweeping: both were in flight.
    expect(result).toMatchObject({ claimed: 2, failed: 0, active: 2 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      messageSecret: SECRET_A.toString(),
      origin: expect.objectContaining({ implementation: EARLIER_USER_OP_IMPLEMENTATION }),
    })
  })

  it("leaves a swept clone recorded under another account to that account", async () => {
    const store = makeStore()
    const theirs = {
      phase: "broadcast",
      replayed: true,
      amount: "0",
      messageSecret: "",
      recipientL2Address: `0x${"99".repeat(32)}`,
    }
    store.records.set(SIPA_EARLIER_USER_OP, theirs)
    const { deps, tokenService } = userOpDeps([SIPA_USER_OP, SIPA_EARLIER_USER_OP], store, [
      USER_OP_IMPLEMENTATION,
      EARLIER_USER_OP_IMPLEMENTATION,
    ])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toEqual(theirs)
  })

  it("scans a clone once when a misfiled record and the clone's own record both pin the event", async () => {
    const store = makeStore()
    const pinned = {
      phase: "broadcast",
      replayed: true,
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    }
    store.records.set(SIPA_C, { ...pinned, intent: "registration" })
    store.records.set(SIPA_USER_OP, { ...pinned, intent: "user-op" })
    const { deps, tokenService } = userOpDeps([SIPA_USER_OP], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({ intent: "user-op", phase: "claimed" })
  })

  it("backfills a clone first recorded under a cursor window before it rides the cursor", async () => {
    const store = makeStore()
    store.cursor = HEAD - 500n
    store.records.set(SIPA_C, {
      phase: "broadcast",
      replayed: true,
      intent: "registration",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      observedFrom: (HEAD - 1_000n).toString(),
    })
    const { deps } = userOpDeps([SIPA_USER_OP], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 0 })
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({ intent: "user-op", phase: "claimed" })
    expect(store.records.get(SIPA_USER_OP)?.observedFrom).toBeUndefined()

    await syncSipaDeposits(deps)
    const subjects = vi.mocked(observeSipas).mock.calls.at(-1)![1].subjects
    expect(subjects.find((s) => s.address === SIPA_USER_OP)?.fromBlock).toBe(HEAD - 50_000n)
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({ observedFrom: HEAD.toString() })
  })

  it("keeps an event whose swept clone sits under no blessed implementation a registration", async () => {
    const { deps, store } = userOpDeps([SIPA_EARLIER_USER_OP])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits(deps)

    expect(observedAddresses()).not.toContain(SIPA_EARLIER_USER_OP)
    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration" })
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toBeUndefined()
  })

  it.each([
    ["user operation first", [USER_OP_HASH, undefined]],
    ["deposit first", [undefined, USER_OP_HASH]],
  ])(
    "keeps a user-op SIPA and a DepositSIPA sharing its salt apart, %s, across runs",
    async (_order, hashes) => {
      const { deps, store } = userOpDeps([SIPA_USER_OP])
      mocks.fetchSipaEvents.mockResolvedValue(hashes.map((hash) => sipaEvent(SECRET_A, hash)))

      await syncSipaDeposits(deps)
      await syncSipaDeposits(deps)

      expect([...store.records.keys()].sort()).toEqual([SIPA_A, SIPA_USER_OP].sort())
      expect(store.records.get(SIPA_USER_OP)).toMatchObject({ intent: "user-op" })
      expect(store.records.get(SIPA_A)?.intent).toBeUndefined()
    },
  )

  it("leaves a funded registration alone and reads no blessed list for it", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "claimed",
      intent: "registration",
      amount: "5",
      inboxIndex: "1",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps } = userOpDeps([SIPA_USER_OP], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits(deps)

    expect(mocks.readBlessedImplementations).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration", phase: "claimed" })
    expect(store.records.get(SIPA_USER_OP)).toBeUndefined()
  })

  it("keeps stray funds at a misfiled address and gives the user operation its own record", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "recoverable",
      replayed: true,
      intent: "registration",
      amount: "0.000001",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps } = userOpDeps([SIPA_USER_OP], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits(deps)
    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration", amount: "0.000001" })
    expect(store.records.get(SIPA_USER_OP)).toMatchObject({
      intent: "user-op",
      phase: "claimed",
      origin: expect.objectContaining({ implementation: USER_OP_IMPLEMENTATION }),
    })
  })

  it("files an adopted stray by the factory's intent, not by what the blessed list could show", async () => {
    const store = makeStore()
    const { deps } = userOpDeps([], store)
    mocks.readBlessedImplementations.mockRejectedValue(new Error("rpc down"))
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])
    const stray = {
      portal: TUPLE.portal,
      recipientCommitment: mocks.computeStealthRecipientHash(SECRET_A).toString(),
      amount: 1n,
      key: MESSAGE_KEY,
      index: 3n,
      blockNumber: HEAD - 5n,
      txHash: TX_HASH,
      logIndex: 0,
    }
    const real = vi.mocked(observeSipas).getMockImplementation()!
    vi.mocked(observeSipas).mockImplementationOnce(async (client, params) => ({
      ...(await real(client, params)),
      strays: [stray as never],
    }))
    mocks.readSweepEmitters.mockResolvedValue([SIPA_EARLIER_USER_OP])
    mocks.readSipaIntent.mockResolvedValue(SipaIntent.UserOp)

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 0 })

    expect(mocks.readSipaIntent).toHaveBeenCalledWith(
      expect.anything(),
      TUPLE.sipaFactory,
      SIPA_EARLIER_USER_OP,
    )
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({
      intent: "user-op",
      messageSecret: SECRET_A.toString(),
      replayed: true,
    })
  })

  it("leaves a stray whose intent the factory did not answer for the next pass", async () => {
    const store = makeStore()
    const { deps } = userOpDeps([], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])
    const stray = {
      portal: TUPLE.portal,
      recipientCommitment: mocks.computeStealthRecipientHash(SECRET_A).toString(),
      amount: 1n,
      key: MESSAGE_KEY,
      index: 3n,
      blockNumber: HEAD - 5n,
      txHash: TX_HASH,
      logIndex: 0,
    }
    const real = vi.mocked(observeSipas).getMockImplementation()!
    const withStray: typeof real = async (client, params) => ({
      ...(await real(client, params)),
      strays: [stray as never],
    })
    vi.mocked(observeSipas).mockImplementationOnce(withStray).mockImplementationOnce(withStray)
    mocks.readSweepEmitters.mockResolvedValue([SIPA_EARLIER_USER_OP])
    mocks.readSipaIntent.mockRejectedValueOnce(new Error("rpc down"))
    mocks.readSipaIntent.mockResolvedValue(SipaIntent.UserOp)

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 0 })
    expect(store.records.has(SIPA_EARLIER_USER_OP)).toBe(false)

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 0 })
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({ intent: "user-op" })
  })

  it("adopts the stray's clone the factory vouches for, past a forged Sweep log ahead of it", async () => {
    const store = makeStore()
    const { deps } = userOpDeps([], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])
    const stray = {
      portal: TUPLE.portal,
      recipientCommitment: mocks.computeStealthRecipientHash(SECRET_A).toString(),
      amount: 1n,
      key: MESSAGE_KEY,
      index: 3n,
      blockNumber: HEAD - 5n,
      txHash: TX_HASH,
      logIndex: 0,
    }
    const real = vi.mocked(observeSipas).getMockImplementation()!
    vi.mocked(observeSipas).mockImplementationOnce(async (client, params) => ({
      ...(await real(client, params)),
      strays: [stray as never],
    }))
    const forger = "0x00000000000000000000000000000000000000ff"
    mocks.readSweepEmitters.mockResolvedValue([forger, SIPA_EARLIER_USER_OP])
    mocks.readSipaIntent.mockImplementation(async (_c: unknown, _f: unknown, clone: string) =>
      clone === forger ? SipaIntent.None : SipaIntent.UserOp,
    )

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 0 })

    expect(store.records.has(forger)).toBe(false)
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({
      intent: "user-op",
      messageSecret: SECRET_A.toString(),
      replayed: true,
    })
  })

  it("claims an adopted stray from its clone's own implementation while the blessed list stays unread", async () => {
    const store = makeStore()
    // As adoption files it: the factory's intent, no origin.
    store.records.set(SIPA_EARLIER_USER_OP, {
      phase: "broadcast",
      intent: "user-op",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = userOpDeps([SIPA_EARLIER_USER_OP], store)
    mocks.readBlessedImplementations.mockRejectedValue(new Error("rpc down"))
    mocks.readSipaCloneImplementation.mockResolvedValue(EARLIER_USER_OP_IMPLEMENTATION)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 0 })

    expect(mocks.readSipaCloneImplementation).toHaveBeenCalledWith(
      expect.anything(),
      TUPLE.sipaFactory,
      SIPA_EARLIER_USER_OP,
    )
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({
      phase: "claimed",
      intent: "user-op",
      origin: expect.objectContaining({ implementation: EARLIER_USER_OP_IMPLEMENTATION }),
    })
  })

  it("follows a recorded user operation's origin without reading the blessed list", async () => {
    const store = makeStore()
    store.records.set(SIPA_EARLIER_USER_OP, {
      phase: "broadcast",
      intent: "user-op",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      origin: { implementation: EARLIER_USER_OP_IMPLEMENTATION },
    })
    const { deps, tokenService } = userOpDeps([SIPA_EARLIER_USER_OP], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 0 })

    expect(mocks.readBlessedImplementations).not.toHaveBeenCalled()
    expect(observedAddresses()).toEqual([SIPA_EARLIER_USER_OP])
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(mocks.readDepositFee).toHaveBeenCalledWith(expect.anything(), route(SipaIntent.UserOp))
  })

  it("backfills a recorded user operation's origin from the blessed implementation that derives it", async () => {
    const store = makeStore()
    store.records.set(SIPA_EARLIER_USER_OP, {
      phase: "broadcast",
      intent: "user-op",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps } = userOpDeps([], store, [USER_OP_IMPLEMENTATION, EARLIER_USER_OP_IMPLEMENTATION])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, USER_OP_HASH)])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_EARLIER_USER_OP)).toMatchObject({
      intent: "user-op",
      origin: expect.objectContaining({ implementation: EARLIER_USER_OP_IMPLEMENTATION }),
    })
  })
})

describe("syncSipaDeposits per-recipient passes", () => {
  const OTHER_RECIPIENT_HEX = "0x9999999999999999999999999999999999999999999999999999999999999999"
  const PORTAL = TUPLE.portal.toLowerCase()
  const empty = { balance: 0n, scaledBalance: 0n, fee: 100n, sweepable: false }

  /** The commitment of `secret` for `recipient`: here the derivation keys it on both, as the real one does. */
  const commitmentFor = (secret: ReturnType<typeof fr>, recipient: string) =>
    fr(`0xhash${secret.toString().slice(4, 8)}${recipient.slice(2, 6)}`)
  const depositEvent = (secret: ReturnType<typeof fr>, recipient: string) =>
    sipaEvent(secret, `0x${intentHashOf(commitmentFor(secret, recipient)).toString("hex")}`)
  const cursorKey = (recipient: string) => `${PORTAL}/${recipient}`.toLowerCase()

  /** A store that keeps one cursor per portal and recipient, as the real one does. */
  function cursorStore() {
    const base = makeStore()
    const cursors = new Map<string, bigint>()
    return {
      ...base,
      cursors,
      observedThrough: vi.fn(async (portal: string, recipient: string) =>
        cursors.get(`${portal}/${recipient}`.toLowerCase()),
      ),
      setObservedThrough: vi.fn(async (portal: string, recipient: string, block: bigint) => {
        cursors.set(`${portal}/${recipient}`.toLowerCase(), block)
      }),
      adoptObservedThrough: vi.fn(async () => undefined),
    }
  }

  function passFor(recipient: string, store: ReturnType<typeof cursorStore>) {
    const made = makeDeps(store as never)
    return { ...made, deps: { ...made.deps, recipient: { toString: () => recipient } as never } }
  }

  const record = (secret: ReturnType<typeof fr>, recipient: string, fields = {}) => ({
    phase: "broadcast",
    messageSecret: secret.toString(),
    recipientL2Address: recipient,
    startTime: 1,
    amount: "0",
    ...fields,
  })

  const observedBy = (pass: number) =>
    vi.mocked(observeSipas).mock.calls[pass]![1].subjects.map((s) => s.address)

  beforeEach(() => {
    mocks.computeStealthRecipientHash.mockImplementation(
      (secret: { toString(): string }, recipient: { toString(): string }) =>
        commitmentFor(secret as never, recipient.toString()),
    )
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
    mocks.readSweepEvents.mockResolvedValue([])
  })

  it.each([
    ["the two-key pass first", true],
    ["the one-key pass first", false],
  ])(
    "reads each recipient's SIPAs from that recipient's own cursor, %s",
    async (_order, twoKeyFirst) => {
      const store = cursorStore()
      store.cursors.set(cursorKey(RECIPIENT_HEX), HEAD - 10n)
      store.cursors.set(cursorKey(OTHER_RECIPIENT_HEX), HEAD - 1_000n)
      const observedFrom = (HEAD - 5_000n).toString()
      store.records.set(SIPA_A, record(SECRET_A, RECIPIENT_HEX, { observedFrom }))
      store.records.set(SIPA_B, record(SECRET_B, OTHER_RECIPIENT_HEX, { observedFrom }))
      mocks.fetchSipaEvents.mockResolvedValue([])
      // A sweep of the one-key SIPA inside the gap between the two cursors.
      mocks.readSweepEvents.mockImplementation(
        async (_c: unknown, sipa: string, from: bigint, to: bigint) =>
          sipa === SIPA_B && from <= HEAD - 500n && HEAD - 500n <= to
            ? [{ index: 7n, amount: 990_000n, blockNumber: HEAD - 500n, txHash: TX_HASH }]
            : [],
      )
      const twoKey = passFor(RECIPIENT_HEX, store)
      const oneKey = passFor(OTHER_RECIPIENT_HEX, store)

      for (const pass of twoKeyFirst ? [twoKey, oneKey] : [oneKey, twoKey])
        expect(await syncSipaDeposits(pass.deps)).toMatchObject({ failed: 0 })

      expect(oneKey.tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
      expect(twoKey.tokenService.claimSweptDeposit).not.toHaveBeenCalled()
      expect(store.records.get(SIPA_B)).toMatchObject({
        phase: "claimed",
        claimedInboxIndexes: ["7"],
      })
      const ranges = new Map(mocks.readSweepEvents.mock.calls.map((c) => [c[1], [c[2], c[3]]]))
      expect(ranges.get(SIPA_A)).toEqual([HEAD - 10n - 128n, HEAD])
      expect(ranges.get(SIPA_B)).toEqual([HEAD - 1_000n - 128n, HEAD])
      expect(store.cursors.get(cursorKey(RECIPIENT_HEX))).toBe(HEAD)
      expect(store.cursors.get(cursorKey(OTHER_RECIPIENT_HEX))).toBe(HEAD)
    },
  )

  it("asks the store to hand the portal-only cursor to the recipient it designates, before reading cursors", async () => {
    const store = cursorStore()
    mocks.fetchSipaEvents.mockResolvedValue([])

    await syncSipaDeposits({ ...passFor(RECIPIENT_HEX, store).deps, adoptLegacyCursor: true })

    expect(store.adoptObservedThrough).toHaveBeenCalledWith(PORTAL, RECIPIENT_HEX)
    expect(store.adoptObservedThrough.mock.invocationCallOrder[0]).toBeLessThan(
      store.observedThrough.mock.invocationCallOrder[0]!,
    )

    await syncSipaDeposits(passFor(OTHER_RECIPIENT_HEX, store).deps)

    expect(store.adoptObservedThrough).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["the recorded recipient first", true],
    ["the other recipient first", false],
  ])(
    "plans each recipient's own address for a salt both use, %s",
    async (_order, recordedFirst) => {
      const store = cursorStore()
      store.records.set(SIPA_B, record(SECRET_A, RECIPIENT_HEX))
      mocks.fetchSipaEvents.mockImplementation(
        async (_wallet: unknown, _token: unknown, recipient: { toString(): string }) => [
          depositEvent(SECRET_A, recipient.toString()),
        ],
      )
      const recorded = passFor(RECIPIENT_HEX, store)
      const other = passFor(OTHER_RECIPIENT_HEX, store)

      const passes = recordedFirst ? [recorded, other] : [other, recorded]
      for (const pass of passes)
        expect(await syncSipaDeposits(pass.deps)).toMatchObject({ failed: 0 })

      expect(observedBy(passes.indexOf(recorded))).toEqual([SIPA_B])
      expect(observedBy(passes.indexOf(other))).toEqual([SIPA_A])
      expect([...store.records.keys()].sort()).toEqual([SIPA_A, SIPA_B].sort())
      expect(store.records.get(SIPA_B)).toMatchObject({
        recipientL2Address: RECIPIENT_HEX,
        recipientHash: commitmentFor(SECRET_A, RECIPIENT_HEX).toString(),
      })
      expect(store.records.get(SIPA_A)).toMatchObject({
        recipientL2Address: OTHER_RECIPIENT_HEX,
        recipientHash: commitmentFor(SECRET_A, OTHER_RECIPIENT_HEX).toString(),
        replayed: true,
      })
    },
  )

  it.each([
    ["the recorded recipient first", true],
    ["the other recipient first", false],
  ])(
    "adopts a stray under the recipient whose plan it matched, %s",
    async (_order, recordedFirst) => {
      const store = cursorStore()
      store.records.set(SIPA_B, record(SECRET_A, RECIPIENT_HEX))
      mocks.fetchSipaEvents.mockImplementation(
        async (_wallet: unknown, _token: unknown, recipient: { toString(): string }) => [
          depositEvent(SECRET_A, recipient.toString()),
        ],
      )
      const stray = {
        portal: TUPLE.portal,
        recipientCommitment: commitmentFor(SECRET_A, OTHER_RECIPIENT_HEX).toString(),
        amount: 1n,
        key: `0x${"01".repeat(32)}`,
        index: 3n,
        blockNumber: HEAD - 5n,
        txHash: TX_HASH,
        logIndex: 0,
      }
      const real = vi.mocked(observeSipas).getMockImplementation()!
      const withStray: typeof real = async (client, params) => ({
        ...(await real(client, params)),
        strays: [stray as never],
      })
      vi.mocked(observeSipas).mockImplementationOnce(withStray).mockImplementationOnce(withStray)
      mocks.readSweepEmitters.mockResolvedValue([SIPA_C])
      const recorded = passFor(RECIPIENT_HEX, store)
      const other = passFor(OTHER_RECIPIENT_HEX, store)

      for (const pass of recordedFirst ? [recorded, other] : [other, recorded])
        expect(await syncSipaDeposits(pass.deps)).toMatchObject({ failed: 0 })

      expect(mocks.readSweepEmitters).toHaveBeenCalledTimes(1)
      expect(store.records.get(SIPA_C)).toMatchObject({
        recipientL2Address: OTHER_RECIPIENT_HEX,
        messageSecret: SECRET_A.toString(),
        recipientHash: stray.recipientCommitment,
        replayed: true,
      })
      expect(store.records.get(SIPA_B)).toMatchObject({ recipientL2Address: RECIPIENT_HEX })
      expect(store.records.get(SIPA_A)).toMatchObject({ recipientL2Address: OTHER_RECIPIENT_HEX })
    },
  )

  it("claims each recipient's own sweeps, a late one to the one-key address as the one-key account", async () => {
    const store = cursorStore()
    const oneKeyHash = depositEvent(SECRET_B, OTHER_RECIPIENT_HEX).intentHash
    mocks.computeSIPAAddress.mockImplementation((inputs: { intentHash: Buffer }) => ({
      toString: () => (`0x${inputs.intentHash.toString("hex")}` === oneKeyHash ? SIPA_B : SIPA_A),
    }))
    mocks.fetchSipaEvents.mockImplementation(
      async (_wallet: unknown, _token: unknown, recipient: { toString(): string }) =>
        recipient.toString() === RECIPIENT_HEX
          ? [depositEvent(SECRET_A, RECIPIENT_HEX)]
          : [depositEvent(SECRET_B, OTHER_RECIPIENT_HEX)],
    )
    const sweeps = new Map<string, bigint[]>([
      [SIPA_A, [7n]],
      [SIPA_B, [8n]],
    ])
    mocks.readSweepEvents.mockImplementation(async (_c: unknown, sipa: string) =>
      (sweeps.get(sipa) ?? []).map((index) => ({
        index,
        amount: 990_000n,
        blockNumber: 1n,
        txHash: TX_HASH,
      })),
    )
    const twoKey = passFor(RECIPIENT_HEX, store)
    const oneKey = passFor(OTHER_RECIPIENT_HEX, store)

    await syncSipaDeposits(twoKey.deps)
    await syncSipaDeposits(oneKey.deps)

    expect(twoKey.tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(oneKey.tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_A)).toMatchObject({
      recipientL2Address: RECIPIENT_HEX,
      claimedInboxIndexes: ["7"],
    })
    expect(store.records.get(SIPA_B)).toMatchObject({
      recipientL2Address: OTHER_RECIPIENT_HEX,
      claimedInboxIndexes: ["8"],
    })

    sweeps.set(SIPA_B, [8n, 9n])
    await syncSipaDeposits(twoKey.deps)
    await syncSipaDeposits(oneKey.deps)

    expect(twoKey.tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(oneKey.tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_B)).toMatchObject({ claimedInboxIndexes: ["8", "9"] })
  })
})

describe("a direct migration deposit", () => {
  /** The record key of a direct deposit: no SIPA holds it. */
  const KEY = "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1" as Address
  const COMMITMENT = `0xhash${SECRET_A.toString().slice(4, 8)}`
  const FROM_BLOCK = HEAD - 5_000n
  const DEPOSIT_BLOCK = HEAD - 4_000n
  /** The record written when its batch is sent, before the deposit lands. */
  const ensured = () => ({
    phase: "broadcast",
    recipientL2Address: RECIPIENT_HEX,
    messageSecret: SECRET_A.toString(),
    recipientHash: COMMITMENT,
    recoveryAddress: "",
    l1ChainId: 11155111,
    amount: "0",
    tokenSymbol: DAI.symbol,
    tokenAddress: DAI.address,
    tokenDecimals: DAI.decimals,
    startTime: 1,
    direct: { recipientCommitment: COMMITMENT, executor: SIPA_C, expected: "990000" },
    fee: "0",
    observedFrom: FROM_BLOCK.toString(),
    rescanFrom: FROM_BLOCK.toString(),
  })
  const landed = { index: 7n, amount: 990_000n, blockNumber: DEPOSIT_BLOCK, txHash: TX_HASH }
  const subjects = () => vi.mocked(observeSipas).mock.calls[0]?.[1].subjects ?? []

  it("is read with every SIPA from its batch's block, by its commitment alone, at no other L1 read", async () => {
    const store = makeStore()
    store.cursor = HEAD - 10n
    store.records.set(KEY, ensured())
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readSweepEvents.mockResolvedValue([])

    await syncSipaDeposits(deps)

    expect(vi.mocked(observeSipas).mock.calls[0]![1].subjects).toEqual([
      { address: KEY, commitment: COMMITMENT, fromBlock: FROM_BLOCK, inflows: false, direct: true },
    ])
    const client = deps.publicClient as unknown as Record<string, ReturnType<typeof vi.fn>>
    expect(client.getBalance).not.toHaveBeenCalled()
    expect(client.readContract).not.toHaveBeenCalled()
    expect(mocks.readSipaFundingStatus).not.toHaveBeenCalled()
    expect(mocks.readDepositFee).not.toHaveBeenCalled()
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(KEY)).toMatchObject({ phase: "broadcast", amount: "0" })
    expect(store.records.get(KEY)?.rescanFrom).toBeUndefined()
  })

  it("takes its seen deposit's claim inputs, then claims it like a sweep and reads it no more", async () => {
    const store = makeStore()
    store.cursor = HEAD - 10n
    store.records.set(KEY, ensured())
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readSweepEvents.mockImplementation(async (_c: unknown, address: string) =>
      address.toLowerCase() === KEY ? [landed] : [],
    )
    mocks.isL1ToL2MessageReady.mockResolvedValueOnce(false)

    await syncSipaDeposits(deps)

    expect(store.records.get(KEY)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "7",
      sweepTxHash: TX_HASH,
      netAmount: "990000",
      fee: "0",
      pendingSweeps: [
        {
          inboxIndex: "7",
          amount: "990000",
          messageKey: `0x${"0a".repeat(32)}`,
          blockNumber: DEPOSIT_BLOCK.toString(),
          sweepTxHash: TX_HASH,
        },
      ],
    })
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()

    // A later pass reads from the cursor: the saved claim inputs carry the deposit.
    mocks.readSweepEvents.mockResolvedValue([])
    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    const [claim] = tokenService.claimSweptDeposit.mock.calls[0]! as unknown as [
      { inboxIndex: bigint; amount: bigint; sharedSecretSalt: { toString(): string } },
    ]
    expect(claim).toMatchObject({ inboxIndex: 7n, amount: 990_000n })
    expect(claim.sharedSecretSalt.toString()).toBe(SECRET_A.toString())
    const record = store.records.get(KEY)
    expect(record).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["7"], fee: "0" })
    expect(record?.pendingSweeps).toBeUndefined()
    expect(sipaSweepsReceived(record as never)).toBe(true)

    vi.mocked(observeSipas).mockClear()
    await syncSipaDeposits(deps)
    expect(subjects()).toEqual([])
  })

  it("keeps reading the commitment after a smaller deposit from another sender, until the batch's amount is claimed", async () => {
    const store = makeStore()
    store.cursor = HEAD - 10n
    store.records.set(KEY, ensured())
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    const dust = { index: 6n, amount: 1n, blockNumber: DEPOSIT_BLOCK - 1n, txHash: TX_HASH }
    let seen = [dust]
    mocks.readSweepEvents.mockImplementation(async (_c: unknown, address: string) =>
      address.toLowerCase() === KEY ? seen : [],
    )

    await syncSipaDeposits(deps)
    expect(store.records.get(KEY)).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["6"] })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)

    // The dust is claimed, and the commitment is still read.
    seen = []
    vi.mocked(observeSipas).mockClear()
    await syncSipaDeposits(deps)
    expect(subjects()).toEqual([expect.objectContaining({ address: KEY, direct: true })])

    // The executor's deposit lands: the rail claims it, then reads the commitment no more.
    seen = [landed]
    await syncSipaDeposits(deps)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(KEY)).toMatchObject({ claimedInboxIndexes: ["6", "7"] })
    seen = []
    vi.mocked(observeSipas).mockClear()
    await syncSipaDeposits(deps)
    expect(subjects()).toEqual([])
  })

  it("keeps reading a claimed record with no batch amount: another sender can come first", async () => {
    const store = makeStore()
    store.cursor = HEAD - 10n
    const { expected: _, ...direct } = ensured().direct
    store.records.set(KEY, {
      ...ensured(),
      direct,
      phase: "claimed",
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweeps: [{ inboxIndex: "7", sweepTxHash: TX_HASH, netAmount: "990000" }],
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readSweepEvents.mockResolvedValue([])

    await syncSipaDeposits(deps)

    expect(subjects()).toEqual([expect.objectContaining({ address: KEY, direct: true })])
  })
})

describe("a direct deposit's announcement", () => {
  const COMMITMENT = `0x${"c0".repeat(32)}`
  const marker = (c: string) =>
    keccak256(
      Buffer.concat([
        keccak256(Buffer.from("oxide.direct-migration")),
        Buffer.from(c.slice(2), "hex"),
      ]),
    )
  const KEY = directDepositKey(COMMITMENT as `0x${string}`).toLowerCase()
  beforeEach(() => {
    // SECRET_A derives a real 32-byte commitment here, as on chain.
    mocks.computeStealthRecipientHash.mockImplementation((secret: { toString(): string }) =>
      secret.toString() === SECRET_A.toString()
        ? fr(COMMITMENT)
        : fr(`0xhash${secret.toString().slice(4, 8)}`),
    )
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      token: { address: DAI.address, symbol: DAI.symbol, decimals: DAI.decimals },
      status: { balance: 0n, sweepable: false },
    })
  })

  it("gives a browser with no batch records the direct deposit's record, and derives no SIPA", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A, `0x${marker(COMMITMENT).toString("hex")}`),
    ])

    await syncSipaDeposits(deps)

    expect(store.records.get(KEY)).toMatchObject({
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientHash: COMMITMENT,
      recipientL2Address: RECIPIENT_HEX,
      direct: { recipientCommitment: COMMITMENT },
      fee: "0",
      amount: "0",
    })
    expect(store.records.get(KEY)?.observedFrom).not.toBe(undefined)
    expect(mocks.computeSIPAAddress).not.toHaveBeenCalled()
    expect(mocks.computeAccountSIPAAddress).not.toHaveBeenCalled()
    expect(store.records.size).toBe(1)
    // The same pass reads it with every SIPA, by its commitment alone.
    expect(vi.mocked(observeSipas).mock.calls[0]![1].subjects).toEqual([
      expect.objectContaining({ address: KEY, commitment: COMMITMENT, direct: true }),
    ])
  })

  it("records the deposit on the row of the token that announced it", async () => {
    const SUSDS = {
      address: "0x5875eee11cf8398102fdad704c9e96607675467a" as Address,
      symbol: "sUSDS",
      decimals: 18,
    }
    const SUSDS_L2 = "0x1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff001"
    const SUSDS_PORTAL = "0x5b0d0000000000000000000000000000000005d5" as Address
    const { deps, store } = makeDeps()
    const rows = [
      row(DAI),
      row(SUSDS, {
        portal: SUSDS_PORTAL,
        l2Token: SUSDS_L2,
        intents: ["deposit"],
      }),
    ]
    mocks.fetchSipaEvents.mockImplementation(
      async (_wallet: unknown, token: { toString(): string }) =>
        token.toString().toLowerCase() === SUSDS_L2.toLowerCase()
          ? [sipaEvent(SECRET_A, `0x${marker(COMMITMENT).toString("hex")}`)]
          : [],
    )

    await syncSipaDeposits({ ...deps, rows })

    expect(store.records.get(KEY)).toMatchObject({
      tokenAddress: SUSDS.address,
      tokenSymbol: "sUSDS",
      tokenDecimals: 18,
      direct: { recipientCommitment: COMMITMENT, portal: SUSDS_PORTAL },
    })
  })

  it("leaves the pass incomplete when the direct deposit's record does not land", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A, `0x${marker(COMMITMENT).toString("hex")}`),
    ])
    store.upsert.mockRejectedValueOnce(new Error("quota exceeded"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 0, complete: false })
    expect(store.records.has(KEY)).toBe(false)
  })

  it("keeps the sending browser's own record and writes no other", async () => {
    const store = makeStore()
    const own = {
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientHash: COMMITMENT,
      recipientL2Address: RECIPIENT_HEX,
      amount: "0",
      tokenSymbol: DAI.symbol,
      startTime: 1,
      direct: { recipientCommitment: COMMITMENT, executor: SIPA_C },
      fee: "0",
      observedFrom: (HEAD - 100n).toString(),
    }
    store.records.set(KEY, own)
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A, `0x${marker(COMMITMENT).toString("hex")}`),
    ])

    await syncSipaDeposits(deps)

    expect(store.records.size).toBe(1)
    expect(store.records.get(KEY)).toMatchObject({
      direct: { recipientCommitment: COMMITMENT, executor: SIPA_C },
    })
    // The announcement writes nothing over it: only the pass's own read window is noted.
    expect(store.upsert.mock.calls.some(([, patch]) => "replayed" in patch)).toBe(false)
  })

  it("dates a replayed direct deposit by its deposit's block, not by when this browser found it", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A, `0x${marker(COMMITMENT).toString("hex")}`),
    ])
    mocks.readSweepEvents.mockImplementation(async (_c: unknown, address: string) =>
      address.toLowerCase() === KEY
        ? [{ index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH }]
        : [],
    )
    mocks.readBlockTimeMs.mockResolvedValue(1_700_000_000_000)

    await syncSipaDeposits(deps)

    expect(store.records.get(KEY)).toMatchObject({
      phase: "claimed",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_000_000,
    })
  })

  it("still reads an ordinary deposit event under the same commitment as a SIPA", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])

    await syncSipaDeposits(deps)

    expect(store.records.has(KEY)).toBe(false)
    expect(mocks.computeSIPAAddress).toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({ recipientHash: COMMITMENT })
    expect(store.records.get(SIPA_A)?.direct).toBeUndefined()
  })
})

describe("syncSipaDeposits complete", () => {
  const empty = { balance: 0n, scaledBalance: 0n, fee: 100n, sweepable: false }
  const funded = { balance: 500n, scaledBalance: 500n, fee: 100n, sweepable: true }
  const sweep = { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH }
  const observedRecord = (fields: Record<string, unknown> = {}) => ({
    phase: "broadcast",
    messageSecret: SECRET_A.toString(),
    recipientL2Address: RECIPIENT_HEX,
    startTime: 1,
    amount: "0",
    observedFrom: (HEAD - 1_000n).toString(),
    ...fields,
  })
  /** The next observation also sees a deposit to SECRET_A's commitment that no tracked SIPA sent. */
  const withStray = () => {
    const real = vi.mocked(observeSipas).getMockImplementation()!
    vi.mocked(observeSipas).mockImplementationOnce(async (client, params) => ({
      ...(await real(client, params)),
      strays: [
        {
          portal: TUPLE.portal,
          recipientCommitment: mocks.computeStealthRecipientHash(SECRET_A).toString(),
          amount: 1n,
          key: `0x${"01".repeat(32)}`,
          index: 3n,
          blockNumber: HEAD - 5n,
          txHash: TX_HASH,
          logIndex: 0,
        } as never,
      ],
    }))
  }

  beforeEach(() => {
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
  })

  it("is set by a pass that claims cleanly, and by one with nothing to read", async () => {
    mocks.readSweepEvents.mockResolvedValue([sweep])
    expect(await syncSipaDeposits(makeDeps().deps)).toMatchObject({ claimed: 1, complete: true })

    mocks.fetchSipaEvents.mockResolvedValue([])
    expect(await syncSipaDeposits(makeDeps().deps)).toMatchObject({ complete: true })
  })

  it("is cleared by a history start that fails to read, though the cursor was already set and moves", async () => {
    const store = makeStore()
    store.cursor = HEAD - 10n

    const result = await syncSipaDeposits({
      ...makeDeps(store).deps,
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    expect(result).toMatchObject({ failed: 0, complete: false })
    expect(store.cursor).toBe(HEAD)
  })

  it.each([
    ["adopting", () => mocks.readSweepEmitters.mockResolvedValue([SIPA_C]), true],
    [
      "failing to adopt",
      () => mocks.readSweepEmitters.mockRejectedValue(new Error("rpc down")),
      false,
    ],
  ])("is cleared by %s a stray", async (_, emitters, adopted) => {
    const store = makeStore()
    withStray()
    emitters()

    const result = await syncSipaDeposits(makeDeps(store).deps)

    expect(result).toMatchObject({ failed: 0, complete: false })
    expect(store.records.has(SIPA_C)).toBe(adopted)
  })

  it("is cleared by a sweep that fails", async () => {
    const { deps, tokenService } = makeDeps()
    mocks.readSweepEvents.mockResolvedValue([sweep])
    tokenService.claimSweptDeposit.mockRejectedValue(new Error("pxe busy"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 1, complete: false })
  })

  it("is cleared when a record write does not land and the cursor holds", async () => {
    const { deps, store } = makeDeps()
    mocks.readSweepEvents.mockResolvedValue([sweep])
    const upsert = store.upsert.getMockImplementation()!
    store.upsert.mockImplementation(async (address, patch, fallback) => {
      if (patch.phase === "claimed") throw new Error("quota exceeded")
      return upsert(address, patch, fallback)
    })

    expect(await syncSipaDeposits(deps)).toMatchObject({ complete: false })
    expect(store.cursor).toBeUndefined()
  })

  it("is cleared when the republish of a paid-again address throws", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({ phase: "claimed", inboxIndex: "7", claimedInboxIndexes: ["7"], fee: "100" }),
    )
    mocks.fetchSipaEvents.mockResolvedValue([{ ...sipaEvent(SECRET_A), resweepable: true }])
    mocks.readSipaFundingStatus.mockResolvedValue(funded)
    const onSweptAddressFunded = vi.fn(async () => {
      throw new Error("node down")
    })

    const result = await syncSipaDeposits({ ...makeDeps(store).deps, onSweptAddressFunded })

    expect(onSweptAddressFunded).toHaveBeenCalledWith(SIPA_A)
    expect(result).toMatchObject({ failed: 0, complete: false })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed" })
  })

  it("is cleared when the republish of an overdue address throws", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({ phase: "sweeping", startTime: Date.now() - 2 * 3_600_000 }),
    )
    mocks.readSipaFundingStatus.mockResolvedValue(funded)
    const onSweepOverdue = vi.fn(async (): Promise<boolean> => {
      throw new Error("node down")
    })

    const result = await syncSipaDeposits({ ...makeDeps(store).deps, onSweepOverdue })

    expect(onSweepOverdue).toHaveBeenCalledWith(SIPA_A)
    expect(result).toMatchObject({ failed: 0, complete: false })
  })

  it("is cleared by a funded address whose sweep it cannot price", async () => {
    mocks.readDepositFee.mockRejectedValue(new Error("rpc down"))
    mocks.readSipaFundingStatus.mockResolvedValue(funded)

    expect(await syncSipaDeposits(makeDeps().deps)).toMatchObject({ failed: 0, complete: false })
  })

  it("is cleared by a claimed sweep whose fee it cannot read", async () => {
    mocks.readSweepEvents.mockResolvedValue([sweep])
    mocks.readDepositFee.mockRejectedValue(new Error("rpc down"))

    expect(await syncSipaDeposits(makeDeps().deps)).toMatchObject({
      claimed: 1,
      failed: 0,
      complete: false,
    })
  })

  it("is cleared when the blessed user-op list cannot be read", async () => {
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, `0x${"88".repeat(32)}`)])
    mocks.readBlessedImplementations.mockRejectedValue(new Error("rpc down"))

    expect(await syncSipaDeposits(makeDeps().deps)).toMatchObject({ failed: 0, complete: false })
  })

  it("is cleared when the spent-sweep lookup fails", async () => {
    mocks.readSweepEvents.mockResolvedValue([sweep])
    mocks.readSipaDepositsConsumed.mockRejectedValue(new Error("node down"))

    const result = await syncSipaDeposits({
      ...makeDeps().deps,
      node: { findLeavesIndexes: vi.fn() } as never,
      masterNullifierHidingKey: { secret: "nhk" } as never,
    })

    expect(result).toMatchObject({ claimed: 1, failed: 0, complete: false })
  })

  it("is cleared when funding attribution fails", async () => {
    mocks.readSweepEvents.mockResolvedValue([sweep])
    mocks.readFundingTransfers.mockResolvedValue([
      { from: SIPA_B, amount: 1_000_000n, blockNumber: 5n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits({
      ...makeDeps().deps,
      onFundingWalletDetected: async () => {
        throw new Error("contacts down")
      },
    })

    expect(result).toMatchObject({ claimed: 1, failed: 0, complete: false })
  })

  it("is cleared when a claimed sweep's ledger entry does not land", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({ phase: "claimed", inboxIndex: "7", claimedInboxIndexes: ["7"] }),
    )
    const upsert = store.upsert.getMockImplementation()!
    store.upsert.mockImplementation(async (address, patch, fallback) => {
      if ("sweeps" in patch) throw new Error("quota exceeded")
      return upsert(address, patch, fallback)
    })
    mocks.readSweepEvents.mockResolvedValue([sweep])

    expect(await syncSipaDeposits(makeDeps(store).deps)).toMatchObject({
      failed: 0,
      complete: false,
    })
  })

  it("is cleared when the balance refresh fails", async () => {
    mocks.readSweepEvents.mockResolvedValue([sweep])

    const result = await syncSipaDeposits({
      ...makeDeps().deps,
      refreshBalance: async () => {
        throw new Error("node down")
      },
    })

    expect(result).toMatchObject({ claimed: 1, failed: 0, complete: false })
  })
})

describe("syncSipaDeposits skipCatchUp", () => {
  const sweep = { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH }

  beforeEach(() => {
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([sweep])
  })

  it("keeps a replaying pass from beginning a catch-up, which it begins without it", async () => {
    const begin = vi.spyOn(syncCatchUp, "begin")
    try {
      let catchingUp: boolean | undefined
      const refreshBalance = async () => {
        catchingUp = syncCatchUp.status.get()
      }

      await syncSipaDeposits({ ...makeDeps().deps, refreshBalance, skipCatchUp: true })
      expect(begin).not.toHaveBeenCalled()
      expect(catchingUp).toBe(false)

      await syncSipaDeposits({ ...makeDeps().deps, refreshBalance })
      expect(begin).toHaveBeenCalledTimes(1)
      expect(catchingUp).toBe(true)
    } finally {
      begin.mockRestore()
    }
  })

  it("keeps a pass from joining a catch-up in progress, which it joins without it", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      startTime: Date.now(),
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const outer = syncCatchUp.begin()
    const begin = vi.spyOn(syncCatchUp, "begin")
    try {
      await syncSipaDeposits({ ...makeDeps(store).deps, skipCatchUp: true })
      expect(begin).not.toHaveBeenCalled()

      await syncSipaDeposits(makeDeps(store).deps)
      expect(begin).toHaveBeenCalledTimes(1)
    } finally {
      begin.mockRestore()
      outer()
    }
  })
})
