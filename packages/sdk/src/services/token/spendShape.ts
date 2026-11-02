/**
 * The shape of a balance: its note amounts and the deposits that make up the rest. A transfer's
 * proof takes a bounded number of notes and deposits, so a move is planned over this shape.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { NotesFilter } from "@aztec-labs/pxe/client/lazy"
import { NoteStatus, type NoteDao } from "@aztec-labs/stdlib/note"
import { OxideTokenContract } from "@obsidion/contracts"

export interface SpendShape {
  /** Active note amounts, largest first. */
  notes: bigint[]
  /** `balance_of` less the notes: what stored deposits hold. */
  depositTotal: bigint
  balance: bigint
}

export type ShapeUnreadReason = "the notes kept changing" | "the balance stayed below the notes"

/** No attempt gave a shape; `reason` is what the last one saw. */
export class ShapeUnreadError extends Error {
  constructor(readonly attempts: number, readonly reason: ShapeUnreadReason) {
    super(`Could not read the balance's shape in ${attempts} attempts: ${reason}`)
    this.name = "ShapeUnreadError"
  }
}

export interface SpendShapePxe {
  debug: { getNotes(filter: NotesFilter): Promise<NoteDao[]> }
}

export interface SpendShapeWallet {
  pxe: SpendShapePxe
}

export interface SpendShapeToken {
  address: AztecAddress
  methods: {
    balance_of(owner: AztecAddress): {
      simulate(options: { from: AztecAddress }): Promise<{ result: unknown }>
    }
  }
}

export const SPEND_SHAPE_ATTEMPTS = 3

interface ShapeNote {
  id: string
  amount: bigint
}

const sameNotes = (a: ShapeNote[], b: ShapeNote[]) => {
  const ids = new Set(b.map((note) => note.id))
  return a.length === b.length && a.every((note) => ids.has(note.id))
}

const descending = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0)

/**
 * The account's shape on `token`. The notes and the balance are separate reads with no shared
 * anchor, so the notes are read before and after the balance and the read counts only when both
 * agree and the balance covers them. Read it while no spend of the account is in flight.
 */
export async function readSpendShape(
  wallet: SpendShapeWallet,
  token: SpendShapeToken,
  account: AztecAddress,
): Promise<SpendShape> {
  const filter: NotesFilter = {
    contractAddress: token.address,
    owner: account,
    storageSlot: OxideTokenContract.storage.balances.slot,
    status: NoteStatus.ACTIVE,
    scopes: [account],
  }
  const readNotes = async (): Promise<ShapeNote[]> =>
    (await wallet.pxe.debug.getNotes(filter)).map((dao) => ({
      id: dao.siloedNullifier.toString(),
      amount: dao.note.items[0]?.toBigInt() ?? 0n,
    }))
  const readBalance = async () =>
    BigInt(String((await token.methods.balance_of(account).simulate({ from: account })).result))
  let reason: ShapeUnreadReason = "the notes kept changing"
  for (let attempt = 0; attempt < SPEND_SHAPE_ATTEMPTS; attempt++) {
    const before = await readNotes()
    const balance = await readBalance()
    const after = await readNotes()
    if (!sameNotes(before, after)) {
      reason = "the notes kept changing"
      continue
    }
    const sum = before.reduce((total, note) => total + note.amount, 0n)
    if (balance < sum) {
      reason = "the balance stayed below the notes"
      continue
    }
    return {
      notes: before.map((note) => note.amount).sort(descending),
      depositTotal: balance - sum,
      balance,
    }
  }
  throw new ShapeUnreadError(SPEND_SHAPE_ATTEMPTS, reason)
}

/**
 * A simulation refused the spend's envelope rather than failing: the token found no balance for
 * a deposit set the planner misjudged, the fee payer refused the gas settings, or the declared gas
 * did not cover the proof. The move planner re-cuts on these and reports anything else.
 */
export const SPEND_ENVELOPE_REFUSALS: readonly RegExp[] = [
  /Balance too low/,
  /Gas settings exceed whitelist max_fee/,
  /(l2|da) gas (limit|used)/i,
  /out of gas/i,
  /exceeds? (the )?gas limit/i,
]

export function isSpendEnvelopeRefusal(err: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const message = (current as { message?: unknown }).message
    if (typeof message === "string" && SPEND_ENVELOPE_REFUSALS.some((re) => re.test(message))) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return typeof err === "string" && SPEND_ENVELOPE_REFUSALS.some((re) => re.test(err))
}
