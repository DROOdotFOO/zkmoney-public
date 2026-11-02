/**
 * Caller-side ABI guard for `buildTokenOperationCall`. `Contract.methods` is index-signature
 * typed, so a wrong argument count or order compiles and only throws when a tx is built. Each
 * operation field gets a distinct value, so the recorded argument list pins the order the artifact
 * declares, not just its length.
 */
import { describe, expect, it } from "vitest"
import { loadContractArtifact, type ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { NoirCompiledContract } from "@aztec-labs/stdlib/noir"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"

import { buildTokenOperationCall } from "../../../src/services/tee/tokenOperationCall.js"
import type { Operation } from "../../../src/oxide/index.js"

async function oxideTokenArtifact(): Promise<ContractArtifact> {
  const json = await import(
    "../../../../contracts/src/artifacts/target/oxide_token_contract/oxide_token_contract-OxideToken.json",
    { with: { type: "json" } }
  )
  return loadContractArtifact(json.default as NoirCompiledContract)
}

function recordingContract(artifact: ContractArtifact) {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const methods = Object.fromEntries(
    artifact.functions.map((fn) => [
      fn.name,
      (...args: unknown[]) => {
        calls.push({ name: fn.name, args })
        return { with: () => undefined }
      },
    ]),
  )
  return { contract: { artifact, methods } as unknown as Contract, calls }
}

function parameters(artifact: ContractArtifact, name: string) {
  const fn = artifact.functions.find((f) => f.name === name)
  expect(fn, `${name} missing from artifact`).toBeDefined()
  return fn!.parameters
}

function metaLength(artifact: ContractArtifact, name: string): number {
  const meta = parameters(artifact, name).find((p) => p.name === "meta")
  expect(meta?.type.kind, `${name}.meta is not an array`).toBe("array")
  return (meta!.type as unknown as { length: number }).length
}

/** Asserts the recorded arguments equal `expected[<parameter name>]`, in the artifact's order. */
function expectArgsInArtifactOrder(
  artifact: ContractArtifact,
  call: { name: string; args: unknown[] },
  expected: Record<string, unknown>,
) {
  const names = parameters(artifact, call.name).map((p) => p.name)
  expect(Object.keys(expected).sort()).toEqual([...names].sort())
  expect(call.args).toEqual(names.map((n) => expected[n]))
}

describe("buildTokenOperationCall", () => {
  it("passes withdraw's arguments in the artifact's order", async () => {
    const artifact = await oxideTokenArtifact()
    const { contract, calls } = recordingContract(artifact)
    const from = AztecAddress.fromNumberUnsafe(11)
    const executor = EthAddress.fromNumber(22)
    const userPayload = encodePlainWithdrawalPayload({
      recipient: EthAddress.fromNumber(33),
      relayerTip: 40n,
    })
    const authwitNonce = new Fr(77)
    const op: Operation = {
      kind: "withdraw",
      from,
      executor,
      userPayload,
      amount: 300n,
      proverTip: 5n,
      authwitNonce,
    }

    buildTokenOperationCall(contract, op, [])

    expectArgsInArtifactOrder(artifact, calls[0]!, {
      from,
      executor,
      user_payload_hash: getUserPayloadHash(userPayload),
      amount: 300n,
      prover_tip: 5n,
      authwit_nonce: authwitNonce,
    })
  })

  it("passes transfer's arguments in the artifact's order", async () => {
    const artifact = await oxideTokenArtifact()
    const { contract, calls } = recordingContract(artifact)
    const from = AztecAddress.fromNumberUnsafe(11)
    const to = AztecAddress.fromNumberUnsafe(22)
    const authwitNonce = new Fr(77)
    const op: Operation = { kind: "transfer", from, to, amount: 300n, authwitNonce }

    buildTokenOperationCall(contract, op, [])

    expectArgsInArtifactOrder(artifact, calls[0]!, {
      from,
      to,
      amount: 300n,
      meta: Array(metaLength(artifact, "transfer")).fill(Fr.ZERO),
      authwit_nonce: authwitNonce,
    })
  })

  it("keeps a caller-supplied transfer meta", async () => {
    const artifact = await oxideTokenArtifact()
    const { contract, calls } = recordingContract(artifact)
    const meta = Array(metaLength(artifact, "transfer")).fill(9)
    const op: Operation = {
      kind: "transfer",
      from: AztecAddress.fromNumberUnsafe(11),
      to: AztecAddress.fromNumberUnsafe(22),
      amount: 300n,
      meta,
    }

    buildTokenOperationCall(contract, op, [])

    const names = parameters(artifact, "transfer").map((p) => p.name)
    expect(calls[0]!.args[names.indexOf("meta")]).toBe(meta)
  })
})
