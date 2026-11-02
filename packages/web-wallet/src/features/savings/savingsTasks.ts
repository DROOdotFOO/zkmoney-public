import {
  resource,
  task,
  within,
  type Milestones,
  type Resource,
  type SavingsSource,
  type Task,
} from "@obsidion/front-core"
import type { ContractService, ObsidionAccount, ObsidionWallet, TokenService } from "@obsidion/sdk"
import { rescanWithdrawals } from "../withdraw/withdrawGateway"
import { savingsRescanToken } from "./savingsGateway"

/** How long a failed read of the deployment, or a failed replay, waits before it tries again. */
export const SAVINGS_RETRY_MS = 30_000
const RETRY = { baseMs: SAVINGS_RETRY_MS, maxMs: SAVINGS_RETRY_MS }

type Inputs = {
  wallet: Resource<ObsidionWallet>
  account: Resource<ObsidionAccount>
  token: Resource<TokenService>
}
type Ready = [ObsidionWallet, ObsidionAccount, TokenService, ContractService]
type Resources<T> = { [K in keyof T]: Resource<T[K]> }

/** Savings over the account and Main's token; null where the profile has no sUSDS deployment. */
export const savingsResource = (
  from: Resources<Ready>,
  open: (...ready: Ready) => Promise<SavingsSource | null>,
) =>
  resource("savings", { from, backoff: RETRY }, (ready, { signal }) =>
    within(open(...ready), "savings", { signal }),
  )

/**
 * Replays the moves this browser has no record of: both tokens' burns are rebuilt, then a settle
 * pass stores their deposits, which can be unspent. A catching-up balance waits for the first try.
 */
export function savingsMovesReplay(
  needs: Inputs & { savings: Resource<SavingsSource | null> },
  milestones: Pick<Milestones, "mark">,
  chain = { rescan: rescanWithdrawals, savingsToken: savingsRescanToken },
): Task {
  return task("savingsMovesReplay", {
    needs,
    after: { firstBalance: true, depositsReplayed: { whenCatchingUp: 0 } },
    every: "once",
    backoff: RETRY,
    async run({ wallet, account, token, savings, signal }) {
      try {
        if (!savings) return
        const rebuilt = Promise.all([
          chain.rescan(wallet, [{ tokenService: token }]),
          chain
            .savingsToken(wallet, account)
            .then((savingsToken) => (savingsToken ? chain.rescan(wallet, [savingsToken]) : [])),
        ])
        await within(rebuilt, "savingsMovesReplay", { signal })
        await within(savings.settle(), "savings settle", { signal })
      } finally {
        if (!signal.aborted) milestones.mark("movesReplayed")
      }
    },
  })
}
