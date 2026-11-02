import * as actual from "../../../src/features/paylink/sponsoredPaylink"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodePaylinkInline, encodePaylinkInline } from "@obsidion/sdk"
import type { OnNetwork, PaylinkTransaction, Transaction } from "@obsidion/front-core"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { session } from "../../../src/platform/session"
import { ROLLUP, TOKEN_INFO, field } from "./data"
import { formatUnits, parseUnits } from "viem"
import { demoClaimFragments, demoEscrowAmount, demoFundingTxHash } from "../../../src/dev/demoFixtures"
import { fixtureState, inOperation, operation, pause } from "./control"
export * from "../../../src/features/paylink/sponsoredPaylink"

let fixtureSequence = 0

/** Distinct synthetic identities even after a retry, fixed clock, or page reload. */
async function fixtureIdentity(kind: "paylink-create" | "paylink-claim", fundingHash?: string) {
  const store = session().activity
  const rows = await store.all()
  const base = kind === "paylink-create" ? 0x78410000n : 0x78420000n
  for (;;) {
    const sequence = ++fixtureSequence
    const id = `capture-${kind}-${sequence}`
    const txHash = `0x${(base + BigInt(sequence)).toString(16).padStart(64, "0")}`
    if (txHash === fundingHash || rows.some((row) => row.operationId === id || row.txHash === txHash)) continue
    return { store, id, txHash }
  }
}

/** A capture row before submit, as `startPaylinkRow` writes one. */
function pendingLinkRow(id: string, fields: Omit<PaylinkTransaction, "id" | "operationId" | "timestamp" | "status" | "txHash" | "emailPaymentAction">): OnNetwork<PaylinkTransaction> {
  return { ...fields, id, operationId: id, networkId: ROLLUP, emailPaymentAction: fields.action, timestamp: Date.now(), status: "pending", txHash: "" }
}

const withFields = (fields: Partial<PaylinkTransaction>) => (row: Transaction) => ({ ...row, ...fields }) as Transaction

function requireRow(matched: boolean, operation: string): void {
  if (!matched) throw new Error(`Capture paylink row missing during ${operation}`)
}

/** Read-only browser assertions over rows written by this capture adapter. */
export async function capturePaylinkRows() {
  if (!fixtureState()) throw new Error("Capture paylink inspection requires an active flow fixture")
  const rows = await session().activity.all()
  return rows.filter((row) => row.operationId?.startsWith("capture-paylink-")).map((tx) => {
    const row = tx as PaylinkTransaction
    return { operationId: row.operationId, kind: row.kind, status: row.status, txHash: row.txHash, amount: row.token?.amount, paylink: row.paylink, secret: row.payToEmailSecret }
  })
}

export const voucherAvailable: typeof actual.voucherAvailable = async (deps) => {
  if (!fixtureState()) return actual.voucherAvailable(deps)
  await pause(300)
  return fixtureState() !== "no-voucher"
}
export const createSponsoredLink: typeof actual.createSponsoredLink = (...args) =>
  fixtureState()
    ? inOperation(
        "paylink-create",
        `$${args[1]} paylink`,
        () => fakeCreate(...args),
        (link) => link.txHash,
      )
    : actual.createSponsoredLink(...args)
