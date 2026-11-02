// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { formatUnits } from "viem"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { RegisteredTeeSigner, TokenService } from "@obsidion/sdk"
import { createBalances } from "../../src/engine/balances"
import { fixed, valueOf, type Resource } from "../../src/engine/resource"
import { derived, memoryStore } from "../../src/engine/store"
import { teeSignerResource, tokenResource } from "../../src/engine/token"
import type { TeeSignerSource } from "../../src/tee/teeSignerSource"
import { fakeClock, flush, later } from "./taskTable"

const signer = (registry: string) =>
  ({ teeRegistry: { toString: () => registry } } as unknown as RegisteredTeeSigner)
const SIGNER = signer("0xtee-registry")
const TOKEN = "0xtoken"

function fakeSource(overrides: Partial<TeeSignerSource> = {}) {
  const listeners = new Set<() => void>()
  const source = {
    label: "fake-source",
    load: vi.fn(async (): Promise<RegisteredTeeSigner | undefined> => SIGNER),
    subscribe: vi.fn((cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    refresh: vi.fn(),
    ...overrides,
  }
  return { source, emit: () => [...listeners].forEach((l) => l()) }
}

function fakeToken() {
  const info = { address: TOKEN, name: "Main", symbol: WALLET_TOKEN_SYMBOL, decimals: 18 }
  return {
    setTeeSigner: vi.fn(),
    fetchTokenInformation: vi.fn(async () => info),
    metadata: info,
    tokenAddressOrNull: { toString: () => TOKEN },
  }
}

function setup(
  teeSigner: Resource<RegisteredTeeSigner>,
  account: Resource<object> = fixed("account", {}),
) {
  const tokens: ReturnType<typeof fakeToken>[] = []
  const create = vi.fn(async () => {
    const token = fakeToken()
    tokens.push(token)
    return token as unknown as TokenService
  })
  const token = tokenResource({
    wallet: fixed("wallet", {} as never),
    account: account as never,
    contractService: fixed("contractService", {} as never),
    teeSigner,
    create,
  })
  return { token, tokens, create }
}

fakeClock()

describe("teeSignerResource", () => {
  it("connects nothing before it is demanded, then logs the connect with the source's label", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { source } = fakeSource()
    const tee = teeSignerResource(source)
    await flush()
    expect(source.load).not.toHaveBeenCalled()
    tee.demand()
    await flush()
    expect(valueOf(tee)).toBe(SIGNER)
    expect(log).toHaveBeenCalledWith(
      "[teeSigner] connected",
      expect.objectContaining({ teeRegistry: "0xtee-registry", source: "fake-source" }),
    )
  })

  it("stays pending when the source has nothing to connect, asking no refresh", async () => {
    const { source } = fakeSource({ load: vi.fn(async () => undefined) })
    const tee = teeSignerResource(source)
    tee.demand()
    await flush()
    expect(tee.get().status).toBe("pending")
    expect(source.refresh).not.toHaveBeenCalled()
  })

  it("fails with the error, asks the source to refresh, and connects on the retry", async () => {
    const failure = new Error("enclave hiccup")
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(SIGNER)
    const { source } = fakeSource({ load, subscribe: undefined })
    const tee = teeSignerResource(source)
    tee.demand()
    await flush()
    expect(tee.get()).toMatchObject({ status: "failed", error: failure })
    expect(source.refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(valueOf(tee)).toBe(SIGNER)
  })

  it("bounds a hung connect at 60 s, then retries", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(SIGNER)
    const tee = teeSignerResource(fakeSource({ load, subscribe: undefined }).source)
    tee.demand()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tee.get()).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "timeout" }),
    })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(valueOf(tee)).toBe(SIGNER)
  })

  it("reconnects on a manifest roll, clearing the signer from the token first", async () => {
    const B = signer("0xtee-registry-B")
    const { source, emit } = fakeSource()
    const tee = teeSignerResource(source)
    const { token, tokens } = setup(tee)
    tee.demand()
    token.demand()
    await flush()
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(SIGNER)
    vi.mocked(source.load).mockResolvedValueOnce(B)
    emit()
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(undefined)
    await flush()
    expect(valueOf(tee)).toBe(B)
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(B)
  })

  it("stops its retry and its subscription on close", async () => {
    const unsubscribe = vi.fn()
    const load = vi.fn().mockRejectedValue(new Error("down"))
    const tee = teeSignerResource(fakeSource({ load, subscribe: vi.fn(() => unsubscribe) }).source)
    tee.demand()
    await flush()
    tee.close()
    expect(unsubscribe).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("connects with no account behind it: a link's visitor cashing out", async () => {
    const tee = teeSignerResource(fakeSource().source)
    const { token, create } = setup(tee, later<object>("account").resource)
    tee.demand()
    token.demand()
    await flush()
    expect(valueOf(tee)).toBe(SIGNER)
    expect(create).not.toHaveBeenCalled()
  })
})

