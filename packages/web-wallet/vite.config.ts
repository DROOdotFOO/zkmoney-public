import { webPasskeyBuildPlugin } from "@obsidion/passkey-web"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "path"
import react from "@vitejs/plugin-react"
import {
  defaultClientConditions,
  defineConfig,
  loadEnv,
  type Connect,
  type Plugin,
  type ProxyOptions,
} from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { BASIC_AUTH_CHALLENGE, gateBasicAuth, isPublicPath } from "./basicAuth.js"
import { bakedConfigProfile } from "./bakedConfigProfile.js"
import { bbWasmAsset } from "./bbWasmAsset.js"
import { resolveBuildCommit } from "./buildCommit.js"
import { desktopSettingsGuard } from "./desktopSettingsGuard.js"
import { l1RpcCapability } from "./l1RpcCapability.js"
import { nativePasskeyLock } from "./nativePasskeyLock.js"
import { slimArtifactsIfAsked } from "./slimArtifacts.js"
import { socialPreview } from "./socialPreview.js"
import { sourceGenerations } from "./sourceGenerations.js"
import { metricsBuildPlugin } from "@obsidion/metrics-policy/build"

const require = createRequire(import.meta.url)

// Cross-origin isolation enables SharedArrayBuffer → bb.js multithreaded
// proving. Dev + preview send them here; the production host must send them too.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
}

// The app reaches account-service same-origin through this proxy (CORS-free); the
// mock TEE enclave rides the same pattern. Production fronts both behind the app
// origin the same way. account-service listens on 8060 — off the SIP ports 5060/5061,
// which browsers and undici fetch reject (net::ERR_UNSAFE_PORT / "bad port"). The
// sandbox launcher still binds 5060; set ACCOUNT_SERVICE_TARGET in `.env.local`.
function backendProxies(fileEnv: Record<string, string>) {
  const target = (name: string, fallback: string) => process.env[name] || fileEnv[name] || fallback
  return {
    "/svc/account": {
      target: target("ACCOUNT_SERVICE_TARGET", "http://localhost:8060"),
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/svc\/account/, ""),
    },
    "/svc/enclave": {
      target: target("ENCLAVE_TARGET", "http://localhost:5071"),
      changeOrigin: true,
      // The enclave RPC lives at the ROOT path — an empty rewrite result 404s.
      rewrite: (path: string) => path.replace(/^\/svc\/enclave/, "") || "/",
    },
    // Predicate serves no CORS headers, so the app dials it same-origin. External HTTPS API with no
    // localhost stand-in — default is their production tier, which serves every chain (Sepolia
    // included) and is where our API keys are issued; each tier only accepts its own keys (the
    // other 403s at the API gateway), so PREDICATE_TARGET must match where the key was issued. A
    // deployed slot fronts it via the vercel.json rewrite instead.
    "/svc/predicate": {
      target: target("PREDICATE_TARGET", "https://api.predicate.io"),
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/svc\/predicate/, ""),
    },
    // zkmoney-api (analytics + error reports). The AWS slot serves this path from its CDN's
    // svc-proxy Lambda; here it lets a local prod-mode build bake VITE_ZKMONEY_API_URL=/svc/usage.
    "/svc/usage": {
      target: target("ANALYTICS_TARGET", "http://localhost:5070"),
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/svc\/usage/, "/v1/usage"),
      // Stamps the ingest gate like the deployed svc-proxy; default matches zkmoney-api's .env.example.
      headers: { "x-metrics-key": process.env.ANALYTICS_METRICS_KEY ?? "0".repeat(64) },
      // Only the deployed proxy sets the viewer's country and region; a browser-sent value must not
      // reach the keyed API.
      configure: (proxy) => {
        proxy.on("proxyReq", (proxyReq) => proxyReq.removeHeader("x-viewer-geo"))
      },
    } satisfies ProxyOptions,
  }
}

// vite-plugin-node-polyfills#81 (still open at 0.28.0): the plugin rewrites node
// builtins to bare "vite-plugin-node-polyfills/shims/*" specifiers, which don't
// resolve from OTHER workspace packages' dist files under pnpm's strict layout —
// build resolution AND dev's on-demand transforms both hit it.
const shimResolveFix: Plugin = {
  name: "node-polyfills-shim-resolve-fix",
  resolveId(source, _importer, options) {
    // The dep optimizer must never see the absolute paths (it records them as
    // un-bundleable entries); its scan passes `options.scan`.
    if ((options as { scan?: boolean } | undefined)?.scan) return undefined
    if (/^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.test(source)) {
      // require.resolve follows the "require" condition (CJS); the browser needs the
      // ESM twin or the injected default-imports fail at runtime.
      return require.resolve(source).replace(/dist\/index\.cjs$/, "dist/index.js")
    }
  },
}

