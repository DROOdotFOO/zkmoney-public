import { CompleteAddress } from "@aztec-labs/stdlib/contract"
import type {
  AlphaAuthService,
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
} from "@obsidion/sdk"
import type { AccountState } from "../types"
import { completeAddressWireFormat } from "../utils/completeAddressWireFormat"
import { logger } from "../utils/logger"
import { WalletError } from "./errors"
import { resource, type Resource, type ResourceState } from "./resource"
import { derived, memoryStore } from "./store"

export interface AccountDeps {
  wallet: Resource<ObsidionWallet>
  /** The unlock derives the account's address through it. */
  contractService: Resource<ContractService>
  accounts: {
    getAccount(): Promise<AccountState | undefined>
    setAccount(account: AccountState): Promise<void>
  }
  auth(wallet: ObsidionWallet): AlphaAuthService
  /** The account a sign-in just built: the unlock returns it. */
  handoff?: ObsidionAccount
}

export interface AccountResource extends Resource<ObsidionAccount> {
  /** Installs the account a sign-in built in place of the unlocked one. */
  handOff(account: ObsidionAccount): void
}

/**
 * The unlocked account: the stored account over the cached master key, with no prompt. It stays
 * pending with no stored account; a missing key or a failed unlock waits for `retry`.
 */
export function accountResource(deps: AccountDeps): AccountResource {
  const handed = memoryStore(deps.handoff)
  const unlocked = resource(
    "account",
    { from: [deps.wallet, deps.contractService], backoff: "manual" },
    ([wallet]) => Promise.resolve(handed.get() ?? unlock(wallet, deps)),
  )
  const state = derived(
    [unlocked, handed],
    (s, account): ResourceState<ObsidionAccount> =>
      account ? { status: "ready", value: account } : s,
  )
  return {
    ...state,
    name: unlocked.name,
    demand: unlocked.demand,
    retry: unlocked.retry,
    close: unlocked.close,
    handOff: (account) => handed.set(account),
  }
}

async function unlock(wallet: ObsidionWallet, deps: AccountDeps) {
  const stored = await deps.accounts.getAccount()
  if (!stored) return undefined
  const service = deps.auth(wallet)
  const authProvider = await service.getAuthProvider()
  if (!authProvider) return undefined
  const secretKey = await service.getSecretKey()
  if (!secretKey) throw new WalletError("account.unlockFailed")

  // The v5 parser reads a 288-byte address; any other layout is re-derived and rewritten.
  const format = stored.completeAddress
    ? completeAddressWireFormat(stored.completeAddress)
    : "unknown"
  if (stored.completeAddress && format !== "v5") {
    const bytes = stored.completeAddress.replace(/^0x/i, "").length / 2
    logger.log(`[account] stored completeAddress is ${format} (${bytes}B): re-deriving it`)
  }
  const account = await wallet.getObsidionAccountWallet(secretKey, authProvider, {
    completeAddress:
      format === "v5" ? await CompleteAddress.fromString(stored.completeAddress) : undefined,
    register: true,
  })
  if (format !== "v5") {
    const derivedAddress = account.getCompleteAddress().toString()
    if (derivedAddress !== stored.completeAddress) {
      await deps.accounts.setAccount({ ...stored, completeAddress: derivedAddress })
      logger.log("[account] rewrote the stored completeAddress in its v5 form")
    }
  }
  return account
}
