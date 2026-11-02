// @vitest-environment node
import { Fr } from "@aztec-labs/aztec.js/fields"
import { BackupRotationStore, deriveBootstrapKey } from "@obsidion/front-core"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import {
  encodeUserHandle,
  runBackupPasskeyCreation,
  type PasskeyCeremony,
} from "@obsidion/passkey-web"
import { ContractService, type FundingAmount, type ObsidionWallet } from "@obsidion/sdk"
import type { Address } from "viem"
import { describe, expect, it, vi } from "vitest"
import { DepositReadError, EmptyDepositError } from "../../../src/features/deposit/depositReadErrors"
import {
  OWNER as RECORD_OWNER,
  PLAN,
  SIPA,
  addr,
  signedRecord,
  storedRotation,
  word,
} from "../../support/backupAdd"
import { MemoryStorage } from "../../support/fakePasskeyCeremony"

// What the flow's dependencies read off the session and the other services, set per test.
const fakes = vi.hoisted(() => ({
  store: {} as unknown,
  keys: undefined as unknown,
  sponsor: { fpcAddress: { fpc: true }, fpcArtifact: { artifact: true } },
  tokenService: { setTeeSigner: vi.fn(), sendTokenSponsored: vi.fn(async () => undefined) },
  client: {} as unknown,
  tuple: {} as unknown,
  observe: vi.fn(),
  seed: vi.fn(),
  readStrandedToken: vi.fn(),
  envFactory: `0x${"af".repeat(20)}`,
  generations: vi.fn(),
}))

const ACCOUNT_FACTORY = `0x${"af".repeat(20)}`
const h = vi.hoisted(() => ({ auth: { providerFor: () => ({}) } as Record<string, unknown> }))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => h.auth }))
vi.mock("../../../src/features/identity/walletIdentity", () => ({ loadWalletIdentity: () => null }))
vi.mock("../../../src/features/backupPasskey/backupRotationStore", () => ({
  getBackupRotationStore: () => fakes.store,
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getFeeTokenBridgeTuple: async () => ({
    plainWithdrawalExecutor: `0x${"e8".repeat(20)}`,
    l2Token: `0x${"2a".repeat(32)}`,
  }),
  l1PublicClient: () => fakes.client,
  oxideEnvFor: async () => ({
    resolver: { owner: `0x${"0d".repeat(20)}` },
    env: { factory: fakes.envFactory },
  }),
}))
vi.mock("../../../src/features/onboarding/oxideGenerations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/oxideGenerations")>()),
  loadOxideGenerations: fakes.generations,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  observeSipas: fakes.observe,
}))
vi.mock("../../../src/features/deposit/sipaRecovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/deposit/sipaRecovery")>()),
  readStrandedToken: fakes.readStrandedToken,
}))
vi.mock("../../../src/features/backupPasskey/rotationPublish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/backupPasskey/rotationPublish")>()),
  seedRotationDeposit: fakes.seed,
}))
vi.mock("../../../src/platform/storage/activeStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/platform/storage/activeStorage")>()),
  getActiveCredentialId: () => "root-credential",
}))
vi.mock("../../../src/features/onboarding/registrationResume", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/features/onboarding/registrationResume")
  >()
  return {
    ...real,
    unlockedSessionKeys: (async (...args) =>
      fakes.keys ?? real.unlockedSessionKeys(...args)) as typeof real.unlockedSessionKeys,
  }
})
vi.mock("../../../src/features/token/oxideToken", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/token/oxideToken")>()),
  currentTxAmountCap: async () => 2n * 10n ** 18n,
  teeSignerOfToken: async () => ({}),
}))
vi.mock("../../../src/features/token/l2TokenService", () => ({
  l2TokenService: () => fakes.tokenService,
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/claimSponsorship")>()),
  claimSponsorContext: async () => fakes.sponsor,
}))
vi.mock("../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readBridgeDestination: async () => fakes.tuple,
}))

const {
  backupUserName,
  buildBackupAddDeps,
  buildBackupFlowDeps,
  depositedAmount,
  signedChangeFor,
  sweepFunding,
} = await import("../../../src/features/backupPasskey/backupPasskeyRuntime")

const OWNER = `0x${"ab".repeat(20)}` as Address

