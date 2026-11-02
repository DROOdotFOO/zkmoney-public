import { describe, expect, it } from "vitest"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { DEFAULT_CONTRACTS, PROOF_FIELD_COUNT, VKEY_FIELD_COUNT } from "@obsidion/core/constants"
import {
  paylinkL1Caller,
  paylinkL1ClaimArgs,
  type PaylinkL1Payout,
} from "../../../../src/services/paylink/claim/paylinkL1Claim.js"
import { plainUserPayload } from "../../../../src/services/withdrawal/plainWithdrawal.js"

const recipient = EthAddress.fromString("0x2222222222222222222222222222222222222222")
const executor = EthAddress.fromString("0x3333333333333333333333333333333333333333")
const payout: PaylinkL1Payout = { executor, userPayload: plainUserPayload(recipient) }
const userPayloadHash = getUserPayloadHash(payout.userPayload)
const publicInputs = [1, 2, 3, 4, 5, 6].map((n) => new Fr(n))
const proof = async (caller: Fr | Promise<Fr> = paylinkL1Caller(payout)) => ({
  vkey: Array(VKEY_FIELD_COUNT).fill("0x01"),
  proof: Array(PROOF_FIELD_COUNT).fill("0x02"),
  public_inputs: [await caller, ...publicInputs].map(String),
})

describe("paylink L1 claim arguments", () => {
  it("passes the direct ABI: executor, user payload hash, prover tip", async () => {
    expect(await paylinkL1ClaimArgs(DEFAULT_CONTRACTS.paylinkDirect, payout, 7n)).toEqual([
      executor,
      userPayloadHash,
      7n,
    ])
  })

  it("passes the email ABI: vkey, proof, public inputs, executor, user payload hash, prover tip", async () => {
    const args = await paylinkL1ClaimArgs(DEFAULT_CONTRACTS.paylinkEmail, payout, 7n, await proof())
    expect(args[0]).toHaveLength(VKEY_FIELD_COUNT)
    expect(args[1]).toHaveLength(PROOF_FIELD_COUNT)
    expect(args.slice(2, 8)).toEqual(publicInputs)
    expect(args.slice(8)).toEqual([executor, userPayloadHash, 7n])
  })

  it("rejects a proof bound to another payout before building a call", async () => {
    const other = EthAddress.fromString("0x4444444444444444444444444444444444444444")
    for (const caller of [
      recipient.toField(),
      paylinkL1Caller({ ...payout, executor: other }),
      paylinkL1Caller({ executor, userPayload: plainUserPayload(other) }),
    ]) {
      await expect(
        paylinkL1ClaimArgs(DEFAULT_CONTRACTS.paylinkEmail, payout, 0n, await proof(caller)),
      ).rejects.toThrow(/not bound to the withdrawal payout/)
    }
  })

  it("rejects missing and malformed email proofs", async () => {
    await expect(paylinkL1ClaimArgs(DEFAULT_CONTRACTS.paylinkEmail, payout, 0n)).rejects.toThrow(
      /zkProof/,
    )
    await expect(
      paylinkL1ClaimArgs(DEFAULT_CONTRACTS.paylinkEmail, payout, 0n, {
        ...(await proof()),
        proof: [],
      }),
    ).rejects.toThrow(/proof must/)
  })

  it("rejects a zero executor, a negative prover tip and unsupported flavors", async () => {
    await expect(
      paylinkL1ClaimArgs(
        DEFAULT_CONTRACTS.paylinkDirect,
        { ...payout, executor: EthAddress.ZERO },
        0n,
      ),
    ).rejects.toThrow(/executor required/)
    await expect(paylinkL1ClaimArgs(DEFAULT_CONTRACTS.paylinkDirect, payout, -1n)).rejects.toThrow(
      /negative/,
    )
    await expect(paylinkL1ClaimArgs("unknown", payout, 0n)).rejects.toThrow(/supports/)
  })
})
