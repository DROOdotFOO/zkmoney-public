/**
 * ClaimFPC gas recorder: captures the gas of whole sponsored txs as the fpc test suites send them,
 * and regenerates src/feePaymentMethod/claimFpc/gas/claimFpcGasTable.ts. Off unless CLAIMFPC_GAS_REPORT is set,
 * in which case each wrapped send records `simResult.totalGas + teardownGas + finalize gasDelta` —
 * the exact quantities `ObsidionWallet.sendTx` turns into the tx's gas limits, which is what the
 * FPC's private fee assert bounds.
 *
 * Implemented as a `finalize` wrapper (staged execution) so measurement adds ZERO extra
 * simulation: for already-staged sends (TEE flows) the inner finalizer runs unchanged and its
 * declared delta is included; for plain sends a pass-through finalizer is injected, which
 * `sendTx` treats identically to a non-staged send.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Gas } from "@aztec-labs/stdlib/gas"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import type { PayloadFinalizer } from "../../../src/obsidion/stagedExecution.js"
import type { ClaimFpcMeasuredTx } from "../../../src/feePaymentMethod/claimFpc/gas/claimFpcGasTable.js"

const TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/feePaymentMethod/claimFpc/gas/claimFpcGasTable.ts",
)
const TABLE_START = "/* TABLE_START */"
const TABLE_END = "/* TABLE_END */"

const enabled = () => !!process.env.CLAIMFPC_GAS_REPORT

/** Flavors already written by this process: repeats keep the max (shapes vary slightly per run). */
const recordedThisRun = new Map<string, ClaimFpcMeasuredTx>()

function readTable(): Record<string, ClaimFpcMeasuredTx> {
  const src = readFileSync(TABLE_PATH, "utf8")
  const start = src.indexOf(TABLE_START)
  const end = src.indexOf(TABLE_END)
  if (start === -1 || end === -1) throw new Error(`gas table markers missing in ${TABLE_PATH}`)
  // The literal is prettier-formatted TS (bare keys, trailing commas); normalize to JSON.
  const literal = src
    .slice(start + TABLE_START.length, end)
    .replace(/(\b\w+):/g, '"$1":')
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(literal.trim())
}

/** The statement is `prettier-ignore`d (shape keys outrun the print width), so this hand-emits
 * prettier's style and regeneration still reads like the rest of the tree. */
function writeTable(table: Record<string, ClaimFpcMeasuredTx>) {
  const src = readFileSync(TABLE_PATH, "utf8")
  const start = src.indexOf(TABLE_START)
  const end = src.indexOf(TABLE_END)
  const rows = Object.entries(table)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([k, g]) => `  ${JSON.stringify(k)}: {\n    daGas: ${g.daGas},\n    l2Gas: ${g.l2Gas},\n  },`,
    )
  writeFileSync(
    TABLE_PATH,
    src.slice(0, start + TABLE_START.length) + ` {\n${rows.join("\n")}\n} ` + src.slice(end),
  )
}

function record(flavor: string, measured: ClaimFpcMeasuredTx) {
  const prev = recordedThisRun.get(flavor)
  const next = prev
    ? { daGas: Math.max(prev.daGas, measured.daGas), l2Gas: Math.max(prev.l2Gas, measured.l2Gas) }
    : measured
  recordedThisRun.set(flavor, next)
  const table = readTable()
  table[flavor] = next
  writeTable(table)
  console.log(`[claimfpc-gas] ${flavor}: daGas=${next.daGas} l2Gas=${next.l2Gas}`)
}

/**
 * Wrap sendTx opts so the send's gas reaches `sink`. Always on — assertions use this; the table
 * recorder below is the CLAIMFPC_GAS_REPORT-gated caller. `payload` must be the payload passed to
 * sendTx (a plain send's pass-through finalizer needs it).
 */
export function withClaimFpcGasCapture<T>(
  payload: ExecutionPayload,
  opts: T,
  sink: (gas: ClaimFpcMeasuredTx) => void,
): T {
  // `finalize` is optional on every send-options shape, so a constrained generic would infer the
  // constraint instead of the caller's object (weak-type inference) and lose its other fields.
  const inner = (opts as { finalize?: PayloadFinalizer }).finalize
  const finalize: PayloadFinalizer = async (simResult) => {
    const finalized = inner ? await inner(simResult) : { payload }
    const delta = finalized.gasDelta ?? Gas.empty()
    const total = simResult.gasUsed.totalGas.add(simResult.gasUsed.teardownGas).add(delta)
    sink({ daGas: total.daGas, l2Gas: total.l2Gas })
    return finalized
  }
  return { ...opts, finalize }
}

/** Wrap sendTx opts so the send's gas is recorded under `flavor`. Identity when the recorder is off. */
export function withClaimFpcGasRecord<T>(flavor: string, payload: ExecutionPayload, opts: T): T {
  if (!enabled()) return opts
  return withClaimFpcGasCapture(payload, opts, (gas) => record(flavor, gas))
}

/**
 * Record every send `wallet` issues while `run` executes, under `flavor` — for legs the sdk builds
 * and sends internally, where the caller never holds the payload. Identity when the recorder is off.
 */
export async function withRecordedSends<T>(
  wallet: object,
  flavor: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled()) return run()
  const target = wallet as { sendTx: (payload: ExecutionPayload, opts: object) => Promise<unknown> }
  const original = target.sendTx
  target.sendTx = (payload, opts) =>
    original.call(wallet, payload, withClaimFpcGasRecord(flavor, payload, opts))
  try {
    return await run()
  } finally {
    target.sendTx = original
  }
}