describe("buildBackupAddDeps", () => {
  it("creates through the auth service under the session's name, with the pick and the signal", async () => {
    const secret = Buffer.alloc(32, 7)
    const seen: Record<string, unknown>[] = []
    const creation = { kind: "creation" }
    Object.assign(h.auth, {
      sessionKeys: async () => ({
        secretKey: { toBuffer: () => secret },
        authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] },
      }),
      createBackupPasskey: async (
        driver: unknown,
        ceremony: unknown,
        opts: Record<string, unknown>,
      ) => {
        seen.push({ driver, ceremony, ...opts })
        return creation
      },
    })
    const wallet = { createObsidionAccount: async () => ({}) } as unknown as ObsidionWallet
    const ceremony = { kind: "ceremony" } as unknown as PasskeyCeremony
    const observe = () => {}
    const signal = new AbortController().signal

    const picked = await buildBackupAddDeps({ wallet, owner: OWNER, choice: "phone" })
    expect(picked.owner).toBe(OWNER)
    expect(picked.masterKey()).toEqual(new Uint8Array(secret))
    await expect(picked.create(ceremony, observe, signal)).resolves.toBe(creation)
    expect(seen[0]).toEqual({
      driver: runBackupPasskeyCreation,
      ceremony,
      userName: "0xabab…abab",
      choice: "phone",
      observe,
      signal,
    })

    const unpicked = await buildBackupAddDeps({ wallet, owner: OWNER })
    await unpicked.create(ceremony, observe)
    expect(seen[1]).toEqual({
      driver: runBackupPasskeyCreation,
      ceremony,
      userName: "0xabab…abab",
      observe,
    })
  })
})

describe("backupUserName", () => {
  it("uses the tag when the identity has one", () => {
    expect(backupUserName("brave-otter-42", OWNER)).toBe("brave-otter-42")
  })

  it("falls back to a short owner the user handle accepts", () => {
    for (const handle of [undefined, ""]) {
      const name = backupUserName(handle, OWNER)
      expect(name).toBe("0xabab…abab")
      expect(() => encodeUserHandle(name)).not.toThrow()
    }
    expect(() => encodeUserHandle(OWNER)).toThrow()
  })
})

describe("sweepFunding", () => {
  const live = (over: Partial<FundingAmount["breakdown"]> = {}): FundingAmount => {
    const breakdown = {
      withdrawalFee: 10n,
      proverTip: 0n,
      relayerTip: 5n,
      sweepTip: 7n,
      beneficiaryFee: 3n,
      minCredited: 100n,
      margin: 50n,
      ...over,
    }
    const credited = breakdown.minCredited + breakdown.margin
    const b = breakdown
    return {
      amount:
        b.withdrawalFee + b.proverTip + b.relayerTip + b.sweepTip + b.beneficiaryFee + credited,
      credited,
      breakdown,
    }
  }

  it("is what the deposit address holds once the funding is withdrawn: the live amount before a plan, the saved one after", () => {
    expect(sweepFunding(live(), undefined)).toBe(7n + 3n + 150n)
    expect(sweepFunding(live(), "175")).toBe(160n)
  })

  it("keeps for the plan what reaches the deposit address, without the withdrawal's charges", () => {
    expect(depositedAmount(live(), 175n)).toBe(160n)
    expect(depositedAmount(live({ proverTip: 4n }), 175n)).toBe(156n)
  })

  it("refuses a saved funding the route's current charges no longer leave sweepable", () => {
    expect(sweepFunding(live({ withdrawalFee: 70n }), "175")).toBeUndefined()
    expect(sweepFunding(live({ minCredited: 200n }), "175")).toBeUndefined()
    expect(sweepFunding(live({ sweepTip: 60n }), "175")).toBeUndefined()
  })
})

describe("signedChangeFor", () => {
  const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
  const rotation = {
    expectedKeys: [{ key: { qx: word(14), qy: word(15) } }],
    builtOver: { l2Address: word(10) },
    add: { pubkey: { qx: word(21), qy: word(22) } },
  }
  const root = `${word(14).slice(2)}${word(15).slice(2)}`

  it("refuses a session signed in with another passkey", () => {
    const other = `${word(21).slice(2)}${word(22).slice(2)}`
    expect(() => signedChangeFor(rotation, other)).toThrow("first passkey")
    expect(() => signedChangeFor({ ...rotation, expectedKeys: [] }, root)).toThrow("first passkey")
  })

  it("refuses a record with nothing signed", () => {
    expect(() => signedChangeFor(undefined, root)).toThrow("nothing signed")
  })
})

describe("the move's send", () => {
  /** Flow deps over a rerooted record whose one-key and two-key accounts are the signed change's. */
  const moveDeps = async () => {
    const rotation = storedRotation()
    const root = rotation.expectedKeys[0]!.key
    const source = rotation.builtOver.l2Address
    fakes.keys = {
      secretKey: {},
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: {},
      authProvider: {},
    }
    const store = new BackupRotationStore(new MemoryStorage())
    await store.put(signedRecord({ phase: "rerooted" }))
    fakes.store = store
    const contractService = { contractService: true }
    vi.spyOn(ContractService, "getInstance").mockReturnValue(contractService as never)
    // The one-key account is the signed change's source; the two-key address is the plan's.
    const wallet = {
      deriveAccountAddress: async (_secret: unknown, set: string[]) => ({
        toString: () => (set.length === 1 ? source : PLAN.address),
      }),
      createObsidionAccount: async () => ({ getAddress: () => ({ toString: () => source }) }),
      node: {},
    } as unknown as ObsidionWallet
    return {
      deps: await buildBackupFlowDeps({ wallet, owner: RECORD_OWNER }),
      wallet,
      contractService,
    }
  }

  it("gives the root key the send's signal while it sends, and none after", async () => {
    let signalOf: (() => AbortSignal | undefined) | undefined
    const providerFor = h.auth.providerFor
    h.auth.providerFor = (passkey: { signal?: () => AbortSignal | undefined }) => {
      signalOf = passkey.signal
      return {}
    }
    const asked: (AbortSignal | undefined)[] = []
    fakes.tokenService.sendTokenSponsored.mockImplementationOnce(async () => {
      asked.push(signalOf?.())
    })
    try {
      const { deps } = await moveDeps()
      const screen = new AbortController()
      await deps.move.send("tok", 1n, vi.fn(), screen.signal)
      expect(asked).toEqual([screen.signal])
      expect(signalOf?.()).toBeUndefined()
    } finally {
      h.auth.providerFor = providerFor
    }
  })
})

