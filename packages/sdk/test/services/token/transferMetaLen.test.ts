/**
 * Drift guard for TRANSFER_META_LEN: the `meta` passthrough length is aztec-nr's
 * `MAX_EVENT_SERIALIZED_LEN - 3`, so an SDK bump can move it. paylink_note and deposit call
 * `transfer` on whichever asset they are handed, and a length mismatch is a selector mismatch.
 * contracts' bridge-abi test covers OxideToken; TestToken, the sandbox asset, is checked here.
 */
import { describe, expect, it } from "vitest"
import { loadContractArtifact, type ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { NoirCompiledContract } from "@aztec-labs/stdlib/noir"
import { TRANSFER_META_LEN } from "@obsidion/core/constants"

async function metaParamLength(artifact: ContractArtifact, fn = "transfer"): Promise<number> {
  const found = artifact.functions.find((f) => f.name === fn)
  expect(found, `${artifact.name} has no ${fn} function`).toBeDefined()
  const meta = found!.parameters.find((p) => p.name === "meta")
  expect(meta, `${artifact.name}.${fn} has no meta parameter`).toBeDefined()
  expect(meta!.type.kind).toBe("array")
  return (meta!.type as unknown as { length: number }).length
}

const ARTIFACTS: Array<[string, () => Promise<{ default: unknown }>]> = [
  [
    "TestToken",
    () =>
      import("../../../../contracts/src/artifacts/target/test_token/test_token-TestToken.json", {
        with: { type: "json" },
      }),
  ],
]

describe("TRANSFER_META_LEN", () => {
  it.each(ARTIFACTS)("matches %s.transfer's meta array length", async (_name, load) => {
    const artifact = loadContractArtifact((await load()).default as NoirCompiledContract)
    expect(await metaParamLength(artifact)).toBe(TRANSFER_META_LEN)
  })
})

const ESCROWS: Array<[string, () => Promise<{ default: unknown }>]> = [
  [
    "PaylinkDirect",
    () =>
      import(
        "../../../../contracts/src/artifacts/target/paylink_direct/paylink_direct-PaylinkDirect.json",
        {
          with: { type: "json" },
        }
      ),
  ],
  [
    "PaylinkEmail",
    () =>
      import(
        "../../../../contracts/src/artifacts/target/paylink_email/paylink_email-PaylinkEmail.json",
        {
          with: { type: "json" },
        }
      ),
  ],
]

describe("paylink deposit meta", () => {
  it.each(ESCROWS)("%s.deposit takes the transfer meta width", async (_name, load) => {
    const artifact = loadContractArtifact((await load()).default as NoirCompiledContract)
    expect(await metaParamLength(artifact, "deposit")).toBe(TRANSFER_META_LEN)
  })
})
