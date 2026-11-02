import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { OffchainEffect } from "@aztec-labs/stdlib/tx"

import { ACCOUNTING_EFFECT_IDENTIFIER } from "@oxide/oxide-lib/oxide_constants.gen.js"
import { collectAccountingEffects } from "@oxide/oxide-client/token_operations_collector.js"

// pnpm test -- test/oxide/tokenOperationsCollector.test.ts
//
// Wallet-side pin on the upstream collector's DepositEffect field order:
// buildTeeOperation hydrates each parsed deposit into a `SpentDeposit`
// (recipient / amount / shared_secret_salt / inbox_index / message_hash feed
// the inbox witness lookup and the TEE balance check), so a silent reorder
// upstream would break lazy deposit consume. Filter and discrimination
// behavior is upstream's own token_operations_collector.test.ts; the
// end-to-end lazy deposit consume runs against a real sandbox in
// test/token/token.sandbox.test.ts.

const TOKEN = AztecAddress.fromFieldUnsafe(new Fr(0x7012n))

// Mirrors DEPOSIT_EFFECT_TYPE in oxide_token_contract/src/effects.nr.
const DEPOSIT_EFFECT_TYPE = 4n

function tokenEffect(fields: bigint[]): OffchainEffect {
  return { contractAddress: TOKEN, data: fields.map((n) => new Fr(n)) }
}

// DepositEffect layout:
// [identifier, typ, recipient, amount, shared_secret_salt, inbox_index, message_hash].
function depositEffect(
  recipient: bigint,
  amount: bigint,
  salt: bigint,
  inboxIndex: bigint,
  hash: bigint,
): OffchainEffect {
  return tokenEffect([
    ACCOUNTING_EFFECT_IDENTIFIER,
    DEPOSIT_EFFECT_TYPE,
    recipient,
    amount,
    salt,
    inboxIndex,
    hash,
  ])
}

describe("collectAccountingEffects", () => {
  it("parses a DEPOSIT_EFFECT (type 4, len 7) into one deposit", () => {
    const collected = collectAccountingEffects(TOKEN, [
      depositEffect(0xbeefn, 100n, 0x5ec7e7n, 7n, 0xa11ce5n),
    ])

    expect(collected.deposits).toHaveLength(1)
    const deposit = collected.deposits[0]!
    expect(deposit.recipient.equals(AztecAddress.fromFieldUnsafe(new Fr(0xbeefn)))).toBe(true)
    expect(deposit.amount).toBe(100n)
    expect(deposit.sharedSecretSalt.toBigInt()).toBe(0x5ec7e7n)
    expect(deposit.inboxIndex).toBe(7n)
    expect(deposit.messageHash.toBigInt()).toBe(0xa11ce5n)
    expect(collected.withdrawals).toHaveLength(0)
  })
})
