/**
 * The account on a rollup a cutover left is opened once per node from the session's key pair: a
 * session signing with another key re-signs it, a failed re-sign keeps the account as it was, and
 * an account that is not the session's opens nothing.
 */
import { describe, expect, it, vi } from "vitest"
import { seedBootConfig } from "../support/seedBootConfig"

const h = vi.hoisted(() => ({
  sessionKeys: vi.fn(),
  create: vi.fn(),
  createObsidionAccount: vi.fn(),
}))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNode: () => ({
    getL1ContractAddresses: async () => ({ rollupAddress: { toString: () => "0xrollup" } }),
  }),
  ObsidionWallet: { create: h.create },
}))
vi.mock("../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ sessionKeys: h.sessionKeys }),
}))
vi.mock("../../src/platform/storage/createPxeStore", () => ({
  createPxeStore: async () => ({ close: async () => {} }),
}))

await seedBootConfig()
const { openSourceRollupWallet } = await import("../../src/platform/sourceRollupWallet")
const { SessionChangedError } = await import("../../src/platform/auth/sessionErrors")

const session = () => ({ secretKey: {}, authProvider: {} })
const accountOn = (authProvider: unknown) => ({ getAuthProvider: () => authProvider } as never)

let nodes = 0
function setup(keys: ReturnType<typeof session>) {
  h.sessionKeys.mockReset()
  h.sessionKeys.mockResolvedValue(keys)
  h.createObsidionAccount.mockReset()
  h.createObsidionAccount.mockImplementation(async (_key: unknown, authProvider: unknown) =>
    accountOn(authProvider),
  )
  h.create.mockReset()
  h.create.mockResolvedValue({ createObsidionAccount: h.createObsidionAccount })
  return `https://node-${++nodes}.example`
}

describe("the source rollup wallet", () => {
  it("re-signs the account when the session signs with another key", async () => {
    const alice = session()
    const bob = session()
    const node = setup(alice)
    const first = await openSourceRollupWallet(node, accountOn(alice.authProvider))
    h.sessionKeys.mockResolvedValue(bob)
    const resigned = await openSourceRollupWallet(node, accountOn(bob.authProvider))
    expect(resigned.wallet).toBe(first.wallet)
    expect(resigned.account.getAuthProvider()).toBe(bob.authProvider)
    expect(h.createObsidionAccount).toHaveBeenLastCalledWith(bob.secretKey, bob.authProvider)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(await openSourceRollupWallet(node, accountOn(bob.authProvider))).toBe(resigned)
    expect(h.createObsidionAccount).toHaveBeenCalledTimes(2)
  })

  it("keeps the account as it was when the re-sign fails", async () => {
    const alice = session()
    const node = setup(alice)
    const first = await openSourceRollupWallet(node, accountOn(alice.authProvider))
    h.sessionKeys.mockResolvedValueOnce(undefined)
    await expect(openSourceRollupWallet(node, accountOn({}))).rejects.toThrow(/Unlock/)
    expect(await openSourceRollupWallet(node, accountOn(alice.authProvider))).toBe(first)
    expect(h.createObsidionAccount).toHaveBeenCalledTimes(1)
  })

  it("opens nothing for an account that is not the session's", async () => {
    const alice = session()
    const node = setup(alice)
    await expect(openSourceRollupWallet(node, accountOn({}))).rejects.toThrow(SessionChangedError)
    const first = await openSourceRollupWallet(node, accountOn(alice.authProvider))
    // A stale account handed in later is refused too, and the session's account stays.
    await expect(openSourceRollupWallet(node, accountOn({}))).rejects.toThrow(SessionChangedError)
    expect(await openSourceRollupWallet(node, accountOn(alice.authProvider))).toBe(first)
    expect(h.createObsidionAccount).toHaveBeenCalledTimes(1)
  })
})
