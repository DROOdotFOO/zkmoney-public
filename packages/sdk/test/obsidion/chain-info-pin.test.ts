/**
 * `ObsidionWallet`'s chain-identity pin. A wallet built with `chainInfo` binds every tx context,
 * authwit hash and link stamp to that pair, whatever the node answers afterwards;
 * a wallet built without it takes the node's answer. Mock PXE / mock node — no sandbox.
 */
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { AccountFeePaymentMethodOptions } from "@aztec-labs/entrypoints/account"
import type { FeeOptions } from "@aztec-labs/wallet-sdk/base-wallet"
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec-labs/stdlib/abi"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { ExecutionPayload, type TxExecutionRequest } from "@aztec-labs/stdlib/tx"
import { describe, expect, it, vi } from "vitest"
import { stubGasSettingsFallback, stubNodeInfo } from "../utils/wallet/obsidionWalletStubs.js"

import { ObsidionWallet, type WalletChainInfo } from "../../src/obsidion/ObsidionWallet.js"
import { chainInfoFields, linkChainInfo } from "../../src/services/claimFpc/claimSponsor.js"

const PINNED: WalletChainInfo = { l1ChainId: 1, rollupVersion: 7 }
const NODE = { l1ChainId: 31337, rollupVersion: 1 }
const LIAR = { l1ChainId: 999, rollupVersion: 42 }

function makeWallet(opts?: {
  chainInfo?: WalletChainInfo
  nodeInfo?: WalletChainInfo
  nodeRejects?: boolean
}) {
  const stubNode = {
    getNodeInfo: vi.fn(async () => {
      if (opts?.nodeRejects) throw new Error("node unreachable")
      return stubNodeInfo(opts?.nodeInfo ?? NODE)
    }),
  }
  const wallet = new ObsidionWallet({} as never, stubNode as never, "0xrollup", {
    chainInfo: opts?.chainInfo,
  })
  return { wallet, stubNode }
}

/** From here on the node reports another rollup. */
function nodeLies(stubNode: ReturnType<typeof makeWallet>["stubNode"]) {
  stubNode.getNodeInfo.mockImplementation(async () => stubNodeInfo(LIAR))
}

const feeOptions: FeeOptions = {
  gasSettings: stubGasSettingsFallback(),
  walletFeePaymentMethod: undefined,
  accountFeePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
}

/** One private call: what upstream's `DefaultEntrypoint` accepts for a NO_FROM request. */
function privateCallPayload() {
  const call = FunctionCall.from({
    name: "f",
    to: AztecAddress.fromBigIntUnsafe(0x1n),
    selector: FunctionSelector.fromField(new Fr(1)),
    type: FunctionType.PRIVATE,
    hideMsgSender: false,
    isStatic: false,
    args: [],
  })
  return new ExecutionPayload([call], [], [], [])
}

describe("ObsidionWallet chain-info pin", () => {
  it("pinned: both accessors answer from the pin and never ask the node", async () => {
    const { wallet, stubNode } = makeWallet({ chainInfo: PINNED, nodeRejects: true })
    await expect(wallet.getNodeIdentity()).resolves.toEqual(PINNED)
    const info = await wallet.getChainInfo()
    expect(info.chainId.toBigInt()).toBe(1n)
    expect(info.version.toBigInt()).toBe(7n)
    expect(stubNode.getNodeInfo).not.toHaveBeenCalled()
  })

  it("unpinned: both accessors answer from the node", async () => {
    const { wallet } = makeWallet()
    await expect(wallet.getNodeIdentity()).resolves.toEqual(NODE)
    const info = await wallet.getChainInfo()
    expect(info.chainId.toBigInt()).toBe(31337n)
    expect(info.version.toBigInt()).toBe(1n)
  })

  it("unpinned: a rejecting node rejects both accessors", async () => {
    const { wallet } = makeWallet({ nodeRejects: true })
    await expect(wallet.getNodeIdentity()).rejects.toThrow("node unreachable")
    await expect(wallet.getChainInfo()).rejects.toThrow("node unreachable")
  })

  it("a NO_FROM request carries the pin after the node changes its answer", async () => {
    const { wallet, stubNode } = makeWallet({ chainInfo: PINNED, nodeInfo: PINNED })
    nodeLies(stubNode)
    // Protected upstream; reached through a structural view.
    const build = wallet as unknown as {
      createTxExecutionRequestFromPayloadAndFee: (
        payload: ExecutionPayload,
        from: typeof NO_FROM,
        fee: FeeOptions,
      ) => Promise<TxExecutionRequest>
    }
    const request = await build.createTxExecutionRequestFromPayloadAndFee(
      privateCallPayload(),
      NO_FROM,
      feeOptions,
    )
    expect(request.txContext.chainId.toBigInt()).toBe(1n)
    expect(request.txContext.version.toBigInt()).toBe(7n)
  })

  it("link stamps and authwit fields come from the pin while the node rejects", async () => {
    const { wallet } = makeWallet({ chainInfo: PINNED, nodeRejects: true })
    await expect(linkChainInfo(wallet)).resolves.toEqual({ chainId: 1, rollupVersion: 7 })
    const fields = await chainInfoFields(wallet)
    expect(fields.chainId.toBigInt()).toBe(1n)
    expect(fields.version.toBigInt()).toBe(7n)
  })

  it("unpinned: link stamps and authwit fields fail with a rejecting node", async () => {
    const { wallet } = makeWallet({ nodeRejects: true })
    await expect(linkChainInfo(wallet)).rejects.toThrow("node unreachable")
    await expect(chainInfoFields(wallet)).rejects.toThrow("node unreachable")
  })
})
