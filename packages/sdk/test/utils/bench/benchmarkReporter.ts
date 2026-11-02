/**
 * Benchmark reporter that collects profile (gate counts) and fee benchmark
 * results, then writes them to a markdown + JSON file.
 */

import { writeFileSync, mkdirSync } from "fs"
import { resolve } from "path"
import type { TxInspection } from "./txInspector.js"

export interface ProfileStep {
  method: string
  gateCount: number
}

export interface BenchmarkEntry {
  flowName: string
  functionName: string
  // Profile data (gate counts)
  profileSteps?: ProfileStep[]
  totalGates?: number
  // Fee / tx effect data
  txInspection?: TxInspection
}

const OUTPUT_DIR = resolve(__dirname, "../../../benchmark")

/**
 * Collect profile steps from a service into BenchmarkEntry fields.
 * Returns an empty object when profiling is disabled or no steps were captured.
 */
export function profileStepsFor(
  svc: { lastProfileSteps?: ProfileStep[] | undefined },
  profiling: boolean,
): Pick<BenchmarkEntry, "profileSteps" | "totalGates"> {
  const steps = profiling ? svc.lastProfileSteps : undefined
  if (!steps || steps.length === 0) return {}
  return {
    profileSteps: steps,
    totalGates: steps.reduce((sum, s) => sum + s.gateCount, 0),
  }
}

/**
 * Print a summary table to stdout and write results to disk.
 */
