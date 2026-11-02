/**
 * The swap routes are gated on the manifest publishing the escrow factory. Without it there is no
 * counterfactual escrow to burn to, so the gate has to fail closed rather than offer a route that
 * would strand the user's DAI.
 */
import { describe, expect, it } from "vitest"
import { withdrawalReceiveAssets } from "../../../src/features/withdraw/withdrawAssets"

const ids = (tuple: Parameters<typeof withdrawalReceiveAssets>[0]) =>
  withdrawalReceiveAssets(tuple).map((option) => option.id)

describe("withdrawalReceiveAssets", () => {
  it("offers DAI only without a factory", () => {
    expect(ids({})).toEqual(["DAI"])
    expect(ids({ swapEscrowFactoryV2: undefined })).toEqual(["DAI"])
  })
})
