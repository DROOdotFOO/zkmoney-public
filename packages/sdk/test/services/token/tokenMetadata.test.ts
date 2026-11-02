/** A token service reports the name, symbol and decimals its token's immutables commit to. */
import { afterEach, describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { OxideTokenImmutables } from "@oxide/oxide-lib/token_immutables.js"
import { TokenService } from "../../../src/services/token/TokenService.js"

const USDC: OxideTokenImmutables = {
  portal: EthAddress.fromNumber(1),
  teeRegistry: EthAddress.fromNumber(2),
  name: "USD Coin",
  symbol: "USDC",
  decimals: 6,
  maxNoteAmount: 10n ** 12n,
}

function tokenServiceAt(address: AztecAddress): TokenService {
  const service = Object.create(TokenService.prototype) as { contractAddress?: AztecAddress }
  service.contractAddress = address
  return service as unknown as TokenService
}

describe("TokenService token metadata", () => {
  afterEach(() => TokenService.setImmutablesSource(undefined))

  it("reads a 6-decimal token's metadata from its immutables", async () => {
    const token = AztecAddress.fromNumberUnsafe(7)
    const asked: string[] = []
    TokenService.setImmutablesSource(async (address) => {
      asked.push(address.toString())
      return USDC
    })
    const service = tokenServiceAt(token)

    expect(await service.fetchTokenInformation()).toEqual({
      address: token.toString(),
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
    })
    expect(await service.parseAmount("1.5")).toBe(1_500_000n)
    expect(await service.formatAmount(1_500_000n)).toBe("1.5")
    expect(asked).toEqual([token.toString()])
  })

  it("refuses to guess metadata without an immutables source", async () => {
    await expect(
      tokenServiceAt(AztecAddress.fromNumberUnsafe(7)).fetchTokenInformation(),
    ).rejects.toThrow(/No immutables source/)
  })
})
