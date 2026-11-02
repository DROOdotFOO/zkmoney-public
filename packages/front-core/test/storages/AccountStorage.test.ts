import { beforeEach, describe, expect, it } from "vitest"
import { AUTH_TYPE } from "@obsidion/sdk"
import {
  AccountStorage,
  ACCOUNT_STORAGE_KEY,
  type IStorageAdapter,
} from "../../src/core/storages/index"
import type { AccountState } from "../../src/types/account"

class InMemoryStorage implements IStorageAdapter {
  private store = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  raw(key: string): string | undefined {
    return this.store.get(key)
  }

  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const ADDR_A = "0x" + "a".repeat(64)
const ADDR_B = "0x" + "b".repeat(64)

const validAccount: AccountState = {
  name: "Alice",
  completeAddress: ADDR_A,
  signKeyConfig: {
    type: AUTH_TYPE.WEB_AUTHN,
    webauthnData: {
      credentialId: "cred-1",
      pubkey: "pubkey-1",
    },
  },
}

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorage()
  const accounts = AccountStorage.get(adapter)
  return { adapter, accounts }
}

describe("AccountStorage (single-account flat shape)", () => {
  beforeEach(() => {
    resetSingletons()
  })

  describe("happy path", () => {
    it("setAccount + getAccount round-trip", async () => {
      const { accounts } = setup()
      await accounts.setAccount(validAccount)
      expect(await accounts.getAccount()).toEqual(validAccount)
    })

    it("hasAccount is false on a fresh adapter", async () => {
      const { accounts } = setup()
      expect(await accounts.hasAccount()).toBe(false)
    })

    it("hasAccount is true after setAccount", async () => {
      const { accounts } = setup()
      await accounts.setAccount(validAccount)
      expect(await accounts.hasAccount()).toBe(true)
    })

    it("getAccountName returns the stored name", async () => {
      const { accounts } = setup()
      await accounts.setAccount(validAccount)
      expect(await accounts.getAccountName()).toBe("Alice")
    })

    it("addWebauthnAccount round-trip survives a fresh singleton", async () => {
      const { accounts, adapter } = setup()
      await accounts.addWebauthnAccount("Bob", ADDR_B, {
        credentialId: "cred-2",
        pubkey: "pubkey-2",
      })

      // Fresh singleton against same adapter — the v2-revised regression test:
      // every persisted account has type === AUTH_TYPE.WEB_AUTHN (numeric 1).
      // A validator that compared type against the string "webauthn" would
      // wipe the just-written account here.
      resetSingletons()
      const fresh = AccountStorage.get(adapter)
      const reloaded = await fresh.getAccount()
      expect(reloaded?.completeAddress).toBe(ADDR_B)
      expect(reloaded?.name).toBe("Bob")
      expect(reloaded?.signKeyConfig.type).toBe(AUTH_TYPE.WEB_AUTHN)
      expect(reloaded?.signKeyConfig.webauthnData.credentialId).toBe("cred-2")
    })
  })

  describe("updateAccount", () => {
    it("persists an update to the same account", async () => {
      const { accounts } = setup()
      await accounts.setAccount(validAccount)
      const updated = { ...validAccount, name: "Alice 2.0" }
      await accounts.updateAccount(updated)
      expect((await accounts.getAccount())?.name).toBe("Alice 2.0")
    })

    it("throws when updateAccount changes completeAddress", async () => {
      const { accounts } = setup()
      await accounts.setAccount(validAccount)
      const reassigned = { ...validAccount, completeAddress: ADDR_B }
      await expect(accounts.updateAccount(reassigned)).rejects.toThrow()
    })
  })

  describe("validate-and-clear", () => {
    it("returns undefined on a fresh adapter (no throw)", async () => {
      const { accounts, adapter } = setup()
      expect(await accounts.getAccount()).toBeUndefined()
      expect(adapter.raw(ACCOUNT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when persisted JSON is null", async () => {
      const { accounts, adapter } = setup()
      adapter.seed(ACCOUNT_STORAGE_KEY, "null")
      expect(await accounts.getAccount()).toBeUndefined()
      expect(adapter.raw(ACCOUNT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when shape is the old per-network record", async () => {
      const { accounts, adapter } = setup()
      adapter.seed(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ testnet: validAccount, sandbox: null }),
      )
      expect(await accounts.getAccount()).toBeUndefined()
      expect(await accounts.hasAccount()).toBe(false)
      expect(adapter.raw(ACCOUNT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when JSON is corrupt", async () => {
      const { accounts, adapter } = setup()
      adapter.seed(ACCOUNT_STORAGE_KEY, "{not-json")
      expect(await accounts.getAccount()).toBeUndefined()
      expect(adapter.raw(ACCOUNT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when signKeyConfig.type is a string instead of numeric enum", async () => {
      // Defends against a v2-revised slip where the validator literal was
      // "webauthn"; a stale build with a string type must NOT hydrate.
      const { accounts, adapter } = setup()
      adapter.seed(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({
          ...validAccount,
          signKeyConfig: {
            type: "webauthn",
            webauthnData: validAccount.signKeyConfig.webauthnData,
          },
        }),
      )
      expect(await accounts.getAccount()).toBeUndefined()
      expect(adapter.raw(ACCOUNT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when signKeyConfig.type is a number outside AUTH_TYPE", async () => {
      const { accounts, adapter } = setup()
      adapter.seed(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({
          ...validAccount,
          signKeyConfig: {
            type: 99,
            webauthnData: validAccount.signKeyConfig.webauthnData,
          },
        }),
      )
      expect(await accounts.getAccount()).toBeUndefined()
      expect(adapter.raw(ACCOUNT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when webauthnData.credentialId is missing", async () => {
      const { accounts, adapter } = setup()
      adapter.seed(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({
          ...validAccount,
          signKeyConfig: {
            type: AUTH_TYPE.WEB_AUTHN,
            webauthnData: { pubkey: "pubkey-1" },
          },
        }),
      )
      expect(await accounts.getAccount()).toBeUndefined()
      expect(adapter.raw(ACCOUNT_STORAGE_KEY)).toBeUndefined()
    })

    it("hydrates a valid persisted shape", async () => {
      const { accounts, adapter } = setup()
      adapter.seed(ACCOUNT_STORAGE_KEY, JSON.stringify(validAccount))
      expect(await accounts.getAccount()).toEqual(validAccount)
    })

    it("strips a legacy transactions field from the returned object", async () => {
      const { accounts, adapter } = setup()
      adapter.seed(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ ...validAccount, transactions: [{ foo: 1 }] }),
      )
      const account = await accounts.getAccount()
      expect(account).toEqual(validAccount)
      expect(account && "transactions" in account).toBe(false)
    })
  })
})
