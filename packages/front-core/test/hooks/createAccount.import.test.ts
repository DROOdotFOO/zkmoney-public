import { describe, it, expect, beforeEach, vi } from "vitest"

// ---------------------------------------------------------------------------
// The import branch: a recovered passkey's two master-key candidates are
// checked against the stored address with a derivation that depends on BOTH
// the master key and the recovered signing key. The wrong key must never
// commit, and a security key with no stored address commits its preferred
// candidate on a device with no wallet.
// ---------------------------------------------------------------------------

const KEY = "aa".repeat(64)
const OTHER_KEY = "bb".repeat(64)
const MSK_A = { toString: () => "0x0a", toBuffer: () => Buffer.alloc(32, 0x0a) }
const MSK_B = { toString: () => "0x0b", toBuffer: () => Buffer.alloc(32, 0x0b) }

/** A derivation only (MSK_B, [KEY]) reproduces as "0xacct". */
const deriveAccountAddressMock = vi.fn(
  async (msk: { toString(): string }, passkeys: readonly string[]) => ({
    toString: () => (msk.toString() === "0x0b" && passkeys[0] === KEY ? "0xacct" : "0xother"),
  }),
)
const obsidionAccountStub = {
  getAddress: () => ({ toString: () => "0xacct" }),
  getCompleteAddress: () => ({ toString: () => "0xcomplete" }),
} as never
const getObsidionAccountWalletMock = vi.fn(async () => obsidionAccountStub)
const obsidionWalletStub = {
  createObsidionAccount: vi.fn(),
  getObsidionAccountWallet: getObsidionAccountWalletMock,
  deriveAccountAddress: deriveAccountAddressMock,
}

const addWebauthnAccountMock = vi.fn(async () => undefined)
const hasAccountMock = vi.fn(async () => false)
vi.mock("src/core", async () => {
  const actual = await vi.importActual<typeof import("src/core")>("src/core")
  return {
    ...actual,
    AccountStorage: {
      get: () => ({ addWebauthnAccount: addWebauthnAccountMock, hasAccount: hasAccountMock }),
    },
    NetworkStorage: { get: () => ({ isProd: async () => false }) },
  }
})

import { createAccount } from "src/hooks/createAccount"
import { AUTH_TYPE } from "@obsidion/sdk"

const commitSecretMock = vi.fn(async () => undefined)

function makeAuthService(recovered: Record<string, unknown>) {
  return {
    recoverPasskey: vi.fn(async () => ({
      authProvider: {},
      credentialId: "cred-1",
      pubkey: KEY,
      candidates: { first: MSK_A, second: MSK_B },
      preferredSlot: "first",
      hasPersistedSlot: true,
      candidateSource: "webauthn",
      expectedAddress: "0xacct",
      authenticatorType: "platform",
      ...recovered,
    })),
    commitSecret: commitSecretMock,
  } as never
}

function renderImport(authService: never) {
  type Args = Parameters<typeof createAccount> extends [unknown, ...infer A] ? A : never
  return (...args: Args) =>
    createAccount({ wallet: obsidionWalletStub as never, authService }, ...args)
}

describe("createAccount — import binds the recovered key into the address check", () => {
  beforeEach(() => {
    commitSecretMock.mockClear()
    getObsidionAccountWalletMock.mockClear()
    deriveAccountAddressMock.mockClear()
    addWebauthnAccountMock.mockClear()
  })

  it("commits the candidate whose (master key, key) address matches the stored one", async () => {
    const create = renderImport(makeAuthService({}))
    await create(true, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", "cred-1")
    expect(deriveAccountAddressMock).toHaveBeenCalledWith(MSK_A, [KEY])
    expect(deriveAccountAddressMock).toHaveBeenCalledWith(MSK_B, [KEY])
    expect(commitSecretMock).toHaveBeenCalledWith(expect.objectContaining({ secretKey: MSK_B }))
    expect(getObsidionAccountWalletMock).toHaveBeenCalledWith(MSK_B, {}, { register: true })
  })

  it("refuses when the recovered key reproduces the address for no candidate", async () => {
    const create = renderImport(makeAuthService({ pubkey: OTHER_KEY }))
    await expect(create(true, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", "cred-1")).rejects.toThrow(
      /does not match the stored account address/,
    )
    expect(deriveAccountAddressMock).toHaveBeenCalledWith(MSK_A, [OTHER_KEY])
    expect(commitSecretMock).not.toHaveBeenCalled()
    expect(getObsidionAccountWalletMock).not.toHaveBeenCalled()
  })

  it("a security key with no stored address commits its preferred candidate on an empty device", async () => {
    const create = renderImport(
      makeAuthService({ expectedAddress: undefined, authenticatorType: "security-key" }),
    )
    await create(true, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", "cred-1")
    expect(deriveAccountAddressMock).not.toHaveBeenCalled()
    expect(commitSecretMock).toHaveBeenCalledWith(expect.objectContaining({ secretKey: MSK_A }))
  })
})
