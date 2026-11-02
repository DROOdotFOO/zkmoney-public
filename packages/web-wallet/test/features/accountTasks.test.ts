// An account's tasks run once their needs are ready, once per session. The Savings replay rebuilds
// both tokens' burns, then settles once, then reaches `movesReplayed`, as does a failed replay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fixed, startRuntime, valueOf, type ContactStorage } from "@obsidion/front-core"
import type { ContractService, ObsidionAccount, ObsidionWallet, TokenService } from "@obsidion/sdk"
import { historicImports } from "../../src/features/migration/historicActivityImport"
import {
  SAVINGS_RETRY_MS,
  savingsMovesReplay,
  savingsResource,
} from "../../src/features/savings/savingsTasks"
import { withdrawalRescan } from "../../src/features/withdraw/withdrawGateway"
import { later, onceSteps, sessions, table } from "../../../front-core/test/engine/taskTable"

const WALLET = { node: "node" } as unknown as ObsidionWallet
const ACCOUNT = {} as ObsidionAccount
const TOKEN = { symbol: "DAI" } as unknown as TokenService
const CONTRACTS = {} as ContractService
const flush = () => vi.advanceTimersByTimeAsync(0)
const ends: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const end of ends.splice(0)) end()
  vi.useRealTimers()
})

/** Sessions whose milestones are reached when `stage` resolves. */
function harness(stage: () => Promise<boolean> = async () => true) {
  const after = vi.fn<(after: unknown, signal?: AbortSignal) => Promise<boolean>>(stage)
  const h = sessions(startRuntime, { after, reached: () => false })
  ends.push(h.end)
  return { ...h, after }
}

describe("savingsMovesReplay", () => {
  function replay(stage?: () => Promise<boolean>) {
    const h = harness(stage)
    const savings = later<{ settle(): Promise<void> } | null>("savings")
    const settle = vi.fn(async () => {})
    const mark = vi.fn()
    const rescan = vi.fn<(wallet: unknown, tokens: unknown[]) => Promise<unknown[]>>(async () => [])
    const savingsToken = vi.fn(async (): Promise<unknown> => ({ label: "sUSDS" }))
    const needs = {
      wallet: fixed("wallet", WALLET),
      account: fixed("account", ACCOUNT),
      token: fixed("token", TOKEN),
      savings: savings.resource as never,
    }
    h.tasks.push(savingsMovesReplay(needs, { mark }, { rescan, savingsToken } as never))
    const ready = () => savings.ready({ settle })
    return { h, settle, mark, rescan, savingsToken, ready, none: () => savings.ready(null) }
  }

  it("rebuilds both tokens' burns at its milestones, then one settle pass, then movesReplayed", async () => {
    let stage!: () => void
    const r = replay(() => new Promise<boolean>((resolve) => (stage = () => resolve(true))))
    let rebuilt!: () => void
    r.rescan.mockImplementation(
      (_wallet, tokens) =>
        new Promise((resolve) =>
          (tokens[0] as { label?: string }).label === "sUSDS"
            ? (rebuilt = () => resolve([]))
            : resolve([]),
        ),
    )
    r.ready()
    r.h.start()
    await flush()
    expect(r.h.after).toHaveBeenCalledWith(
      { firstBalance: true, depositsReplayed: { whenCatchingUp: 0 } },
      expect.anything(),
    )
    expect(r.rescan).not.toHaveBeenCalled()

    stage()
    await flush()
    expect(r.rescan.mock.calls.map(([, tokens]) => tokens)).toEqual([
      [{ tokenService: TOKEN }],
      [{ label: "sUSDS" }],
    ])
    // The pass waits for the move out's burn to be rebuilt.
    expect(r.settle).not.toHaveBeenCalled()
    expect(r.mark).not.toHaveBeenCalled()

    rebuilt()
    await flush()
    expect(r.mark.mock.calls).toEqual([["movesReplayed"]])
    expect(r.settle).toHaveBeenCalledTimes(1)
    expect(r.settle.mock.invocationCallOrder[0]).toBeLessThan(r.mark.mock.invocationCallOrder[0]!)
  })

  it("reaches movesReplayed with nothing to replay where the profile has no sUSDS deployment", async () => {
    const r = replay()
    r.none()
    r.h.start()
    await flush()
    expect(r.mark.mock.calls).toEqual([["movesReplayed"]])
    expect(r.rescan).not.toHaveBeenCalled()
  })

  it("releases the balance after a failed replay, and tries the replay again", async () => {
    const r = replay()
    r.savingsToken.mockRejectedValueOnce(new Error("node down"))
    r.ready()
    r.h.start()
    await flush()
    expect(r.mark).toHaveBeenCalledWith("movesReplayed")
    expect(r.settle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SAVINGS_RETRY_MS)
    expect(r.savingsToken).toHaveBeenCalledTimes(2)
    expect(r.settle).toHaveBeenCalledTimes(1)
  })

  it("replays once per session, once Savings is ready", async () => {
    const r = replay()
    await table(onceSteps(r.h, r.ready), () => r.settle.mock.calls.length)
  })
})

describe("savingsResource", () => {
  it("opens Savings once Main's token is ready, and reads it again after a failed read", async () => {
    const token = later<TokenService>("token")
    const source = { settle: async () => {} }
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error("manifest unreachable"))
      .mockResolvedValue(source)
    const savings = savingsResource(
      [
        fixed("wallet", WALLET),
        fixed("account", ACCOUNT),
        token.resource,
        fixed("contractService", CONTRACTS),
      ],
      open,
    )
    ends.push(savings.close)
    await flush()
    expect(open).not.toHaveBeenCalled()
    token.ready(TOKEN)
    await flush()
    expect(open).toHaveBeenCalledWith(WALLET, ACCOUNT, TOKEN, CONTRACTS)
    expect(savings.get().status).toBe("failed")
    await vi.advanceTimersByTimeAsync(SAVINGS_RETRY_MS)
    expect(valueOf(savings)).toBe(source)
  })
})

describe("the account's one-shot rescans and imports", () => {
  it("rescans Main's withdrawals once per session, once the token is ready", async () => {
    const h = harness()
    const token = later<TokenService>("token")
    const rescan = vi.fn(async () => [])
    h.tasks.push(
      withdrawalRescan({ wallet: fixed("wallet", WALLET), token: token.resource }, rescan),
    )
    await table(
      onceSteps(h, () => token.ready(TOKEN)),
      () => rescan.mock.calls.length,
    )
    expect(rescan).toHaveBeenLastCalledWith(WALLET, [{ tokenService: TOKEN }])
  })

  it("imports the account's retired activity and contacts once per session, once the wallet is ready", async () => {
    const h = harness()
    const wallet = later<ObsidionWallet>("wallet")
    const activity = vi.fn(async () => null)
    const contacts = vi.fn<(storageId: string, contacts: unknown) => Promise<number>>(async () => 0)
    const account = { storageId: "acct", contacts: {} as ContactStorage }
    h.tasks.push(...historicImports(wallet.resource, account, { activity, contacts }))
    await table(
      onceSteps(h, () => wallet.ready(WALLET)),
      () => activity.mock.calls.length,
    )
    expect(contacts).toHaveBeenCalledTimes(2)
    expect(contacts).toHaveBeenLastCalledWith("acct", account.contacts)
    expect(activity).toHaveBeenLastCalledWith("acct")
  })
})
