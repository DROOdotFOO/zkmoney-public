import { useCallback, useEffect, useState } from "react"
import {
  fundingFits,
  isOpenCreatorLink,
  planMove,
  unreadDeposits,
  useStore,
  WITHDRAWAL_TERMINAL_PHASES,
  type ChunkFit,
  type PaylinkTransaction,
  type WithdrawalRecord,
  useResource,
} from "@obsidion/front-core"
import {
  type ContractService,
  fundingAmount,
  readBridgeDestination,
  readSpendShape,
  RotationRouteNotLiveError,
  type FundingAmount,
  type ObsidionWallet,
  type SpendShape,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { getConfig } from "../../config/env"
import { getWebOxideToken } from "../../config/classArtifacts"
import { getFeeTokenBridgeTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { useSession } from "../../platform/session"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useOldVersionHoldings } from "../migration/oldVersionBalance"
import { useUpgradeLock } from "../migration/upgradeLock"
import { unlockedSessionKeys } from "../onboarding/registrationResume"
import { rescanPaylinks, usePaylinksRescanned } from "../paylink/paylinkRescanState"
import { currentTxAmountCap } from "../token/oxideToken"
import { useWithdrawals } from "../withdraw/useWithdrawals"

/** What the entry reads off the chain before it can be pressed. */
export interface ChainFacts {
  routeLive: boolean
  balance: bigint
  fundingAmount: bigint
  chunk: ChunkFit
  /** A move plan exists over the balance. */
  plan: boolean
  /** How many sponsored sends the move takes, at most. */
  moves: number
}

// The deposit set is read by the move itself; here a balance held in deposits makes the plan an
// upper bound.
export function chainFacts(input: {
  funding: FundingAmount | undefined
  shape: SpendShape
  cap: bigint
}): ChainFacts {
  const { funding, shape, cap } = input
  const amount = funding?.amount ?? 0n
  const deposits = unreadDeposits(shape)
  let moves = 0
  let plan = false
  try {
    moves = planMove(shape, cap, deposits).m
    plan = true
  } catch {
    // No plan over this balance and cap; the entry says so.
  }
  return {
    routeLive: funding !== undefined,
    balance: shape.balance,
    fundingAmount: amount,
    chunk: fundingFits(amount, cap, shape, deposits),
    plan,
    moves,
  }
}

export async function readChainFacts(
  wallet: ObsidionWallet,
  contractService: ContractService,
): Promise<ChainFacts> {
  const keys = await unlockedSessionKeys(wallet)
  if (!keys) throw new Error("wallet locked")
  const config = getConfig()
  const client = l1PublicClient(config)
  const envTuple = await getFeeTokenBridgeTuple(config)
  const [tuple, token] = await Promise.all([
    readBridgeDestination(client, envTuple),
    getWebOxideToken(wallet, contractService, requireTupleField(envTuple, "l2Token")),
  ])
  const [funding, shape, cap] = await Promise.all([
    fundingAmount(client, {
      tuple,
      plainWithdrawalExecutor: requireTupleField(envTuple, "plainWithdrawalExecutor") as Address,
      proverTip: 0n,
    }).catch((err: unknown) => {
      if (err instanceof RotationRouteNotLiveError) return undefined
      throw err
    }),
    readSpendShape(wallet, token, keys.account.getAddress()),
    currentTxAmountCap(),
  ])
  return chainFacts({ funding, shape, cap })
}

/**
 * Whether `account` holds an open paylink, kept current with the stored rows. Undefined until this
 * page's rescan has rebuilt every link the account made; `unreadable` while the latest pass failed
 * or deferred a link.
 */
function useOpenLink(account: string | undefined): boolean | "unreadable" | undefined {
  const rescanned = usePaylinksRescanned(account)
  const network = useResource(useSession().wallet)?.networkId
  // The links still in escrow, once loaded: a link not yet read is not "none".
  const rows = useStore(useSession().reads.open)
  const open =
    !!account &&
    rows.records.some((row) => isOpenCreatorLink(row as PaylinkTransaction, account, network))
  if (rescanned === false || rows.failed) return "unreadable"
  return rescanned && rows.loaded ? open : undefined
}

/** Whether a withdrawal of this wallet's is still on its way. */
export const withdrawalInFlight = (records: readonly Pick<WithdrawalRecord, "phase">[]) =>
  records.some((record) => !WITHDRAWAL_TERMINAL_PHASES.has(record.phase))

export type EntryFacts = ChainFacts & {
  withdrawalInFlight: boolean
  openLink: boolean
  /** Money on an old version still to move, or an upgrade not yet finished here. */
  historicBalance: boolean
}

/**
 * The entry's facts for the signed-in account: the chain's read once per mount and again on
 * `refresh`, the rest kept current. `checking` while they are read, `unreadable` when a read failed;
 * `refresh` also starts a paylink rescan.
 */
export function useBackupEntryFacts(
  wallet: ObsidionWallet | undefined,
  contractService: ContractService | null,
  active: boolean,
): { facts: "checking" | "unreadable" | EntryFacts; refresh: () => void } {
  const [chain, setChain] = useState<"checking" | "unreadable" | ChainFacts>("checking")
  const [run, setRun] = useState(0)
  const withdrawals = useWithdrawals()
  const holdings = useOldVersionHoldings()
  const identity = loadWalletIdentity()?.address
  const upgrade = useUpgradeLock(identity).state
  const openLink = useOpenLink(identity)
  useEffect(() => {
    if (!active || !wallet || !contractService) return
    let stale = false
    setChain("checking")
    readChainFacts(wallet, contractService).then(
      (facts) => {
        if (!stale) setChain(facts)
      },
      (err: unknown) => {
        console.warn("[backup passkey] entry facts read failed", err)
        if (!stale) setChain("unreadable")
      },
    )
    return () => {
      stale = true
    }
  }, [active, wallet, contractService, run])
  const refresh = useCallback(() => {
    setRun((n) => n + 1)
    rescanPaylinks()
  }, [])
  if (typeof chain === "string") return { facts: chain, refresh }
  if (openLink === "unreadable") return { facts: "unreadable", refresh }
  if (!withdrawals.hydrated || holdings.pending || openLink === undefined) {
    return { facts: "checking", refresh }
  }
  return {
    facts: {
      ...chain,
      openLink,
      withdrawalInFlight: withdrawalInFlight(withdrawals.records),
      historicBalance: holdings.total > 0n || upgrade === "held",
    },
    refresh,
  }
}
