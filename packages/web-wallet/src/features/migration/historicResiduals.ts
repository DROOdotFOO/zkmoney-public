/**
 * Residual-funds probe over the retired oxide deployments (the other entries of `deployments[]`
 * the profile reaches). A historic
 * portal may still hold user value as a private balance on its l2Token, a SIPA deposit still in
 * transit or swept-but-unclaimed, or a paylink escrow that was never claimed/refunded. A paylink
 * still inside its claim window is reported separately: nothing can refund it until the window
 * closes, so the modal only announces it and the pending-migration store waits it out. The
 * migration-detected modal shows iff any historic deployment reports residuals — re-checked every
 * boot until drained. Only a frozen source on another rollup, which nothing new reaches, stops being
 * read once drained (`retiredSourceSettled`). On a frozen portal the
 * balance and the deposits are what is still refundable: a refund pays on L1 and leaves the L2
 * notes in place, and a deposit claimed on L2 after the freeze still refunds. The balance takes in
 * the open payment links, whose escrows refund to L1 too, so their rows start no L2 reclaim: notes
 * a reclaim makes after the freeze are outside the frozen snapshot.
 *
 * Each probe runs in its own try/catch: one failing deployment or probe must not hide residuals
 * the other probes found. A failed balance read or SIPA scan is reported as `incomplete`, so an
 * unread source never reads as an empty one.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { FrozenDepositDescriptor, OxideEnvTuple } from "@obsidion/core/types"
import { TokenService, type ObsidionWallet } from "@obsidion/sdk"
import type { Account } from "@aztec-labs/aztec.js/account"
import {
  scanRefundableDeposits,
  scanSweptDeposits,
  paylinkRefundEligibility,
  type RefundableDeposit,
  type RefundableSipaSource,
  type PaylinkTransaction,
  type Transaction,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import type { Address, PublicClient } from "viem"

/** In-flight withdrawals. Informational: their burns are already done, migration leaves them alone. */
export function countPendingWithdrawals(records: readonly WithdrawalRecord[]): number {
  return records.filter((r) => r.phase !== "done" && r.phase !== "failed").length
}

export interface HistoricResidualSummary {
  tuple: OxideEnvTuple
  /**
   * Private balance on the historic l2Token (raw units). On a frozen portal, the refundable notes:
   * the account's and its open payment links'.
   */
  balance: bigint
  frozen: boolean
  /** Swept SIPA deposits still unclaimed on L2, or on a frozen portal still refundable. */
  sweptDeposits: number
  /** Broadcast SIPAs on the historic deployment that still hold L1 funds awaiting a sweep. */
  inTransitDeposits: number
  /** What those SIPAs hold (raw units). */
  inTransitAmount: bigint
  /** Deposits a frozen portal refunds once their L1 block is final. */
  waitingDeposits: number
  /** What those deposits hold (raw units). */
  waitingAmount: bigint
  /** Savings moves this device cannot verify. Listed, but not residuals on their own. */
  unverifiedMoves?: number
  /** Creator paylink escrows on the historic token the creator can refund now. */
  paylinkEscrows: number
  /** Creator paylinks on the historic token still inside their claim window — not refundable yet. */
  lockedPaylinks: PaylinkTransaction[]
  /**
   * Creator paylink rows on a historic token that is frozen, or whose freeze state the probe could
   * not read: they leave the pending lane. A live portal's next probe records them again.
   */
  frozenLinks: PaylinkTransaction[]
  /** Every still-escrowed creator paylink on the historic token, window state aside — the pending lane's input. */
  paylinkCandidates: PaylinkTransaction[]
  incomplete: boolean
  hasResiduals: boolean
  /** On another Aztec generation's live portal: only a freeze lets this build move it. */
  awaitingFreeze: boolean
  /**
   * On a frozen portal whose destination publishes no usable migration feature yet: the upgrade
   * does not offer it until the manifest lists one. Absent reads as false.
   */
  awaitingFeature?: boolean
}

