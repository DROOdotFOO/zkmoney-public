/**
 * The page's wallet hands the auth service its address derivation and its stored account once it is
 * up, so a cached key proves out before the account's unlock asks for it: the read that follows
 * returns the key with no ceremony.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AccountStorage, fixed, resource } from "@obsidion/front-core"
import { AUTH_TYPE, type ObsidionWallet } from "@obsidion/sdk"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { seedBootConfig } from "../../support/seedBootConfig"

const ADDR = `0x${"0a".repeat(32)}`
const PUBKEY = "ab".repeat(64)
const CRED = "cred-1"

const h = { wallet: undefined as unknown }

const { bindWalletAuth, getAuthService, writeStoredSigner } = await import(
  "../../../src/platform/auth/useAuthenticator"
)
const { WebPasskeyIdentityMap } = await import("../../../src/platform/auth/WebPasskeyIdentityMap")
const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
const accounts = AccountStorage.get(webStorage)
const {
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  storageIdFromSecret,
  writeCachedMsk,
} = await import("../../../src/platform/storage/activeStorage")

const msk = Fr.random()

/** A session as a commit leaves it on disk. */
async function seedSession() {
  const storageId = await storageIdFromSecret(new Uint8Array(msk.toBuffer()))
  setActiveStorageId(storageId)
  setActiveCredentialId(CRED)
  writeCachedMsk({ v: 1, storageId, credentialId: CRED, msk: msk.toString() })
  await new WebPasskeyIdentityMap(webStorage, "localhost").upsert({
    credentialId: CRED,
    l2Address: ADDR,
    pubkey: PUBKEY,
    prfSlot: "first",
    isMskRoot: true,
  })
}

const seedAccount = () =>
  accounts.addWebauthnAccount("Account 1", `${ADDR}:complete`, {
    credentialId: CRED,
    pubkey: PUBKEY,
  })

beforeAll(seedBootConfig)

beforeEach(async () => {
  localStorage.clear()
  getAuthService().clear()
  h.wallet = undefined
  await seedSession()
})

/** The page's wallet, up once a test sets `h.wallet`. */
const render = async () =>
  bindWalletAuth(
    h.wallet
      ? fixed("wallet", h.wallet as never)
      : resource<[], ObsidionWallet>(
          "wallet",
          { from: [], backoff: "manual" },
          async () => undefined,
        ),
  )

// The service is a process singleton and keeps what the wallet injected; the no-wallet case runs first.
describe("bindWalletAuth and the cached key", () => {
  beforeEach(seedAccount)

  it("before the wallet exists nothing is injected and the read stays locked, cache kept", async () => {
    await render()
    expect(await getAuthService().getSecretKey()).toBeUndefined()
    expect(readCachedMsk()).not.toBeNull()
  })

  it("with the wallet mounted, the first key read restores from the cache with no ceremony", async () => {
    const deriveAccountAddress = vi.fn(async (candidate: Fr, [pubkeyHex]: readonly string[]) => ({
      toString: () =>
        candidate.toString() === msk.toString() && pubkeyHex === PUBKEY ? ADDR : "0xother",
    }))
    h.wallet = { deriveAccountAddress }
    await render()
    expect((await getAuthService().getSecretKey())?.toString()).toBe(msk.toString())
    expect(getAuthService().isUnlocked()).toBe(true)
    expect(readCachedMsk()).not.toBeNull()
    // The cached key is proved under the record's signing key.
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, [PUBKEY])
  })

  it("an address that exists only under another signing key drops the cache", async () => {
    h.wallet = {
      deriveAccountAddress: async (_candidate: Fr, [pubkeyHex]: readonly string[]) => ({
        toString: () => (pubkeyHex === "ff".repeat(64) ? ADDR : "0xother"),
      }),
    }
    await render()
    expect(await getAuthService().getSecretKey()).toBeUndefined()
    expect(readCachedMsk()).toBeNull()
  })
})

describe("the stored signer", () => {
  it("moves to another key of the wallet, keeping the account's name and address", async () => {
    await seedAccount()
    const signer = {
      credentialId: "cred-2",
      pubkey: "cd".repeat(64),
      authenticatorType: "security-key" as const,
    }
    await writeStoredSigner(signer)
    expect(await accounts.getAccount()).toEqual({
      name: "Account 1",
      completeAddress: `${ADDR}:complete`,
      signKeyConfig: { type: AUTH_TYPE.WEB_AUTHN, webauthnData: signer },
    })
  })

  it("leaves an account that no passkey signs for, or no account, alone", async () => {
    const signer = { credentialId: "cred-2", pubkey: "cd".repeat(64) }
    await writeStoredSigner(signer)
    expect(await accounts.getAccount()).toBeUndefined()
    const other = {
      name: "x",
      completeAddress: ADDR,
      signKeyConfig: {
        type: AUTH_TYPE.ECDSA_K256,
        webauthnData: { credentialId: CRED, pubkey: PUBKEY },
      },
    }
    await accounts.setAccount(other)
    await writeStoredSigner(signer)
    expect(await accounts.getAccount()).toEqual(other)
  })
})
