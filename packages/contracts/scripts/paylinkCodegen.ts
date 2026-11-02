/**
 * Offline paylink codegen: recompile the zkJWT circuit and the paylink contracts, rewriting the
 * marker-bounded `ZKJWT_VKEY_HASH` section in `@obsidion/core/constants` and printing the class
 * ids. No registry, wallet, PXE, or on-chain transactions — class ids are a pure function of the
 * Noir source. Run via `pnpm recompile:paylinks`; the canonical package test
 * runs Check D against the committed verification key and both core pins.
 */

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
} from "fs"
import { resolve, join, dirname } from "path"
import { execSync } from "child_process"
import { tmpdir } from "os"
import { fileURLToPath } from "url"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../../")

const ZKJWT_VKEY_HASH_BEGIN = "// ── BEGIN AUTO-GEN: zkjwt vkey hash ──"
const ZKJWT_VKEY_HASH_END = "// ── END AUTO-GEN: zkjwt vkey hash ──"

export interface PaylinkCompileResult {
  /** Map of camelCase contract name → class ID (e.g. { paylinkEmail: "0x..." }) */
  classIds: Record<string, string>
}

interface ZkJwtVkeyHashRefreshResult {
  oldHash: string
  newHash: string
  changed: boolean
}

/** Atomic write (tempfile + rename). */
function writeAtomic(path: string, data: string | Buffer): void {
  const tmpPath = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmpPath, data)
    renameSync(tmpPath, path)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

function requireTool(tool: string): void {
  try {
    execSync(`command -v ${tool}`, { stdio: "ignore" })
  } catch {
    throw new Error(
      `refreshZkJwtVkeyHash: ${tool} not found on PATH; install via aztec-up or check $PATH`,
    )
  }
}

/**
 * Strict marker-based section splitter. Returns the substrings BEFORE the
 * begin marker, the section content (markers included), and AFTER the end
 * marker. Throws on:
 *   - missing or duplicate begin marker
 *   - missing or duplicate end marker
 *   - end marker preceding begin marker
 * — any of which means manual edits drifted the file out of the regenerator's
 * contract and a section rewrite would silently corrupt the file.
 */
function splitAroundMarkedSection(
  source: string,
  beginMarker: string,
  endMarker: string,
): { before: string; section: string; after: string } {
  const beginCount = source.split(beginMarker).length - 1
  const endCount = source.split(endMarker).length - 1
  if (beginCount !== 1) {
    throw new Error(
      `splitAroundMarkedSection: expected exactly one occurrence of "${beginMarker}", found ${beginCount}.`,
    )
  }
  if (endCount !== 1) {
    throw new Error(
      `splitAroundMarkedSection: expected exactly one occurrence of "${endMarker}", found ${endCount}.`,
    )
  }
  const beginIdx = source.indexOf(beginMarker)
  const endIdx = source.indexOf(endMarker)
  if (endIdx < beginIdx) {
    throw new Error(`splitAroundMarkedSection: "${endMarker}" precedes "${beginMarker}" in source.`)
  }
  const sectionEnd = endIdx + endMarker.length
  return {
    before: source.slice(0, beginIdx),
    section: source.slice(beginIdx, sectionEnd),
    after: source.slice(sectionEnd),
  }
}

/**
 * Recompile the zkJWT circuit, derive its verification key, compute the plain
 * Poseidon2 hash of the vk fields, and write it to the `ZKJWT_VKEY_HASH`
 * constant in `@obsidion/core/constants` — alongside refreshing the committed
 * binary vk at `circuits/zkJWT/target/vk/vk`.
 *
 * the vkey hash is no longer a baked global in `paylink_email` (it is a
 * per-deposit note binding the SDK sources from `ZKJWT_VKEY_HASH`), so this no
 * longer touches Noir source, and recompile ordering vs `paylink_email` no
 * longer matters for any class id. The constant and the committed vk are
 * written from the SAME bb output, so they can never disagree — the canonical Check D test
 * enforces exactly that pairing.
 *
 * Idempotent at the file-diff level: when the recomputed hash equals the
 * current constant, the constant file is left untouched; the binary vk is
 * rewritten with identical bytes (no git diff). `nargo compile` still runs
 * (artifact mtime moves) and `bb write_vk` writes a tempdir, cleaned up after.
 *
 * Throws on any failure (toolchain missing, compile failure, vk length
 * mismatch).
 */