/** A live deployment of another generation: its balance, which moves once its portal freezes. */
export function awaitingFreezeResidual(
  tuple: OxideEnvTuple,
  balance: bigint,
  incomplete: boolean,
): HistoricResidualSummary {
  return {
    tuple,
    balance,
    frozen: false,
    sweptDeposits: 0,
    inTransitDeposits: 0,
    inTransitAmount: 0n,
    waitingDeposits: 0,
    waitingAmount: 0n,
    paylinkEscrows: 0,
    lockedPaylinks: [],
    frozenLinks: [],
    paylinkCandidates: [],
    incomplete,
    hasResiduals: balance > 0n,
    awaitingFreeze: true,
  }
}

export interface HistoricResidualDeps {
  wallet: ObsidionWallet
  account: Account
  publicClient: PublicClient
  current: OxideEnvTuple
  historic: OxideEnvTuple[]
  rows: readonly Transaction[]
  /** What a frozen portal can still refund, or `undefined` while it is live. */
  frozenSource?(
    tuple: OxideEnvTuple,
    depositDescriptors: () => Promise<FrozenDepositDescriptor[]>,
  ): Promise<
    | {
        notes: bigint
        links: bigint
        deposits: number
        waiting: number
        waitingAmount: bigint
        unverifiedMoves?: number
      }
    | undefined
  >
  /**
   * Chain/PXE-only SIPA discovery for one historic deployment. The caller binds note sync and the
   * L2 nullifier check because those need the unlocked wallet/node.
   */
  sipaDiscovery?: {
    sources(tuple: OxideEnvTuple): Promise<readonly RefundableSipaSource[]>
    scanRange(tuple: OxideEnvTuple): Promise<{ fromBlock: bigint; toBlock: bigint }>
    /** Which of `deposits` are already spent on L2, in one batch. */
    consumed(tuple: OxideEnvTuple, deposits: readonly RefundableDeposit[]): Promise<boolean[]>
  }
  /**
   * Chain-tip seconds for the claim window, or null when the tip was unreadable: paylinks are then
   * left unclassified (still recorded as candidates) rather than judged by the wall clock.
   */
  nowSec: number | null
}

/** Rows attributable to a historic deployment: tokenAddress match, or (legacy rows without one)
 *  created before the current deployment existed. */
export function isHistoricPaylinkRow(
  row: PaylinkTransaction,
  tuple: OxideEnvTuple,
  currentTimestampMs: number,
): boolean {
  if (row.tokenAddress) return row.tokenAddress.toLowerCase() === tuple.l2Token.toLowerCase()
  return row.timestamp < currentTimestampMs
}

