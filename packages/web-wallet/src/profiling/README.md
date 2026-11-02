# Wallet profiler

A recording overlay over the wallet, PXE, node client, HTTP and bb.js WASM: hit **Rec**, run a flow,
hit **Stop**, and the panel opens a waterfall of every span with a per-category roll-up under it.
Ported from `aztec-kit`'s `apps/swap` profiler, re-fitted to `ObsidionWallet` and off MUI.

Nothing in `front-core` or `sdk` knows this exists. `instrumentWallet` wraps methods on the live
wallet, its PXE, the node client and the PXE's own sub-services from the outside, and the
interceptors patch `window.fetch`, the circuit simulator's prototype and bb.js's two singletons.
That is why the spans are named after real methods rather than hand-placed markers, and why the
whole thing disappears from a default build.

## Build modes

The panel is gated at build time by `VITE_PROFILER`. There is no runtime switch — a default build
carries neither the panel chunk nor zone.js.

| `VITE_PROFILER` | Panel | zone.js | Build target | What you get                                             |
| --------------- | ----- | ------- | ------------ | -------------------------------------------------------- |
| _(unset)_       | no    | no      | default      | Production. The profiling chunks are not emitted at all. |
| `true`          | yes   | yes     | `chrome54`   | Full waterfall with causal nesting.                      |

It is all or nothing on purpose: the panel is only worth reading with causal nesting under it, and
nesting needs the lowering. Zone.js can only observe an await boundary when async/await has been
compiled down to a generator driven by a user-space `Promise.resolve().then()` — V8 resumes a native
async function without ever calling that — so a profiling build lowers the entire bundle to the
newest engine that predates async/await.

That lowering costs real speed, and costs it unevenly across the code. **Read proportions, not
absolute numbers, and compare a recording only against another profiling build** — timing one
against a production bundle measures the build, not the wallet.

## Recording against staging

The wallet's client-side work is the same wherever the bundle is served from; what staging supplies
is its node, account-service, TEE enclave and their latency. So the fastest loop is a local
profiling build pointed at the staging tier — the recipe in the package
[README](../../README.md#running-locally-against-staging), with the flag added:

```shell
export ACCOUNT_SERVICE_TARGET=https://account.staging.zk.money
export ENCLAVE_TARGET=<enclave-url>
VITE_PROFILER=true pnpm build && pnpm preview --port 5173 --strictPort
```

`preview`, never `dev`: the dev server's dep optimizer sweeps served chunk hashes out from under the
PXE's dynamic imports mid-flow, and only a built bundle gets the target lowering (`vite.config.ts`
applies it as a whole-bundle pass, which the dev server has no equivalent of).

To profile the deployed bundle itself — CDN asset latency included, which is the one thing the local
loop cannot show — bake the flag into a deploy: `VITE_PROFILER` alongside the other `VITE_*` in the
build step of `deploy-web-wallet.yml` (staging only) or `ci-web-wallet-preview.yml`, whose previews
already share staging's backend. Never on the production environment.

Every report stamps the network, node URL, app version, origin, core count and whether zone tracking
was live, so a downloaded JSON stays attributable to the tier it came from.

## Reading a report

Spans carry a category, and the colours are consistent between the waterfall, the legend and the
roll-up:

| Category | Where the span comes from                                                                |
| -------- | ---------------------------------------------------------------------------------------- |
| `wallet` | A method on `ObsidionWallet` — `sendTx`, `proveTx`, `simulateTx`.                        |
| `pxe`    | A method on the PXE instance.                                                            |
| `store`  | A PXE sub-service or KV store reached by walking the PXE's own fields.                   |
| `sim`    | One circuit execution, labelled `Contract:function`.                                     |
| `oracle` | One oracle callback inside a circuit execution — `getNotes`, `getPublicDataTreeWitness`. |
| `node`   | A method on the Aztec node client.                                                       |
| `rpc`    | One `fetch`: a JSON-RPC call (batches are labelled and re-parented) or a backend hop.    |
| `wasm`   | One `bb.js` backend call, named from the msgpack operation.                              |
| `tee`    | The staged `finalize` phase, and each enclave call on the `TeeSigner` inside it.         |

**Reading TEE cost.** Two spans, and the interesting number is the difference between them.

`finalize` is the whole staged-execution phase: the L1→L2 membership-witness read per spent deposit,
the spend-metadata resolution per nullified note, the token-operation build, the capsule
construction — and only at the end the enclave call. `signTokenOperation` is that enclave call
alone. So **`finalize` − `signTokenOperation` is the data gathering**, and each read inside it is an
`rpc` or `node` child you can expand to see which one dominates. Inside `signTokenOperation` sits
one more `rpc` child, the POST itself, separating wire and enclave time from the local crypto around
it.

Neither needs a marker in the sdk. `finalize` arrives as a property of the options bag
`wallet.sendTx` takes, so the profiler wraps it in transit while wrapping `sendTx` — a plain object
literal only, since spreading a class instance would drop its prototype. The signer is caught one
layer out at `ServiceBase.setTeeSigner`, the point the session's token takes it, as do
PaylinkService. A signer passed straight to a service constructor rather than through `setTeeSigner`
would not be wrapped; nothing currently does that.

The summary tables under the chart are usually the faster read: **BY CATEGORY** says where the wall
clock went, **CIRCUIT EXECUTIONS** lists every circuit with its count and total, **TOP WASM** and
**TOP RPC** rank the individual operations. The waterfall is for the question those cannot answer —
whether the time was spent serially or waiting on something.

`JSON` downloads the raw report (`ProfileReport` in `types.ts`) for diffing two runs offline.

The panel also parks its profiler on `window.__profiler`, so a recording can be driven from the
console or a Playwright script rather than the pill — `__profiler.start("send")`, run the flow,
`__profiler.download(__profiler.stop())`.

## Gotchas

**The flag is spelled out inline at each branch site** (`boot.tsx`, `App.tsx`) rather than imported
from a shared const. Vite replaces `import.meta.env.VITE_PROFILER` with a literal in the module that
reads it, and only then does the comparison fold and the dead `import()` disappear. Re-exporting the
boolean from one module leaves the branch live, and both the zone.js and the panel chunk get emitted
into production builds — 60KB that nothing loads.

**Only bundled code gets the lowering, so console-driven spans do not nest.** A snippet typed into
devtools or passed to `page.evaluate` is compiled by the browser as-is, with native async/await —
the exact thing `chrome54` exists to remove — so `__profiler.span(...)` calls written there lose
their zone at the first `await` and land as roots. That says nothing about the recording: the
wallet's own spans, which are bundled, nest correctly. Drive real flows and let the instrumented
methods produce the spans; use `__profiler` for `start`/`stop`/`download` only.

**Fetches without a body are skipped unless they are under `/svc/`.** That is what keeps the WASM,
CRS and chunk downloads out of the profile while still catching every node JSON-RPC call and every
account-service, enclave and analytics hop. A backend reached at an absolute URL by a `GET` would be
missed; none currently is.

**Some objects are wrapped by reference rather than patched.** PXE's caching node wrapper is a
`Proxy` whose `get` trap synthesizes methods, so writing a wrapper onto it recurses infinitely on
the first read. `canObserveOwnWrites` probes for that and those objects get a facade installed at
each property site instead. The console says which path each object took at instrument time.

**Queue-like objects are skipped entirely.** A `SerialQueue`'s blocking `get()` sits idle for
seconds waiting for work, and a span covering it says nothing except that the queue was empty.
