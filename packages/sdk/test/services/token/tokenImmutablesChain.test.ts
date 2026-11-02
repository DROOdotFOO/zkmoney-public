/** A token's immutables are stored from the artifact of the rollup its wallet runs on. */
import { afterEach, describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractService } from "@obsidion/contracts"
import type { OxideTokenImmutables } from "@oxide/oxide-lib/token_immutables.js"
import type { ObsidionWallet } from "../../../src/obsidion/ObsidionWallet.js"
import { TokenService } from "../../../src/services/token/TokenService.js"

describe("TokenService.ensureImmutablesStored", () => {
  afterEach(() => TokenService.setImmutablesSource(undefined))

  it("resolves the token's artifact on the wallet's rollup, not the service's", async () => {
    // A retired rollup's wallet: its token exists only on that wallet's node.
    const wallet = { node: {}, pxe: {} } as unknown as ObsidionWallet
    const chains: unknown[] = []
    const contractService = {
      getArtifactForContract: async (_name: unknown, _address: unknown, chain?: unknown) => {
        chains.push(chain)
        throw new Error("artifact read")
      },
    } as unknown as ContractService
    TokenService.setImmutablesSource(async () => ({} as OxideTokenImmutables))

    await expect(
      TokenService.ensureImmutablesStored(
        wallet,
        contractService,
        AztecAddress.fromNumberUnsafe(7),
      ),
    ).rejects.toThrow("artifact read")
    expect(chains).toEqual([wallet])
  })
})
