import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Address, Hex } from "viem"
import type {
  PendingRegistrationRecord,
  SIPADepositRecord,
  SipaRecoveryDeps,
} from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  pending: null as PendingRegistrationRecord | null,
  derive: vi.fn(),
  makeDeriver: vi.fn(),
  run: vi.fn<(deps: SipaRecoveryDeps) => Promise<Hex>>(),
  readDeployed: vi.fn(async () => true),
  readContract: vi.fn(async () => 10n),
  tuple: { token: `0x${"11".repeat(20)}`, sipaFactory: `0x${"22".repeat(20)}` },
}))
const secret = new Fr(123n)
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  detectHistoricDeployments: async () => ({ historic: [] }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRegistrationSipaDeriver: h.makeDeriver,
  deriveStealthKey: () => ({ scalar: 1n, publicKey: { x: 1n, y: 2n } }),
  runSipaRecovery: h.run,
  SIPADepositStore: { get: () => ({ upsert: vi.fn() }) },
}))
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ l1ChainId: 31337, network: "sandbox" }),
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ readContract: h.readContract }),
  getOxideTuple: async () => h.tuple,
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  oxideEnvFor: async () => ({
    tuple: h.tuple,
    env: {},
    publicClient: { readContract: h.readContract },
  }),
}))
vi.mock("../../../../src/features/onboarding/webRegistration", () => ({
  registrationRecordForSipa: () => h.pending,
  getPendingStore: () => ({ get: () => null, upsert: vi.fn() }),
}))
vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    getSecretKey: async () => secret,
    sessionKeys: async () => ({ secretKey: secret, authProvider: {} }),
  }),
}))
vi.mock("../../../../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => true }))
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({}))
vi.mock("../../../../src/features/deposit/sipaSweep", () => ({ readSipaDeployed: h.readDeployed }))
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../../support/depositTokens")
  return mockLoadDepositFacts(importOriginal, () => singleToken(h.tuple.token as Address))
})

const { recoverDeposit } = await import("../../../../src/features/deposit/sipaRecovery")
const sipa = `0x${"33".repeat(20)}` as Address
const owner = `0x${"44".repeat(20)}` as Address
const beneficiary = `0x${"55".repeat(20)}` as Address
const nameHash = `0x${"66".repeat(32)}` as Hex
const l2Address = `0x${"77".repeat(32)}` as Hex
const sipaArgs = {
  implementation: `0x${"88".repeat(20)}` as Address,
  intentHash: nameHash,
  recoveryAddress: owner,
  rollupVersion: 7n,
  resweepable: false,
}
const deposit: SIPADepositRecord = {
  sipaAddress: sipa,
  recipientL2Address: l2Address,
  messageSecret: nameHash,
  recipientHash: nameHash,
  recoveryAddress: owner,
  l1ChainId: 31337,
  amount: "1",
  tokenSymbol: "DAI",
  phase: "recoverable",
  startTime: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.pending = {
    account: owner,
    tag: "demo",
    nameHash,
    l2Address,
    l1ChainId: 31337,
    sipaAddress: sipa,
    fee: "12345678901234567890",
    beneficiary,
    depositToken: h.tuple.token as Address,
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: 1,
  }
  h.makeDeriver.mockReturnValue(h.derive)
  h.derive.mockResolvedValue({ sipaArgs })
  h.run.mockResolvedValue(nameHash)
})

describe("registration recovery derivation", () => {
  it.each(["12345678901234567890", "0"])(
    "uses the stored fee %s and beneficiary for the original address",
    async (fee) => {
      h.readDeployed.mockResolvedValueOnce(false)
      h.pending!.fee = fee
      await expect(recoverDeposit(deposit, { destination: owner })).resolves.toBe(nameHash)
      expect(h.derive).toHaveBeenCalledTimes(1)
      expect(h.derive).toHaveBeenCalledWith({
        owner,
        nameHash,
        l2Address,
        fee: BigInt(fee),
        beneficiary,
        masterSecret: secret,
      })
      expect(h.run.mock.calls[0][0].deployment.candidates).toEqual([
        { protocol: "legacy-eoa", sipaFactory: h.tuple.sipaFactory, args: sipaArgs },
      ])
    },
  )

  it.each(["fee", "beneficiary"] as const)(
    "does not invent a registration candidate when the stored %s is absent",
    async (field) => {
      delete h.pending![field]
      await recoverDeposit(deposit, { destination: owner })
      expect(h.makeDeriver).not.toHaveBeenCalled()
      expect(h.run.mock.calls[0][0].deployment.candidates).toEqual([])
      // A deployed legacy address can still use the existing direct-recovery path.
      await expect(h.run.mock.calls[0][0].deployment.readDeployed(sipa)).resolves.toBe(true)
    },
  )
})
