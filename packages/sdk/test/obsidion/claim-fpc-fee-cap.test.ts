import { GasFees } from "@aztec-labs/stdlib/gas"
import { expect, it } from "vitest"
import { CLAIM_FPC_MAX_FEES_PER_GAS as CAP } from "../../src/feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"

function walletAt(minFees: GasFees): ObsidionWallet {
  const info = { l1ChainId: 1, rollupVersion: 1, txsLimits: { gas: { daGas: 1e6, l2Gas: 1e7 } } }
  const node = { getPredictedMinFees: async () => [minFees], getNodeInfo: async () => info }
  const pxe = { sync: async () => {}, getSyncedBlockHeader: async () => ({}) }
  return new ObsidionWallet(pxe as never, node as never, "0xrollup")
}

it.each([
  ["at the config fee-per-gas", CAP, false],
  ["above it", new GasFees(CAP.feePerDaGas, CAP.feePerL2Gas + 1n), true],
])("sponsoredFeesAboveCap with a min fee %s is %s", async (_, minFees, above) => {
  expect(await walletAt(minFees).sponsoredFeesAboveCap()).toBe(above)
})
