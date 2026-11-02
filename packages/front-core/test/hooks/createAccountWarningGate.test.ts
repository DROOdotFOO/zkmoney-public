import { describe, it, expect, beforeEach, vi } from "vitest"

// ---------------------------------------------------------------------------
// The no-backup warning gate is the single fund-safety seam
// between a declined warning and an irreversible on-chain deploy + committed
// MSK. This test pins the ordering invariant: a security-key create must await
// the acknowledgement, and a DECLINE must abort BEFORE createObsidionAccount /
// recordRecoveryMetadata / commitSecret / storeAccount run.
// ---------------------------------------------------------------------------

const order: string[] = []

const obsidionAccountStub = {
  getAddress: () => ({ toString: () => "0xacct" }),
  getCompleteAddress: () => ({ toString: () => "0xcomplete" }),
} as never

const createObsidionAccountMock = vi.fn(async () => {
  order.push("createObsidionAccount")
  return obsidionAccountStub
})
const obsidionWalletStub = {
  createObsidionAccount: createObsidionAccountMock,
  getObsidionAccountWallet: vi.fn(),
  deriveAccountAddress: vi.fn(),
}

const addWebauthnAccountMock = vi.fn(async () => undefined)
const hasAccountMock = vi.fn(async () => false)
const isProdMock = vi.fn(async () => false)
vi.mock("src/core", async () => {
  const actual = await vi.importActual<typeof import("src/core")>("src/core")
  return {
    ...actual,
    AccountStorage: {
      get: () => ({ addWebauthnAccount: addWebauthnAccountMock, hasAccount: hasAccountMock }),
    },
    NetworkStorage: { get: () => ({ isProd: isProdMock }) },
  }
})

import { createAccount } from "src/hooks/createAccount"
import { AUTH_TYPE } from "@obsidion/sdk"

const recordRecoveryMetadataMock = vi.fn(async () => undefined)
const commitSecretMock = vi.fn(async () => undefined)

function makeAuthService(authenticatorType: "platform" | "security-key") {
  return {
    createPasskey: vi.fn(async () => ({
      authProvider: {},
      credentialId: "cred-1",
      pubkey: "aa".repeat(64),
      secretKey: { toBuffer: () => Buffer.alloc(32) },
      prfSlot: "first",
      prfAaguid: "00000000-0000-0000-0000-000000000000",
      authenticatorType,
    })),
    recordRecoveryMetadata: recordRecoveryMetadataMock,
    commitSecret: commitSecretMock,
  } as never
}

function renderCreate(authService: never) {
  type Args = Parameters<typeof createAccount> extends [unknown, ...infer A] ? A : never
  return (...args: Args) =>
    createAccount({ wallet: obsidionWalletStub as never, authService }, ...args)
}

