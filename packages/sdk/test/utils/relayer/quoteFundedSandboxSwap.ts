import {
  SwapTipExceedsInputError,
  type SwapOnWithdrawSimulator,
  type SwapSimulation,
  type SwapSimulationArgs,
} from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"

const RETAINED_SWAP_AMOUNT = 20n * 10n ** 18n
const MAX_QUOTE_ATTEMPTS = 3

type Simulator = Pick<SwapOnWithdrawSimulator, "simulate">

/**
 * Sizes a sandbox fixture from the live relayer quote while retaining a useful amount to swap.
 * No funds move until this returns; failed attempts are read-only L1 simulations.
 */
export async function quoteFundedSandboxSwap(
  simulator: Simulator,
  args: SwapSimulationArgs,
): Promise<{ amount: bigint; quote: SwapSimulation }> {
  const deductions =
    args.deductions.withdrawalFee + args.deductions.withdrawalRelayerTip + args.deductions.proverTip
  let amount = args.amount
  let lastError: SwapTipExceedsInputError | undefined

  for (let attempt = 1; attempt <= MAX_QUOTE_ATTEMPTS; attempt++) {
    try {
      const quote = await simulator.simulate({ ...args, amount })
      return { amount, quote }
    } catch (error) {
      if (!(error instanceof SwapTipExceedsInputError)) throw error
      lastError = error
      const tip = error.tip.relayerTip
      amount = deductions + tip + RETAINED_SWAP_AMOUNT
      if (attempt < MAX_QUOTE_ATTEMPTS) {
        console.log(
          `Sandbox swap quote ${attempt}/${MAX_QUOTE_ATTEMPTS} needs ${tip} in relayer fees; ` +
            `retrying with gross amount ${amount}`,
        )
      }
    }
  }

  throw new Error(`Could not fund the sandbox swap after ${MAX_QUOTE_ATTEMPTS} live quotes`, {
    cause: lastError,
  })
}
