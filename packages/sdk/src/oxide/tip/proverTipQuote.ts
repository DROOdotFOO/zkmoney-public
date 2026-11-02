/**
 * The prover tip that makes an oxide prover post a partial-epoch proof covering one withdrawal early. Oxide's
 * `quoteProverTip` is the relayer's own rule; this module reads its L1 inputs the way the relayer does and
 * quotes at a buffered gas price, since the relayer decides minutes after the burn.
 */
import { ProverSubsidyAbi } from "@oxide/l1-contracts"
import { quoteProverTip } from "@oxide/oxide-client/partial_epoch_proof_profit.js"
import type { Address, PublicClient } from "viem"
import { PROVER_TIP_GAS_PRICE_BUFFER_BPS } from "@obsidion/core/constants"
import { readTipPrices, type TipTokenPrice } from "./tipQuote.js"

/** Tips are rounded up to one hundredth of a whole token: a cent of a dollar token. */
const tipStep = (decimals: number) => (decimals > 2 ? 10n ** BigInt(decimals - 2) : 1n)

/** The rounding step of an 18-dec token. */
export const PROVER_TIP_STEP = tipStep(18)

export interface ProverTipQuote {
  /** Portal token units, a whole number of hundredths of a token. */
  proverTip: bigint
  /** The L1 gas price read now. The tip is quoted at it times `PROVER_TIP_GAS_PRICE_BUFFER_BPS`. */
  gasPriceWei: bigint
  /** ETH/USD feed answer, 8 decimals. */
  usdPerEth: bigint
  /** `ProverSubsidy.quoteSubsidy(1)`; zero where the deployment has no prover subsidy. */
  subsidy: bigint
}

export async function quoteWithdrawalProverTip(
  client: PublicClient,
  args: {
    chainId: bigint
    proverSubsidy?: Address
    /** Checkpoints the partial proof covers: the burn's index in its epoch. */
    checkpointCount?: bigint
    /** The portal token, as the prover's price oracle values it. An 18-dec dollar token by default. */
    token?: TipTokenPrice
  },
): Promise<ProverTipQuote> {
  const [gasPriceWei, prices, subsidy] = await Promise.all([
    client.getGasPrice(),
    readTipPrices(client, { eth: { chainId: args.chainId }, token: args.token }),
    args.proverSubsidy
      ? client.readContract({
          address: args.proverSubsidy,
          abi: ProverSubsidyAbi,
          functionName: "quoteSubsidy",
          args: [1n],
        })
      : Promise.resolve(0n),
  ])
  // Oxide's rule nets the subsidy out of the reward it values.
  const tip = quoteProverTip({
    gasPriceWei: (gasPriceWei * PROVER_TIP_GAS_PRICE_BUFFER_BPS) / 10_000n,
    usdPerEth: prices.usdPerEth,
    tokenPrice: prices.token,
    subsidyForOneClaim: subsidy,
    checkpointCount: args.checkpointCount ?? 1n,
  })
  const step = tipStep(prices.token.decimals)
  return {
    proverTip: ((tip + step - 1n) / step) * step,
    gasPriceWei,
    usdPerEth: prices.usdPerEth,
    subsidy,
  }
}
