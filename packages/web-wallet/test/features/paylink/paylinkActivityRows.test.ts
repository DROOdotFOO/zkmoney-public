/**
 * Paylink activity-row storage: the sponsored create/claim glue writes the same
 * PaylinkTransaction rows (pending synth row → txHash/paylink patch →
 * terminal status), and those rows surface in the activity view.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PaylinkActionEnum } from "@obsidion/sdk"
import {
  TxInFlightError,
  type Activity,
  type PaylinkTransaction,
  type Transaction,
} from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession } from "../../../src/platform/session"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import {
  failPaylinkRow,
  finishPaylinkRow,
  markCreateRowRefunded,
  paylinkFailure,
  savePreparedLink,
  saveRefundSubmitted,
  startPaylinkRow,
  type SponsoredPaylinkDeps,
} from "../../../src/features/paylink/sponsoredPaylink"
import { PaylinkClaimReconciler } from "@obsidion/front-core"
import { testWalletDbs } from "../../support/fakeWalletDb"

const TX_HASH = `0x${"ab".repeat(32)}`
const ACCOUNT = `0x${"22".repeat(32)}`
const TOKEN_ADDR = `0x${"33".repeat(32)}`
const SECRET = `0x${"44".repeat(32)}`

/** A display amount at the token's 6 decimals. */
const usd = (human: number) => ({ atomic: BigInt(human) * 10n ** 6n, human })

const deps = {
  wallet: { networkId: "0xnet" },
  tokenService: {
    fetchTokenInformation: async () => ({
      address: TOKEN_ADDR,
      name: "DAI",
      symbol: "DAI",
      decimals: 6,
    }),
  },
  account: { getAddress: () => ({ toString: () => ACCOUNT }) },
} as unknown as SponsoredPaylinkDeps

/** The rows once every background write has landed. */
async function savedRows() {
  await walletStorage.flush()
  return await store.all()
}

let store: Activity

beforeEach(() => {
  store = switchSession(activeNamespace()).activity
})
afterEach(closeSession)