describe("the stranded deposit's recovery", () => {
  const tuple = { factory: addr(0xfa), token: addr(0xd4), portal: addr(0x90) }
  const secretKey = new Fr(5n)
  // The account the bootstrap key predicts under the factory the recovery checks.
  const owner = predictAccountAddressLocally(
    ACCOUNT_FACTORY as Address,
    deriveBootstrapKey(secretKey).address,
  )
  const record = signedRecord({
    owner,
    phase: "attention",
    attention: "stranded",
    suspended: "funded",
  })

  const setup = async (envFactory = ACCOUNT_FACTORY) => {
    const store = new BackupRotationStore(new MemoryStorage())
    await store.put(record)
    const root = storedRotation().expectedKeys[0]!.key
    fakes.store = store
    fakes.keys = {
      secretKey,
      pubkeyHex: `0x${root.qx.slice(2)}${root.qy.slice(2)}`,
      account: {},
      authProvider: {},
    }
    fakes.client = { getBlockNumber: async () => 99n }
    fakes.tuple = tuple
    fakes.envFactory = envFactory
    fakes.seed.mockReset().mockResolvedValue({ sipaAddress: SIPA })
    fakes.readStrandedToken.mockReset().mockResolvedValue({ balance: "1.4" })
    fakes.generations.mockReset()
    vi.spyOn(ContractService, "getInstance").mockReturnValue({} as never)
    return buildBackupFlowDeps({ wallet: {} as ObsidionWallet, owner })
  }

  it("reads the latest recovery at the deposit address", async () => {
    const deps = await setup()
    fakes.observe.mockResolvedValue({
      observed: new Map([
        [
          SIPA.toLowerCase(),
          { sweeps: [], outflows: [], recoveries: [{ txHash: word(1) }, { txHash: word(2) }] },
        ],
      ]),
      strays: [],
    })
    expect(await deps.l1.recovery(SIPA, 50)).toBe(word(2))
    expect(fakes.observe).toHaveBeenCalledWith(fakes.client, {
      portals: [tuple.portal],
      tokens: [tuple.token],
      subjects: [
        {
          address: SIPA,
          commitment: storedRotation().intent.recipientCommitment,
          fromBlock: 50n,
          inflows: false,
        },
      ],
      head: 99n,
    })
    fakes.observe.mockResolvedValue({ observed: new Map(), strays: [] })
    await expect(deps.l1.recovery(SIPA, 50)).rejects.toThrow("did not complete")
  })

  it("keeps the read's own words for the user, and passes an empty address through", async () => {
    const deps = await setup()
    fakes.readStrandedToken.mockRejectedValueOnce(new Error("Switch networks and try again."))
    const failed = deps.strandedDeposit(record)
    await expect(failed).rejects.toBeInstanceOf(DepositReadError)
    await expect(failed).rejects.toThrow("Switch networks and try again.")
    fakes.readStrandedToken.mockRejectedValueOnce(new EmptyDepositError())
    await expect(deps.strandedDeposit(record)).rejects.toBeInstanceOf(EmptyDepositError)
    fakes.seed.mockRejectedValueOnce(new Error("nothing signed to publish"))
    await expect(deps.strandedDeposit(record)).rejects.not.toBeInstanceOf(DepositReadError)
  })

  it("names the factory of an account an earlier generation made from the deployment's catalog, once", async () => {
    const deps = await setup(addr(0x01))
    fakes.generations.mockResolvedValue({
      catalog: [{ accountFactory: addr(0x02) }, { accountFactory: ACCOUNT_FACTORY }],
    })
    await deps.strandedDeposit(record)
    await deps.strandedDeposit(record)
    expect(fakes.seed).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountFactory: ACCOUNT_FACTORY }),
    )
    expect(fakes.generations).toHaveBeenCalledTimes(1)

    const missing = await setup(addr(0x01))
    fakes.generations.mockResolvedValue({ catalog: [{ accountFactory: addr(0x02) }] })
    await expect(missing.strandedDeposit(record)).rejects.toThrow("no account factory")
    await expect(missing.strandedDeposit(record)).rejects.toThrow("no account factory")
    expect(fakes.generations).toHaveBeenCalledTimes(2)
  })
})