describe("tokenResource", () => {
  it("builds nothing before it is demanded", async () => {
    const { token, create } = setup(fixed("teeSigner", SIGNER))
    await flush()
    expect(create).not.toHaveBeenCalled()
    token.demand()
    await flush()
    expect(valueOf(token)).toBeDefined()
  })

  it("builds once a late account arrives, and hands it the signer connected before", async () => {
    const account = later<object>("account")
    const { token, tokens } = setup(fixed("teeSigner", SIGNER), account.resource)
    token.demand()
    await flush()
    expect(token.get().status).toBe("pending")
    account.ready({})
    await flush()
    expect(tokens[0].fetchTokenInformation).toHaveBeenCalled()
    expect(tokens[0].setTeeSigner).toHaveBeenCalledWith(SIGNER)
  })

  it("gives the signer only to the current token", async () => {
    const account = later<object>("account")
    account.ready({})
    const { token, tokens } = setup(fixed("teeSigner", SIGNER), account.resource)
    token.demand()
    await flush()
    account.ready({})
    await flush()
    expect(tokens).toHaveLength(2)
    expect(tokens[0].setTeeSigner).toHaveBeenLastCalledWith(undefined)
    expect(tokens[1].setTeeSigner).toHaveBeenLastCalledWith(SIGNER)
  })

  it("retries a failed metadata read with a backoff", async () => {
    const { token, tokens, create } = setup(fixed("teeSigner", SIGNER))
    create.mockImplementationOnce(async () => {
      const t = fakeToken()
      t.fetchTokenInformation.mockRejectedValueOnce(new Error("L1 unreachable"))
      tokens.push(t)
      return t as unknown as TokenService
    })
    token.demand()
    await flush()
    expect(token.get().status).toBe("failed")
    await vi.advanceTimersByTimeAsync(4_000)
    expect(valueOf(token)).toBe(tokens[1])
  })

  it("renders the right figure over a row stored with the wrong decimals", async () => {
    const { token } = setup(fixed("teeSigner", SIGNER))
    token.demand()
    await flush()
    const balances = createBalances(
      {
        load: async () => {},
        list: () => [
          { scope: "sandbox:0xacct", tokenAddress: TOKEN, balance: (5n * 10n ** 18n).toString() },
        ],
        onListChanged: () => () => {},
      },
      {
        network: "sandbox",
        account: memoryStore({ value: { completeAddress: "0xacct" }, loaded: true }),
        tokens: memoryStore({
          value: [{ address: TOKEN, symbol: WALLET_TOKEN_SYMBOL, decimals: 6 }],
          loaded: true,
        }),
        activeToken: derived([token], (s) => (s.status === "ready" ? TOKEN : null)),
      },
      memoryStore({ syncing: false, progress: null }).readonly,
    )
    balances.view.subscribe(() => {})
    await flush()
    const main = balances.view.get().main
    const decimals = valueOf(token)?.metadata.decimals
    expect(main && decimals !== undefined && formatUnits(main.atomic, decimals)).toBe("5")
  })
})
