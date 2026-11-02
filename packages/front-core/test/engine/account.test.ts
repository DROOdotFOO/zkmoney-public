// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContractService, ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import { accountResource } from "../../src/engine/account"
import { fixed, valueOf } from "../../src/engine/resource"
import type { AccountState } from "../../src/types"
import { fakeClock, flush, later } from "./taskTable"

const V4 = "0x" + "11".repeat(320)
const V5_DERIVED = "0x" + "22".repeat(288)

const built = { getCompleteAddress: () => ({ toString: () => V5_DERIVED }) } as ObsidionAccount

function setup(o: { stored?: Partial<AccountState> | null; key?: boolean } = {}) {
  const stored =
    o.stored === null ? undefined : ({ completeAddress: V4, ...o.stored } as AccountState)
  const accounts = {
    getAccount: vi.fn(async () => stored),
    setAccount: vi.fn(async (account: AccountState) => void account),
  }
  let key = o.key ?? true
  const service = {
    getAuthProvider: vi.fn(async () => ({})),
    getSecretKey: vi.fn(async () => (key ? { secret: true } : undefined)),
  }
  const wallet = { getObsidionAccountWallet: vi.fn(async () => built) }
  return {
    accounts,
    service,
    wallet,
    cacheKey: () => (key = true),
    deps: {
      accounts,
      auth: () => service as never,
      contractService: fixed("contractService", {} as ContractService),
    },
  }
}

describe("accountResource", () => {
  fakeClock()
  beforeEach(() => void vi.spyOn(console, "log").mockImplementation(() => {}))

  it("unlocks once a late wallet arrives", async () => {
    const { wallet, deps } = setup()
    const late = later<ObsidionWallet>("wallet")
    const account = accountResource({ ...deps, wallet: late.resource })
    await flush()
    expect(account.get().status).toBe("pending")
    late.ready(wallet as unknown as ObsidionWallet)
    await flush()
    expect(valueOf(account)).toBe(built)
  })

  it("unlocks once the contract service arrives after the wallet, with no retry", async () => {
    const { wallet, deps } = setup()
    const late = later<ContractService>("contractService")
    const account = accountResource({
      ...deps,
      wallet: fixed("wallet", wallet as never),
      contractService: late.resource,
    })
    await flush()
    expect(account.get().status).toBe("pending")
    expect(wallet.getObsidionAccountWallet).not.toHaveBeenCalled()
    late.ready({} as ContractService)
    await flush()
    expect(valueOf(account)).toBe(built)
  })

  it("stays pending with no stored account", async () => {
    const { wallet, deps } = setup({ stored: null })
    const account = accountResource({ ...deps, wallet: fixed("wallet", wallet as never) })
    await flush()
    expect(account.get().status).toBe("pending")
    expect(wallet.getObsidionAccountWallet).not.toHaveBeenCalled()
  })

  it("waits for a retry when no key is cached, then unlocks", async () => {
    const { wallet, deps, cacheKey } = setup({ key: false })
    const account = accountResource({ ...deps, wallet: fixed("wallet", wallet as never) })
    await flush()
    expect(account.get()).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "account.unlockFailed" }),
    })
    cacheKey()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(account.get().status).toBe("failed")
    account.retry()
    await flush()
    expect(valueOf(account)).toBe(built)
  })

  it("re-derives a v4 stored address and rewrites it in its v5 form", async () => {
    const { wallet, deps, accounts } = setup()
    accountResource({ ...deps, wallet: fixed("wallet", wallet as never) })
    await flush()
    expect(wallet.getObsidionAccountWallet).toHaveBeenCalledWith(
      expect.anything(),
      {},
      {
        completeAddress: undefined,
        register: true,
      },
    )
    expect(accounts.setAccount).toHaveBeenCalledWith(
      expect.objectContaining({ completeAddress: V5_DERIVED }),
    )
  })

  it("returns a sign-in's account as is, and installs a later one in place", async () => {
    const { wallet, deps } = setup()
    const handed = {} as ObsidionAccount
    const account = accountResource({
      ...deps,
      wallet: fixed("wallet", wallet as never),
      handoff: handed,
    })
    await flush()
    expect(valueOf(account)).toBe(handed)
    expect(wallet.getObsidionAccountWallet).not.toHaveBeenCalled()
    const next = {} as ObsidionAccount
    const seen: string[] = []
    account.subscribe(() => seen.push(account.get().status))
    account.handOff(next)
    expect(valueOf(account)).toBe(next)
    expect(seen).toEqual(["ready"])
  })
})
