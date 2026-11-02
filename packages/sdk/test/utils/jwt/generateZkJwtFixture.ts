/**
 * Regenerate the zkJWT fixture bound to a specific caller address.
 *
 * Pipeline:
 *   1. Build a Google-shaped JWT whose nonce = poseidon2(preimage, caller) using
 *      the repo's mocked JWKS (test/fixtures/jwks.json).
 *   2. Run it through `prepareJwtFromProvider` to produce a JwtInput.
 *   3. Write Prover.toml for circuits/zkJWT and call the prove script
 *      (which uses @aztec-foundation/bb.js UltraHonkBackend).
 *   4. Pack {proof, public_inputs, vk_base64} into test/fixtures/zkjwt/fixture.json.
 *
 * The helper installs a global fetch interceptor (setupJwtMocking) so that
 * PublicKeyRegistry resolves to the test JWKS — the same JWKS callers can then
 * register against the on-chain OidcKeyRegistry. Callers are responsible for
 * calling restoreFetch() in afterAll.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs"
import { tmpdir } from "os"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeNonce, prepareJwtFromProvider, type JwtInput } from "../../../src/email/utils.js"
import { PublicKeyRegistry } from "../../../src/email/PublicKeyRegistry.js"
import { createJwtPayload, setupJwtMocking } from "./email.js"
import { writeZkJwtProverToml } from "./zkjwtProverToml.js"
import type { ZkJwtFixture } from "./zkJwtFixtureHelpers.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = resolve(__dirname, "../../..")
const CIRCUIT_DIR = resolve(SDK_ROOT, "../contracts/circuits/zkJWT")
const PROVER_TOML = resolve(CIRCUIT_DIR, "Prover.toml")
const TARGET_PROOF_DIR = resolve(CIRCUIT_DIR, "target/proof")
const TARGET_VK_DIR = resolve(CIRCUIT_DIR, "target/vk")
const FIXTURE_PATH = resolve(__dirname, "../../fixtures/zkjwt/fixture.json")
const PROVE_SCRIPT = resolve(SDK_ROOT, "scripts/jwt/generate-zkjwt-proof.mjs")
const ZKJWT_PUBLIC_INPUT_COUNT = 7
/** Proving writes fixed paths under CIRCUIT_DIR, so files running side by side take turns. */
const PROVE_LOCK = resolve(tmpdir(), "obsidion-zkjwt-prove.lock")
/** Longer than any prove; a lock this old was left by a killed run. */
const PROVE_LOCK_STALE_MS = 15 * 60_000

async function withProveLock<T>(work: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      mkdirSync(PROVE_LOCK)
      break
    } catch {
      const lock = statSync(PROVE_LOCK, { throwIfNoEntry: false })
      if (lock && Date.now() - lock.mtimeMs > PROVE_LOCK_STALE_MS)
        rmSync(PROVE_LOCK, { recursive: true, force: true })
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  try {
    return await work()
  } finally {
    rmSync(PROVE_LOCK, { recursive: true, force: true })
  }
}

function normalizeCaller(callerHex: string): string {
  // Canonicalise to 0x-prefixed 64-char lowercase so string compare is meaningful.
  return Fr.fromHexString(callerHex).toString()
}

async function buildJwtInputForCaller(
  callerHex: string,
  iatSeconds: number = Math.floor(Date.now() / 1000),
): Promise<JwtInput> {
  const callerBigInt = BigInt(callerHex)
  const preimage = Fr.random().toBigInt()
  const nonce = computeNonce(preimage, callerBigInt)

  const payload = createJwtPayload(undefined, nonce, {
    iat: iatSeconds,
  })
  // setupJwtMocking installs a global fetch interceptor for Google + Apple certs
  // using the repo's local JWKS fixture. Leaving it in place matches the existing
  // test flow (pkr.getPublicKeys() in beforeAll resolves to the same mocked keys).
  const { jwt } = setupJwtMocking(payload)

  const pkr = new PublicKeyRegistry()
  const { input } = await prepareJwtFromProvider(jwt, preimage, pkr, "google")
  return input
}

/**
 * Prove the zkJWT circuit for `callerHex` and pack proof/public_inputs/vk into
 * a fixture object.
 *
 * @param iatSeconds  JWT `iat` to embed (defaults to now). Backdate it past
 *                    PaylinkEmail's IAT_ALLOWED_DELAY to exercise the claim
 *                    freshness gate.
 * @param persist     When true (default) the fixture is also written to the
 *                    shared fixture.json. Pass false for one-off proofs (e.g. a
 *                    stale-iat proof) that must not clobber the happy-path
 *                    fixture the other tests rely on.
 */
