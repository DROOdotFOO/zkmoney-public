/**
 * The browser's migration run is one session's: the account signed in under another passkey ends
 * its writes and its consent prompts, as another account signed in does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  session: vi.fn(async (o: unknown) => o),
  sign: vi.fn(async () => ({ signature: "0x01" })),
}))

vi.mock("@obsidion/front-core", () => ({
  createMetadataMigrationSession: h.session,
  pubkeyToR1KeyArg: (hex: string) => ({ qx: hex, qy: hex }),
  UpgradeActivity: { get: () => ({}) },
  SIPADepositStore: { get: () => ({}) },
  BalanceStorage: { get: () => ({}) },
  WalletSyncCoordinator: {},
  BROADCASTS_STORAGE_KEY: "broadcasts",
  NETWORK_STORAGE_KEY: "network",
  OPERATIONS_STORAGE_KEY: "operations",
}))
vi.mock("@obsidion/sdk", () => ({
  createLocalMetadataMigrationSource: vi.fn(),
  FrozenMetadataMigrationSource: class {},
  frozenRuntimeFromSourceGeneration: vi.fn(),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
vi.mock("../../../src/platform/session", () => ({
  session: () => ({ activity: { all: async () => [] } }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  l1MulticallClient: () => ({}),
  getFeeTokenBridgeTuple: async () => ({ portal: `0x${"ab".repeat(20)}` }),
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ signMetadataChallenge: h.sign }),
}))
vi.mock("../../../src/features/onboarding/oxideOnboarding", () => ({
  collectOnboardingKeys: async () => ({ secretKey: {}, pubkeyHex: "0x04ab", authProvider: {} }),
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: vi.fn(),
}))
vi.mock("../../../src/features/token/oxideToken", () => ({ portalContract: vi.fn() }))
vi.mock("../../../src/features/migration/historicTokenContext", () => ({
  sourceChain: vi.fn(),
  historicTokenContext: vi.fn(),
}))
vi.mock("../../../src/features/migration/sourceSipaSources", () => ({
  sourceSweptDeposits: vi.fn(),
}))

const { createWebMetadataMigration } = await import(
  "../../../src/features/migration/createWebMetadataMigration"
)
const { setActiveCredentialId, setActiveStorageId } = await import(
  "../../../src/platform/storage/activeStorage"
)
const { walletStorage } = await import("../../../src/platform/storage/walletStorage")
const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
const { SessionChangedError } = await import("../../../src/platform/auth/sessionErrors")

type Run = {
  storage: { setItem(key: string, value: string): Promise<void> }
  passkey: { signChallenge(digest: `0x${string}`, opts?: unknown): Promise<unknown> }
}

const tuple = { portal: `0x${"ab".repeat(20)}` } as never
const account = { getAddress: () => `0x${"01".repeat(32)}` } as never

beforeEach(() => {
  localStorage.clear()
  h.sign.mockClear()
})

async function compose(): Promise<Run> {
  setActiveStorageId("wallet-1")
  setActiveCredentialId("cred-a")
  await walletStorage.flush()
  const run = await createWebMetadataMigration({
    wallet: {} as never,
    account,
    contractService: {} as never,
    toTokenService: {} as never,
    historic: tuple,
    current: tuple,
  })
  return run as unknown as Run
}

describe("the browser's migration run", () => {
  it("writes and asks consent while its session stays", async () => {
    const run = await compose()
    await run.storage.setItem("k", "v")
    expect(await webStorage.getItem("k")).toBe("v")
    await run.passkey.signChallenge("0xaa")
    expect(h.sign).toHaveBeenCalledWith("0xaa", undefined)
  })

  it("ends once the account is signed in under another passkey", async () => {
    const run = await compose()
    setActiveCredentialId("cred-b")
    await walletStorage.flush()
    await expect(run.storage.setItem("k", "v")).rejects.toThrow(SessionChangedError)
    expect(() => run.passkey.signChallenge("0xaa")).toThrow(SessionChangedError)
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("ends once another account is signed in", async () => {
    const run = await compose()
    setActiveStorageId("wallet-2")
    await walletStorage.flush()
    await expect(run.storage.setItem("k", "v")).rejects.toThrow(SessionChangedError)
  })
})
