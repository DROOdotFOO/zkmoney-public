#!/usr/bin/env node
// Build glue for vendored `@oxide/*` packages. Workspace packages import these
// via `"./*": "./dest/*"` exports maps, so each package's dest/ must exist
// before tsc / vitest run.
//
// The vendored yarn-project packages have a yarn `packageManager`
// declaration that prevents `pnpm --filter` from running their build scripts.
// We compile each directly with the locally-hoisted tsc instead.
//
// Builds the full subset needed by oxide-client::submit():
//   1. `yarn install` inside vendor/oxide/l1-contracts (pulls @aztec-foundation/l1-artifacts
//      whose sources @oxide/l1-contracts and OxidePortal.sol consume via remappings).
//   2. The pinned Solidity repositories under vendor/oxide/l1-contracts/.deps/.
//   3. `forge build` inside vendor/oxide/l1-contracts/ (writes
//      vendor/oxide/dist/l1_contracts/artifacts/).
//   4. `node gen_abis.mjs` inside vendor/oxide/yarn-project/l1-contracts/
//      (emits src/abis/*.ts from the Foundry JSON).
//   5. The three refund circuits under
//      `vendor/oxide/noir-projects/{frozen_notes_refund,frozen_deposits_refund,unprocessed_deposit_refund}/target/`,
//      which @oxide/refund-proof JSON-imports. A plain build stubs missing ones;
//      `OXIDE_REFUND_CIRCUITS=required` compiles them with the pinned Aztec toolchain.
//   6. tsc-build each yarn-project/ package in topological order.
//
// With `--relayer`, it then builds the Oxide relayer on top of that subset:
//   7. Generate the @oxide/noir-contracts.js bindings from the Broadcaster and
//      OxideToken artifacts that `pnpm build-contracts` compiles.
//   8. tsc-build noir-contracts.js, telemetry, watcher-lib and oxide-relayer.
//
// Steps 1-5 are gated by sentinel files so subsequent runs short-circuit;
// the script is idempotent and a full from-cold run is ~1 min.

import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "../../..")
const VENDOR_ROOT = resolve(REPO_ROOT, "vendor/oxide")
const YARN_PROJECT = resolve(VENDOR_ROOT, "yarn-project")
const L1_CONTRACTS = resolve(VENDOR_ROOT, "l1-contracts")
const L1_DIST = resolve(VENDOR_ROOT, "dist/l1_contracts")

// The ABI .ts files gen_abis.mjs writes — derived from its own TARGETS map so
// the sentinel never under-covers when oxide adds a contract. gen_abis.mjs
// emits one `<sym>.ts` per TARGETS key; its generation loop runs at module
// load, so we parse the keys from its source instead of importing it. The
// completeness check matters because gen_abis.mjs writes one file at a time:
// a partial run (crashed on a missing forge artifact) must not let a later run
// skip ABI generation entirely.
const GEN_ABIS = resolve(YARN_PROJECT, "l1-contracts/scripts/gen_abis.mjs")
const ABI_TARGETS = (() => {
  const src = readFileSync(GEN_ABIS, "utf8")
  const start = src.indexOf("const TARGETS = {")
  const block = src.slice(start, src.indexOf("\n};", start))
  const targets = [...block.matchAll(/(\w+):\s*\{/g)].map((m) => `${m[1]}.ts`)
  if (targets.length === 0) {
    console.error(`ERROR: could not derive ABI targets from ${GEN_ABIS}`)
    process.exit(1)
  }
  return targets
})()
const ABI_DIR = resolve(YARN_PROJECT, "l1-contracts/src/abis")

// Sentinel files that mark each upstream-build step as done.
const SENTINELS = {
  yarnInstall: resolve(L1_CONTRACTS, "node_modules/.yarn-state.yml"),
  l1Forge: resolve(L1_DIST, "artifacts/OxidePortal.sol/OxidePortal.json"),
}

const NOIR_PROJECTS = resolve(VENDOR_ROOT, "noir-projects")
const REFUND_CIRCUITS = [
  "frozen_notes_refund",
  "frozen_deposits_refund",
  "unprocessed_deposit_refund",
]

// Build oxide-lib-tee before oxide-lib, which re-exports its shared protocol types.
// resolver-lib mirrors resolver_circuit/content_hash.nr (SIPA-resolution parity) and depends on oxide-lib.
// tee-enclave hosts LocalTeeSigner (the sandbox in-process signer) and depends on oxide-lib.
// refund-proof bundles the frozen/unprocessed refund circuits oxide-client re-exports.
// experiments holds the experiments' clients and depends on l1-contracts and oxide-client.
// migration-lib holds the source-runner protocol and has no @oxide/* deps.
const PACKAGES = [
  "oxide-lib-tee",
  "oxide-lib",
  "resolver-lib",
  "tee-enclave",
  "l1-contracts",
  "refund-proof",
  "oxide-client",
  "experiments",
  "migration-lib",
]

const BUILD_RELAYER = process.argv.includes("--relayer")
// Topological order, on top of PACKAGES: the relayer imports all three.
const RELAYER_PACKAGES = ["noir-contracts.js", "telemetry", "watcher-lib", "oxide-relayer"]

function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name)
    const m = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs
    if (m > newest) newest = m
  }
  return newest
}

