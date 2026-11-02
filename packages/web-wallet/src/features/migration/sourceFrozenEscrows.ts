/**
 * The account's payment links on a frozen source. A link its funding transfer announces needs nothing
 * local. The others come from this browser's link rows the residual probe attributes to the source, in
 * this rollup's database and earlier ones.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { OxideEnvTuple, SourceGenerationSession } from "@obsidion/core/types"
import {
  creatorLinksFromRows,
  markPaylinkMigrated,
  storedActivity,
  type PaylinkTransaction,
  type Transaction,
} from "@obsidion/front-core"
import {
  ContractService,
  createTransferEventSource,
  discoverFrozenEscrows,
  PaylinkService,
  TokenService,
  type FrozenEscrow,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import { getActiveStorageId, withSessionLock } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { session } from "../../platform/session"
import { isHistoricPaylinkRow } from "./historicResiduals"

/** The escrows of the source's links, registered in the source chain's wallet. */
export async function sourceFrozenEscrows(o: {
  chain: { wallet: ObsidionWallet; account: ObsidionAccount }
  tuple: OxideEnvTuple
  masterSecret: Fr
  /** The source's link rows, from {@link sourceLinkRows}. */
  rows: Transaction[]
}): Promise<FrozenEscrow[]> {
  const { wallet, account } = o.chain
  const token = AztecAddress.fromStringUnsafe(o.tuple.l2Token)
  const tokenService = await TokenService.create(wallet, account, token)
  const contractService = ContractService.getInstance()
  return discoverFrozenEscrows({
    paylinkService: new PaylinkService(wallet, account, tokenService, contractService),
    escrows: { wallet, contractService },
    events: createTransferEventSource({
      wallet,
      tokenAddress: o.tuple.l2Token,
      accountAddress: account.getAddress().toString(),
    }),
    account: account.getAddress(),
    masterSecret: o.masterSecret,
    hints: await creatorLinksFromRows(o.rows),
  })
}

/**
 * Marks migrated the source's links a frozen refund paid out on L1, which leaves their L2 notes
 * unspent. Run on every probe, so a refund sent after the rows were imported is caught too. Only this
 * rollup's rows are read: the import carries every other database's into it.
 */
export async function markRefundedSourceLinks(o: {
  session: SourceGenerationSession
  tuple: OxideEnvTuple
  current: OxideEnvTuple
  storageId: string
}): Promise<void> {
  const refunded = await o.session.refundedLinks({
    tuple: o.tuple,
    paylinkRows: () =>
      sourceLinkRows({
        ...o,
        rows: async () => [...(await session().activity.all())],
      }),
  })
  if (!refunded.length) return
  await withSessionLock(async () => {
    if (getActiveStorageId() !== o.storageId) throw new SessionChangedError()
    const { activity } = session()
    for (const txHash of refunded) await markPaylinkMigrated(txHash, activity)
  })
}

/**
 * The source's links among this browser's rows of the account `storageId` names. A legacy row's link
 * from another chain is not the source's. An account switch during the read fails it, so one
 * account's link secrets never reach another's refund.
 */
export async function sourceLinkRows(o: {
  tuple: OxideEnvTuple
  /** The current deployment, whose creation dates a legacy row with no token address. */
  current: OxideEnvTuple
  storageId: string
  /** The rows to pick from; by default every database's. */
  rows?: () => Promise<Transaction[]>
}): Promise<Transaction[]> {
  const checkSession = () => {
    if (getActiveStorageId() !== o.storageId) throw new SessionChangedError()
  }
  checkSession()
  const since = Date.parse(o.current.timestamp)
  const rows = (await (o.rows ?? browserRows)()).filter((row) =>
    isHistoricPaylinkRow(row as PaylinkTransaction, o.tuple, since),
  )
  checkSession()
  const onSource: Transaction[] = []
  for (const row of rows) {
    const [link] = await creatorLinksFromRows([row])
    if (
      link &&
      link.chainId === getConfig().l1ChainId &&
      link.rollupVersion === Number(o.tuple.rollupVersion)
    )
      onSource.push(row)
  }
  checkSession()
  return onSource
}

/**
 * This account's rows here and in every other rollup's database. A database that can't be read
 * fails the read, so a hint is never silently missing.
 */
async function browserRows(): Promise<Transaction[]> {
  const others = await webStorage.readOtherDatabases(storedActivity)
  return [...(await session().activity.all()), ...(others.flat() as Transaction[])]
}
