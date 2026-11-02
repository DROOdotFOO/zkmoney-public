import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { createWalletSyncSource } from "../../../src/services/token/transferEventSource.js"
import type { ObsidionWallet } from "../../../src/obsidion/ObsidionWallet.js"

describe("createWalletSyncSource", () => {
  it("prepares the token before a snapshot reads its events", async () => {
    const calls: string[] = []
    const wallet = {
      getPrivateEventsSnapshot: vi.fn(
        async (_def, _filter, readProjection: () => Promise<unknown>) => {
          calls.push("events")
          return { events: [], projection: await readProjection(), anchorBlock: 7 }
        },
      ),
    } as unknown as ObsidionWallet
    const source = createWalletSyncSource({
      wallet,
      tokenAddress: (await AztecAddress.random()).toString(),
      accountAddress: (await AztecAddress.random()).toString(),
      readBalances: async () => ({ balances: { token: 5n }, readAt: { token: 9 } }),
      prepareToken: async () => {
        calls.push("prepare")
      },
    })

    await expect(source.readSnapshot(1, 8)).resolves.toEqual({
      events: [],
      balances: { token: 5n },
      readAt: { token: 9 },
      anchorBlock: 7,
    })
    expect(calls).toEqual(["prepare", "events"])
  })

  it("reads nothing when the token cannot be prepared", async () => {
    const wallet = { getPrivateEventsSnapshot: vi.fn() } as unknown as ObsidionWallet
    const source = createWalletSyncSource({
      wallet,
      tokenAddress: (await AztecAddress.random()).toString(),
      accountAddress: (await AztecAddress.random()).toString(),
      readBalances: async () => ({ balances: { token: 5n }, readAt: { token: 9 } }),
      prepareToken: () => Promise.reject(new Error("portal unreachable")),
    })

    await expect(source.readSnapshot(1, 8)).rejects.toThrow("portal unreachable")
    expect(wallet.getPrivateEventsSnapshot).not.toHaveBeenCalled()
  })
})
