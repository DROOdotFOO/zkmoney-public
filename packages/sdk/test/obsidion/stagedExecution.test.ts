import { describe, expect, it } from "vitest"
import {
  DA_GAS_PER_FIELD,
  L2_GAS_PER_PRIVATE_LOG,
  PRIVATE_LOG_CIPHERTEXT_LEN,
  PRIVATE_LOG_SIZE_IN_FIELDS,
} from "@aztec-labs/constants"
import { Gas } from "@aztec-labs/stdlib/gas"

import {
  InvalidEffectDeltasError,
  ProvenGasExceedsLimitsError,
  assertProvenGasWithinLimits,
  priceDeclaredEffectDeltas,
} from "../../src/obsidion/stagedExecution.js"
import { computePublishDaLogEmittedLengths } from "../../src/oxide/token/publishDaLogs.js"

// pnpm test -- test/obsidion-wallet/stagedExecution.test.ts
//
// Sandbox-free unit coverage for the staged-execution gas math. The
// end-to-end accuracy check (staged single-sim estimate vs the legacy
// double-sim estimate vs the actually-proven tx) lives in
// test/token/token.sandbox.test.ts and needs a running sandbox.

/** Items that fit in one publish_da chunk log (`DA_COMPONENT_LOG_PAYLOAD_LENGTH` in da.nr). */
const ITEMS_PER_LOG = PRIVATE_LOG_CIPHERTEXT_LEN

describe("priceDeclaredEffectDeltas", () => {
  it("prices no deltas as zero gas", () => {
    expect(priceDeclaredEffectDeltas(undefined)).toEqual(Gas.empty())
    expect(priceDeclaredEffectDeltas({ privateLogEmittedLengths: [] })).toEqual(Gas.empty())
  })

  it("mirrors meterGasUsed's private-log terms (emittedLength + 1 DA fields, flat L2 per log)", () => {
    const lengths = [7, PRIVATE_LOG_SIZE_IN_FIELDS, 2]
    const priced = priceDeclaredEffectDeltas({ privateLogEmittedLengths: lengths })
    const expectedDaFields = lengths.reduce((acc, len) => acc + len + 1, 0)
    expect(priced.daGas).toBe(expectedDaFields * DA_GAS_PER_FIELD)
    expect(priced.l2Gas).toBe(lengths.length * L2_GAS_PER_PRIVATE_LOG)
  })

  it("rejects structurally invalid declarations", () => {
    for (const bad of [0, -1, 1.5, PRIVATE_LOG_SIZE_IN_FIELDS + 1, Number.NaN]) {
      expect(() => priceDeclaredEffectDeltas({ privateLogEmittedLengths: [bad] })).toThrow(
        InvalidEffectDeltasError,
      )
    }
  })
})

describe("computePublishDaLogEmittedLengths", () => {
  // Mirrors oxide_token_contract/src/da.nr: every emitted log is
  // [componentDaTag, ...chunk] (the single siloed tag field), so
  // emittedLength = 1 + chunk. Empty components emit NO log; the metadata
  // component is a single unchunked log of 1 + metadataFields.

  it("emits only the metadata log when every component is empty", () => {
    const lengths = computePublishDaLogEmittedLengths({
      teeNotes: 0,
      requiredNullifiers: 0,
      withdrawalMessageHashes: 0,
      metadataFields: 5,
    })
    expect(lengths).toEqual([6])
  })

  it("matches the typical transfer shape (2 created notes, 1 required nullifier, no exits)", () => {
    const lengths = computePublishDaLogEmittedLengths({
      teeNotes: 2,
      requiredNullifiers: 1,
      withdrawalMessageHashes: 0,
      metadataFields: 5,
    })
    expect(lengths).toEqual([3, 2, 6])
  })

  it("chunks components at PRIVATE_LOG_CIPHERTEXT_LEN items per log", () => {
    const exactlyOneLog = computePublishDaLogEmittedLengths({
      teeNotes: ITEMS_PER_LOG,
      requiredNullifiers: 0,
      withdrawalMessageHashes: 0,
      metadataFields: 5,
    })
    expect(exactlyOneLog).toEqual([1 + ITEMS_PER_LOG, 6])

    const oneOverflow = computePublishDaLogEmittedLengths({
      teeNotes: ITEMS_PER_LOG + 1,
      requiredNullifiers: 0,
      withdrawalMessageHashes: 0,
      metadataFields: 5,
    })
    expect(oneOverflow).toEqual([1 + ITEMS_PER_LOG, 2, 6])
  })

  it("conserves items and respects the protocol log-size ceiling for arbitrary counts", () => {
    for (const n of [
      1,
      3,
      ITEMS_PER_LOG,
      ITEMS_PER_LOG + 1,
      2 * ITEMS_PER_LOG,
      2 * ITEMS_PER_LOG + 5,
    ]) {
      const lengths = computePublishDaLogEmittedLengths({
        teeNotes: n,
        requiredNullifiers: 0,
        withdrawalMessageHashes: 0,
        metadataFields: 5,
      })
      // Component logs come first; drop the trailing metadata log (empty
      // components emit nothing) to isolate the teeNotes component.
      const componentLogs = lengths.slice(0, lengths.length - 1)
      expect(componentLogs.length).toBe(Math.ceil(n / ITEMS_PER_LOG))
      expect(componentLogs.reduce((acc, len) => acc + (len - 1), 0)).toBe(n)
      for (const len of lengths) {
        expect(len).toBeLessThanOrEqual(PRIVATE_LOG_SIZE_IN_FIELDS)
        expect(len).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it("prices through priceDeclaredEffectDeltas without validation errors", () => {
    const lengths = computePublishDaLogEmittedLengths({
      teeNotes: 2 * ITEMS_PER_LOG + 5,
      requiredNullifiers: 3,
      withdrawalMessageHashes: 1,
      metadataFields: 5,
    })
    const priced = priceDeclaredEffectDeltas({ privateLogEmittedLengths: lengths })
    expect(priced.daGas).toBeGreaterThan(0)
    expect(priced.l2Gas).toBe(lengths.length * L2_GAS_PER_PRIVATE_LOG)
  })
})

describe("assertProvenGasWithinLimits", () => {
  const limits = Gas.from({ daGas: 1000, l2Gas: 2000 })

  it("passes when proven gas fits the limits", () => {
    expect(() =>
      assertProvenGasWithinLimits(Gas.from({ daGas: 1000, l2Gas: 2000 }), limits, "test"),
    ).not.toThrow()
  })

  it("throws the typed error when either dimension exceeds the limits", () => {
    expect(() =>
      assertProvenGasWithinLimits(Gas.from({ daGas: 1001, l2Gas: 1 }), limits, "test"),
    ).toThrow(ProvenGasExceedsLimitsError)
    expect(() =>
      assertProvenGasWithinLimits(Gas.from({ daGas: 1, l2Gas: 2001 }), limits, "test"),
    ).toThrow(ProvenGasExceedsLimitsError)
  })
})
