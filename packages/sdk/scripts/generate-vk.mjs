// Pin a circuit's UltraHonk verification key in @obsidion/core and write it beside the circuit
// (target/vk/vk), the way zkJWT's is.
//
// `packages/contracts/scripts/build_contracts.sh` runs this on every circuit build with `--in`
// (the artifact it just compiled), `--out` (the constants file) and `--circuit`, so the pin cannot
// fall behind the artifact the wallet proves with. Standalone, with no `--in`, it compiles the
// circuit first and copies the artifact to packages/contracts. `--check` derives the key and fails
// on a pin that differs, writing nothing. `--vk-out FILE` only writes the derived key to FILE; the
// Nix build derives it that way, and `--vk FILE` pins that key instead of deriving it.
import { execSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Barretenberg, UltraHonkBackend } from "@aztec-foundation/bb.js"

const PINS = { golden_ticket: "GOLDEN_TICKET_VK_BASE64", eligibility: "ELIGIBILITY_VK_BASE64" }
const VK_BYTES = 115 * 32

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../..")

function parseArgs(argv) {
  const args = { in: null, out: null, circuit: null, check: false, vk: null, vkOut: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--in") args.in = argv[++i]
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--circuit") args.circuit = argv[++i]
    else if (a === "--check") args.check = true
    else if (a === "--vk") args.vk = argv[++i]
    else if (a === "--vk-out") args.vkOut = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  if (!PINS[args.circuit])
    throw new Error(`--circuit must be one of ${Object.keys(PINS).join(", ")}`)
  return args
}

async function deriveVk(bytecode) {
  const api = await Barretenberg.new({})
  try {
    return await new UltraHonkBackend(bytecode, api).getVerificationKey()
  } finally {
    await api.destroy()
  }
}

const args = parseArgs(process.argv.slice(2))
const NAME = PINS[args.circuit]
const PIN = new RegExp(`// ${NAME}_START\\n[\\s\\S]*?// ${NAME}_END`)
const PINNED = new RegExp(`export const ${NAME} =\\n\\s*"([A-Za-z0-9+/=]*)"`)
const circuitDir = resolve(root, "packages/contracts/circuits", args.circuit)
const vkPath = resolve(circuitDir, "target/vk/vk")
const constants = resolve(args.out ?? resolve(root, "packages/core/src/constants/index.ts"))
let compiled = args.in ? resolve(args.in) : resolve(circuitDir, `target/${args.circuit}.json`)
if (!args.in) {
  execSync(`${process.env.NARGO ?? "aztec-nargo"} compile`, { cwd: circuitDir, stdio: "inherit" })
  const canonical = resolve(
    root,
    `packages/contracts/src/artifacts/target/${args.circuit}/${args.circuit}.json`,
  )
  mkdirSync(dirname(canonical), { recursive: true })
  copyFileSync(compiled, canonical)
}

const { bytecode } = JSON.parse(readFileSync(compiled, "utf-8"))
if (typeof bytecode !== "string" || !bytecode) throw new Error(`${compiled} has no bytecode`)
const src = args.vkOut ? "" : readFileSync(constants, "utf-8")
if (!args.vkOut && !PIN.test(src)) throw new Error(`${NAME} markers not found in ${constants}`)

const vk = args.vk ? readFileSync(args.vk) : await deriveVk(bytecode)
if (vk.length !== VK_BYTES) {
  throw new Error(`verification key is ${vk.length} bytes, expected ${VK_BYTES}`)
}
const b64 = Buffer.from(vk).toString("base64")
if (args.vkOut) {
  writeFileSync(args.vkOut, vk)
  console.log(`vk: ${vk.length} bytes → ${args.vkOut}`)
} else if (args.check) {
  const pinned = src.match(PINNED)?.[1]
  if (pinned !== b64) {
    console.error(
      `${NAME} in ${constants} does not match the key derived from ${compiled}; ` +
        "rerun without --check to re-pin it",
    )
    process.exit(1)
  }
  console.log(`${NAME} matches ${compiled}`)
} else {
  mkdirSync(dirname(vkPath), { recursive: true })
  writeFileSync(vkPath, vk)
  writeFileSync(
    constants,
    src.replace(PIN, `// ${NAME}_START\nexport const ${NAME} =\n  "${b64}"\n// ${NAME}_END`),
  )
  console.log(`vk: ${vk.length} bytes → ${vkPath}; pinned in ${constants}`)
}