export async function refreshZkJwtVkeyHash(): Promise<ZkJwtVkeyHashRefreshResult> {
  // 0. Toolchain preflight — opaque ENOENT errors from execSync are hard to diagnose.
  requireTool("aztec-nargo")
  requireTool("bb")

  const zkJwtDir = resolve(repoRoot, "packages/contracts/circuits/zkJWT")
  const zkJwtArtifactPath = resolve(zkJwtDir, "target/zkJWT.json")

  // 1. Compile zkJWT. Brillig soundness warnings on sha256/jwt_lib are pre-existing
  //    dependency warnings, not failures.
  console.log("   Compiling zkJWT circuit...")
  execSync("aztec-nargo compile", { cwd: zkJwtDir, stdio: "inherit" })

  // 1a. Sync the freshly-compiled zkJWT artifact into src/artifacts/target/zkJWT/.
  //     `nargo compile` only writes to circuits/zkJWT/target/, but every consumer
  //     (sdk, contracts service) loads from src/artifacts/target/.
  //     Without this copy the two diverge: paylink_email gets compiled against the
  //     fresh VKEY_HASH while clients generate proofs against the stale artifact,
  //     causing `Recursive Ultra Verifier: VK Hash Mismatch` at claim time.
  //     `bash packages/contracts/scripts/build_contracts.sh` does an equivalent copy for paylinks
  //     ("Copying compiled outputs … to src/artifacts/target/paylink_*"); this
  //     mirrors that behavior for the zkJWT circuit.
  const zkJwtCanonicalDir = resolve(repoRoot, "packages/contracts/src/artifacts/target/zkJWT")
  const zkJwtCanonicalPath = resolve(zkJwtCanonicalDir, "zkJWT.json")
  mkdirSync(zkJwtCanonicalDir, { recursive: true })
  copyFileSync(zkJwtArtifactPath, zkJwtCanonicalPath)
  console.log(`   Synced zkJWT artifact → ${zkJwtCanonicalPath}`)

  // 2. Derive the VK via bb write_vk. Use noir-recursive target (Poseidon2-compatible, ZK).
  const vkOutDir = mkdtempSync(join(tmpdir(), "zkjwt-vk-"))
  try {
    console.log("   Deriving zkJWT verification key...")
    execSync(
      `bb write_vk -b ${zkJwtArtifactPath} -o ${vkOutDir} -t noir-recursive --output_format json`,
      { stdio: "inherit" },
    )

    // 3. Compute Poseidon2 hash matching bb's NativeVerificationKey::hash().
    //    bb uses plain Poseidon2(vk_fields) with sponge IV = `len << 64` and no
    //    domain separator. `poseidon2HashWithSeparator(vk, 115)` is WRONG here —
    //    it prepends 115 as an extra input field (116 total), which produces a
    //    totally different hash. The Noir-side `VKEY_HASH_SEP=115` global in
    //    paylink_email/main.nr is unused legacy code; the actual hash check
    //    lives inside `verify_proof_with_type` and uses bb's native VK hash.
    const vkJson = JSON.parse(readFileSync(join(vkOutDir, "vk.json"), "utf-8")) as { vk: string[] }
    if (!Array.isArray(vkJson.vk)) {
      throw new Error("refreshZkJwtVkeyHash: bb write_vk output missing 'vk' array")
    }
    const EXPECTED_VK_LENGTH = 115
    if (vkJson.vk.length !== EXPECTED_VK_LENGTH) {
      throw new Error(
        `refreshZkJwtVkeyHash: expected vk array length ${EXPECTED_VK_LENGTH}, got ${vkJson.vk.length}; ` +
          `zkJWT circuit shape may have changed and the recursive-verifier ABI needs review`,
      )
    }
    const vkFields = vkJson.vk.map((hex) => Fr.fromString(hex))
    const newHashFr = await poseidon2Hash(vkFields)
    const newHash = newHashFr.toString()

    // 3b. Refresh the committed binary vk that Check D hashes. It is the raw
    //     concatenation of the vk fields as 32-byte big-endian words (exactly
    //     what Fr.fromBuffer reads back), reconstructed from the SAME bb output
    //     used for the hash below — so the constant and this file derive from
    //     one source and can never disagree post-recompile. Without it a
    //     circuit change would refresh the constant but strand the committed
    //     vk, turning Check D red on a correct constant.
    const vkBinPath = resolve(zkJwtDir, "target/vk/vk")
    mkdirSync(dirname(vkBinPath), { recursive: true })
    writeAtomic(vkBinPath, Buffer.concat(vkFields.map((f) => f.toBuffer())))

    // 4. Write ZKJWT_VKEY_HASH into the marker-bounded auto-gen section of
    //    @obsidion/core/constants. moved the vkey hash out of the
    //    paylink_email bytecode (it is now a per-deposit note binding) into
    //    this constant, which the SDK supplies as the deposit `vkey_hash`.
    const constantsPath = resolve(repoRoot, "packages/core/src/constants/index.ts")
    const currentConstants = readFileSync(constantsPath, "utf-8")
    const { before, section, after } = splitAroundMarkedSection(
      currentConstants,
      ZKJWT_VKEY_HASH_BEGIN,
      ZKJWT_VKEY_HASH_END,
    )
    const oldHash = section.match(/ZKJWT_VKEY_HASH\s*=\s*"(0x[0-9a-fA-F]+)"/)?.[1] ?? "0x0"
    const newSection =
      ZKJWT_VKEY_HASH_BEGIN +
      "\n" +
      "// AUTO-GENERATED by packages/contracts/scripts/paylinkCodegen.ts (refreshZkJwtVkeyHash). The zkJWT\n" +
      "// circuit's verifying-key hash: plain Poseidon2 of the `bb write_vk` fields. PaylinkEmail\n" +
      "// .deposit binds it per paylink; the SDK reads it to supply the deposit\n" +
      "// `vkey_hash` arg. Kept in lockstep with circuits/zkJWT/target/vk/vk by Check D in\n" +
      "// packages/contracts/scripts/check-paylink-freshness.ts. Do NOT edit by hand.\n" +
      `export const ZKJWT_VKEY_HASH = "${newHash}"\n` +
      "// The vk itself (base64 of the committed circuits/zkJWT/target/vk/vk bytes): the [Field; 115]\n" +
      "// PaylinkEmail.claim takes; hashing it must reproduce ZKJWT_VKEY_HASH (sdk getZkJwtVkey asserts).\n" +
      "// prettier-ignore\n" +
      `export const ZKJWT_VK_BASE64 = ${JSON.stringify(
        Buffer.concat(vkFields.map((f) => f.toBuffer())).toString("base64"),
      )}\n` +
      ZKJWT_VKEY_HASH_END
    const newConstants = before + newSection + after
    if (newConstants === currentConstants) {
      console.log(`   ZKJWT_VKEY_HASH unchanged (${newHash}); constant rewrite skipped.`)
    } else {
      writeAtomic(constantsPath, newConstants)
      console.log(`   Wrote ZKJWT_VKEY_HASH ${oldHash} → ${newHash} in core/constants`)
    }
    return { oldHash, newHash, changed: oldHash !== newHash }
  } finally {
    rmSync(vkOutDir, { recursive: true, force: true })
  }
}

