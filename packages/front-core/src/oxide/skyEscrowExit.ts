/**
 * The user's two exits from a Savings move's Sky escrow that was funded but nobody ran, over the
 * same injected L1 channel and recovery signing as the swap escrow's (`swapEscrowRecovery`):
 *
 *   - run it themselves: `SkyEscrowFactory.deployAndExecute(args)` deposits into the destination
 *     portal and pays them the tip; the settle pass then claims the deposit;
 *   - recover the DAI to an address they name, signed by the move's recovery account.
 */
import type { SkyEscrowArgs } from "@oxide/experiments/sky/sky_savings.js"
import type { Address, Hex } from "viem"
import { buildSkyEscrowRecoverCall, buildSkyEscrowRunCall } from "@obsidion/sdk"
import { SWAP_STUCK_THRESHOLD_MS } from "../core/services/bridge/withdrawalPhases"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { savingsRoute } from "../core/services/savings/savingsMoveQuote"
import { isSavingsMovePending, type SavingsMove } from "./savingsMoves"
import {
  requireFunded,
  signEscrowRecovery,
  type EscrowRecoverySigning,
  type SwapEscrowExitDeps,
} from "./swapEscrowRecovery"

const RAN = "This move's escrow has already run. Savings will update shortly."

export interface SkyEscrowTarget {
  escrow: Address
  factory: Address
  args: SkyEscrowArgs
}

/** The move's escrow as its burn committed to it; undefined for a burn without Sky meta. */
export function skyEscrowTarget(
  move: Pick<SavingsMove, "escrow">,
  burn: Pick<WithdrawalRecord, "skyMove">,
): SkyEscrowTarget | undefined {
  const sky = burn.skyMove
  if (!sky) return undefined
  return {
    escrow: move.escrow,
    factory: sky.factory,
    args: {
      route: savingsRoute(sky.direction),
      recipientCommitment: sky.recipientCommitment,
      recoveryCommitment: sky.recoveryCommitment,
      relayerTip: BigInt(sky.relayerTip),
      nonce: sky.nonce,
    },
  }
}

/**
 * Whether the move's release has paid its escrow and nobody has run it since: the burn is released,
 * no deposit has been found, and it has waited longer than a relayer takes.
 */
export function canSelfRunSkyEscrow(
  move: SavingsMove,
  burn: WithdrawalRecord,
  now: number = Date.now(),
): boolean {
  return (
    burn.phase === "done" &&
    isSavingsMovePending(move) &&
    !move.deposit &&
    skyEscrowTarget(move, burn) !== undefined &&
    now - (burn.endTime ?? burn.phaseEnteredAt ?? burn.startTime) >= SWAP_STUCK_THRESHOLD_MS
  )
}

export interface SkyEscrowExitDeps {
  target: SkyEscrowTarget
  channel: SwapEscrowExitDeps["channel"]
  reader: SwapEscrowExitDeps["reader"]
}

async function send(deps: SkyEscrowExitDeps, call: { to: Address; data: Hex }, what: string) {
  const hash = await deps.channel.sendTransaction(call.to, call.data)
  if (!(await deps.channel.waitForReceipt(hash)))
    throw new Error(`${what} transaction ${hash} reverted`)
  return hash
}

/** Run the escrow as the relayer would: its deposit lands and the tip comes back to the sender. */
export async function runSkyEscrow(deps: SkyEscrowExitDeps): Promise<Hex> {
  await requireFunded(deps, deps.target.escrow, RAN)
  return send(deps, buildSkyEscrowRunCall(deps.target.factory, deps.target.args), "escrow run")
}

/** Send the escrow's DAI to `deps.target`, signed by the move's recovery account. */
export async function runSkyEscrowRecovery(
  deps: SkyEscrowExitDeps & Omit<EscrowRecoverySigning, "reader" | "channel" | "target">,
  to: Address,
): Promise<Hex> {
  const { target } = deps
  const signed = await signEscrowRecovery(
    { ...deps, target: to },
    target.escrow,
    target.args.recoveryCommitment,
    { owner: "move", ran: RAN },
  )
  const call = buildSkyEscrowRecoverCall({
    deployed: await deps.reader.isDeployed(target.escrow),
    factory: target.factory,
    escrow: target.escrow,
    args: target.args,
    recovery: deps.recovery,
    target: to,
    token: deps.dai,
    ...signed,
  })
  return send(deps, call, "recovery")
}
