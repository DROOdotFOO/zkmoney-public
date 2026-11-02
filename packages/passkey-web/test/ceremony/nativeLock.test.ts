/**
 * The page-start lock, driven through the script text the wallet ships. A `node:vm` realm stands
 * in for the page: its `navigator.credentials` prototype carries the realm's real `Object.create`
 * and `Reflect.get` as `create` and `get` (named natives print as the browser's own), and its
 * `PublicKeyCredential` carries the three probes as functions the realm's
 * `Function.prototype.toString` prints as native, since no real native carries those names.
 */
import { createContext, runInContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"
import {
  KEPT_PASSKEY_API_KEY,
  KEPT_WRAPPER_MARKERS,
  NATIVE_LOCK_KEY,
  NATIVE_PRINT_PATTERN,
  keptPasskeyApiFor,
  lockNativePasskeyApi,
  nativeLockFor,
  nativeLockScript,
  printsNative,
} from "../../src/ceremony/nativeLock.js"
import { PASSKEY_NATIVE_LOCKS } from "../../src/telemetry/passkeyTelemetryVocabulary.js"
import {
  BITWARDEN_CREATE,
  PROTON_PASS_CREATE,
  PROTON_PASS_GET,
  wrapperFrom,
} from "../support/extensionWrappers.js"

const STATICS = [
  "isUserVerifyingPlatformAuthenticatorAvailable",
  "isConditionalMediationAvailable",
  "getClientCapabilities",
] as const
const NAMES = ["create", "get", ...STATICS] as const

const ALL_APPLIED = Object.fromEntries(NAMES.map((name) => [name, "applied"]))

type Realm = {
  context: Record<string, unknown>
  credentials: Record<string, unknown>
  proto: Record<string, unknown>
  pkc: Record<string, unknown>
  /** A function the realm prints as `function <name>() { [native code] }`. */
  native: (name: string) => (...args: unknown[]) => unknown
  run: () => Record<string, string>
  record: () => unknown
  kept: () => Record<string, unknown> | undefined
  descriptor: (container: object, name: string) => PropertyDescriptor | undefined
}

/**
 * A page-like realm. `setup` edits the scope before the script runs; with `webauthn: false` the
 * realm has no `PublicKeyCredential`.
 */
function realm(setup?: (r: Realm) => void, options: { webauthn?: boolean } = {}): Realm {
  const context = createContext({})
  const boot = runInContext(
    `(function () {
      var original = Function.prototype.toString
      var prints = new Map()
      Function.prototype.toString = function () {
        return prints.has(this) ? prints.get(this) : original.call(this)
      }
      var proto = { create: Object.create, get: Reflect.get }
      var credentials = Object.create(proto)
      var pkc = function PublicKeyCredential() {}
      return {
        proto: proto,
        credentials: credentials,
        pkc: pkc,
        native: function (name) {
          var fn = function () {}
          prints.set(fn, "function " + name + "() { [native code] }")
          return fn
        },
      }
    })()`,
    context,
  )
  for (const name of STATICS) boot.pkc[name] = boot.native(name)
  context.navigator = { credentials: boot.credentials }
  if (options.webauthn !== false) context.PublicKeyCredential = boot.pkc
  const r: Realm = {
    context,
    credentials: boot.credentials,
    proto: boot.proto,
    pkc: boot.pkc,
    native: boot.native,
    run: () => runInContext(nativeLockScript(), context),
    record: () => context[NATIVE_LOCK_KEY],
    kept: () => context[KEPT_PASSKEY_API_KEY],
    descriptor: (container, name) => Object.getOwnPropertyDescriptor(container, name),
  }
  setup?.(r)
  return r
}

const locked = (r: Realm, container: object, name: string) => {
  const desc = r.descriptor(container, name)
  expect(desc).toBeDefined()
  expect(desc!.writable).toBe(false)
  expect(desc!.configurable).toBe(false)
  expect(typeof desc!.value).toBe("function")
}

/** The kept slot as the lock publishes it: frozen, prototype-free, holding exactly `entries`. */
const keptExactly = (r: Realm, entries: Record<string, unknown>) => {
  const slot = Object.getOwnPropertyDescriptor(r.context, KEPT_PASSKEY_API_KEY)
  expect(slot).toBeDefined()
  expect(slot!.writable).toBe(false)
  expect(slot!.configurable).toBe(false)
  expect(slot!.enumerable).toBe(false)
  const kept = r.kept()!
  expect(Object.isFrozen(kept)).toBe(true)
  expect(Object.getPrototypeOf(kept)).toBeNull()
  expect(Object.keys(kept)).toEqual(Object.keys(entries))
  for (const [name, value] of Object.entries(entries)) expect(kept[name]).toBe(value)
}

/** A wrapper as an extension's page script assigns it: a plain function from the page's realm. */
const wrapper = () => runInContext("(function create(e) { return e })", realm().context)

const protonCreate = () => wrapperFrom(PROTON_PASS_CREATE)
const protonGet = () => wrapperFrom(PROTON_PASS_GET)

describe("the native print", () => {
  it("accepts the browser's print for the given name, whatever the whitespace, and nothing else", () => {
    expect(printsNative("create", "function create() { [native code] }")).toBe(true)
    expect(printsNative("create", "function create() {\n    [native code]\n}")).toBe(true)
    expect(printsNative("get", Function.prototype.toString.call(Reflect.get))).toBe(true)
    expect(printsNative("get", "function create() { [native code] }")).toBe(false)
    expect(printsNative("create", "function () { [native code] }")).toBe(false)
    expect(printsNative("create", "function create(e) { return e }")).toBe(false)
    expect(
      printsNative("create", 'function create(){ return "function create() { [native code] }" }'),
    ).toBe(false)
  })
})

describe("the lock script", () => {
  it("freezes every native in place and records it", () => {
    const r = realm()
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
    for (const name of ["create", "get"]) {
      locked(r, r.credentials, name)
      expect(r.descriptor(r.credentials, name)!.value).toBe(r.proto[name])
      expect(r.descriptor(r.credentials, name)!.enumerable).toBe(true)
    }
    for (const name of STATICS) locked(r, r.pkc, name)
  })

  it("publishes an empty kept slot on a page with nothing to keep, which no later script can fill", () => {
    const r = realm()
    r.run()
    keptExactly(r, {})
    const late = () => "mine"
    runInContext(
      `(function (w) {
        globalThis[${JSON.stringify(KEPT_PASSKEY_API_KEY)}] = { get: w }
        try { globalThis[${JSON.stringify(KEPT_PASSKEY_API_KEY)}].get = w } catch (e) {}
      })`,
      r.context,
    )(late)
    keptExactly(r, {})
    expect(() => Object.defineProperty(r.kept()!, "get", { value: late })).toThrow(TypeError)
    expect(() =>
      Object.defineProperty(r.context, KEPT_PASSKEY_API_KEY, { value: { get: late } }),
    ).toThrow(TypeError)
  })

  it("keeps a frozen value against assignment, deletion and a later prototype patch", () => {
    const r = realm()
    r.run()
    const late = () => "mine"
    runInContext("(function (w) { navigator.credentials.create = w })", r.context)(late)
    expect(r.credentials.create).toBe(r.proto.create)
    expect(() => {
      "use strict"
      r.credentials.create = late
    }).toThrow(TypeError)
    expect(runInContext("delete navigator.credentials.create", r.context)).toBe(false)
    r.proto.create = late
    expect(r.credentials.create).not.toBe(late)
  })

  it("publishes the record as a frozen, non-writable slot no later script can replace", () => {
    const r = realm()
    r.run()
    const slot = Object.getOwnPropertyDescriptor(r.context, NATIVE_LOCK_KEY)!
    expect(slot.writable).toBe(false)
    expect(slot.configurable).toBe(false)
    expect(Object.isFrozen(r.record())).toBe(true)
    runInContext(
      `globalThis[${JSON.stringify(NATIVE_LOCK_KEY)}] = { create: "lost_race" }`,
      r.context,
    )
    expect(r.record()).toEqual(ALL_APPLIED)
  })

  it("runs twice without a throw and records applied both times", () => {
    const r = realm()
    r.run()
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
  })

  it.each<[string, (r: Realm) => void, string]>([
    [
      "a locked accessor on the instance",
      (r) => {
        Object.defineProperty(r.credentials, "create", {
          get: () => () => null,
          set: () => {},
          configurable: false,
        })
      },
      "create",
    ],
    [
      "a locked accessor on the prototype",
      (r) => {
        Object.defineProperty(r.proto, "get", { get: () => () => null, configurable: false })
      },
      "get",
    ],
    [
      "a configurable accessor",
      (r) => {
        Object.defineProperty(r.credentials, "create", {
          get: () => Object.create,
          configurable: true,
        })
      },
      "create",
    ],
    [
      "an accessor with neither getter nor setter",
      (r) => {
        Object.defineProperty(r.credentials, "create", {
          get: undefined,
          set: undefined,
          configurable: true,
        })
      },
      "create",
    ],
    [
      "an accessor under an own native value",
      (r) => {
        Object.defineProperty(r.proto, "create", { get: () => () => null, configurable: false })
        Object.defineProperty(r.credentials, "create", {
          value: Object.create,
          writable: true,
          configurable: true,
        })
      },
      "create",
    ],
    [
      "an accessor deeper on the chain",
      (r) => {
        const base = { get: () => null }
        Object.defineProperty(base, "get", { get: () => () => null, configurable: false })
        Object.setPrototypeOf(r.proto, base)
      },
      "get",
    ],
    [
      "an accessor on a static",
      (r) => {
        Object.defineProperty(r.pkc, "getClientCapabilities", {
          get: () => () => null,
          configurable: true,
        })
      },
      "getClientCapabilities",
    ],
  ])("skips and leaves alone %s", (_case, setup, name) => {
    const r = realm(setup)
    const container = (STATICS as readonly string[]).includes(name) ? r.pkc : r.credentials
    const before = r.descriptor(container, name)
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, [name]: "skipped_accessor" })
    expect(r.descriptor(container, name)).toEqual(before)
  })

  describe("a wrapper assigned on the instance before the page's scripts", () => {
    it("is replaced by the prototype's own method, frozen, and recorded as restored", () => {
      const w = wrapper()
      const r = realm((r) => {
        r.credentials.create = w
        r.credentials.get = w
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored", get: "restored" })
      for (const name of ["create", "get"]) {
        locked(r, r.credentials, name)
        expect(r.descriptor(r.credentials, name)!.value).toBe(r.proto[name])
        expect(r.descriptor(r.credentials, name)!.enumerable).toBe(true)
      }
    })

    it("restores only the calls that were overridden", () => {
      const r = realm((r) => {
        r.credentials.get = wrapper()
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, get: "restored" })
      expect(r.descriptor(r.credentials, "create")!.value).toBe(r.proto.create)
    })

    it("restores a native-printing own value too, since the browser never puts one there", () => {
      // Firefox's exportFunction yields a forwarder that prints as a named native.
      const r = realm((r) => {
        r.credentials.create = r.native("create")
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored" })
      expect(r.descriptor(r.credentials, "create")!.value).toBe(r.proto.create)
      keptExactly(r, {})
    })

    it("leaves a non-configurable override alone, recorded as lost_race", () => {
      const w = wrapper()
      const r = realm((r) => {
        Object.defineProperty(r.credentials, "create", { value: w, writable: true })
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
      expect(r.credentials.create).toBe(w)
    })

    describe("carrying Proton Pass's marker", () => {
      it("is restored like any other and kept aside, create and get each under its own name", () => {
        const create = protonCreate()
        const get = protonGet()
        const r = realm((r) => {
          r.credentials.create = create
          r.credentials.get = get
        })
        r.run()
        expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored", get: "restored" })
        keptExactly(r, { create, get })
      })

      it("checks the marker per name: a get carrying only the create marker is not kept", () => {
        const r = realm((r) => {
          r.credentials.get = protonCreate()
        })
        r.run()
        expect(r.record()).toEqual({ ...ALL_APPLIED, get: "restored" })
        keptExactly(r, {})
      })

      it("keeps nothing from another vendor's wrapper", () => {
        const r = realm((r) => {
          r.credentials.create = wrapperFrom(BITWARDEN_CREATE)
          r.credentials.get = wrapper()
        })
        r.run()
        expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored", get: "restored" })
        keptExactly(r, {})
      })

      it("keeps nothing it could not restore: a non-configurable override", () => {
        const create = protonCreate()
        const r = realm((r) => {
          Object.defineProperty(r.credentials, "create", { value: create, writable: true })
        })
        r.run()
        expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
        keptExactly(r, {})
      })

      it("keeps nothing when the container refuses the restore", () => {
        const create = protonCreate()
        const proto = { create: Object.create, get: Reflect.get }
        const credentials = Object.create(proto)
        credentials.create = create
        const refusing = new Proxy(credentials, {
          defineProperty() {
            throw new TypeError("refused")
          },
        })
        const scope: Record<string, unknown> = {
          navigator: { credentials: refusing },
          PublicKeyCredential: {},
        }
        const record = lockNativePasskeyApi(
          scope,
          NATIVE_PRINT_PATTERN,
          NATIVE_LOCK_KEY,
          KEPT_PASSKEY_API_KEY,
          KEPT_WRAPPER_MARKERS,
        )
        expect(record).toEqual({ create: "lost_race", get: "lost_race" })
        expect(credentials.create).toBe(create)
        expect(Object.keys(scope[KEPT_PASSKEY_API_KEY] as object)).toEqual([])
      })
    })

    it("restores a configurable own value that is not a function, keeping nothing and throwing nothing", () => {
      const r = realm((r) => {
        r.credentials.create = null
      })
      expect(() => r.run()).not.toThrow()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored" })
      expect(r.descriptor(r.credentials, "create")!.value).toBe(r.proto.create)
      keptExactly(r, {})
    })

    it("restores an override whose source cannot be read, keeping nothing", () => {
      const r = realm((r) => {
        const fn = protonCreate() as (...args: unknown[]) => unknown
        r.credentials.create = fn
        runInContext(
          `(function (fn) {
            var original = Function.prototype.toString
            Function.prototype.toString = function () {
              if (this === fn) throw new Error("blocked")
              return original.call(this)
            }
          })`,
          r.context,
        )(fn)
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "restored" })
      expect(r.descriptor(r.credentials, "create")!.value).toBe(r.proto.create)
      keptExactly(r, {})
    })

    it("leaves the override alone when the prototype's method is no longer the browser's", () => {
      const w = wrapper()
      const r = realm((r) => {
        r.proto.create = new Proxy(r.proto.create as object, {})
        r.credentials.create = w
      })
      r.run()
      expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
      expect(r.credentials.create).toBe(w)
    })
  })

  it("accepts an own copy of the prototype's own method, as another freeze would leave it", () => {
    const r = realm((r) => {
      Object.defineProperty(r.credentials, "get", {
        value: r.proto.get,
        writable: false,
        configurable: false,
        enumerable: false,
      })
    })
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
    expect(r.descriptor(r.credentials, "get")!.enumerable).toBe(false)
  })

  it("leaves a nameless native print alone: a bound function or a Proxy over the native", () => {
    const r = realm((r) => {
      r.proto.create = (r.proto.create as () => unknown).bind(Object)
      r.proto.get = new Proxy(r.proto.get as object, {})
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race", get: "lost_race" })
    expect(r.descriptor(r.credentials, "create")).toBeUndefined()
    expect(r.descriptor(r.credentials, "get")).toBeUndefined()
  })

  it("keeps a constructor's own probe when its parent carries one of the same name, as Chromium's Credential does", () => {
    const r = realm((r) => {
      const parent = function Credential() {}
      ;(parent as unknown as Record<string, unknown>).isConditionalMediationAvailable = r.native(
        "isConditionalMediationAvailable",
      )
      Object.setPrototypeOf(r.pkc, parent)
    })
    const own = r.pkc.isConditionalMediationAvailable
    r.run()
    expect(r.record()).toEqual(ALL_APPLIED)
    expect(r.descriptor(r.pkc, "isConditionalMediationAvailable")!.value).toBe(own)
    locked(r, r.pkc, "isConditionalMediationAvailable")
  })

  it("leaves a scripted wrapper alone wherever it sits: on the prototype or on a static", () => {
    const onProto = realm((r) => {
      r.proto.create = wrapperFrom(BITWARDEN_CREATE)
    })
    onProto.run()
    expect(onProto.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
    expect(onProto.descriptor(onProto.credentials, "create")).toBeUndefined()

    const onStatic = realm((r) => {
      r.pkc.isConditionalMediationAvailable = () => true
    })
    onStatic.run()
    expect(onStatic.record()).toEqual({
      ...ALL_APPLIED,
      isConditionalMediationAvailable: "lost_race",
    })
    expect(onStatic.descriptor(onStatic.pkc, "isConditionalMediationAvailable")!.writable).toBe(
      true,
    )
  })

  it("skips a probe the browser does not have", () => {
    const r = realm((r) => {
      delete r.pkc.getClientCapabilities
    })
    r.run()
    const rest = { ...ALL_APPLIED }
    delete rest.getClientCapabilities
    expect(r.record()).toEqual(rest)
  })

  it("records lost_race when the container refuses the definition, and goes on", () => {
    const r = realm((r) => {
      Object.preventExtensions(r.credentials)
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race", get: "lost_race" })
  })

  it("records unsupported for every name without WebAuthn, and defines nothing", () => {
    const r = realm(undefined, { webauthn: false })
    r.run()
    expect(r.record()).toEqual(Object.fromEntries(NAMES.map((name) => [name, "unsupported"])))
    expect(r.descriptor(r.credentials, "create")).toBeUndefined()
    const bare = realm((r) => {
      delete (r.context.navigator as { credentials?: unknown }).credentials
    })
    bare.run()
    expect(bare.record()).toEqual(Object.fromEntries(NAMES.map((name) => [name, "unsupported"])))
  })

  it("records lost_race for a value whose print cannot be read", () => {
    const r = realm((r) => {
      const fn = r.native("create")
      r.proto.create = fn
      runInContext(
        `(function (fn) {
          var original = Function.prototype.toString
          Function.prototype.toString = function () {
            if (this === fn) throw new Error("blocked")
            return original.call(this)
          }
        })`,
        r.context,
      )(fn)
    })
    r.run()
    expect(r.record()).toEqual({ ...ALL_APPLIED, create: "lost_race" })
  })

  it("still locks when the record cannot be written", () => {
    const throwing = realm((r) => {
      Object.defineProperty(r.context, NATIVE_LOCK_KEY, {
        get: () => undefined,
        set: () => {
          throw new Error("no")
        },
      })
    })
    expect(() => throwing.run()).not.toThrow()
    locked(throwing, throwing.credentials, "create")
    expect(throwing.record()).toBeUndefined()
    const frozen = realm((r) => {
      Object.defineProperty(r.context, NATIVE_LOCK_KEY, { value: "held", writable: false })
    })
    expect(() => frozen.run()).not.toThrow()
    locked(frozen, frozen.credentials, "get")
    expect(frozen.record()).toBe("held")
  })

  it("publishes each slot on its own: a held record still gets the kept slot, and the reverse", () => {
    const create = protonCreate()
    const recordHeld = realm((r) => {
      r.credentials.create = create
      Object.defineProperty(r.context, NATIVE_LOCK_KEY, { value: "held", writable: false })
    })
    expect(() => recordHeld.run()).not.toThrow()
    expect(recordHeld.record()).toBe("held")
    keptExactly(recordHeld, { create })

    const keptHeld = realm((r) => {
      r.credentials.create = create
      Object.defineProperty(r.context, KEPT_PASSKEY_API_KEY, { value: "held", writable: false })
    })
    expect(() => keptHeld.run()).not.toThrow()
    expect(keptHeld.record()).toEqual({ ...ALL_APPLIED, create: "restored" })
    expect(keptHeld.kept()).toBe("held")
  })

  it("ships as one self-contained classic script", () => {
    const text = nativeLockScript()
    expect(text).not.toMatch(/\b(import|require|export)\b/)
    expect(text).not.toMatch(
      /nativeLockFor|keptPasskeyApiFor|printsNative|NATIVE_PRINT_PATTERN|NATIVE_LOCK_KEY|KEPT_PASSKEY_API_KEY|KEPT_WRAPPER_MARKERS|PASSKEY_NATIVE_LOCKS/,
    )
    expect(text).not.toMatch(/<\/script|<!--/i)
    expect(text).toContain(JSON.stringify(NATIVE_PRINT_PATTERN))
    for (const name of NAMES) expect(text).toContain(`"${name}"`)
    for (const outcome of PASSKEY_NATIVE_LOCKS) expect(text).toContain(`"${outcome}"`)
  })

  it("gives the direct call the same answers as the script for create and get", () => {
    const proto = { create: Object.create, get: Reflect.get }
    const credentials = Object.create(proto)
    const get = protonGet()
    credentials.get = get
    const scope: Record<string, unknown> = { navigator: { credentials }, PublicKeyCredential: {} }
    const record = lockNativePasskeyApi(
      scope,
      NATIVE_PRINT_PATTERN,
      NATIVE_LOCK_KEY,
      KEPT_PASSKEY_API_KEY,
      KEPT_WRAPPER_MARKERS,
    )
    expect(record).toEqual({ create: "applied", get: "restored" })
    expect(scope[NATIVE_LOCK_KEY]).toBe(record)
    expect(Object.getOwnPropertyDescriptor(credentials, "create")!.writable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(credentials, "get")!.value).toBe(proto.get)
    expect((scope[KEPT_PASSKEY_API_KEY] as Record<string, unknown>)["get"]).toBe(get)
  })
})

describe("keptPasskeyApiFor", () => {
  const scope = globalThis as Record<string, unknown>
  const fn = () => Promise.resolve(null)
  afterEach(() => {
    delete scope[KEPT_PASSKEY_API_KEY]
    delete (Object.prototype as Record<string, unknown>)[KEPT_PASSKEY_API_KEY]
  })

  it("reads an own function for the call from an own slot, and nothing otherwise", () => {
    expect(keptPasskeyApiFor("get")).toBeUndefined()
    scope[KEPT_PASSKEY_API_KEY] = Object.assign(Object.create(null), { get: fn })
    expect(keptPasskeyApiFor("get")).toBe(fn)
    expect(keptPasskeyApiFor("create")).toBeUndefined()
    scope[KEPT_PASSKEY_API_KEY] = Object.create(null)
    expect(keptPasskeyApiFor("get")).toBeUndefined()
  })

  it("takes no entry from a slot's prototype, no accessor, and no non-function", () => {
    scope[KEPT_PASSKEY_API_KEY] = Object.create({ get: fn })
    expect(keptPasskeyApiFor("get")).toBeUndefined()
    scope[KEPT_PASSKEY_API_KEY] = Object.defineProperty(Object.create(null), "get", {
      get: () => fn,
    })
    expect(keptPasskeyApiFor("get")).toBeUndefined()
    scope[KEPT_PASSKEY_API_KEY] = Object.assign(Object.create(null), { get: "get" })
    expect(keptPasskeyApiFor("get")).toBeUndefined()
  })

  it("takes no slot that is not the global's own, and no slot that is not an object", () => {
    Object.defineProperty(Object.prototype, KEPT_PASSKEY_API_KEY, {
      value: Object.assign(Object.create(null), { get: fn }),
      configurable: true,
    })
    expect(keptPasskeyApiFor("get")).toBeUndefined()
    delete (Object.prototype as Record<string, unknown>)[KEPT_PASSKEY_API_KEY]
    scope[KEPT_PASSKEY_API_KEY] = fn
    expect(keptPasskeyApiFor("get")).toBeUndefined()
    scope[KEPT_PASSKEY_API_KEY] = null
    expect(keptPasskeyApiFor("get")).toBeUndefined()
    Object.defineProperty(scope, KEPT_PASSKEY_API_KEY, {
      get() {
        throw new Error("blocked")
      },
      configurable: true,
    })
    expect(keptPasskeyApiFor("get")).toBeUndefined()
  })
})

describe("nativeLockFor", () => {
  const scope = globalThis as Record<string, unknown>
  afterEach(() => {
    delete scope[NATIVE_LOCK_KEY]
  })

  it("reads the entry for the call, and nothing where there is none or it is off the list", () => {
    expect(nativeLockFor("create")).toBeUndefined()
    scope[NATIVE_LOCK_KEY] = { create: "lost_race", get: "applied" }
    expect(nativeLockFor("create")).toBe("lost_race")
    expect(nativeLockFor("get")).toBe("applied")
    scope[NATIVE_LOCK_KEY] = { get: "restored" }
    expect(nativeLockFor("create")).toBeUndefined()
    expect(nativeLockFor("get")).toBe("restored")
    scope[NATIVE_LOCK_KEY] = { create: "frozen" }
    expect(nativeLockFor("create")).toBeUndefined()
    scope[NATIVE_LOCK_KEY] = "applied"
    expect(nativeLockFor("create")).toBeUndefined()
    scope[NATIVE_LOCK_KEY] = null
    expect(nativeLockFor("get")).toBeUndefined()
  })
})
