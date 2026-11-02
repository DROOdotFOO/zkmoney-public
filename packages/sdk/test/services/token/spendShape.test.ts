/** The balance's shape read over a scripted PXE, and the refusals a move planner re-cuts on. */
import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { NoteStatus, type NoteDao } from "@aztec-labs/stdlib/note"
import { OxideTokenContract } from "@obsidion/contracts"
import {
  SPEND_SHAPE_ATTEMPTS,
  ShapeUnreadError,
  isSpendEnvelopeRefusal,
  readSpendShape,
  type SpendShapeToken,
  type SpendShapeWallet,
} from "../../../src/services/token/spendShape.js"

const ACCOUNT = AztecAddress.fromBigIntUnsafe(0xacc0n)
const TOKEN = AztecAddress.fromBigIntUnsafe(0x70n)

const note = (id: number, amount: bigint) =>
  ({ siloedNullifier: new Fr(BigInt(id)), note: { items: [new Fr(amount)] } } as unknown as NoteDao)

/** `reads` are the note sets in order; `balances` the `balance_of` results in order. */
function fixture(reads: NoteDao[][], balances: unknown[]) {
  const getNotes = vi.fn(async () => reads.shift() ?? [])
  const simulate = vi.fn(async () => ({ result: balances.shift() ?? 0n }))
  const wallet: SpendShapeWallet = { pxe: { debug: { getNotes } } }
  const token: SpendShapeToken = { address: TOKEN, methods: { balance_of: () => ({ simulate }) } }
  return { wallet, token, getNotes, simulate }
}

describe("readSpendShape", () => {
  it("lists the notes largest first and puts the rest of the balance down to deposits", async () => {
    const notes = [note(1, 5n), note(2, 2n), note(3, 9n)]
    const { wallet, token, getNotes, simulate } = fixture([notes, [...notes]], [20n])

    const shape = await readSpendShape(wallet, token, ACCOUNT)

    expect(shape).toEqual({ notes: [9n, 5n, 2n], depositTotal: 4n, balance: 20n })
    expect(getNotes).toHaveBeenCalledWith({
      contractAddress: TOKEN,
      owner: ACCOUNT,
      storageSlot: OxideTokenContract.storage.balances.slot,
      status: NoteStatus.ACTIVE,
      scopes: [ACCOUNT],
    })
    expect(simulate).toHaveBeenCalledWith({ from: ACCOUNT })
  })

  it("reads a balance the simulation returns as a string", async () => {
    const { wallet, token } = fixture([[note(1, 5n)], [note(1, 5n)]], ["7"])
    expect(await readSpendShape(wallet, token, ACCOUNT)).toEqual({
      notes: [5n],
      depositTotal: 2n,
      balance: 7n,
    })
  })

  it("takes the same notes in another order as one read", async () => {
    const a = note(1, 5n)
    const b = note(2, 3n)
    const { wallet, token, getNotes } = fixture(
      [
        [a, b],
        [b, a],
      ],
      [8n],
    )

    const shape = await readSpendShape(wallet, token, ACCOUNT)

    expect(shape).toEqual({ notes: [5n, 3n], depositTotal: 0n, balance: 8n })
    expect(getNotes).toHaveBeenCalledTimes(2)
  })

  it("reads again when a note arrives between the brackets", async () => {
    const a = note(1, 5n)
    const b = note(2, 3n)
    const { wallet, token, getNotes } = fixture([[a], [a, b], [a, b], [a, b]], [5n, 8n])

    const shape = await readSpendShape(wallet, token, ACCOUNT)

    expect(shape).toEqual({ notes: [5n, 3n], depositTotal: 0n, balance: 8n })
    expect(getNotes).toHaveBeenCalledTimes(4)
  })

  it("reads again when the balance does not cover the notes", async () => {
    const a = note(1, 5n)
    const { wallet, token } = fixture([[a], [a], [a], [a]], [3n, 5n])
    expect(await readSpendShape(wallet, token, ACCOUNT)).toEqual({
      notes: [5n],
      depositTotal: 0n,
      balance: 5n,
    })
  })

  it("gives up after the notes changed under every attempt", async () => {
    const reads = Array.from({ length: SPEND_SHAPE_ATTEMPTS * 2 }, (_, i) => [note(i, 1n)])
    const { wallet, token } = fixture(reads, [1n, 1n, 1n])
    const refusal = await readSpendShape(wallet, token, ACCOUNT).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(ShapeUnreadError)
    expect(refusal).toMatchObject({
      attempts: SPEND_SHAPE_ATTEMPTS,
      reason: "the notes kept changing",
    })
  })

  it("gives up when the balance stays below the notes, and says so", async () => {
    const a = note(1, 5n)
    const reads = Array.from({ length: SPEND_SHAPE_ATTEMPTS * 2 }, () => [a])
    const { wallet, token } = fixture(reads, [3n, 3n, 3n])
    const refusal = await readSpendShape(wallet, token, ACCOUNT).catch((e: unknown) => e)
    expect(refusal).toMatchObject({
      attempts: SPEND_SHAPE_ATTEMPTS,
      reason: "the balance stayed below the notes",
    })
  })
})

describe("isSpendEnvelopeRefusal", () => {
  it("recognizes the token, the fee payer and the gas refusing the envelope", () => {
    for (const message of [
      "Assertion failed: Balance too low",
      "Assertion failed: Gas settings exceed whitelist max_fee",
      "Tx exceeded L2 gas limit",
      "DA gas used 1234 exceeds the limit",
      "Circuit execution ran out of gas",
    ]) {
      expect(isSpendEnvelopeRefusal(new Error(message))).toBe(true)
      expect(isSpendEnvelopeRefusal(message)).toBe(true)
    }
  })

  it("looks through the cause chain, once", () => {
    const inner = new Error("Balance too low")
    expect(isSpendEnvelopeRefusal(new Error("simulation failed", { cause: inner }))).toBe(true)
    const loop = new Error("simulation failed")
    ;(loop as { cause?: unknown }).cause = loop
    expect(isSpendEnvelopeRefusal(loop)).toBe(false)
  })

  it("reports anything else", () => {
    expect(isSpendEnvelopeRefusal(new Error("Cannot satisfy constraint"))).toBe(false)
    expect(isSpendEnvelopeRefusal(new Error("Nullifier already exists"))).toBe(false)
    expect(isSpendEnvelopeRefusal(undefined)).toBe(false)
    expect(isSpendEnvelopeRefusal(42)).toBe(false)
  })
})