describe("createAccount — no-backup warning gate", () => {
  beforeEach(() => {
    order.length = 0
    createObsidionAccountMock.mockClear()
    recordRecoveryMetadataMock.mockClear()
    commitSecretMock.mockClear()
    addWebauthnAccountMock.mockClear()
  })

  it("DECLINE: aborts with zero on-chain/committed state (no deploy, record, commit, or storeAccount)", async () => {
    const create = renderCreate(makeAuthService("security-key"))

    await expect(
      create(false, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", undefined, {
        mode: "combined",
        onSecurityKeyDetected: async () => false,
      }),
    ).rejects.toMatchObject({ code: "account.creationCancelled" })

    expect(createObsidionAccountMock).not.toHaveBeenCalled()
    expect(recordRecoveryMetadataMock).not.toHaveBeenCalled()
    expect(commitSecretMock).not.toHaveBeenCalled()
    expect(addWebauthnAccountMock).not.toHaveBeenCalled()
  })

  it("ACCEPT: the warning is acknowledged STRICTLY BEFORE the on-chain deploy, then the flow commits", async () => {
    const create = renderCreate(makeAuthService("security-key"))
    const onSecurityKeyDetected = vi.fn(async () => {
      order.push("ack")
      return true
    })

    await create(false, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", undefined, {
      mode: "combined",
      onSecurityKeyDetected,
    })

    expect(onSecurityKeyDetected).toHaveBeenCalledTimes(1)
    // The gate strictly precedes the irreversible deploy.
    expect(order).toEqual(["ack", "createObsidionAccount"])
    expect(recordRecoveryMetadataMock).toHaveBeenCalledTimes(1)
    expect(commitSecretMock).toHaveBeenCalledTimes(1)
    expect(addWebauthnAccountMock).toHaveBeenCalledTimes(1)
  })

  it("PLATFORM: a platform-class create never invokes the warning gate", async () => {
    const create = renderCreate(makeAuthService("platform"))
    const onSecurityKeyDetected = vi.fn(async () => true)

    await create(false, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", undefined, {
      mode: "platform",
      onSecurityKeyDetected,
    })

    expect(onSecurityKeyDetected).not.toHaveBeenCalled()
    expect(createObsidionAccountMock).toHaveBeenCalledTimes(1)
  })

  it("hands the caller's signal to the passkey creation, so abandoning it closes the prompt", async () => {
    const authService = makeAuthService("platform")
    const create = renderCreate(authService)
    const controller = new AbortController()

    await create(false, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", undefined, {
      signal: controller.signal,
    })

    const { createPasskey } = authService as unknown as { createPasskey: ReturnType<typeof vi.fn> }
    expect(createPasskey).toHaveBeenCalledWith(
      "@x",
      expect.any(Function),
      expect.objectContaining({ signal: controller.signal }),
    )
  })
})

describe("createAccount — caller recovery checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("saves the credential and account before committing the session", async () => {
    const create = renderCreate(makeAuthService("platform"))
    let saved = false
    commitSecretMock.mockImplementationOnce(async () => {
      expect(saved).toBe(true)
    })
    const checkpoint = vi.fn(async (account) => {
      expect(recordRecoveryMetadataMock).toHaveBeenCalledTimes(1)
      expect(commitSecretMock).not.toHaveBeenCalled()
      expect(addWebauthnAccountMock).not.toHaveBeenCalled()
      expect(account).toEqual({ credentialId: "cred-1", l2Address: "0xacct" })
      saved = true
    })
    await create(false, AUTH_TYPE.WEB_AUTHN, () => {}, "alice", undefined, {
      onAccountCreated: checkpoint,
    })
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(addWebauthnAccountMock).toHaveBeenCalledTimes(1)
  })

  it("a failed checkpoint prevents session commit and account persistence", async () => {
    const create = renderCreate(makeAuthService("platform"))
    const refused = new Error("storage refused")
    await expect(
      create(false, AUTH_TYPE.WEB_AUTHN, () => {}, "alice", undefined, {
        onAccountCreated: () => {
          throw refused
        },
      }),
    ).rejects.toBe(refused)
    expect(recordRecoveryMetadataMock).toHaveBeenCalledTimes(1)
    expect(commitSecretMock).not.toHaveBeenCalled()
    expect(addWebauthnAccountMock).not.toHaveBeenCalled()
  })

  it("preserves the checkpoint when the later session commit fails", async () => {
    const create = renderCreate(makeAuthService("platform"))
    const checkpoint = vi.fn()
    const refused = new Error("commit refused")
    commitSecretMock.mockRejectedValueOnce(refused)
    await expect(
      create(false, AUTH_TYPE.WEB_AUTHN, () => {}, "alice", undefined, {
        onAccountCreated: checkpoint,
      }),
    ).rejects.toBe(refused)
    expect(checkpoint).toHaveBeenCalledWith({ credentialId: "cred-1", l2Address: "0xacct" })
    expect(addWebauthnAccountMock).not.toHaveBeenCalled()
  })
})