/**
 * Compile the given paylink contracts and return their class IDs. Paylink class
 * ids are a pure function of the Noir source — no address is baked into the
 * bytecode (the token, OIDC key registry, and zkJWT vkey hash are all runtime
 * per-deposit args), so this just compiles and reads back the class ids.
 *
 * @param contractDirs - Which paylink contract dirs to compile (e.g. ["paylink_email", "paylink_direct"])
 */
export async function compilePaylinks(contractDirs: string[]): Promise<PaylinkCompileResult> {
  // Compile contracts and collect class IDs.
  // Map contract dir → its camelCase ContractName key. Enumerated rather than
  // derived so an unmapped dir throws below instead of silently producing a
  // key that matches nothing.
  const CONTRACT_DIR_TO_NAME: Record<string, string> = {
    paylink_email: "paylinkEmail",
    paylink_direct: "paylinkDirect",
  }
  const classIds: Record<string, string> = {}

  for (const contractDir of contractDirs) {
    console.log(`   Compiling ${contractDir}...`)
    execSync(`bash ${repoRoot}/packages/contracts/scripts/build_contracts.sh -c ${contractDir}`, {
      cwd: repoRoot,
      stdio: "inherit",
    })

    const contractName = CONTRACT_DIR_TO_NAME[contractDir]
    if (!contractName) {
      throw new Error(
        `compilePaylinks: unknown contract dir "${contractDir}". ` +
          `Add it to CONTRACT_DIR_TO_NAME to map it to its ContractName key.`,
      )
    }
    const pascalName = contractName[0].toUpperCase() + contractName.slice(1)
    const artifactJsonPath = resolve(
      repoRoot,
      `packages/contracts/src/artifacts/target/${contractDir}/${contractDir}-${pascalName}.json`,
    )

    const artifact = loadContractArtifact(JSON.parse(readFileSync(artifactJsonPath, "utf-8")))
    const contractClass = await getContractClassFromArtifact(artifact)
    const classId = contractClass.id.toString()
    classIds[contractName] = classId
    console.log(`   ${contractDir} class ID: ${classId}`)
  }

  return { classIds }
}

/**
 * The full refresh chain:
 *   1. refreshZkJwtVkeyHash() — regenerate the ZKJWT_VKEY_HASH constant +
 *      committed vk. Not baked into bytecode, but the email deposit sources
 *      its vkey_hash from the constant, so it must stay fresh (Check D).
 *   2. compilePaylinks(allPaylinks) — compile and read back class ids.
 */
export async function recompilePaylinks(): Promise<PaylinkCompileResult> {
  console.log(`\n🔄 Recompiling paylink contracts...`)
  await refreshZkJwtVkeyHash()
  const result = await compilePaylinks(["paylink_email", "paylink_direct"])
  console.log(`\n✅ Paylink recompilation complete. No on-chain transactions sent.`)
  return result
}
