import { beforeEach, describe, expect, it, vi } from "vitest"
import { profiler } from "../../src/profiling"
import { installFetchInterceptor } from "../../src/profiling/interceptors"

/** One recording, so a test asserts on the spans its own body produced. */
async function record(run: () => Promise<void> | void) {
  profiler.start("test")
  await run()
  return profiler.stop()
}

const names = (report: { records: { name: string }[] }) => report.records.map((r) => r.name)

describe("runSpan", () => {
  it("records a span per call with its duration and category", async () => {
    const report = await record(async () => {
      await profiler.span("outer", "wallet", async () => {
        await new Promise((r) => setTimeout(r, 10))
      })
    })

    expect(names(report)).toEqual(["outer"])
    expect(report.records[0].category).toBe("wallet")
    // setTimeout(10) can fire early and performance.now deltas read under; assert the span was
    // measured at roughly the sleep length without pinning timer precision.
    expect(report.records[0].duration).toBeGreaterThanOrEqual(5)
  })

  it("marks a throwing span as an error and rethrows", async () => {
    const report = await record(async () => {
      await expect(
        profiler.span("boom", "pxe", async () => {
          throw new Error("nope")
        }),
      ).rejects.toThrow("nope")
    })

    expect(report.records[0]).toMatchObject({ name: "boom", error: true })
  })

  it("keeps a span that outlives its recording out of the next one", async () => {
    profiler.start("first")
    const leaked = profiler.span("slow", "node", () => new Promise((r) => setTimeout(r, 20)))
    profiler.stop()

    // The generation counter is what isolates recordings: `slow` resolves inside the second
    // recording's window and must not be attributed to it.
    const second = await record(async () => {
      await leaked
      await profiler.span("own", "wallet", async () => {})
    })
    expect(names(second)).toEqual(["own"])
  })

  it("runs the body untouched and records nothing when not recording", async () => {
    const result = await profiler.span("ignored", "wallet", async () => 42)
    expect(result).toBe(42)
    expect(profiler.isRecording).toBe(false)
  })

  it("stamps the environment onto every report", async () => {
    const report = await record(() => {})
    expect(report.env).toMatchObject({ origin: window.location.origin })
    // jsdom loads no zone.js, so a report from it is always a flat one.
    expect(report.env.zoneTracking).toBe(false)
  })
})

describe("fetch interceptor", () => {
  let restore: () => void
  let seen: string[]

  beforeEach(() => {
    seen = []
    window.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response("{}")
    }) as typeof window.fetch
    restore = installFetchInterceptor(profiler)
    return () => restore()
  })

  const post = (url: string, body: string) => fetch(url, { method: "POST", body })

  it("names a JSON-RPC call after its method", async () => {
    const report = await record(async () => {
      await post("http://node/", JSON.stringify({ method: "node_getBlockNumber", id: 1 }))
    })
    expect(names(report)).toEqual(["node_getBlockNumber"])
    expect(report.records[0].category).toBe("rpc")
  })

  it("joins a batched call's methods under one span", async () => {
    const report = await record(async () => {
      await post("http://node/", JSON.stringify([{ method: "a" }, { method: "b" }]))
    })
    expect(names(report)).toEqual(["[batch] a, b"])
  })

  it("labels a non-JSON-RPC body by method and path", async () => {
    const report = await record(async () => {
      await post("http://account.test/domain/sign", "not json")
    })
    expect(names(report)).toEqual(["POST /domain/sign"])
  })

  it("captures a bodyless backend hop under /svc/ but not a static asset", async () => {
    const report = await record(async () => {
      await fetch("/svc/account/health")
      await fetch("/assets/barretenberg.wasm")
    })
    expect(names(report)).toEqual(["GET /svc/account/health"])
    // Both still reached the real fetch — instrumentation never swallows a request.
    expect(seen).toHaveLength(2)
  })

  it("passes every request straight through when not recording", async () => {
    await post("http://node/", JSON.stringify({ method: "node_getBlockNumber" }))
    expect(seen).toHaveLength(1)
  })
})

