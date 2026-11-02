/**
 * Fetch + WASM + simulator interception for profiling.
 *
 * Every interceptor takes the `Profiler` instance and wraps work through its `runSpan`, which
 * routes through `runInSpan` (zone.js) so async context propagates and each captured span carries
 * the right `parentId`.
 */

import type { Profiler } from "./index"
import { findAncestorSpan } from "./context"

// Categories to skip when re-parenting batched fetches. A batched RPC call is triggered by a
// setTimeout scheduled inside a `node` method, so it would otherwise nest under that first node
// call. Skipping `node` makes the batch record a sibling of the node calls it groups.
const SKIP_FOR_BATCH_PARENT = new Set(["node" as const, "rpc" as const])

// ─── Fetch interceptor ──────────────────────────────────────────────────────

/** Backend hops the wallet reaches same-origin through the CDN / dev-server proxy. */
const SERVICE_PATH_PREFIX = "/svc/"

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return new URL(raw, window.location.origin)
  } catch {
    return null
  }
}

/**
 * Label a request, and decide whether it is worth a span at all.
 *
 * Anything carrying a body is instrumented: that is every JSON-RPC call to the node plus the REST
 * hops to account-service, the TEE enclave and analytics — and never a static asset. Bodyless
 * requests only qualify under `/svc/`, which keeps the WASM, CRS and chunk downloads out of the
 * profile.
 */
function describeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { label: string; batched: boolean } | null {
  const url = requestUrl(input)
  const method = (
    init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
  ).toUpperCase()
  const body = init?.body

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) {
        return {
          label: `[batch] ${parsed.map((r: any) => r?.method ?? "?").join(", ")}`,
          batched: true,
        }
      }
      if (parsed?.method) return { label: String(parsed.method), batched: false }
    } catch {
      // Not JSON — fall through to the path label.
    }
  }
  if (body != null) return { label: `${method} ${url?.pathname ?? "?"}`, batched: false }
  if (url?.pathname.startsWith(SERVICE_PATH_PREFIX)) {
    return { label: `${method} ${url.pathname}`, batched: false }
  }
  return null
}

export function installFetchInterceptor(profiler: Profiler): () => void {
  const original = window.fetch.bind(window)

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!profiler.isRecording) return original(input, init)

    const described = describeRequest(input, init)
    if (!described) return original(input, init)

    // For batched fetches, re-parent above any node ancestors so the batch is a sibling of the
    // node calls it bundled rather than nested under the first one, which is only where the
    // setTimeout happened to land.
    const parentOverride = described.batched
      ? findAncestorSpan(SKIP_FOR_BATCH_PARENT) ?? null
      : undefined

    return profiler.runSpan(
      described.label,
      "rpc",
      async () => await original(input, init),
      undefined,
      parentOverride,
    ) as Promise<Response>
  }

  return () => {
    window.fetch = original
  }
}

// ─── Msgpack operation name decoder ─────────────────────────────────────────
// bb.js backend.call receives msgpack-encoded [["OperationName", ...args]]. Extract just the
// operation name from the first few bytes.

function decodeMsgpackOpName(buf: Uint8Array): string | null {
  try {
    let pos = 0
    const u8 = (o: number) => buf[o]

    // Outer fixarray header (0x90..0x9f)
    const outer = u8(pos++)
    if ((outer & 0xf0) !== 0x90) return null
    // Inner fixarray header
    const inner = u8(pos++)
    if ((inner & 0xf0) !== 0x90) return null
    // String header
    const strHdr = u8(pos++)
    let strLen: number
    if ((strHdr & 0xe0) === 0xa0) {
      strLen = strHdr & 0x1f // fixstr
    } else if (strHdr === 0xd9) {
      strLen = u8(pos++) // str 8
    } else {
      return null
    }
    let name = ""
    for (let i = 0; i < strLen && pos < buf.length; i++) {
      name += String.fromCharCode(u8(pos++))
    }
    return name || null
  } catch {
    return null
  }
}

// ─── WASM interceptor ───────────────────────────────────────────────────────