const fakeCreate: typeof actual.createSponsoredLink = async (...args) => {
  const [deps, amount, onStage, opts] = args
  onStage?.("building")
  const fragments = demoClaimFragments()
  const fragment = opts?.email ? fragments.email : fragments.direct
  const params = decodePaylinkInline(fragment)
  const { store, id, txHash } = await fixtureIdentity("paylink-create", demoFundingTxHash(fragment))
  // Synthetic fields for rendering; no escrow or funding transaction is created.
  const prepared = { ...params, secret: Fr.fromString(txHash) }
  const link = {
    ...actual.decodeLink(encodePaylinkInline(prepared)),
    amount,
    email: opts?.email,
    memo: opts?.memo,
  }
  const now = Math.floor(Date.now() / 1000)
  const untilClaimable = now + (opts?.expiryDays ?? 30) * 86_400
  await store.insertPending(pendingLinkRow(id, {
    action: PaylinkActionEnum.PAY, flavor: link.flavor, kind: "paylink-create", to: opts?.email,
    token: { ...TOKEN_INFO, amount: Number(amount), price: 1, logo: "" },
    amountAtomic: parseUnits(amount, TOKEN_INFO.decimals),
    obsidionAccountAddress: deps.account.getAddress().toString(), tokenAddress: TOKEN_INFO.address,
    memo: opts?.memo,
  }))
  try {
    await operation("paylink-create", onStage, true, {
      operationId: id,
      txHash,
      onPrepared: async () => {
        requireRow(await store.patch(id, withFields({
          payToEmailSecret: prepared.secret.toString(),
          paylink: link.url, fallbackSecret: field("1d"), fromClaimable: now + 300,
          untilClaimable, refundableUntil: untilClaimable,
        })), "prepare")
        opts?.onLink?.(link)
      },
    })
    const settledLink = { ...link, txHash }
    requireRow(await store.setHash(id, txHash), "funding hash")
    requireRow(await store.patch(id, withFields({ paylink: settledLink.url })), "settled link")
    await store.settle(id)
    return settledLink
  } catch (error) {
    await store.fail(id, { code: "tx.failed" })
    throw error
  }
}
export const claimSponsoredLink: typeof actual.claimSponsoredLink = (...args) =>
  fixtureState()
    ? inOperation(
        "paylink-claim",
        "Paylink",
        () => fakeClaim(...args),
        (txHash) => txHash,
      )
    : actual.claimSponsoredLink(...args)
const fakeClaim: typeof actual.claimSponsoredLink = async (...args) => {
  const [deps, fragment, onStage, zkProof] = args
  onStage?.("building")
  const params = decodePaylinkInline(fragment)
  const link = actual.decodeLink(fragment)
  if (link.flavor === "email" && !zkProof)
    throw new Error("This link is locked to an email — sign in first to prove ownership")
  const { store, id, txHash } = await fixtureIdentity("paylink-claim", demoFundingTxHash(fragment))
  // Capture has no PXE note; this fragment is ours, so its amount is the demo escrow.
  await store.insertPending(pendingLinkRow(id, {
    action: PaylinkActionEnum.CLAIM, kind: "paylink-claim", flavor: link.flavor,
    token: { ...TOKEN_INFO, amount: Number(formatUnits(demoEscrowAmount(fragment), TOKEN_INFO.decimals)), price: 1, logo: "" },
    amountAtomic: demoEscrowAmount(fragment),
    obsidionAccountAddress: deps.account.getAddress().toString(), tokenAddress: TOKEN_INFO.address,
  }))
  try {
    await operation("paylink-claim", onStage, true, { operationId: id, txHash })
    requireRow(await store.setHash(id, txHash), "claim hash")
    await store.settle(id)
    await actual.markCreateRowClaimed(params.secret.toString(), link.flavor, deps.account.getAddress().toString())
    return txHash
  } catch (error) {
    await store.fail(id, { code: "tx.failed" })
    throw error
  }
}
export const recoverSponsoredLink: typeof actual.recoverSponsoredLink = (...args) =>
  fixtureState()
    ? inOperation(
        "paylink-reclaim",
        "Paylink",
        () => fakeRecover(...args),
        (txHash) => txHash,
      )
    : actual.recoverSponsoredLink(...args)
const fakeRecover: typeof actual.recoverSponsoredLink = async (...args) => {
  const [, , onStage] = args
  onStage?.("building")
  const refundHash = field("5c")
  await operation("paylink-recover", onStage, true, { txHash: refundHash })
  const params = decodePaylinkInline(args[1])
  await actual.markCreateRowRefunded(params.secret.toString(), actual.decodeLink(args[1]).flavor, args[0].account.getAddress().toString(), refundHash, "cancel")
  return refundHash
}
export const viewLink: typeof actual.viewLink = async (...args) => {
  if (!fixtureState()) return actual.viewLink(...args)
  if (fixtureState() === "loading") await new Promise<void>(() => {})
  await pause()
  const fragment = args[1]
  return {
    ...actual.decodeLink(fragment),
    amount: formatUnits(demoEscrowAmount(fragment), TOKEN_INFO.decimals),
    status: fixtureState() === "claimed" ? "claimed" : "unclaimed",
    memo: "Dinner and groceries for the weekend, including the train tickets home.",
  }
}