function run(cmd, args, cwd) {
  console.error(`> ${cmd} ${args.join(" ")}   (cwd: ${cwd})`)
  execFileSync(cmd, args, { cwd, stdio: "inherit" })
}

// --- Upstream-build steps (idempotent) -------------------------------------

// The forge/ABI sentinels are existence-based and the tsc step below is mtime-based, so a vendor
// pin bump would otherwise leave stale L1 artifacts (and gen_abis crashing on interfaces the
// stale artifacts lack). Stamp the submodule SHA; on mismatch, invalidate the forge outputs,
// generated ABIs and every package's `dest/` so they rebuild against the new pin.
// A container build has no repo to ask — `.dockerignore` excludes `.git` — and no
// stale artifacts either, since the stage starts clean. So a missing SHA means
// "nothing to invalidate", not a build failure. `OXIDE_VENDOR_SHA` supplies it
// where git is unavailable but the stamp is still wanted.
const VENDOR_SHA_STAMP = resolve(L1_DIST, ".vendor-sha")
const exportManifest = resolve(REPO_ROOT, "EXPORT-MANIFEST.json")
// The public export omits test-only packages such as migration-lib.
const exportedPackages = existsSync(exportManifest)
  ? JSON.parse(readFileSync(exportManifest, "utf8")).oxidePackages
  : undefined
const BUILT_PACKAGES = exportedPackages
  ? PACKAGES.filter((pkg) => exportedPackages.includes(`@oxide/${pkg}`))
  : PACKAGES