describe("instrumentWallet", () => {
  /** A wallet-shaped object: prototype methods, a node, a PXE with a sub-service. */
  function fakeWallet() {
    class Wallet {
      constructor(public pxe: any, public node: any) {}
      async sendTx() {
        await this.pxe.proveTx()
        return "hash"
      }
    }
    const store = { getNotes: async () => [1, 2] }
    const pxe = {
      store,
      proveTx: async () => {
        await store.getNotes()
        return "proof"
      },
    }
    const node = { getBlockNumber: async () => 7 }
    return new Wallet(pxe, node)
  }

  it("names spans after the methods it wrapped, across the wallet, its PXE and its stores", async () => {
    const wallet = fakeWallet()
    profiler.instrumentWallet(wallet)

    const report = await record(async () => {
      await wallet.sendTx()
      await wallet.node.getBlockNumber()
    })

    expect(names(report).sort()).toEqual(["getBlockNumber", "getNotes", "proveTx", "sendTx"])
    expect(report.records.find((r) => r.name === "sendTx")?.category).toBe("wallet")
    expect(report.records.find((r) => r.name === "proveTx")?.category).toBe("pxe")
    expect(report.records.find((r) => r.name === "getNotes")?.category).toBe("store")
    expect(report.records.find((r) => r.name === "getBlockNumber")?.category).toBe("node")
  })

  it("leaves the wrapped methods returning what they always returned", async () => {
    const wallet = fakeWallet()
    profiler.instrumentWallet(wallet)
    profiler.start("values")
    expect(await wallet.sendTx()).toBe("hash")
    expect(await wallet.node.getBlockNumber()).toBe(7)
    profiler.stop()
  })

  it("wraps a get-trap proxy by reference instead of patching through it", async () => {
    // PXE's caching node wrapper is one of these: writing a method onto it lands under the trap,
    // whose closure calls straight back in. The facade path is what keeps that from recursing.
    const target = { getBlockNumber: async () => 3 }
    const trapped = new Proxy(target, {
      get: (t, p) => {
        const v = Reflect.get(t, p)
        return typeof v === "function" ? v.bind(t) : v
      },
    })
    const wallet: any = { pxe: { cachedNode: trapped } }

    profiler.instrumentWallet(wallet)
    const report = await record(async () => {
      expect(await wallet.pxe.cachedNode.getBlockNumber()).toBe(3)
    })

    expect(names(report)).toContain("getBlockNumber")
  })

  it("skips a queue-like object, whose blocking get() is idle time rather than work", async () => {
    const queue = { get: async () => "item", put: async () => {} }
    const wallet: any = { pxe: { jobQueue: queue } }

    profiler.instrumentWallet(wallet)
    const report = await record(async () => {
      await wallet.pxe.jobQueue.get()
    })

    expect(names(report)).toEqual([])
  })

  it("instruments a given wallet once", async () => {
    const wallet = fakeWallet()
    profiler.instrumentWallet(wallet)
    profiler.instrumentWallet(wallet)

    const report = await record(() => wallet.node.getBlockNumber())
    expect(names(report)).toEqual(["getBlockNumber"])
  })
})

