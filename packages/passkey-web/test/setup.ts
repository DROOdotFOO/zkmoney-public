// jsdom ships no WebAuthn and no Web Locks, so `passkeysSupported()` would read every jsdom suite
// as an unsupported browser. Node suites have no window at all. The lock stand-in serializes per
// name within this realm, which is what the consumers rely on.
if (typeof window !== "undefined") {
  ;(window as { PublicKeyCredential?: unknown }).PublicKeyCredential ??= class {}
  const nav = navigator as Navigator & { locks?: unknown }
  if (!nav.locks) {
    const queues = new Map<string, Promise<unknown>>()
    Object.defineProperty(nav, "locks", {
      configurable: true,
      value: {
        request: (name: string, fn: () => Promise<unknown>) => {
          const previous = queues.get(name) ?? Promise.resolve()
          const run = previous.then(fn, fn)
          queues.set(name, run)
          return run
        },
      },
    })
  }
}
