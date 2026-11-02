/** `ObsidionWallet.getDefaultSendOptions` fails closed with a typed error. */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { describe, expect, it } from "vitest"

import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { FeeUnavailableError } from "../../src/obsidion/FeeUnavailableError.js"

describe("ObsidionWallet.getDefaultSendOptions", () => {
  it("throws FeeUnavailableError", async () => {
    const wallet = new ObsidionWallet({} as never, {} as never, "0xrollup")
    await expect(
      wallet.getDefaultSendOptions(AztecAddress.fromBigIntUnsafe(0x42n)),
    ).rejects.toBeInstanceOf(FeeUnavailableError)
  })
})
