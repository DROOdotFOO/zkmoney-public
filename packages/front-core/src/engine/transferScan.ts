import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  TokenService,
  WalletBalanceRead,
  WalletBalances,
} from "@obsidion/sdk"
import type { WalletSyncCoordinator } from "../core/services/transactions/WalletSyncCoordinator"
import {
  TRANSFER_SCAN_POLL_INTERVAL_MS,
  type TransferScanPass,
} from "../core/services/transactions/TransferEventScanner"
import { bestEffort, WalletError } from "./errors"
import { BOOT_WAIT_MS } from "./milestones"
import type { Resource } from "./resource"
import { task, within, type Needs, type RunCtx, type Task } from "./runtime"
import type { ReadonlyStore } from "./store"

/** How long a failed Savings lookup waits before it tries again. */
export const SAVINGS_LOOKUP_RETRY_MS = 30_000

export interface BalanceReader {
  readBalanceAssumingSynced(): Promise<bigint>
}

/**
 * The transfer scan, one pass per run: every 5 s while the page is visible, paused while hidden,
 * backing off to a minute while passes fail. A wake runs a full pass.
 */
export function transferScanTask<const N extends Needs>(
  needs: N,
  pass: (opts: TransferScanPass, ctx: RunCtx<N>) => Promise<boolean>,
): Task {
  return task("transferScan", {
    needs,
    every: TRANSFER_SCAN_POLL_INTERVAL_MS,
    backoff: { baseMs: 2 * TRANSFER_SCAN_POLL_INTERVAL_MS, maxMs: 60_000 },
    async run(ctx) {
      if (!(await pass({ full: ctx.woken, signal: ctx.signal }, ctx)))
        throw new WalletError("scan.incomplete")
    },
  })
}

type SyncCoordinator = Pick<WalletSyncCoordinator, "pass" | "attach" | "readBalanceCoalesced">

type Ready = {
  wallet: ObsidionWallet
  account: ObsidionAccount
  token: TokenService
  contractService: ContractService
}

export type TransferScanDeps = { [K in keyof Ready]: Resource<Ready[K]> } & {
  /** The account's display tag; a nameless account shows its address. */
  tag(): string | undefined
  endpointScope?(): string | undefined
  /** The coordinator's refreshes run passes only while it holds. */
  visible: ReadonlyStore<boolean>
  /** The coordinator over Main's token, reading every balance through `readBalances`. */
  coordinator(ready: Ready, readBalances: () => Promise<WalletBalanceRead>): SyncCoordinator
}

export interface TransferScan {
  readonly task: Task
  /** Reads `reader` beside Main's balance at every synced anchor. */
  alsoRead(address: string, reader: BalanceReader): void
  /** The balances alone at a fresh anchor; a full pass while the coordinator is not live. */
  refreshBalance(): Promise<void>
  dispose(): void
}

/** The wallet's chain sync: a coordinator per value of Main's token. */
export function transferScan(deps: TransferScanDeps): TransferScan {
  const others = new Map<string, BalanceReader>()
  let built:
    | { token: TokenService; coordinator: SyncCoordinator; wake(): Promise<void> }
    | undefined
  let detach: (() => void) | undefined
  let disposed = false
  const live = () => !disposed && deps.visible.get()

  const build = (ready: Ready, wake: () => Promise<void>) => {
    const { account, token } = ready
    const coordinator = deps.coordinator(ready, async () => {
      const balances: WalletBalances = {}
      const readAt: Record<string, number> = {}
      // Each token is stamped when its read resolves: a Savings claim stored after it is missing.
      const stamp = (address: string, atomic: bigint) => {
        balances[address] = atomic
        readAt[address] = Date.now()
      }
      stamp(token.metadata.address, await token.readBalanceAssumingSynced(account))
      // Another token's failed read leaves Main's standing; the next pass reads it again.
      for (const [address, reader] of others) {
        const atomic = await bestEffort("balance.unread", reader.readBalanceAssumingSynced())
        if (atomic !== undefined) stamp(address, atomic)
      }
      return { balances, readAt }
    })
    detach?.()
    detach = disposed ? undefined : coordinator.attach({ wake, live })
    return (built = { token, coordinator, wake })
  }

  const { wallet, account, token, contractService } = deps
  const scan: Task = transferScanTask({ wallet, account, token, contractService }, (opts, ctx) => {
    const { coordinator } = built?.token === ctx.token ? built : build(ctx, () => ctx.wake(scan))
    const address = ctx.account.getAddress().toString()
    const context = {
      accountAddress: address,
      accountTag: deps.tag() ?? address,
      networkId: ctx.wallet.networkId,
      endpointScope: deps.endpointScope?.(),
    }
    return coordinator.pass(context, opts)
  })
  return {
    task: scan,
    alsoRead: (address, reader) => others.set(address, reader),
    async refreshBalance() {
      if (!built) return
      if (!live()) return built.wake()
      await built.coordinator.readBalanceCoalesced().catch(built.wake)
    },
    dispose() {
      disposed = true
      detach?.()
    },
  }
}

type SavingsToken = { tokenService: BalanceReader & { tokenAddress: { toString(): string } } }

/** Savings' token, looked up after the first balance; from then on its shares are read beside Main's. */
export function savingsLookup<W, A>(deps: {
  wallet: Resource<W>
  account: Resource<A>
  lookup(wallet: W, account: A): Promise<SavingsToken | undefined>
  scan: Pick<TransferScan, "alsoRead" | "refreshBalance">
}): Task {
  return task("savingsLookup", {
    needs: { wallet: deps.wallet, account: deps.account },
    after: { firstBalance: BOOT_WAIT_MS },
    every: "once",
    backoff: { baseMs: SAVINGS_LOOKUP_RETRY_MS, maxMs: SAVINGS_LOOKUP_RETRY_MS },
    async run({ wallet, account, signal }) {
      const found = await within(deps.lookup(wallet, account), "savingsLookup", { signal })
      if (!found) return
      deps.scan.alsoRead(found.tokenService.tokenAddress.toString(), found.tokenService)
      await within(deps.scan.refreshBalance(), "refreshBalance", { signal })
    },
  })
}
