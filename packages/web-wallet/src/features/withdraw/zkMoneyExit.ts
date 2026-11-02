/**
 * "Pay from zk.money": the account claims its name on this version with the zero-fee record update,
 * then its sponsored broadcasts send every old-version refund to an address the user names, private
 * and with no ETH. The relayer that runs each refund takes a flat tip from it.
 */
import type { Address, Hex } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { runMetadataMigration, type OldVersionWithdrawal } from "@obsidion/front-core"
import { FrozenMetadataMigrationSource, planFrozenSelfRefunds } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { pause } from "../migration/freezeWatch"
import type { WithdrawableSource } from "../migration/oldVersionWithdraw"
import type { FrozenExitRead } from "./frozenExitRun"
import {
  getOldVersionWithdrawalStore,
  pendingRefundIds,
  setProducingOldVersionWithdrawal,
  settleOldVersionWithdrawal,
  withdrawalSent,
} from "./oldVersionWithdrawals"

export type ZkMoneyExitStage = "preparing" | "sending"

/** A source's raw amount in USD: a Savings source refunds shares. */
export type SourceUsd = (source: WithdrawableSource, amount: bigint) => bigint

/** Main's and Savings' amounts, each in its own units. */
export interface AccountAmounts {
  main: bigint
  savings: bigint
}

export interface ZkMoneyQuote {
  /** What the refunds move, before tips. A refund no larger than its tip stays behind. */
  moving: AccountAmounts
  /** What the relayers take from them. */
  tips: AccountAmounts
}

export interface ZkMoneyExit {
  /** What the refunds move and what the relayers take, leaving out refunds already on their way. */
  fee(reads: readonly { ws: WithdrawableSource; read: FrozenExitRead }[]): Promise<ZkMoneyQuote>
  /**
   * Claims the name if it is not claimed, then broadcasts every refund to `to`, saving each one as
   * sent. Resolves once Ethereum ran every refund, with what was sent and what is left, in USD.
   */
  run(
    sources: readonly WithdrawableSource[],
    to: Address,
    onStage: (stage: ZkMoneyExitStage) => void,
    usd: SourceUsd,
  ): Promise<{ sent: bigint; left: bigint; hash?: Hex }>
}

const POLL_MS = 5_000
/** How long the screen waits for the relayers. Activity follows a withdrawal after that. */
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000

async function openSource(ws: WithdrawableSource) {
  const session = await ws.open()
  if (!(session.source instanceof FrozenMetadataMigrationSource))
    throw new Error("This version's funds can't be withdrawn yet")
  return session.source
}

/** Drives this version's registration run to its end: the name record and recurring sponsorship. */
async function register(ws: WithdrawableSource) {
  const { controller } = await ws.registration()
  await controller.load()
  const record = await runMetadataMigration(controller, { signal: new AbortController().signal })
  if (record?.phase !== "done")
    throw new Error(record?.error ?? "Your account couldn't be set up on this version. Try again.")
}

async function inFlight() {
  const records = getOldVersionWithdrawalStore()
  await records.load()
  return pendingRefundIds(records.list())
}

async function settled(id: string) {
  for (const end = Date.now() + CONFIRM_TIMEOUT_MS; ; await pause(POLL_MS)) {
    const record = await settleOldVersionWithdrawal(id)
    if (record?.phase === "done") return record
    if (record?.phase === "failed")
      throw new Error("Your withdrawal didn't go through. Nothing moved.")
    if (Date.now() > end)
      throw new Error(
        "Your withdrawal is sent, but Ethereum has not run it yet. Activity shows it until it does.",
      )
  }
}

export function zkMoneyExit(): ZkMoneyExit {
  return {
    async fee(reads) {
      const quote: ZkMoneyQuote = {
        moving: { main: 0n, savings: 0n },
        tips: { main: 0n, savings: 0n },
      }
      const skip = await inFlight()
      for (const { ws, read } of reads) {
        const batches = planFrozenSelfRefunds({
          ...read,
          candidates: read.candidates.filter((c) => !skip.has(c.id)),
          minimumAmount: WITHDRAW_RELAYER_TIP + 1n,
        })
        const account = ws.savings ? "savings" : "main"
        quote.moving[account] += batches.reduce((sum, batch) => sum + batch.amount, 0n)
        quote.tips[account] += BigInt(batches.length) * WITHDRAW_RELAYER_TIP
      }
      return quote
    },

    async run(sources, to, onStage, usd) {
      onStage("preparing")
      if (sources[0]) await register(sources[0])
      const records = getOldVersionWithdrawalStore()
      const skip = await inFlight()
      const base: OldVersionWithdrawal = {
        id: crypto.randomUUID(),
        startTime: Date.now(),
        to,
        feeUsd: "0",
        fromBlock: String(await l1PublicClient(getConfig()).getBlockNumber()),
        refunds: [],
        phase: "sending",
      }
      let sent = 0
      let left = 0n
      setProducingOldVersionWithdrawal(base.id)
      try {
        // Main first, then Savings, which pays out its own token.
        for (const ws of [
          ...sources.filter((s) => !s.savings),
          ...sources.filter((s) => s.savings),
        ]) {
          const result = await (
            await openSource(ws)
          ).refundTo(to, WITHDRAW_RELAYER_TIP, {
            skip,
            onSent: async ({ ids, deposits, amount, txHash }) => {
              const add = (record: OldVersionWithdrawal): OldVersionWithdrawal => ({
                ...record,
                feeUsd: String(BigInt(record.feeUsd) + usd(ws, WITHDRAW_RELAYER_TIP)),
                refunds: [
                  ...record.refunds,
                  {
                    portal: ws.source.portal,
                    ids,
                    deposits,
                    usd: String(usd(ws, amount - WITHDRAW_RELAYER_TIP)),
                    l2TxHash: txHash,
                    sentAt: Date.now(),
                  },
                ],
              })
              await (sent++ ? records.update(base.id, add) : records.put(add(base)))
            },
          })
          left += usd(ws, result.stranded + result.waiting)
        }
      } finally {
        setProducingOldVersionWithdrawal(undefined)
        // A stopped run sends no more, so its record can end once its refunds do.
        if (sent) await records.update(base.id, (record) => ({ ...record, allSent: true }))
      }
      if (!sent)
        throw new Error("Nothing is left to send. A withdrawal on its way shows in Activity.")
      // Every refund is broadcast, so closing the app now loses nothing.
      onStage("sending")
      const done = await settled(base.id)
      const hash = done.refunds.at(-1)?.l1TxHash as Hex | undefined
      return { sent: withdrawalSent(done), left, ...(hash ? { hash } : {}) }
    },
  }
}