describe("paylink activity rows", () => {
  it("create: pending synth row → success row with hash + link", async () => {
    const { operationId } = await startPaylinkRow(
      deps,
      "paylink-create",
      PaylinkActionEnum.PAY,
      usd(25),
    )

    let [row] = (await savedRows()) as PaylinkTransaction[]
    expect(row.status).toBe("pending")
    expect(row.emailPaymentAction).toBe(PaylinkActionEnum.PAY)
    expect(row.flavor).toBe("direct")
    expect(row.kind).toBe("paylink-create")
    expect(row.obsidionAccountAddress).toBe(ACCOUNT)
    expect(row.token?.amount).toBe(25)

    await finishPaylinkRow(operationId, TX_HASH, {
      payToEmailSecret: SECRET,
      paylink: "https://wallet.example/link#frag",
      untilClaimable: 1234,
    })
    ;[row] = (await savedRows()) as PaylinkTransaction[]
    expect(row.status).toBe("success")
    expect(row.txHash).toBe(TX_HASH)
    expect(row.paylink).toBe("https://wallet.example/link#frag")
    expect(row.untilClaimable).toBe(1234)
  })

  it.each([["cancel", "direct"]] as const)(
    "%s: the refund folds into the creator's PAY row, which carries both hashes",
    async (_label, flavor) => {
      const { operationId: createId } = await startPaylinkRow(
        deps,
        "paylink-create",
        PaylinkActionEnum.PAY,
        usd(25),
        { flavor },
      )
      await finishPaylinkRow(createId, TX_HASH, {
        payToEmailSecret: SECRET,
        paylink: "https://x/l#f",
        fallbackSecret: `0x${"55".repeat(32)}`,
        fromClaimable: 0,
        untilClaimable: 1234,
      })

      const { operationId: backId } = await startPaylinkRow(
        deps,
        "paylink-refund",
        PaylinkActionEnum.CLAIM_BACK,
        usd(25),
        { flavor },
      )
      const refundHash = `0x${"ef".repeat(32)}`
      await finishPaylinkRow(backId, refundHash)
      await markCreateRowRefunded(SECRET, flavor, ACCOUNT, refundHash, "cancel")

      const rows = (await savedRows()) as PaylinkTransaction[]
      const back = rows.find((r) => r.emailPaymentAction === PaylinkActionEnum.CLAIM_BACK)!
      const create = rows.find((r) => r.emailPaymentAction === PaylinkActionEnum.PAY)!
      expect(back.status).toBe("success")
      expect(back.kind).toBe("paylink-refund")
      expect(create.isRefunded).toBe(true)
      // Scrubbed with the refund: the link can never be claimed again.
      expect(create.paylink).toBeUndefined()

      // The refund transaction is readable off the create row, which is the only row left.
      expect(create.refundTxHash).toBe(refundHash)
    },
  )

  // ULT-876: past the submit boundary the tx may still land, so a rejection is not a failed row —
  // and the caller has to learn that too, or its screen offers to send the same operation again.
  it("leaves the row alone and surfaces the in-flight hash when the tx reached the node", async () => {
    const { operationId } = await startPaylinkRow(
      deps,
      "paylink-create",
      PaylinkActionEnum.PAY,
      usd(5),
    )
    const rejection = new Error("socket closed")
    const submission = { survived: async () => TX_HASH as `0x${string}` }
    const surfaced = await paylinkFailure(operationId, rejection, submission, {} as never)
    expect(surfaced).toBeInstanceOf(TxInFlightError)
    expect(surfaced).toMatchObject({
      txHash: TX_HASH,
      message: rejection.message,
      cause: rejection,
    })
    const [row] = await savedRows()
    expect(row.status).not.toBe("failed")
  })

  it("does not remove or scrub a paylink that already has a transaction hash", async () => {
    const { operationId } = await startPaylinkRow(
      deps,
      "paylink-create",
      PaylinkActionEnum.PAY,
      usd(5),
    )
    await store.setHash(operationId, TX_HASH)
    store.patch(operationId, (tx) => ({ ...tx, paylink: "https://x/l#f" } as Transaction))
    await failPaylinkRow(operationId, new DOMException("Aborted", "AbortError"))
    expect(await savedRows()).toMatchObject([{ txHash: TX_HASH, paylink: "https://x/l#f" }])
  })

  // The tab closes after the refund reaches the node: no finish, no refunded flag, only the hash.
  it("a refund submitted before a reload is never read as a recipient's claim", async () => {
    const { operationId: createId } = await startPaylinkRow(
      deps,
      "paylink-create",
      PaylinkActionEnum.PAY,
      usd(25),
      { flavor: "direct" },
    )
    await finishPaylinkRow(createId, TX_HASH, {
      payToEmailSecret: SECRET,
      paylink: "https://x/l#f",
      fallbackSecret: `0x${"55".repeat(32)}`,
      fromClaimable: 0,
      untilClaimable: 1234,
    })
    const { operationId: refundId } = await startPaylinkRow(
      deps,
      "paylink-refund",
      PaylinkActionEnum.CLAIM_BACK,
      usd(25),
    )
    await saveRefundSubmitted(refundId, SECRET, "direct", ACCOUNT, `0x${"ef".repeat(32)}`, "cancel")

    const spent = async (rows: PaylinkTransaction[]) => new Map(rows.map((r) => [r.txHash, true]))
    await walletStorage.flush()
    await new PaylinkClaimReconciler({ checkSpent: spent, storage: store }).reconcile("0xnet")

    const create = ((await savedRows()) as PaylinkTransaction[]).find(
      (r) => r.emailPaymentAction === PaylinkActionEnum.PAY,
    )!
    expect(create.isClaimed).toBeFalsy()
    expect(create.refundTxHash).toBe(`0x${"ef".repeat(32)}`)
  })
  describe("a prepared link", () => {
    const fields = { payToEmailSecret: SECRET, paylink: "https://x/l#f", untilClaimable: 1234 }
    const create = () => startPaylinkRow(deps, "paylink-create", PaylinkActionEnum.PAY, usd(25))

    it("rejects when its save fails, so the flow stops before it signs", async () => {
      const { operationId } = await create()
      testWalletDbs().onApply = (_version, ops) => {
        if (ops.some(([, value]) => value?.includes(SECRET))) throw new Error("disk full")
      }
      await expect(savePreparedLink(operationId, fields)).rejects.toThrow("disk full")
      expect(await store.get(operationId)).not.toMatchObject({ paylink: fields.paylink })
    })
  })

  describe("a submitted refund's hash", () => {
    const REFUND_HASH = `0x${"ef".repeat(32)}`

    async function linkAndRefund() {
      const { operationId: createId } = await startPaylinkRow(
        deps,
        "paylink-create",
        PaylinkActionEnum.PAY,
        usd(25),
      )
      await finishPaylinkRow(createId, TX_HASH, {
        payToEmailSecret: SECRET,
        paylink: "https://x/l#f",
        fallbackSecret: `0x${"55".repeat(32)}`,
      })
      await walletStorage.flush()
      const { operationId: refundId } = await startPaylinkRow(
        deps,
        "paylink-refund",
        PaylinkActionEnum.CLAIM_BACK,
        usd(25),
      )
      return { createId, refundId }
    }

    it("never lands on the refund row without the creator row's stamp", async () => {
      const { createId, refundId } = await linkAndRefund()
      testWalletDbs().onApply = (_version, ops) => {
        if (ops.some(([, value]) => value?.includes('"refundTxHash"'))) throw new Error("disk full")
      }
      await expect(
        saveRefundSubmitted(refundId, SECRET, "direct", ACCOUNT, REFUND_HASH, "cancel"),
      ).rejects.toThrow("disk full")
      await walletStorage.flush().catch(() => {})

      expect((await store.get(refundId))?.txHash).toBe("")
      expect(((await store.get(createId)) as PaylinkTransaction).refundTxHash).toBeUndefined()
    })
  })
})