// The sqlite3mc loader resolves its wasm and its OPFS async-proxy worker through a RUNTIME
// `locateFile` / dynamic path, invisible to the bundler: the worker chunk asks for
// `assets/<file>` relative to itself. The bundler only rewrites the static fallback reference and
// emits a content-hashed copy nothing loads, so the unhashed path falls through to the SPA
// index.html — `WebAssembly.compile` then rejects the `text/html` body with "Incorrect response
// MIME type", the PXE store never opens, and every route sits on the boot splash forever. Dev is
// unaffected (it serves straight from node_modules), so only `vite preview` — i.e. the e2e — bites.
// Ported from aztec-kit's @aztec-kit/common/vite.
const sqliteRuntimeAssets: Plugin = {
  name: "sqlite-runtime-assets",
  apply: "build",
  generateBundle() {
    for (const file of ["sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) {
      this.emitFile({
        type: "asset",
        fileName: `assets/${file}`,
        source: readFileSync(require.resolve(`@aztec-labs/sqlite3mc-wasm/vendor/jswasm/${file}`)),
      })
    }
  },
}

// Emscripten's compileStreaming rejects anything but `application/wasm`, and vite's dev middleware
// doesn't set it for files served out of node_modules / @fs paths.
const wasmContentType: Plugin = {
  name: "wasm-content-type",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.endsWith(".wasm") || req.url?.includes(".wasm?")) {
        res.setHeader("Content-Type", "application/wasm")
      }
      next()
    })
  },
}

const pathOf = (url: string | undefined) => (url ?? "").split("?")[0]

// The site-wide gate the deployed CDN applies, so a locally served build behaves like the
// deployment. Off unless BASIC_AUTH_USER is exported into the shell — vite's `.env` files feed
// `import.meta.env`, not `process.env`, so a value in `.env.production` would not reach this. The
// link-preview paths are exempt, as on the deployed host (basicAuth.ts).
const basicAuthGate: Plugin = {
  name: "basic-auth-gate",
  configureServer: gateServer,
  configurePreviewServer: gateServer,
}

function gateServer(server: { middlewares: Connect.Server }) {
  server.middlewares.use((req, res, next) => {
    if (isPublicPath(req.method, pathOf(req.url))) return next()
    const { verdict, setCookie } = gateBasicAuth(req.headers)
    if (setCookie) res.appendHeader("Set-Cookie", setCookie)
    if (verdict !== "challenge") return next()
    res.statusCode = 401
    res.setHeader("WWW-Authenticate", BASIC_AUTH_CHALLENGE)
    res.end("Authentication required")
  })
}

