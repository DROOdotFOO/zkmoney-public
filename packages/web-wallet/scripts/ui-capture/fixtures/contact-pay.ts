import * as actual from "../../../src/features/contacts/contactPay"
import { ContactStorage } from "@obsidion/front-core"
import { parseUnits } from "viem"
import { session } from "../../../src/platform/session"
import { fixtureState, inOperation, operation } from "./control"
import { field, TOKEN_INFO, TX_HASH, ROLLUP } from "./data"
export * from "../../../src/features/contacts/contactPay"
let sequence = 0
export const requestFromContact: typeof actual.requestFromContact = async (deps, args) => {
  if (!fixtureState()) return actual.requestFromContact(deps, args)
  await operation("request")
  await session().requests.add({
    id: field((++sequence + 16).toString(16)), contactTag: args.tag, direction: "outgoing", status: "pending",
    kind: "contact", amount: Number(args.amountDisplay), amountAtomic: parseUnits(args.amountDisplay, 18).toString(),
    asset: "DAI", createdAt: Date.now(), note: args.note, tokenAddress: TOKEN_INFO.address, tokenDecimals: 18, networkId: ROLLUP,
  })
}
export const runContactPay: typeof actual.runContactPay = async (args, onStage) => {
  if (!fixtureState()) return actual.runContactPay(args, onStage)
  if (args.mode !== "send") {
    await requestFromContact(args.deps, { tag: args.tag, requesterTag: args.senderTag, amountDisplay: args.amountDisplay, note: args.note })
    return {}
  }
  const store = session().activity
  const entry = (await ContactStorage.get().getEntries()).find((entry) => entry.tag === args.tag)
  const id = `capture-send-${++sequence}`
  let rowCreated = false
  onStage("resolving")
  const send = async () => {
    try {
      await operation("send", onStage, true, {
        operationId: id,
        onPrepared: async () => {
          await store.insertPending({
            id, operationId: id, networkId: ROLLUP, action: "send", token: { ...TOKEN_INFO, amount: Number(args.amountDisplay), price: 1, logo: "" },
            amountAtomic: parseUnits(args.amountDisplay, 18), timestamp: Date.now(), status: "pending", txHash: "",
            to: entry?.address ?? args.tag, memo: args.note, requestId: args.request?.id,
          })
          rowCreated = true
        },
      })
      store.settle(id, TX_HASH)
      return { txHash: TX_HASH }
    } catch (error) {
      if (rowCreated) store.fail(id, { code: "tx.failed", detail: String(error) })
      throw error
    }
  }
  return inOperation("send", `$${args.amountDisplay} to @${args.tag}`, send, (r) => r.txHash)
}