function wrapBackendCall(backend: any, profiler: Profiler, fallbackName: string): () => void {
  if (!backend || typeof backend.call !== "function" || backend.call.__profiled) return () => {}

  const original = backend.call.bind(backend)

  backend.call = function (inputBuffer: Uint8Array) {
    if (!profiler.isRecording) return original(inputBuffer)
    const opName = decodeMsgpackOpName(inputBuffer) ?? fallbackName
    return profiler.runSpan(opName, "wasm", () => original(inputBuffer))
  }

  backend.call.__profiled = true
  return () => {
    backend.call = original
  }
}

/**
 * Instrument bb.js's two singletons: `BarretenbergSync` (main-thread hashing — poseidon, pedersen)
 * and `Barretenberg` (the proving worker). Either may be uninitialized at install time, so
 * `initSingleton` is patched to catch the instance whenever it is created.
 */
export async function installWasmInterceptor(profiler: Profiler): Promise<() => void> {
  const restores: (() => void)[] = []

  try {
    const bbMod = await import("@aztec-foundation/bb.js")
    const singletons: [any, string][] = [
      [(bbMod as any).BarretenbergSync, "bb_sync"],
      [(bbMod as any).Barretenberg, "bb_async"],
    ]

    for (const [Class, fallbackName] of singletons) {
      if (!Class) continue

      try {
        const existing = Class.getSingleton()
        if (existing?.backend)
          restores.push(wrapBackendCall(existing.backend, profiler, fallbackName))
      } catch {
        /* not yet init'd */
      }

      if (Class.initSingleton && !Class.initSingleton.__profiled) {
        const orig = Class.initSingleton.bind(Class)
        Class.initSingleton = async (...args: any[]) => {
          const inst = await orig(...args)
          if (inst?.backend) restores.push(wrapBackendCall(inst.backend, profiler, fallbackName))
          return inst
        }
        Class.initSingleton.__profiled = true
        restores.push(() => {
          Class.initSingleton = orig
        })
      }
    }
  } catch {
    // @aztec-foundation/bb.js not available — no WASM profiling
  }

  return () => restores.forEach((r) => r())
}

// ─── TEE signer interceptor ────────────────────────────────────────────────

/**
 * A `tee` span per enclave call, wrapping the signer by reference.
 *
 * `TeeSigner`'s methods live on a class prototype and it carries readonly key material beside
 * them, so this is a Proxy rather than a copied object: functions are wrapped on the way out and
 * everything else — `publicKey`, `ethAddress`, `encryptionPublicKey` — passes through untouched.
 */
function wrapTeeSigner(signer: any, profiler: Profiler): any {
  if (!signer || typeof signer !== "object" || signer.__profiled) return signer
  const facade = new Proxy(signer, {
    get(target, prop, receiver) {
      if (prop === "__profiled") return true
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function" || typeof prop !== "string") return value
      return function (this: any, ...args: any[]) {
        if (!profiler.isRecording) return value.apply(target, args)
        return profiler.runSpan(prop, "tee", () => value.apply(target, args))
      }
    },
  })
  return facade
}

/**
 * Catch the signer where it is handed to the services rather than where it is built: the session's
 * `teeSigner` resolves it from an injected source and fans it in through `setTeeSigner`, which every service
 * inherits from `ServiceBase`. Patching that one prototype method covers TokenService and
 * PaylinkService both, and leaves the signer source, front-core and the sdk untouched.
 *
 * The enclave round-trip inside `signTokenOperation` is a POST, so the fetch interceptor records
 * it as an `rpc` child of the `tee` span — the gap between the two is the local crypto.
 */
export async function installTeeInterceptor(profiler: Profiler): Promise<() => void> {
  try {
    const sdk: any = await import("@obsidion/sdk")
    const proto = sdk.ServiceBase?.prototype
    if (!proto || typeof proto.setTeeSigner !== "function" || proto.setTeeSigner.__profiled) {
      return () => {}
    }
    const original = proto.setTeeSigner
    proto.setTeeSigner = function (this: any, signer: any) {
      return original.call(this, signer ? wrapTeeSigner(signer, profiler) : signer)
    }
    proto.setTeeSigner.__profiled = true
    console.info("[profiler] wrapped tee: signer facade installed on ServiceBase.setTeeSigner")
    return () => {
      proto.setTeeSigner = original
    }
  } catch {
    // @obsidion/sdk not resolvable — no TEE profiling
    return () => {}
  }
}