export async function generateZkJwtFixtureForCaller(
  callerHex: string,
  opts: { iatSeconds?: number; persist?: boolean } = {},
): Promise<ZkJwtFixture> {
  return withProveLock(() => proveForCaller(callerHex, opts))
}

async function proveForCaller(
  callerHex: string,
  { iatSeconds, persist = true }: { iatSeconds?: number; persist?: boolean },
): Promise<ZkJwtFixture> {
  const input = await buildJwtInputForCaller(callerHex, iatSeconds)
  writeZkJwtProverToml(PROVER_TOML, input, callerHex)

  // Use `aztec-nargo` (matches the project's contract-compile toolchain at
  // `noir_version: 1.0.0-beta.21`). Plain `nargo` from ~/.nargo/bin/ may be a
  // mismatched version (e.g. beta.12) and crashes with a Rust stack overflow
  // on the zkJWT circuit.
  execSync(`node ${JSON.stringify(PROVE_SCRIPT)} --prove`, {
    cwd: SDK_ROOT,
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env, NARGO: process.env.NARGO ?? "aztec-nargo" },
  })

  const proofJson = JSON.parse(readFileSync(resolve(TARGET_PROOF_DIR, "proof.json"), "utf-8")) as {
    proof: string[]
  }
  const publicInputsJson = JSON.parse(
    readFileSync(resolve(TARGET_PROOF_DIR, "public_inputs.json"), "utf-8"),
  ) as { public_inputs: string[] }
  const vkBytes = readFileSync(resolve(TARGET_VK_DIR, "vk"))

  const fixture: ZkJwtFixture = {
    proof: proofJson.proof,
    public_inputs: publicInputsJson.public_inputs,
    vk_base64: vkBytes.toString("base64"),
  }
  if (persist) {
    // Renamed into place: a reader never sees a half-written fixture.
    writeFileSync(`${FIXTURE_PATH}.${process.pid}`, JSON.stringify(fixture, null, 2))
    renameSync(`${FIXTURE_PATH}.${process.pid}`, FIXTURE_PATH)
  }
  return fixture
}

/** Regenerate `test/fixtures/zkjwt/fixture.json` bound to `callerHex`. */
export async function regenerateZkJwtFixture(callerHex: string): Promise<ZkJwtFixture> {
  return generateZkJwtFixtureForCaller(callerHex)
}

// A committed fixture's `iat` (public_inputs[4]) is frozen at generation time.
// PaylinkEmail::claim now rejects proofs whose iat is older than IAT_ALLOWED_DELAY
// (2 weeks), so a stale committed fixture fails every *successful*-claim test.
// Regenerate once the fixture ages past this threshold — kept well under the
// 2-week gate to leave margin for the sandbox clock drift + test-run duration.
const FIXTURE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/**
 * Returns a fixture whose `public_inputs[0]` equals `callerHex` AND whose `iat`
 * is fresh enough to pass PaylinkEmail's on-chain freshness gate. Regenerates
 * (full prove) on caller mismatch or when the on-disk fixture's iat is stale;
 * otherwise returns the on-disk fixture as-is.
 */
export async function ensureZkJwtFixtureForCaller(callerHex: string): Promise<ZkJwtFixture> {
  return withProveLock(() => ensureUnlocked(callerHex))
}

async function ensureUnlocked(callerHex: string): Promise<ZkJwtFixture> {
  const want = normalizeCaller(callerHex)
  if (existsSync(FIXTURE_PATH)) {
    const existing = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as ZkJwtFixture
    if (existing.public_inputs.length !== ZKJWT_PUBLIC_INPUT_COUNT) {
      console.log(
        `[zkJWT fixture] public input layout changed (have=${existing.public_inputs.length}, want=${ZKJWT_PUBLIC_INPUT_COUNT}); regenerating`,
      )
      return proveForCaller(callerHex, {})
    }
    const have = normalizeCaller(existing.public_inputs[0]!)
    const iat = Number(BigInt(existing.public_inputs[4]!))
    const ageSeconds = Math.floor(Date.now() / 1000) - iat
    if (have === want && ageSeconds < FIXTURE_MAX_AGE_SECONDS) return existing
    if (have !== want) {
      console.log(`[zkJWT fixture] caller mismatch (have=${have}, want=${want}); regenerating`)
    } else {
      console.log(
        `[zkJWT fixture] iat stale (age=${ageSeconds}s >= ${FIXTURE_MAX_AGE_SECONDS}s); regenerating`,
      )
    }
  } else {
    console.log(`[zkJWT fixture] no fixture on disk; generating for ${want}`)
  }
  return proveForCaller(callerHex, {})
}
