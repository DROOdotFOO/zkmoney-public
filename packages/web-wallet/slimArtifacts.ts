import { readFileSync } from "node:fs"
import type { Plugin } from "vite"

/**
 * Where the contract artifacts the wallet bundles come from: ours (the contracts package's compiled
 * target) and aztec's protocol, standard and account contracts, current and historical.
 */
const SLIM_SOURCES = [
  /\/node_modules\/@aztec-labs\/(?:protocol-contracts|standard-contracts|accounts)\/artifacts[^/]*\/[^/]+\.json$/,
  /\/packages\/contracts\/(?:src|dist)\/artifacts\/target\/[^/]+\/[^/]+\.json$/,
]

export function isSlimSource(file: string): boolean {
  const path = file.split("?")[0].replaceAll("\\", "/")
  return SLIM_SOURCES.some((source) => source.test(path))
}

type CompiledFunction = Record<string, unknown> & { bytecode?: unknown }
type CompiledContract = Record<string, unknown> & { functions: CompiledFunction[] }

/** A compiled Noir contract, as nargo emits it or as aztec loads it. */
export function isCompiledContract(json: unknown): json is CompiledContract {
  if (typeof json !== "object" || json === null) return false
  const artifact = json as Record<string, unknown>
  return Array.isArray(artifact.functions) && ("file_map" in artifact || "fileMap" in artifact)
}

/**
 * The artifact without its debug-only fields: the Noir sources (`file_map`) and each function's
 * `debug_symbols`, cleared to the empty values aztec's schema accepts. Nothing else changes.
 */
export function slimContractArtifact<T extends CompiledContract>(artifact: T): T {
  return {
    ...artifact,
    ...("file_map" in artifact ? { file_map: {} } : {}),
    ...("fileMap" in artifact ? { fileMap: {} } : {}),
    functions: artifact.functions.map((fn) => ({
      ...fn,
      ...("debug_symbols" in fn ? { debug_symbols: "" } : {}),
      ...("debugSymbols" in fn ? { debugSymbols: "" } : {}),
    })),
  }
}

/**
 * Ships every bundled contract artifact slim: about half their bytes, and less for the PXE to parse,
 * hash and store when it registers one. A simulation error then names no Noir source location. The
 * dev server keeps the full artifacts. test/build/slimArtifacts.test.ts holds each slimmed artifact's
 * bytecode, verification keys and class id to the original's.
 */
export function slimArtifacts(): Plugin {
  return {
    name: "slim-artifacts",
    apply: "build",
    enforce: "pre",
    load(id) {
      if (!isSlimSource(id)) return null
      const json: unknown = JSON.parse(readFileSync(id.split("?")[0], "utf8"))
      return isCompiledContract(json) ? JSON.stringify(slimContractArtifact(json)) : null
    },
  }
}

/** Only a build run with `STRIP_CONTRACT_DEBUG=true` slims; every other build ships the artifacts as compiled. */
export function slimArtifactsIfAsked(
  env: Record<string, string | undefined> = process.env,
): Plugin[] {
  return env.STRIP_CONTRACT_DEBUG === "true" ? [slimArtifacts()] : []
}
