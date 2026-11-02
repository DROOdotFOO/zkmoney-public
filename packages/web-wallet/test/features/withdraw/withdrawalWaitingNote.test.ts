/**
 * The withdrawal detail's waiting note: which wait each phase names, and where it names none. The
 * assertions pin what the note distinguishes — deducted or not, who can release, whose transaction
 * is outstanding — not the wording.
 */
import { describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { releaseNote, waitingNote } from "../../../src/features/withdraw/waitingNote"

const HOUR = 60 * 60 * 1000
const L2_TX = `0x${"0a".repeat(32)}` as Hex
const FINALIZE_TX = `0x${"0b".repeat(32)}` as Hex

const record = (patch: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  localId: "wdraw_1",
  recipient: `0x${"dd".repeat(20)}` as Address,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  phase: "submitting",
  startTime: Date.now() - 60_000,
  ...patch,
})

/** Past the delay threshold, so the manual finalize is on offer. */
const delayed = (patch: Partial<WithdrawalRecord>): WithdrawalRecord =>
  record({ startTime: Date.now() - 5 * HOUR, phaseEnteredAt: Date.now() - 4 * HOUR, ...patch })

describe("waitingNote", () => {
  it("names the proof before the burn has a hash, and the unmined Aztec transaction after", () => {
    const proving = waitingNote(record({ phase: "submitting" }))!
    expect(proving).toMatch(/proving/)
    expect(proving).toMatch(/still in your balance/)
    const sent = waitingNote(record({ phase: "submitting", l2TxHash: L2_TX }))!
    expect(sent).toMatch(/Aztec/)
    expect(sent).toMatch(/still in your balance/)
  })

  it("says the withdrawal is being released to Ethereum on both phases before Ethereum accepts it", () => {
    const mined = waitingNote(record({ phase: "l2_mined", l2TxHash: L2_TX }))!
    const proving = waitingNote(record({ phase: "awaiting_proven", l2TxHash: L2_TX }))!
    // Both wait on the same thing, so they say the same thing.
    expect(proving).toBe(mined)
    expect(mined).toMatch(/released to Ethereum/)
    expect(mined).not.toMatch(/prov|finali/i)
    expect(mined).toMatch(/deducted/)
    expect(mined).toMatch(/to the recipient/)
    expect(mined).not.toMatch(/yourself/)
  })

  it("names the relayer's single release transaction once Ethereum accepts the withdrawal", () => {
    const note = waitingNote(record({ phase: "finalizing_l1", l2TxHash: L2_TX }))!
    expect(note).toMatch(/relayer/)
    expect(note).toMatch(/deducted/)
    // Nothing to offer yet — the wait is still within normal.
    expect(note).not.toMatch(/yourself/)
  })

  it("offers the manual send only where the record is delayed enough to allow it", () => {
    const note = waitingNote(delayed({ phase: "finalizing_l1", l2TxHash: L2_TX }))!
    expect(note).toMatch(/relayer/)
    expect(note).toMatch(/yourself/)
  })

  it("names the user's own finalization once one is in flight, delayed or not", () => {
    const inFlight = waitingNote(
      delayed({ phase: "finalizing_l1", l2TxHash: L2_TX, finalizeTxHash: FINALIZE_TX }),
    )!
    // A submitted release is what is waited on; no relayer, and no second send to offer.
    expect(inFlight).not.toMatch(/relayer/)
    expect(inFlight).not.toMatch(/yourself/)
    expect(inFlight).toMatch(/confirm/)
    expect(
      waitingNote(record({ phase: "finalizing_l1", l2TxHash: L2_TX, finalizeTxHash: FINALIZE_TX })),
    ).toBe(inFlight)
  })

  it("names the swap leg on a swap withdrawal's waiting notes", () => {
    const proving = waitingNote(
      record({ phase: "awaiting_proven", l2TxHash: L2_TX, swapOutput: "ETH" }),
    )!
    const relaying = waitingNote(
      record({ phase: "finalizing_l1", l2TxHash: L2_TX, swapOutput: "ETH" }),
    )!
    expect(proving).toMatch(/swapped to ETH/)
    expect(relaying).toMatch(/swapped to ETH/)
    // The direct route promises the recipient the release itself — no swap to mention.
    expect(waitingNote(record({ phase: "finalizing_l1", l2TxHash: L2_TX }))).not.toMatch(/swapped/)
  })

  it("explains nothing about a released withdrawal", () => {
    expect(
      waitingNote(record({ phase: "done", l2TxHash: L2_TX, endTime: Date.now() })),
    ).toBeUndefined()
  })

  it("hands a failed withdrawal its failure's words, and stays silent without one", () => {
    expect(
      waitingNote(record({ phase: "failed", failure: { code: "withdrawal.interrupted" } })),
    ).toBe(
      "This withdrawal was interrupted before it finished. The amount is still in your balance.",
    )
    expect(waitingNote(record({ phase: "failed" }))).toBeUndefined()
  })

  describe("the swap leg", () => {
    const swap = (patch: Partial<WithdrawalRecord>): WithdrawalRecord =>
      record({
        l2TxHash: L2_TX,
        swapOutput: "USDC",
        swapEscrow: `0x${"e5".repeat(20)}` as Address,
        swapEscrowFactory: `0x${"fa".repeat(20)}` as Address,
        swapNonce: `0x${"77".repeat(32)}` as Hex,
        swapRecoveryCommitment: `0x${"5a".repeat(32)}` as Hex,
        swapRelayerTip: "5000000000000000000",
        ...patch,
      })

    it("swapping waits on a relayer, and offers the self-run once it has waited long enough", () => {
      const fresh = waitingNote(swap({ phase: "swapping", phaseEnteredAt: Date.now() }))!
      expect(fresh).toMatch(/released to the swap escrow/i)
      expect(fresh).toMatch(/relayer/)
      expect(fresh).not.toMatch(/yourself/)
      const stale = waitingNote(swap({ phase: "swapping", phaseEnteredAt: Date.now() - HOUR }))!
      expect(stale).toMatch(/run the swap yourself/)
    })

    it("a swap of the user's own in flight waits on that transaction", () => {
      const note = waitingNote(swap({ phase: "swapping", swapExecuteTxHash: FINALIZE_TX }))!
      expect(note).toMatch(/Your swap transaction/)
      expect(note).not.toMatch(/relayer/)
    })

    it("recoverable says why the swap cannot run and names the recovery exit", () => {
      const note = waitingNote(swap({ phase: "recoverable" }))!
      expect(note).toMatch(/can't complete right now/)
      expect(note).toMatch(/recover it/)
    })
  })
})

describe("releaseNote", () => {
  it("promises the release only once sent, and says so when it runs late", () => {
    expect(releaseNote(record({ phase: "submitting", l2TxHash: undefined }))).toBeUndefined()
    const fresh = record({
      phase: "awaiting_proven",
      l2TxHash: "0xabc" as Hex,
      phaseEnteredAt: Date.now(),
    })
    expect(releaseNote(fresh)).toMatch(/on its own/)
    const late = record({
      phase: "awaiting_proven",
      l2TxHash: "0xabc" as Hex,
      phaseEnteredAt: Date.now() - 24 * HOUR,
    })
    expect(releaseNote(late)).toBe("This is taking longer than usual.")
    expect(releaseNote(record({ phase: "done", l2TxHash: "0xabc" as Hex }))).toBeUndefined()
  })

  it("says the release pays the swap escrow, not the recipient, on a swap cash-out", () => {
    const swap = { l2TxHash: L2_TX, swapOutput: "USDC" as const }
    expect(
      releaseNote(record({ phase: "awaiting_proven", phaseEnteredAt: Date.now(), ...swap })),
    ).toMatch(/swapped to USDC before they reach the recipient/)
    expect(releaseNote(delayed({ phase: "finalizing_l1", ...swap }))).toMatch(
      /send the Ethereum transaction.*swapped to USDC/,
    )
  })
})