const vendorSha =
  process.env.OXIDE_VENDOR_SHA?.trim() ||
  (existsSync(exportManifest) ? JSON.parse(readFileSync(exportManifest, "utf8")).oxidePin : "") ||
  (() => {
    try {
      return execFileSync("git", ["-C", VENDOR_ROOT, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      console.error("vendor/oxide is not a git checkout — skipping the pin-bump invalidation")
      return ""
    }
  })()
if (
  vendorSha &&
  (!existsSync(VENDOR_SHA_STAMP) || readFileSync(VENDOR_SHA_STAMP, "utf8").trim() !== vendorSha)
) {
  console.error(`vendor/oxide pin moved (or first build) — clearing forge outputs, ABIs and dest/`)
  // The pin can move the l1-contracts dependencies (e.g. the l1-artifacts that forge remaps to).
  rmSync(SENTINELS.yarnInstall, { force: true })
  rmSync(L1_DIST, { recursive: true, force: true })
  rmSync(resolve(L1_CONTRACTS, ".cache"), { recursive: true, force: true })
  rmSync(ABI_DIR, { recursive: true, force: true })
  // tsc emits into dest/ without pruning it, so a module the old pin had and the new one dropped
  // survives as an orphan importing symbols the regenerated modules no longer export — and the
  // mtime check below sees a dest/ newer than src/ and skips the package entirely. Neither the
  // failure nor the skip is visible here: it surfaces later as a SyntaxError from a consumer.
  for (const pkg of [...PACKAGES, ...RELAYER_PACKAGES]) {
    rmSync(resolve(YARN_PROJECT, pkg, "dest"), { recursive: true, force: true })
  }
  for (const circuit of REFUND_CIRCUITS) {
    rmSync(resolve(NOIR_PROJECTS, circuit, "target"), { recursive: true, force: true })
  }
}

if (!existsSync(SENTINELS.yarnInstall)) {
  console.error("vendor/oxide/l1-contracts: yarn install (pulls @aztec-foundation/l1-artifacts)")
  run("yarn", ["install"], L1_CONTRACTS)
}

if (!existsSync(SENTINELS.l1Forge)) {
  run("bash", ["fetch_solidity_deps.sh"], L1_CONTRACTS)
  console.error("vendor/oxide/l1-contracts: forge build --skip test")
  // Skips only *.t.sol; the test/ mocks gen_abis.mjs reads still build.
  run("forge", ["build", "--skip", "test"], L1_CONTRACTS)
}

const allAbisExist = ABI_TARGETS.every((name) => existsSync(resolve(ABI_DIR, name)))
if (!allAbisExist) {
  console.error("vendor/oxide/yarn-project/l1-contracts: gen_abis.mjs")
  run("node", ["scripts/gen_abis.mjs"], resolve(YARN_PROJECT, "l1-contracts"))
}

// Everything pin-derived is now in place — stamp the pin so the next run
// short-circuits (and a future pin bump invalidates again). With no SHA there is
// nothing to compare against later, so writing a stamp would only be misleading.
if (vendorSha) writeFileSync(VENDOR_SHA_STAMP, `${vendorSha}\n`)

// Only a frozen-source refund executes these circuits, so a plain build stubs missing ones and
// needs no Aztec toolchain. `required` compiles them, replacing stubs and output from another pin.
const isCompiledCircuit = (path) => {
  try {
    return typeof JSON.parse(readFileSync(path, "utf8")).bytecode === "string"
  } catch {
    return false
  }
}
const refundCircuitsRequired = process.env.OXIDE_REFUND_CIRCUITS === "required"
for (const circuit of REFUND_CIRCUITS) {
  const target = resolve(NOIR_PROJECTS, circuit, "target")
  const artifact = resolve(target, `${circuit}.json`)
  const stamp = resolve(target, ".vendor-sha")
  if (refundCircuitsRequired) {
    const pinned =
      !vendorSha || (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === vendorSha)
    if (isCompiledCircuit(artifact) && pinned) continue
    console.error(`vendor/oxide/noir-projects: compile ${circuit}`)
    run("./bootstrap.sh", [circuit], NOIR_PROJECTS)
    if (!isCompiledCircuit(artifact)) {
      console.error(`ERROR: ${circuit} compiled to no circuit bytecode`)
      process.exit(1)
    }
    if (vendorSha) writeFileSync(stamp, `${vendorSha}\n`)
  } else if (!existsSync(artifact)) {
    console.error(`Stubbing ${artifact} (OXIDE_REFUND_CIRCUITS=required compiles it)`)
    mkdirSync(target, { recursive: true })
    writeFileSync(artifact, "{}\n")
  }
}

// --- tsc build per package -------------------------------------------------

// Resolve a tsc binary from any sibling workspace that has typescript hoisted.
// We avoid `pnpm exec tsc` because the vendored yarn-project package.json
// pins `packageManager: yarn@*` which makes pnpm bail.
const tscCandidates = [
  resolve(REPO_ROOT, "node_modules/.bin/tsc"),
  resolve(REPO_ROOT, "packages/core/node_modules/.bin/tsc"),
  resolve(REPO_ROOT, "packages/sdk/node_modules/.bin/tsc"),
]
const tsc = tscCandidates.find((p) => existsSync(p))
if (!tsc) {
  console.error("ERROR: no hoisted tsc binary found; run `pnpm install` first.")
  process.exit(1)
}

// Write a sibling tsconfig.build.json that extends the vendored tsconfig but
// excludes *.test.ts. The vendored packages don't ship @types/jest at the
// pnpm-workspace level (oxide's CI yarn-install does), so test files trip
// "Cannot find name 'describe'". The override is idempotent and lives inside
// the submodule tree (untracked); cleaner than editing the vendored tsconfig.
//
// EXTRA_EXCLUDES drops files that pull in an @oxide package we deliberately
// don't build. oxide-client's broadcaster.ts, sipa_events.ts and token.ts import the
// generated @oxide/noir-contracts.js bindings, and the barrel index.ts
// re-exports them, so all four drop out. Consumers import oxide-client's
// bindings-free subpaths (broadcaster_calls.js, sipa_event_calls.js,
// withdraw_escrows/swap.js, …), never the barrel.
//
// tee-enclave's src/testing/ holds worker entrypoints that only its own *.test.ts
// spawn, by URL, for Node to run under native type stripping — so they import with
// explicit .ts extensions, which tsc rejects unless allowImportingTsExtensions is on
// (and that in turn forbids emit). Excluding the whole directory keeps them out of a
// build that emits, and covers any worker oxide adds later.
const EXTRA_EXCLUDES = {
  "oxide-client": ["src/broadcaster.ts", "src/sipa_events.ts", "src/token.ts", "src/index.ts"],
  "tee-enclave": ["src/testing/**"],
}

// A vendored tsconfig.build.json with the same settings is left as Oxide wrote it.
function writeBuildConfig(pkgDir, pkg) {
  const overridePath = resolve(pkgDir, "tsconfig.build.json")
  const config = {
    extends: "./tsconfig.json",
    exclude: ["**/*.test.ts", ...(EXTRA_EXCLUDES[pkg] ?? [])],
  }
  if (
    !existsSync(overridePath) ||
    !isDeepStrictEqual(JSON.parse(readFileSync(overridePath, "utf8")), config)
  ) {
    writeFileSync(overridePath, JSON.stringify(config, null, 2) + "\n")
  }
  return overridePath
}

function buildPackage(pkg) {
  const dir = resolve(YARN_PROJECT, pkg)
  const dest = resolve(dir, "dest")
  const src = resolve(dir, "src")
  if (existsSync(dest) && newestMtime(src) <= newestMtime(dest)) {
    return
  }
  console.error(`Building @oxide/${pkg} dest/ ...`)
  const buildConfig = writeBuildConfig(dir, pkg)
  try {
    execFileSync(tsc, ["-p", buildConfig], { stdio: "inherit" })
  } catch (err) {
    // tsc emits what it could before failing, which leaves dest/ newer than src/ — the
    // staleness check above would then treat the half-built package as current and skip it,
    // so a second run reports success over a broken build. Drop the partial output.
    rmSync(dest, { recursive: true, force: true })
    throw err
  }
}

for (const pkg of BUILT_PACKAGES) buildPackage(pkg)

// --- Relayer (--relayer) ------------------------------------------------------

// The contracts @oxide/noir-contracts.js binds: [noir package, contract name]. The compiled
// artifact is `<package>-<contract>.json` in the `pnpm build-contracts` output. Oxide's
// generate-types.sh also binds a passkey test account, which is not vendored and which the
// relayer does not import.
const BOUND_CONTRACTS = [
  ["broadcaster_contract", "Broadcaster"],
  ["oxide_token_contract", "OxideToken"],
]
const COMPILED_CONTRACTS = resolve(REPO_ROOT, "packages/contracts/src/artifacts/target")
const NOIR_CONTRACTS_JS = resolve(YARN_PROJECT, "noir-contracts.js")

// Types each artifact JSON as a NoirCompiledContract, as generate-types.sh does, so tsc does not
// infer the multi-MB literal.
const ARTIFACT_DECLARATION = `import { type NoirCompiledContract } from '@aztec-labs/aztec.js/abi';
const circuit: NoirCompiledContract;
export = circuit;
`

// Does what Oxide's generate-types.sh does for BOUND_CONTRACTS, with the `aztec codegen` of the
// Aztec toolchain: generate-types.sh expects @aztec-labs/builder in a yarn node_modules tree.
function generateNoirBindings() {
  const contracts = BOUND_CONTRACTS.map(([pkg, name]) => {
    const file = `${pkg}-${name}.json`
    return { name, file, compiled: resolve(COMPILED_CONTRACTS, pkg, file) }
  })
  const missing = contracts.filter((c) => !existsSync(c.compiled))
  if (missing.length > 0) {
    console.error(`ERROR: ${missing.map((c) => c.compiled).join(", ")} not found.`)
    console.error("Run `pnpm build-contracts` first.")
    process.exit(1)
  }

  const srcDir = resolve(NOIR_CONTRACTS_JS, "src")
  const artifactsDir = resolve(NOIR_CONTRACTS_JS, "artifacts")
  const current = contracts.every((c) => {
    const binding = resolve(srcDir, `${c.name}.ts`)
    return existsSync(binding) && statSync(c.compiled).mtimeMs <= statSync(binding).mtimeMs
  })
  if (current) return

  console.error("Generating @oxide/noir-contracts.js bindings ...")
  for (const dir of [srcDir, artifactsDir]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  for (const c of contracts) {
    copyFileSync(c.compiled, resolve(artifactsDir, c.file))
    writeFileSync(
      resolve(artifactsDir, c.file.replace(/\.json$/, ".d.json.ts")),
      ARTIFACT_DECLARATION,
    )
  }
  run("aztec", ["codegen", "--force", "-o", "src", "artifacts"], NOIR_CONTRACTS_JS)
  const names = contracts.map((c) => `  '${c.name}',`).join("\n")
  writeFileSync(
    resolve(srcDir, "index.ts"),
    `/* Autogenerated file, do not edit! */\n\n` +
      `/** Names of the contracts whose bindings this package exports. */\n` +
      `export const ContractNames = [\n${names}\n];\n`,
  )
}

if (BUILD_RELAYER) {
  generateNoirBindings()
  for (const pkg of RELAYER_PACKAGES) buildPackage(pkg)
}
