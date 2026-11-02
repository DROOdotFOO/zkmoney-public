import {
  decodeRequestInline,
  sipaDeploymentTag,
  type StoredRequest,
  type SipaOrigin,
} from "@obsidion/front-core"
import { describe, expect, it, vi } from "vitest"
import { createAndStoreRequestLink } from "../../../src/features/requests/requestLinkCreation"

const FIELD_ID = `0x${"0a".repeat(32)}`
const TOKEN_ADDRESS = `0x${"1b".repeat(32)}`

const input = {
  requestId: FIELD_ID,
  requesterTag: "alice",
  requesterAddress: `0x${"2c".repeat(32)}`,
  tokenAddress: TOKEN_ADDRESS,
  tokenDecimals: 18,
  tokenSymbol: "DAI",
  networkId: "0xrollup",
  baseUrl: "https://paylink.test.zk.money",
  amountInput: "25",
  noteInput: "dinner",
  durationMs: 30 * 86_400_000,
  now: 1_800_000_000_000,
}

describe("createAndStoreRequestLink", () => {
  it("persists the outgoing join row before returning the link", async () => {
    const writes: StoredRequest[] = []
    const result = await createAndStoreRequestLink(input, {
      add: async (row) => {
        writes.push(row)
      },
    })

    expect(writes).toEqual([result.row])
    expect(decodeRequestInline(result.url.split("#")[1])).toMatchObject({
      requestId: FIELD_ID,
      requesterTag: "alice",
      tokenAddress: TOKEN_ADDRESS,
      amountAtomic: 25_000_000_000_000_000_000n,
      note: "dinner",
    })
  })

  const sipaAddress = `0x${"3d".repeat(20)}`
  const origin = {
    protocol: "account",
    sipaFactory: `0x${"6a".repeat(20)}`,
    implementation: `0x${"7b".repeat(20)}`,
    intentHash: `0x${"4e".repeat(32)}`,
    rollupVersion: "7",
    resweepable: true,
    recoveryAccount: `0x${"8c".repeat(20)}`,
    recoveryCommitment: `0x${"5f".repeat(32)}`,
    accountFactory: `0x${"9d".repeat(20)}`,
  } as SipaOrigin

  it("carries the recorded preimage of the link's address", async () => {
    const preimage = { intentHash: origin.intentHash, recovery: `0x${"5f".repeat(32)}` }
    const originOf = vi.fn(async () => origin)
    const result = await createAndStoreRequestLink(
      { ...input, sipaAddress },
      { add: async () => {} },
      originOf,
    )
    expect(originOf).toHaveBeenCalledWith(sipaAddress)
    expect(decodeRequestInline(result.url.split("#")[1]).sipaPreimage).toEqual(preimage)
    expect(result.row.sipaPreimage).toEqual(preimage)
  })

  it("tags a Receive code's address with the deployment it was derived under", async () => {
    const result = await createAndStoreRequestLink(
      { ...input, requestId: `0x${"00".repeat(16)}${"0a".repeat(16)}`, compact: true, sipaAddress },
      { add: async () => {} },
      async () => origin,
    )
    const packet = decodeRequestInline(result.url.split("#")[1])
    expect(packet.sipaDeployment).toBe(sipaDeploymentTag(origin))
    expect(packet.sipaPreimage).toBeUndefined()
  })

  it("does not reveal a result when persistence fails", async () => {
    const error = new Error("quota exceeded")
    const add = vi.fn().mockRejectedValue(error)

    await expect(createAndStoreRequestLink(input, { add })).rejects.toBe(error)
    expect(add).toHaveBeenCalledOnce()
  })
})
