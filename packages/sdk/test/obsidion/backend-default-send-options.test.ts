/**
 * Unit test for `ObsidionWalletBackend.getDefaultSendOptions`.
 *
 * The backend deploy wallet pays through its own SponsorFPC once
 * setOwnSponsorFPCAddress is called. With no SponsorFPC it fails loud
 * (testnet/sandbox always deploy one) unless setAllowDirectFeeJuice(true) was
 * called — the mainnet minimal deploy, which skips the drainable SponsorFPC and
 * has the sender pay from its own bridged fee juice.
 *
 * Mock PXE / node in the style of `get-default-send-options.test.ts`.
 */
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { describe, expect, it } from "vitest"

import { ObsidionWalletBackend } from "../../src/obsidion/ObsidionWalletBackend.js"

function makeBackend(): ObsidionWalletBackend {
  return new ObsidionWalletBackend({} as never, {} as never, "0xrollup")
}

describe("ObsidionWalletBackend.getDefaultSendOptions", () => {
  const from = AztecAddress.fromBigIntUnsafe(0x42n)

  it("throws when no SponsorFPC is set and direct fee juice is not allowed (testnet/sandbox fail-loud)", async () => {
    const wallet = makeBackend()
    await expect(wallet.getDefaultSendOptions(from)).rejects.toThrow(/Sponsor FPC address not set/)
  })

  it("returns { from } with no fee payer when direct fee juice is allowed (mainnet minimal deploy)", async () => {
    // `{ from }` with no fee payer makes the base wallet's completeFeeOptions
    // select PREEXISTING_FEE_JUICE, so the sender (admin) pays from its own
    // bridged balance.
    const wallet = makeBackend()
    wallet.setAllowDirectFeeJuice(true)
    const opts = await wallet.getDefaultSendOptions(from)
    expect(opts.from).toBe(from)
    expect(opts.fee).toBeUndefined()
  })
})
