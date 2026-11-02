/** Construction-time DI for `ObsidionWallet`'s `pendingTxStore`. */
import { describe, expect, it } from "vitest"

import { InMemoryPendingTxStore } from "../../src/obsidion/pending/index.js"
import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { ObsidionAlphaTestWallet } from "../../src/obsidion/ObsidionAlphaTestWallet.js"

describe("ObsidionWallet — pendingTxStore DI", () => {
  it("defaults to InMemoryPendingTxStore when no opts.pendingTxStore is provided", () => {
    const wallet = new ObsidionWallet({} as never, {} as never, "0xrollup")
    expect(wallet.pendingTxStore).toBeInstanceOf(InMemoryPendingTxStore)
  })

  it("uses an injected store when provided", () => {
    const injected = new InMemoryPendingTxStore()
    const wallet = new ObsidionWallet({} as never, {} as never, "0xrollup", {
      pendingTxStore: injected,
    })
    expect(wallet.pendingTxStore).toBe(injected)
  })

  // The test must hit the FACTORY path (not the constructor): a factory that drops `walletOpts`
  // leaves test-mode wallets on a local in-memory store that `TxLifecycleService` never observes,
  // and a constructor-only test would not notice.
  it("ObsidionAlphaTestWallet.createWithPXE forwards walletOpts (pendingTxStore)", async () => {
    const injected = new InMemoryPendingTxStore()
    const wallet = await ObsidionAlphaTestWallet.createWithPXE(
      {} as never,
      {} as never,
      "0xrollup",
      {
        pendingTxStore: injected,
      },
    )
    expect(wallet.pendingTxStore).toBe(injected)
  })
})