export function writeBenchmarkReport(entries: BenchmarkEntry[], filename: string) {
  const dir = resolve(OUTPUT_DIR, filename)
  mkdirSync(dir, { recursive: true })

  // ── Console table ──
  printSummaryTable(entries)

  // ── JSON output ──
  const jsonPath = resolve(dir, `${filename}.json`)
  writeFileSync(jsonPath, JSON.stringify(entries, bigintReplacer, 2))
  console.log(`\nJSON results written to: ${jsonPath}`)

  // ── Markdown output ──
  const mdPath = resolve(dir, `${filename}.md`)
  writeFileSync(mdPath, buildMarkdown(entries))
  console.log(`Markdown results written to: ${mdPath}`)
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

function computeTotalGates(entry: BenchmarkEntry): number | undefined {
  if (entry.totalGates !== undefined) return entry.totalGates
  if (entry.profileSteps && entry.profileSteps.length > 0) {
    return entry.profileSteps.reduce((sum, s) => sum + s.gateCount, 0)
  }
  return undefined
}

function countKernelInner(steps: ProfileStep[]): number {
  return steps.filter((s) => s.method === "private_kernel_inner").length
}

function largestCircuit(steps: ProfileStep[]): ProfileStep | undefined {
  const [first, ...rest] = steps
  if (!first) return undefined
  return rest.reduce((max, s) => (s.gateCount > max.gateCount ? s : max), first)
}

function printSummaryTable(entries: BenchmarkEntry[]) {
  const col = {
    flow: 20,
    fn: 30,
    gates: 13,
    kernelInner: 14,
    largest: 36,
    largestGates: 13,
    l2Gas: 12,
    daGas: 12,
    fee: 15,
    nullifiers: 11,
    noteHashes: 11,
    privLogs: 10,
    pubWrites: 11,
  }

  const widths = Object.values(col)
  const totalWidth = widths.reduce((a, b) => a + b, 0) + widths.length + 1

  const hr = (l: string, m: string, r: string) =>
    `${l}${widths.map((w) => "\u2500".repeat(w)).join(m)}${r}`

  const pad = (s: string, w: number, right = false) =>
    right ? s.padStart(w - 2) + "  " : " " + s.padEnd(w - 1)

  console.log("\n" + "=".repeat(totalWidth))
  console.log("FLOW BENCHMARK")
  console.log("=".repeat(totalWidth))

  console.log(hr("\u250c", "\u252c", "\u2510"))
  console.log(
    `\u2502${pad("Flow", col.flow)}\u2502${pad("Function", col.fn)}` +
      `\u2502${pad("Total Gates", col.gates, true)}\u2502${pad(
        "Kernel Inner #",
        col.kernelInner,
        true,
      )}\u2502${pad("Largest Circuit", col.largest)}\u2502${pad(
        "Circuit Gates",
        col.largestGates,
        true,
      )}` +
      `\u2502${pad("L2 Gas", col.l2Gas, true)}\u2502${pad("DA Gas", col.daGas, true)}\u2502${pad(
        "Tx Fee",
        col.fee,
        true,
      )}\u2502${pad("Nullifiers", col.nullifiers, true)}\u2502${pad(
        "NoteHashes",
        col.noteHashes,
        true,
      )}\u2502${pad("PrivLogs", col.privLogs, true)}\u2502${pad(
        "PubWrites",
        col.pubWrites,
        true,
      )}\u2502`,
  )
  console.log(hr("\u251c", "\u253c", "\u2524"))

  for (const e of entries) {
    const totalGates = computeTotalGates(e)
    const gates = totalGates?.toString() ?? "-"
    const steps = e.profileSteps ?? []
    const kernelCount = steps.length > 0 ? countKernelInner(steps).toString() : "-"
    const biggest = largestCircuit(steps)
    const largestName = biggest?.method ?? "-"
    const largestGates = biggest?.gateCount.toString() ?? "-"
    const l2Gas = e.txInspection?.l2Gas?.toString() ?? "-"
    const daGas = e.txInspection?.daGas?.toString() ?? "-"
    const fee = e.txInspection?.transactionFee.toString() ?? "-"
    const nullifiers = e.txInspection?.nullifierCount.toString() ?? "-"
    const noteHashes = e.txInspection?.noteHashCount.toString() ?? "-"
    const privLogs = e.txInspection?.privateLogCount.toString() ?? "-"
    const pubWrites = e.txInspection?.publicDataWriteCount.toString() ?? "-"

    console.log(
      `\u2502${pad(e.flowName, col.flow)}\u2502${pad(e.functionName, col.fn)}` +
        `\u2502${pad(gates, col.gates, true)}\u2502${pad(
          kernelCount,
          col.kernelInner,
          true,
        )}\u2502${pad(largestName, col.largest)}\u2502${pad(
          largestGates,
          col.largestGates,
          true,
        )}` +
        `\u2502${pad(l2Gas, col.l2Gas, true)}\u2502${pad(daGas, col.daGas, true)}\u2502${pad(
          fee,
          col.fee,
          true,
        )}\u2502${pad(nullifiers, col.nullifiers, true)}\u2502${pad(
          noteHashes,
          col.noteHashes,
          true,
        )}\u2502${pad(privLogs, col.privLogs, true)}\u2502${pad(
          pubWrites,
          col.pubWrites,
          true,
        )}\u2502`,
    )
  }

  console.log(hr("\u2514", "\u2534", "\u2518"))
  console.log("=".repeat(totalWidth) + "\n")
}

function buildMarkdown(entries: BenchmarkEntry[]): string {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ")
  const lines: string[] = [
    `# Flow Benchmark Results`,
    ``,
    `Generated: ${now}`,
    ``,
    `## Summary`,
    ``,
    `| Flow | Function | Total Gates | Kernel Inner # | Largest Circuit | Circuit Gates | L2 Gas | DA Gas | Tx Fee | Nullifiers | Note Hashes | Private Logs | Public Writes |`,
    `|------|----------|-------------|----------------|-----------------|---------------|--------|--------|--------|------------|-------------|--------------|---------------|`,
  ]

  for (const e of entries) {
    const totalGates = computeTotalGates(e)
    const gates = totalGates?.toString() ?? "-"
    const steps = e.profileSteps ?? []
    const kernelCount = steps.length > 0 ? countKernelInner(steps).toString() : "-"
    const biggest = largestCircuit(steps)
    const largestName = biggest?.method ?? "-"
    const largestGates = biggest?.gateCount.toString() ?? "-"
    const l2Gas = e.txInspection?.l2Gas?.toString() ?? "-"
    const daGas = e.txInspection?.daGas?.toString() ?? "-"
    const fee = e.txInspection?.transactionFee.toString() ?? "-"
    const nullifiers = e.txInspection?.nullifierCount.toString() ?? "-"
    const noteHashes = e.txInspection?.noteHashCount.toString() ?? "-"
    const privLogs = e.txInspection?.privateLogCount.toString() ?? "-"
    const pubWrites = e.txInspection?.publicDataWriteCount.toString() ?? "-"

    lines.push(
      `| ${e.flowName} | ${e.functionName} | ${gates} | ${kernelCount} | ${largestName} | ${largestGates} | ${l2Gas} | ${daGas} | ${fee} | ${nullifiers} | ${noteHashes} | ${privLogs} | ${pubWrites} |`,
    )
  }

  // Detailed gate profiles
  const profiledEntries = entries.filter((e) => e.profileSteps && e.profileSteps.length > 0)
  if (profiledEntries.length > 0) {
    lines.push(``, `## Gate Count Details`, ``)

    for (const e of profiledEntries) {
      const totalGates = computeTotalGates(e)
      lines.push(`### ${e.flowName}: ${e.functionName}`, ``)
      lines.push(`| ID | Method | Gate Count |`)
      lines.push(`|----|--------|-----------|`)

      e.profileSteps!.forEach((step, i) => {
        lines.push(`| ${i + 1} | ${step.method} | ${step.gateCount} |`)
      })

      lines.push(`| | **TOTAL** | **${totalGates ?? 0}** |`)
      lines.push(``)
    }
  }

  return lines.join("\n") + "\n"
}