export async function probeHistoricResiduals(
  deps: HistoricResidualDeps,
): Promise<HistoricResidualSummary[]> {
  const nowSec = deps.nowSec
  const currentTimestampMs = Date.parse(deps.current.timestamp)

  return Promise.all(
    deps.historic.map(async (tuple) => {
      let balance = 0n
      let frozen = false
      // The frozen read failed, so the portal's state is unknown.
      let frozenUnknown = false
      let incomplete = false
      let sweptDeposits = 0
      let inTransitDeposits = 0
      let inTransitAmount = 0n
      let waitingDeposits = 0
      let waitingAmount = 0n
      let unverifiedMoves = 0
      // One observation of the deployment's portal over its whole life.
      const target = async () => {
        const range = await deps.sipaDiscovery!.scanRange(tuple)
        return {
          publicClient: deps.publicClient,
          portal: tuple.portal as Address,
          token: tuple.token as Address,
          fromBlock: range.fromBlock,
          head: range.toBlock,
        }
      }
      // A frozen portal refunds a deposit whatever its L2 state, so its scan skips the claim check.
      let swept: ReturnType<typeof scanSweptDeposits> | undefined
      const sweptScan = () =>
        (swept ??= (async () => {
          const sources = (await deps.sipaDiscovery?.sources(tuple)) ?? []
          if (!sources.length) return { descriptors: [], inTransit: [] }
          return scanSweptDeposits(await target(), sources)
        })())
      try {
        const refundable = await deps.frozenSource?.(
          tuple,
          async () => (await sweptScan()).descriptors,
        )
        frozen = refundable !== undefined
        if (refundable !== undefined) {
          balance = refundable.notes + refundable.links
          sweptDeposits = refundable.deposits
          waitingDeposits = refundable.waiting
          waitingAmount = refundable.waitingAmount
          unverifiedMoves = refundable.unverifiedMoves ?? 0
          const { inTransit } = await sweptScan()
          inTransitDeposits = inTransit.length
          inTransitAmount = inTransit.reduce((sum, d) => sum + d.balance, 0n)
        }
      } catch (error) {
        incomplete = true
        frozenUnknown = true
        console.warn(`[migration] frozen probe failed for historic portal ${tuple.portal}:`, error)
      }
      const live = !frozen && !incomplete
      if (live) {
        try {
          // Explicit-address pin — a service created without one captures the live registry slot.
          const tokenService = await TokenService.create(
            deps.wallet,
            deps.account,
            AztecAddress.fromStringUnsafe(tuple.l2Token),
          )
          balance = await tokenService.getBalance(deps.account)
        } catch (error) {
          incomplete = true
          console.warn(
            `[migration] balance probe failed for historic token ${tuple.l2Token}:`,
            error,
          )
        }
      }

      if (deps.sipaDiscovery && live) {
        try {
          const sources = await deps.sipaDiscovery.sources(tuple)
          if (sources.length > 0) {
            const scan = await scanRefundableDeposits(await target(), sources, (deposits) =>
              deps.sipaDiscovery!.consumed(tuple, deposits),
            )
            sweptDeposits = scan.refundable.length
            inTransitDeposits = scan.inTransit.length
            inTransitAmount = scan.inTransit.reduce((sum, d) => sum + d.balance, 0n)
          }
        } catch (error) {
          incomplete = true
          console.warn(`[migration] SIPA scan failed for historic portal ${tuple.portal}:`, error)
        }
      }

      let paylinkEscrows = 0
      const lockedPaylinks: PaylinkTransaction[] = []
      const paylinkCandidates: PaylinkTransaction[] = []
      const frozenLinks: PaylinkTransaction[] = []
      try {
        for (const row of deps.rows) {
          const p = row as PaylinkTransaction
          if (!isHistoricPaylinkRow(p, tuple, currentTimestampMs)) continue
          // A portal whose state is unknown may be frozen, so its rows start no reclaim either.
          if (frozen || frozenUnknown) {
            frozenLinks.push(p)
            continue
          }
          // Still escrowed: every rejection except the window itself means the escrow is gone.
          const atZero = paylinkRefundEligibility(p, 0)
          if (!atZero.eligible && atZero.reason !== "within-window") continue
          paylinkCandidates.push(p)
          if (nowSec === null) continue
          const { eligible, reason } = paylinkRefundEligibility(p, nowSec)
          if (eligible) paylinkEscrows++
          else if (reason === "within-window") lockedPaylinks.push(p)
        }
      } catch {
        // Under-report; next boot retries.
      }

      console.info(
        `[migration] probe ${tuple.l2Token.slice(
          0,
          10,
        )}: balance=${balance} swept=${sweptDeposits} inTransit=${inTransitDeposits} escrows=${paylinkEscrows} locked=${
          lockedPaylinks.length
        }`,
      )
      return {
        tuple,
        balance,
        frozen,
        sweptDeposits,
        inTransitDeposits,
        inTransitAmount,
        waitingDeposits,
        waitingAmount,
        unverifiedMoves,
        paylinkEscrows,
        lockedPaylinks,
        paylinkCandidates,
        frozenLinks,
        incomplete,
        awaitingFreeze: false,
        hasResiduals:
          balance > 0n ||
          sweptDeposits > 0 ||
          inTransitDeposits > 0 ||
          waitingDeposits > 0 ||
          paylinkEscrows > 0 ||
          paylinkCandidates.length > 0,
      }
    }),
  )
}
