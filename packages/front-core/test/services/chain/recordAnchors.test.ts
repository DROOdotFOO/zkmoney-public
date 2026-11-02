import { beforeEach, describe, expect, it } from "vitest"
import type { Address } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import type {
  ReorgTxReceiptLike,
  ReorgNodeLike,
} from "../../../src/core/services/chain/receiptTypes"
import {
  SIPADepositStore,
  type SIPADepositFields,
} from "../../../src/core/services/deposits/SIPADepositStore"
import { TxStatus } from "@aztec-labs/stdlib/tx"

const NETWORK_ID = "0x" + "ab".repeat(20)
const TX_HASH = "0x" + "11".repeat(32)
const BLOCK_HASH = "0x" + "22".repeat(32)

describe("receipt shape", () => {
  it("ReorgTxReceiptLike / ReorgNodeLike are structural", async () => {
    const receipt: ReorgTxReceiptLike = {
      status: TxStatus.PROPOSED,
      blockNumber: 7,
      blockHash: BLOCK_HASH,
    }
    const node: ReorgNodeLike = { getTxReceipt: async () => receipt }
    await expect(node.getTxReceipt(TX_HASH)).resolves.toEqual(receipt)
  })
})

describe("SIPADepositRecord networkId", () => {
  const SIPA_ADDR = "0xAbCdEf0123456789abcdef0123456789abcdef01" as Address

  function fallback(): SIPADepositFields {
    return {
      networkId: NETWORK_ID.toUpperCase(),
      recipientL2Address: "0x" + "33".repeat(32),
      messageSecret: "0x" + "11".repeat(32),
      recipientHash: "0x" + "22".repeat(32),
      recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
      l1ChainId: 11155111,
      amount: "12.5",
      tokenSymbol: "DAI",
      startTime: 1000,
    }
  }

  beforeEach(() => {
    resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  })

  it("stamps networkId, lowercase, on first insert and preserves it across patches", async () => {
    const store = SIPADepositStore.get(new InMemoryStorageAdapter())
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, fallback())
    expect(store.get(SIPA_ADDR)?.networkId).toBe(NETWORK_ID)

    await store.upsert(SIPA_ADDR, { phase: "sweeping" })
    expect(store.get(SIPA_ADDR)?.networkId).toBe(NETWORK_ID)
  })
})
