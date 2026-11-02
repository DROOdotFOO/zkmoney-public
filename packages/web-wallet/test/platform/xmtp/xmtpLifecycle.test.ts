import { describe, expect, it, vi } from "vitest"
import {
  XMTP_CREATE_CLIENT_TIMEOUT_MS,
  XmtpLifecycle,
  messagingCapability,
  type XmtpClientHandle,
  type XmtpLifecycleDeps,
  type XmtpUiState,
} from "../../../src/platform/xmtp/xmtpLifecycle"
import { FakeLocks } from "../../support/fakeLocks"

const DB_KEY = new Uint8Array(32).fill(7)

interface TabOptions {
  createClient?: XmtpLifecycleDeps["createClient"]
  deriveDbKey?: () => Promise<Uint8Array>
}

/** A createClient fake that records the signal it was handed and settles on demand. */
function deferredClient() {
  const signals: AbortSignal[] = []
  let settle: { resolve: (c: XmtpClientHandle) => void; reject: (e: unknown) => void } | undefined
  const createClient: XmtpLifecycleDeps["createClient"] = (_key, signal) => {
    signals.push(signal)
    return new Promise<XmtpClientHandle>((resolve, reject) => {
      settle = { resolve, reject }
    })
  }
  return {
    createClient,
    signals,
    resolve: (c: XmtpClientHandle) => settle?.resolve(c),
    reject: (e: unknown) => settle?.reject(e),
  }
}

