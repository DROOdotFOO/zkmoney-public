import type {
  ContractFunctionInteraction,
  DeployMethod,
  SimulateInteractionOptions,
} from "@aztec-labs/aztec.js/contracts"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ExecutionPayload, TxProfileResult } from "@aztec-labs/stdlib/tx"

export interface ExecutionStep {
  id: number
  method: string
  gateCount: number
}

/** The shape every profiling helper in this file returns. */
export interface Profiled {
  steps: ExecutionStep[]
  totalGateCount: number
}

/** Maps raw TxProfileResult execution steps into the shared {@link Profiled} shape. */
const toProfiled = (result: TxProfileResult): Profiled => {
  let totalGateCount = 0
  const steps = result.executionSteps.map((step, i) => {
    totalGateCount += step.gateCount ?? 0
    return { id: i + 1, method: step.functionName, gateCount: step.gateCount ?? 0 }
  })
  return { steps, totalGateCount }
}

/**
 * Profile an already-built ExecutionPayload through a wallet (gates mode, no proving). Use for
 * interactions `.profile()` can't handle — e.g. the TEE flows' `BatchCall`, whose payload carries
 * per-call capsules.
 */
export const profileExecutionPayload = async (
  wallet: Pick<Wallet, "profileTx">,
  payload: ExecutionPayload,
  opts: { from: AztecAddress; label?: string },
): Promise<Profiled> => {
  const result = await wallet.profileTx(payload, {
    from: opts.from,
    profileMode: "gates",
    skipProofGeneration: true,
  })
  const profiled = toProfiled(result)
  if (opts.label) {
    console.log(
      `[profile:${opts.label}]`,
      profiled.steps.map((s) => `${s.method}=${s.gateCount}`).join(" "),
    )
  }
  return profiled
}

export const profile = async (
  contractFunctionInteraction: ContractFunctionInteraction | DeployMethod,
  options: SimulateInteractionOptions,
): Promise<Profiled> => {
  const result = await contractFunctionInteraction.profile({
    ...options,
    profileMode: "gates",
    skipProofGeneration: true,
  })

  const executionNames = (await contractFunctionInteraction.request()).calls.map(
    (call) => call.name,
  )

  const { steps, totalGateCount } = toProfiled(result)

  // Create table header
  console.log("\n" + "=".repeat(80))
  console.log("EXECUTION PROFILE: ", executionNames)
  console.log("=".repeat(80))

  // Table header
  console.log("┌─────┬──────────────────────────────────────┬─────────────┐")
  console.log("│ ID  │ Method                               │ Gate Count  │")
  console.log("├─────┼──────────────────────────────────────┼─────────────┤")

  // Table rows
  for (const step of steps) {
    const id = step.id.toString().padStart(3)
    const method = step.method.padEnd(36)
    const gateCount = step.gateCount.toString().padStart(11)
    console.log(`│ ${id} │ ${method} │ ${gateCount} │`)
  }

  // Table footer with total
  console.log("├─────┼──────────────────────────────────────┼─────────────┤")
  const totalStr = totalGateCount.toString().padStart(11)
  console.log(`│     │ TOTAL                                │ ${totalStr} │`)
  console.log("└─────┴──────────────────────────────────────┴─────────────┘")
  console.log("=".repeat(80) + "\n")

  return { steps, totalGateCount }
}

/** Render a profile result as a markdown table section (used by the handshake profile docs). */
export const renderProfileMarkdown = (
  title: string,
  profiled: { steps: ExecutionStep[]; totalGateCount: number },
): string => {
  const rows = profiled.steps
    .map((s) => `| ${s.id} | \`${s.method}\` | ${s.gateCount.toLocaleString("en-US")} |`)
    .join("\n")
  return [
    `## ${title}`,
    "",
    "| # | Step | Gates |",
    "|---|------|------:|",
    rows,
    `| | **TOTAL** | **${profiled.totalGateCount.toLocaleString("en-US")}** |`,
    "",
  ].join("\n")
}
