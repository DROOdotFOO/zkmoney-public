import type { AccountState, WebAuthnData } from "../../types"
import { assert } from "ts-essentials"
import { ACCOUNT_STORAGE_KEY } from "./constants"
import { AUTH_TYPE } from "@obsidion/sdk"
import type { IStorageAdapter } from "./adapter"
import { memoryStore } from "../../engine/store"
import { legacyStore } from "../../engine/legacyStore"

/**
 * Single-account wallet storage.
 *
 * The wallet runs against a single account on a single network. The persisted
 * value is the raw `AccountState` JSON (or absent). Both prior layers — a
 * tuple-map of multi-account state and a per-network outer map — were
 * collapsed once the corresponding switch flows were retired.
 */
export class AccountStorage {
  private static instance: AccountStorage | null = null
  private storage: IStorageAdapter
  private writes = memoryStore(0)
  /** The stored account, read again after every write. */
  readonly current = legacyStore<AccountState | undefined>(
    { read: () => this.getAccount(), subscribe: (onChange) => this.writes.subscribe(onChange) },
    undefined,
  )

  constructor(storage: IStorageAdapter) {
    this.storage = storage
  }

  static get(storage?: IStorageAdapter): AccountStorage {
    if (!AccountStorage.instance) {
      if (!storage) {
        throw new Error("First call to getInstance requires parameter")
      }

      AccountStorage.instance = new AccountStorage(storage)
    }
    return AccountStorage.instance
  }

  private async loadAccount(): Promise<AccountState | undefined> {
    const raw = await this.storage.getItem(ACCOUNT_STORAGE_KEY)
    if (raw === null) return undefined

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    const candidate = parsed as Record<string, unknown>
    if (
      typeof candidate.completeAddress !== "string" ||
      typeof candidate.name !== "string"
    ) {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    const skc = candidate.signKeyConfig
    if (
      skc === null ||
      typeof skc !== "object" ||
      typeof (skc as Record<string, unknown>).type !== "number" ||
      !Object.values(AUTH_TYPE).includes((skc as Record<string, unknown>).type as AUTH_TYPE)
    ) {
      await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
      return undefined
    }

    const skcType = (skc as Record<string, unknown>).type as AUTH_TYPE
    if (skcType === AUTH_TYPE.WEB_AUTHN) {
      const wd = (skc as Record<string, unknown>).webauthnData
      if (
        wd === null ||
        typeof wd !== "object" ||
        typeof (wd as Record<string, unknown>).credentialId !== "string" ||
        typeof (wd as Record<string, unknown>).pubkey !== "string"
      ) {
        await this.storage.removeItem(ACCOUNT_STORAGE_KEY)
        return undefined
      }
    }

    delete (candidate as Record<string, unknown>).transactions
    return candidate as unknown as AccountState
  }

  /** Returns the stored account, or `undefined` if none exists yet. */
  public async getAccount(): Promise<AccountState | undefined> {
    return this.loadAccount()
  }

  /** Returns whether an account is currently stored. */
  public async hasAccount(): Promise<boolean> {
    return (await this.getAccount()) !== undefined
  }

  /** Overwrite the stored account. */
  public async setAccount(accountState: AccountState): Promise<void> {
    await this.storage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountState))
    this.writes.update((n) => n + 1)
  }

  /** Persist an update to the current account. */
  public async updateAccount(accountState: AccountState): Promise<void> {
    const existing = await this.getAccount()
    assert(existing, "No account to update")
    assert(
      existing.completeAddress === accountState.completeAddress,
      "updateAccount cannot change completeAddress",
    )
    await this.setAccount(accountState)
  }

  /** Convenience: add a WebAuthn-backed account. */
  public async addWebauthnAccount(
    name: string,
    completeAddress: string,
    webauthnData: WebAuthnData,
  ): Promise<void> {
    await this.setAccount({
      name,
      completeAddress,
      signKeyConfig: {
        type: AUTH_TYPE.WEB_AUTHN,
        webauthnData,
      },
    })
  }

  public async getWebAuthnDataForCurrentAccount(): Promise<WebAuthnData | undefined> {
    const account = await this.getAccount()
    return account?.signKeyConfig.webauthnData
  }

  public async getAccountName(): Promise<string> {
    const account = await this.getAccount()
    assert(account, "No account selected")
    return account.name
  }
}
