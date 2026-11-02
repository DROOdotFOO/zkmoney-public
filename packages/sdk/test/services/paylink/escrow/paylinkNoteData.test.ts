import { describe, it, expect } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  assertPaylinkTerms,
  buildPaylinkNoteView,
  packPaylinkData,
  PAYLINK_TERMS_REFUSAL,
  paylinkSenderHash,
  paylinkTerms,
  unpackPaylinkData,
} from "../../../../src/services/paylink/escrow/paylinkNoteData.js"
import type { RawPaylinkNote } from "../../../../src/services/paylink/escrow/paylinkNoteData.js"

function rawNote(data: Fr, refundable_until: Fr = Fr.ZERO): RawPaylinkNote {
  return {
    hash: Fr.ZERO,
    sender_hash: Fr.ZERO,
    data,
    refundable_until,
    oidc_key_registry: AztecAddress.ZERO,
    vkey_hash: Fr.ZERO,
    token_address: AztecAddress.fromBigIntUnsafe(42n),
  }
}

describe("unpackPaylinkData", () => {
  it("round-trips timestamp-like values through Fr and bigint encodings", () => {
    const amount = 1_000_000_000_000_000_000n
    const from_claimable = 1_704_067_200n
    const until_claimable = 1_735_689_600n
    const packed = packPaylinkData(amount, from_claimable, until_claimable)
    const expected = { amount, from_claimable, until_claimable }

    expect(unpackPaylinkData(packed)).toEqual(expected)
    expect(unpackPaylinkData(packed.toBigInt())).toEqual(expected)
  })
})

describe("buildPaylinkNoteView", () => {
  const packed = packPaylinkData(500n, 1_000n, 2_000n)
  const note = rawNote(packed, new Fr(1_500n))

  it("exposes the note's amount, token and windows", () => {
    const view = buildPaylinkNoteView(note, 1_500)
    expect(view.amount).toBe(500n)
    expect(view.tokenAddress.toString()).toBe(note.token_address.toString())
    expect(view).toMatchObject({
      claimableFrom: 1_000,
      claimableUntil: 2_000,
      expiresAt: 2_000,
      refundableUntil: 1_500,
      validUntil: new Date(2_000_000).toISOString(),
    })
  })

  it.each([
    [999, "gracePeriod", true, false, false],
    [1_000, "claimable", false, true, false],
    [1_500, "claimable", false, true, false],
    [2_000, "claimable", false, true, false],
    [2_001, "expired", false, false, true],
  ])("at %i is %s", (now, status, isInGracePeriod, isClaimable, isExpired) => {
    expect(buildPaylinkNoteView(note, now)).toMatchObject({
      status,
      isInGracePeriod,
      isClaimable,
      isExpired,
    })
  })

  it.each([
    [1_500n, 500, true],
    [1_500n, 1_300, true],
    [1_500n, 1_500, true],
    [1_500n, 1_501, false],
    [1_500n, 2_000, false],
    [1_500n, 2_001, true],
    [0n, 1_300, false],
    [0n, 2_001, true],
  ])("with refundableUntil %i, at %i refundable is %s", (refundableUntil, now, isRefundable) => {
    const view = buildPaylinkNoteView(rawNote(packed, new Fr(refundableUntil)), now)
    expect(view.isRefundable).toBe(isRefundable)
  })
})

describe("paylinkTerms", () => {
  const note: RawPaylinkNote = {
    hash: new Fr(1),
    sender_hash: new Fr(2),
    data: packPaylinkData(1000n, 10n, 100n),
    refundable_until: new Fr(50),
    oidc_key_registry: AztecAddress.fromBigIntUnsafe(3n),
    vkey_hash: new Fr(4),
    token_address: AztecAddress.fromBigIntUnsafe(5n),
  }

  it("matches paylink_note::test_paylink_terms_vector", async () => {
    expect((await paylinkTerms(note)).toString()).toBe(
      "0x2990a2606ec999744beecb7c857e662d4f0e072435c4a898e51e9ecd78761d29",
    )
  })

  it("hashes the sender as paylink_note::test_sender_hash_vector", async () => {
    expect((await paylinkSenderHash(AztecAddress.fromBigIntUnsafe(7n))).toString()).toBe(
      "0x29f0f539ca2b1865fb736203c036100998291b6e1072323a1db5022f0a52b3cc",
    )
  })

  it("refuses a note other than the link's, and passes a link with no terms", async () => {
    const terms = await paylinkTerms(note)
    await expect(assertPaylinkTerms({ terms }, note)).resolves.toBeUndefined()
    await expect(
      assertPaylinkTerms({}, { ...note, data: packPaylinkData(1n, 10n, 100n) }),
    ).resolves.toBeUndefined()
    await expect(
      assertPaylinkTerms({ terms }, { ...note, data: packPaylinkData(1n, 10n, 100n) }),
    ).rejects.toThrow(PAYLINK_TERMS_REFUSAL)
  })
})