describe("TEE signer interceptor", () => {
  /** The seam the token resource drives: a service inherits setTeeSigner, and the signer goes in through it. */
  class FakeServiceBase {
    _teeSigner: any
    setTeeSigner(signer: any) {
      this._teeSigner = signer
    }
  }

  function installOn(proto: any) {
    const original = proto.setTeeSigner
    proto.setTeeSigner = function (this: any, signer: any) {
      return original.call(this, signer ? wrapForTest(signer) : signer)
    }
    return () => {
      proto.setTeeSigner = original
    }
  }

  // Mirrors interceptors.ts wrapTeeSigner; the real one reaches through @obsidion/sdk, which
  // pulls the whole wallet stack into a unit test.
  function wrapForTest(signer: any) {
    return new Proxy(signer, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== "function" || typeof prop !== "string") return value
        return (...args: any[]) =>
          profiler.isRecording
            ? profiler.runSpan(prop, "tee", () => value.apply(target, args))
            : value.apply(target, args)
      },
    })
  }

  /** TeeSigner's methods live on a prototype and its key material sits beside them. */
  class FakeSigner {
    readonly publicKey = "0xpub"
    async signTokenOperation() {
      await new Promise((r) => setTimeout(r, 5))
      return { signatures: [] }
    }
  }

  it("times each enclave call under the tee category", async () => {
    const restore = installOn(FakeServiceBase.prototype)
    const service = new FakeServiceBase()
    service.setTeeSigner(new FakeSigner())

    const report = await record(async () => {
      await service._teeSigner.signTokenOperation()
    })

    expect(names(report)).toEqual(["signTokenOperation"])
    expect(report.records[0].category).toBe("tee")
    expect(report.records[0].duration).toBeGreaterThanOrEqual(4)
    restore()
  })

  it("passes the signer's key material through untouched", () => {
    const restore = installOn(FakeServiceBase.prototype)
    const service = new FakeServiceBase()
    service.setTeeSigner(new FakeSigner())
    // A copied object would drop a prototype getter; the facade must not.
    expect(service._teeSigner.publicKey).toBe("0xpub")
    restore()
  })

  it("leaves a cleared signer as undefined rather than facading it", () => {
    const restore = installOn(FakeServiceBase.prototype)
    const service = new FakeServiceBase()
    // The token resource clears it before every reconnect; a facade over undefined would break the
    // "TEE signer not wired" guard downstream.
    service.setTeeSigner(undefined)
    expect(service._teeSigner).toBeUndefined()
    restore()
  })
})

describe("staged finalizer", () => {
  /** The shape sendTx receives: an options bag whose `finalize` does the TEE payload work. */
  function fakeWalletWithStagedSend() {
    const node = { getWitness: async () => "witness" }
    class Wallet {
      node = node
      async sendTx(_payload: unknown, opts: { finalize?: (r: unknown) => Promise<unknown> }) {
        await opts.finalize?.({ simResult: true })
        return "hash"
      }
    }
    return new Wallet()
  }

  it("gives the whole finalize phase its own tee span", async () => {
    const wallet = fakeWalletWithStagedSend()
    profiler.instrumentWallet(wallet)

    const report = await record(async () => {
      await wallet.sendTx(
        {},
        {
          finalize: async () => {
            // The reads that precede the enclave call — the cost being hunted.
            await wallet.node.getWitness()
            await wallet.node.getWitness()
            return { payload: {} }
          },
        },
      )
    })

    expect(names(report)).toContain("finalize")
    expect(report.records.find((r) => r.name === "finalize")?.category).toBe("tee")
    // Both gathering reads land in the recording; their attribution TO the finalize span needs
    // zone tracking, which jsdom has none of — profilerZone.test.ts asserts that half.
    expect(report.records.filter((r) => r.name === "getWitness")).toHaveLength(2)
  })

  it("leaves an options bag without a finalizer alone", async () => {
    const wallet = fakeWalletWithStagedSend()
    profiler.instrumentWallet(wallet)
    const report = await record(async () => {
      await wallet.sendTx({}, {})
    })
    expect(names(report)).toEqual(["sendTx"])
  })

  it("does not spread a class instance argument, which would drop its prototype", async () => {
    class Opts {
      finalize = async () => "done"
      get marker() {
        return "prototype-intact"
      }
    }
    const seen: string[] = []
    const wallet: any = {
      async sendTx(opts: any) {
        seen.push(opts.marker)
        await opts.finalize()
      },
    }
    profiler.instrumentWallet(wallet)
    await record(() => wallet.sendTx(new Opts()))
    expect(seen).toEqual(["prototype-intact"])
  })
})