/** A simulated tab: its own visibility + lifecycle over the shared lock. */
function makeTab(locks: FakeLocks, opts: TabOptions = {}) {
  let visible = true
  const visibilityListeners = new Set<() => void>()
  const states: XmtpUiState[] = []
  const close = vi.fn()
  const createClient = vi.fn<XmtpLifecycleDeps["createClient"]>(
    opts.createClient ?? (async () => ({ close })),
  )
  const lifecycle = new XmtpLifecycle({
    locks,
    isVisible: () => visible,
    onVisibilityChange: (cb) => {
      visibilityListeners.add(cb)
      return () => visibilityListeners.delete(cb)
    },
    deriveDbKey: opts.deriveDbKey ?? (async () => DB_KEY),
    createClient,
    onState: (s) => states.push(s),
  })
  return {
    lifecycle,
    states,
    createClient,
    close,
    setVisible(next: boolean) {
      visible = next
      for (const cb of [...visibilityListeners]) cb()
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("XmtpLifecycle", () => {
  it("a single visible tab acquires the lock and constructs the client once", async () => {
    const locks = new FakeLocks()
    const tab = makeTab(locks)
    tab.lifecycle.start()
    await flush()
    expect(tab.createClient).toHaveBeenCalledTimes(1)
    expect(tab.states.at(-1)).toBe("leader")
  })

  it("a second visible tab stays 'another-tab' and never constructs a client", async () => {
    const locks = new FakeLocks()
    const a = makeTab(locks)
    const b = makeTab(locks)
    a.lifecycle.start()
    await flush()
    b.lifecycle.start()
    await flush()
    expect(a.states.at(-1)).toBe("leader")
    expect(b.states.at(-1)).toBe("another-tab")
    expect(b.createClient).not.toHaveBeenCalled()
  })

  it("leader going hidden closes the client, releases the lock, and the waiting tab promotes", async () => {
    const locks = new FakeLocks()
    const a = makeTab(locks)
    const b = makeTab(locks)
    a.lifecycle.start()
    await flush()
    b.lifecycle.start()
    await flush()

    a.setVisible(false)
    await flush()
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.states.at(-1)).toBe("leader")
    expect(b.createClient).toHaveBeenCalledTimes(1)
  })

  it("a hidden waiter withdraws its pending request; becoming visible re-requests", async () => {
    const locks = new FakeLocks()
    const a = makeTab(locks)
    const b = makeTab(locks)
    a.lifecycle.start()
    await flush()
    b.lifecycle.start()
    await flush()

    // B hides while pending, then A hides: nobody may promote a hidden tab.
    b.setVisible(false)
    await flush()
    a.setVisible(false)
    await flush()
    expect(b.createClient).not.toHaveBeenCalled()

    // B visible again → acquires the now-free lock.
    b.setVisible(true)
    await flush()
    expect(b.states.at(-1)).toBe("leader")
  })

  it("a leader's hide→show flicker re-acquires — a visible tab never strands on 'another-tab'", async () => {
    const locks = new FakeLocks()
    const tab = makeTab(locks)
    tab.lifecycle.start()
    await flush()
    expect(tab.states.at(-1)).toBe("leader")

    // No flush between: show lands while the released lock-hold is still settling.
    tab.setVisible(false)
    tab.setVisible(true)
    await flush()
    expect(tab.states.at(-1)).toBe("leader")
    expect(tab.createClient).toHaveBeenCalledTimes(2)
  })

  it("a waiter's hide→show flicker re-requests, so it still auto-promotes", async () => {
    const locks = new FakeLocks()
    const a = makeTab(locks)
    const b = makeTab(locks)
    a.lifecycle.start()
    await flush()
    b.lifecycle.start()
    await flush()

    // No flush between: the withdrawn request's rejection settles after the show event.
    b.setVisible(false)
    b.setVisible(true)
    await flush()
    a.setVisible(false)
    await flush()
    expect(b.states.at(-1)).toBe("leader")
  })

  it("stop() closes the client, releases the lock, and lands on 'off'", async () => {
    const locks = new FakeLocks()
    const a = makeTab(locks)
    const b = makeTab(locks)
    a.lifecycle.start()
    await flush()
    b.lifecycle.start()
    await flush()

    a.lifecycle.stop()
    await flush()
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(a.states.at(-1)).toBe("off")
    expect(b.states.at(-1)).toBe("leader")
  })

  it("construction failure lands on 'error' and frees the lock for other tabs", async () => {
    const locks = new FakeLocks()
    const a = makeTab(locks, {
      createClient: async () => {
        throw new Error("no OPFS")
      },
    })
    const b = makeTab(locks)
    a.lifecycle.start()
    await flush()
    expect(a.states.at(-1)).toBe("error")

    b.lifecycle.start()
    await flush()
    expect(b.states.at(-1)).toBe("leader")
  })

  it("a transient construction failure retries on the next visibility transition", async () => {
    const locks = new FakeLocks()
    let fail = true
    const signals: AbortSignal[] = []
    const tab = makeTab(locks, {
      createClient: async (_key, signal) => {
        signals.push(signal)
        if (fail) throw new Error("network down")
        return { close: vi.fn() }
      },
    })
    tab.lifecycle.start()
    await flush()
    expect(tab.states.at(-1)).toBe("error")
    // No self-retry loop while the tab stays visible.
    await flush()
    expect(tab.createClient).toHaveBeenCalledTimes(1)

    fail = false
    tab.setVisible(false)
    await flush()
    tab.setVisible(true)
    await flush()
    expect(tab.states.at(-1)).toBe("leader")
    expect(tab.createClient).toHaveBeenCalledTimes(2)
    // The failed attempt's signal fired; the retry got a fresh one.
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
  })

  it("a successful construction keeps its signal un-aborted", async () => {
    const locks = new FakeLocks()
    const deferred = deferredClient()
    const tab = makeTab(locks, { createClient: deferred.createClient })
    tab.lifecycle.start()
    await flush()
    expect(deferred.signals[0]!.aborted).toBe(false)
    deferred.resolve({ close: vi.fn() })
    await flush()
    expect(tab.states.at(-1)).toBe("leader")
    expect(deferred.signals[0]!.aborted).toBe(false)
  })

  it("a hung createClient times out into 'error', aborts its signal and frees the lock", async () => {
    vi.useFakeTimers()
    try {
      const locks = new FakeLocks()
      const deferred = deferredClient()
      const a = makeTab(locks, { createClient: deferred.createClient })
      const b = makeTab(locks)
      a.lifecycle.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(a.createClient).toHaveBeenCalledTimes(1)
      expect(a.states.at(-1)).toBe("another-tab")
      expect(deferred.signals[0]!.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(XMTP_CREATE_CLIENT_TIMEOUT_MS)
      expect(a.states.at(-1)).toBe("error")
      expect(deferred.signals[0]!.aborted).toBe(true)

      b.lifecycle.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(b.states.at(-1)).toBe("leader")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a construction that settles after the timeout is closed", async () => {
    vi.useFakeTimers()
    try {
      const locks = new FakeLocks()
      const deferred = deferredClient()
      const tab = makeTab(locks, { createClient: deferred.createClient })
      tab.lifecycle.start()
      await vi.advanceTimersByTimeAsync(XMTP_CREATE_CLIENT_TIMEOUT_MS)
      expect(tab.states.at(-1)).toBe("error")

      const late = { close: vi.fn() }
      deferred.resolve(late)
      await vi.advanceTimersByTimeAsync(0)
      expect(late.close).toHaveBeenCalledTimes(1)
      expect(tab.states.at(-1)).toBe("error")
    } finally {
      vi.useRealTimers()
    }
  })

  it("stop() during construction aborts the signal and stays 'off' when construction then fails", async () => {
    const locks = new FakeLocks()
    const deferred = deferredClient()
    const tab = makeTab(locks, { createClient: deferred.createClient })
    tab.lifecycle.start()
    await flush()
    expect(deferred.signals[0]!.aborted).toBe(false)

    tab.lifecycle.stop()
    expect(deferred.signals[0]!.aborted).toBe(true)
    expect(tab.states.at(-1)).toBe("off")

    deferred.reject(new Error("abandoned"))
    await flush()
    expect(tab.states.at(-1)).toBe("off")
  })

  it("stop() during key derivation never constructs", async () => {
    const locks = new FakeLocks()
    let releaseKey: (() => void) | undefined
    const tab = makeTab(locks, {
      deriveDbKey: () =>
        new Promise<Uint8Array>((resolve) => {
          releaseKey = () => resolve(DB_KEY)
        }),
    })
    tab.lifecycle.start()
    await flush()
    tab.lifecycle.stop()
    releaseKey?.()
    await flush()
    expect(tab.createClient).not.toHaveBeenCalled()
    expect(tab.states.at(-1)).toBe("off")
  })

  it("never constructs a client without a 32-byte derived db key", async () => {
    const locks = new FakeLocks()
    const tab = makeTab(locks, { deriveDbKey: async () => new Uint8Array(16) })
    tab.lifecycle.start()
    await flush()
    expect(tab.createClient).not.toHaveBeenCalled()
    expect(tab.states.at(-1)).toBe("error")

    const good = makeTab(locks)
    good.lifecycle.start()
    await flush()
    expect(good.createClient).toHaveBeenCalledWith(DB_KEY, expect.any(AbortSignal))
  })
})

describe("messagingCapability", () => {
  it("reports unsupported when the runtime lacks Worker/OPFS/locks (jsdom)", () => {
    // jsdom has no navigator.locks and no OPFS — the probe must fail closed here.
    expect(messagingCapability()).toBe("unsupported")
  })
})