// ─── Simulator + oracle callback interceptor ───────────────────────────────

/**
 * Wrap every method on an ACIRCallback (oracle) object with profiling. Each key is an oracle
 * function name (getNotes, getPublicDataTreeWitness, ...).
 *
 * Returns a NEW object with wrapped methods — the original callback is left untouched and the ACVM
 * only ever sees the wrapped one.
 */
function wrapOracleCallback(callback: any, profiler: Profiler): any {
  if (!callback || typeof callback !== "object") return callback

  const wrapped: any = {}
  for (const key of Object.keys(callback)) {
    const original = callback[key]
    if (typeof original !== "function") {
      wrapped[key] = original
      continue
    }
    wrapped[key] = function (this: any, ...args: any[]) {
      if (!profiler.isRecording) return original.apply(this, args)
      return profiler.runSpan(key, "oracle", () => original.apply(this, args))
    }
  }
  return wrapped
}

/**
 * Patch the circuit simulator's prototype by reaching through the PXE instance, which avoids
 * importing @aztec-labs/simulator or @aztec-labs/pxe/server (both carry node deps that break the browser
 * build).
 *
 * `executeUserCircuit` records the circuit execution and wraps the oracle callback so every oracle
 * call gets its own span; `executeProtocolCircuit` records protocol circuit execution.
 */
export function installSimulatorInterceptorFromPXE(pxe: any, profiler: Profiler): () => void {
  const restores: (() => void)[] = []

  const sim = pxe?.simulator
  if (!sim) return () => {}

  const simProto = Object.getPrototypeOf(sim)
  if (!simProto) return () => {}

  if (
    typeof simProto.executeUserCircuit === "function" &&
    !simProto.executeUserCircuit.__profiled
  ) {
    const original = simProto.executeUserCircuit
    simProto.executeUserCircuit = function (
      this: any,
      input: any,
      artifact: any,
      callback: any,
      ...rest: any[]
    ) {
      if (!profiler.isRecording) return original.call(this, input, artifact, callback, ...rest)
      const name = artifact?.name ?? artifact?.functionName ?? "circuit"
      const contract = artifact?.contractName ?? ""
      const label = contract ? `${contract}:${name}` : name
      const wrappedCallback = wrapOracleCallback(callback, profiler)
      return profiler.runSpan(label, "sim", () =>
        original.call(this, input, artifact, wrappedCallback, ...rest),
      )
    }
    simProto.executeUserCircuit.__profiled = true
    restores.push(() => {
      simProto.executeUserCircuit = original
    })
  }

  if (
    typeof simProto.executeProtocolCircuit === "function" &&
    !simProto.executeProtocolCircuit.__profiled
  ) {
    const original = simProto.executeProtocolCircuit
    simProto.executeProtocolCircuit = function (
      this: any,
      input: any,
      artifact: any,
      callback: any,
      ...rest: any[]
    ) {
      if (!profiler.isRecording) return original.call(this, input, artifact, callback, ...rest)
      const label = artifact?.name ?? "protocol_circuit"
      const wrappedCallback =
        callback && typeof callback === "object" ? wrapOracleCallback(callback, profiler) : callback
      return profiler.runSpan(label, "sim", () =>
        original.call(this, input, artifact, wrappedCallback, ...rest),
      )
    }
    simProto.executeProtocolCircuit.__profiled = true
    restores.push(() => {
      simProto.executeProtocolCircuit = original
    })
  }

  return () => restores.forEach((r) => r())
}

// Standalone functions imported via `import { foo } from 'bar'` (simulateViaNode, waitForTx) are
// not captured: ESM imports are live bindings to the exporter's local variable, not the namespace
// object, so monkey-patching the namespace at runtime does not reach existing importers. Their
// work still shows through the interceptors that capture their internals — RPC/fetch for
// simulateViaNode, the node.getTxReceipt polls for waitForTx.