// Vite 8's Rolldown bundler handles aztec.js's web workers and .wasm assets
// natively. Polyfill list is measured, not cargo-culted: `buffer` (aztec.js
// expects the global), `assert`/`util` (sdk paylink + wallet runtime imports).
// DEV-SERVER CAVEAT: the dep optimizer discovers the WASM worker packages
// (bb.js, acvm, sqlite3mc) only when a worker first loads — mid-session — and
// the re-optimization sweeps already-served chunk hashes out from under the
// lazy PXE client's dynamic imports, killing an in-flight sync/prove. Excluding
// them instead breaks CJS interop (detect-node). Long wallet flows must run
// against `pnpm build && pnpm preview` (no optimizer); the e2e scripts do.
// VITE_PROFILER=true is the only build that carries the profiler, and it downlevels. Zone.js sees an await boundary only when
// async/await is compiled to a generator driven by a user-space `Promise.resolve().then()`: V8's
// fast-await path resumes a native async function without ever calling that, and the profiler's
// spans then all land as roots. `chrome54` is the newest engine predating async/await, so it forces
// exactly that lowering, and it lowers the whole bundle — a dep that keeps native async/await
// breaks the chain on its own. A browser target rather than an `esNNNN` one because the wallet and
// aztec are full of `10n`: the chunk pass downgrades an un-lowerable BigInt literal to a warning,
// where an ES target refuses the build outright.
//
// This is `build.target` alone, so it is a whole-bundle pass over the emitted chunks — `oxc.target`
// would lower the same code per module but hard-fails on those BigInt literals, and it is the
// dev-server path anyway, which long wallet flows already cannot use (see optimizeDeps below).
// Profile against `pnpm build && pnpm preview`.
//
// The lowering is not free: a profiling build's absolute timings run slower than production's, so
// read proportions from it and compare only against another profiling build, never against a
// production one.
//
// Reads process.env, not import.meta.env: this is the config that BAKES the latter.
const buildTarget = process.env.VITE_PROFILER === "true" ? "chrome54" : undefined

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_")
  // Unprefixed keys (ACCOUNT_SERVICE_TARGET, ENCLAVE_TARGET, …) live in `.env.local` for local
  // sandbox; `process.env` still wins so a shell export can override.
  const local = loadEnv(mode, process.cwd(), "")
  return {
    // Aztec reads process.env.LOG_LEVEL at module init; PXE_LOG_LEVEL=debug
    // builds emit circuit/oracle traces.
    define: {
      "process.env.LOG_LEVEL": JSON.stringify(process.env.PXE_LOG_LEVEL ?? "info"),
      "__BUILD_COMMIT__": JSON.stringify(resolveBuildCommit(env)),
    },
    ...(buildTarget ? { build: { target: buildTarget } } : {}),
    plugins: [
      webPasskeyBuildPlugin(env),
      metricsBuildPlugin("wallet"),
      react(),
      // `path`: `@aztec-labs/ethereum`'s L1 deploy module joins a path at import (see the
      // `node:module` shim below).
      nodePolyfills({ include: ["buffer", "assert", "util", "path"] }),
      shimResolveFix,
      sqliteRuntimeAssets,
      bbWasmAsset(),
      ...slimArtifactsIfAsked(process.env),
      wasmContentType,
      basicAuthGate,
      // Bakes the config profile into the bundle and emits build-target.json.
      bakedConfigProfile(),
      desktopSettingsGuard(),
      l1RpcCapability(),
      socialPreview(env),
      nativePasskeyLock(),
      sourceGenerations(),
    ],
    // Per the @xmtp/browser-sdk README: the SDK + wasm-bindings use import.meta.url (worker/WASM
    // loading) and must not be pre-bundled; @xmtp/proto is CJS and must be.
    // content-type-primitives is deliberately unbundled: two versions coexist (sdk pins 2.x,
    // browser-sdk 3.x — 3.x dropped the ContentTypeId class for plain objects + helpers), and a
    // single pre-bundled entry would collapse browser-sdk's 3.x import onto the 2.x copy
    // ("does not provide an export named 'contentTypeToString'").
    optimizeDeps: {
      exclude: ["@xmtp/wasm-bindings", "@xmtp/browser-sdk", "@xmtp/content-type-primitives"],
      // The lazy module worker needs jsQR's CommonJS entry before its first camera frame.
      include: ["@xmtp/proto", "jsqr"],
    },
    server: {
      headers: crossOriginIsolation,
      proxy: backendProxies(local),
    },
    preview: { headers: crossOriginIsolation, proxy: backendProxies(local) },
    resolve: {
      // The dev server reads workspace packages from their source. A build reads their dist, so the
      // shipped bundle does not depend on this.
      ...(command === "serve" ? { conditions: ["source", ...defaultClientConditions] } : {}),
      alias: {
        // Design system consumed from SOURCE (not dist): instant HMR while iterating on UI,
        // and no build-ordering between the packages. Styles are imported in walletBoot.tsx.
        "@obsidion/web-ds": path.resolve(__dirname, "../design-system/src/index.ts"),
        // The native KZG addon enters via the vendored oxide packages: @oxide/oxide-lib
        // types.js and @oxide/oxide-client import SpongeBlob/Poseidon2Sponge from the
        // @aztec-labs/blob-lib ROOT barrel, whose blob.js top-level-imports kzg_context -> the
        // addon. The classes actually used are pure JS; KZG is never called client-side.
        // Proper fix is upstream: oxide imports from `@aztec-labs/blob-lib/types` (pure subpath).
        "@crate-crypto/node-eth-kzg": path.resolve(__dirname, "src/shims/node-eth-kzg.ts"),
        // The L1 deploy module `@oxide/l1-contracts` re-exports calls `createRequire` at import.
        "node:module": path.resolve(__dirname, "src/shims/node-module.ts"),
      },
    },
  }
})
