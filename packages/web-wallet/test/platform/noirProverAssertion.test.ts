// @vitest-environment node
/** A circuit's failed assert reaches the caller as the circuit's own message, over the real wasm. */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"
import initACVM from "@aztec-foundation/noir-acvm_js/web/acvm_js.js"
import initABI from "@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm.js"
import circuit from "../../../contracts/src/artifacts/target/golden_ticket/golden_ticket.json"
import { proveNoirCircuit } from "../../src/platform/noirProver"

const require = createRequire(import.meta.url)
const wasm = (path: string) => ({ module_or_path: readFileSync(require.resolve(path)) })

const ZERO = "0x0"
/** A ticket whose escrow class is in neither slot of its pair. */
const outsideThePair = {
  root: ZERO,
  threshold: ZERO,
  token: { inner: ZERO },
  class_ids: ["0x1", "0x2"],
  owner: ZERO,
  note: {
    hash: ZERO,
    sender_hash: ZERO,
    data: ZERO,
    refundable_until: ZERO,
    oidc_key_registry: { inner: ZERO },
    vkey_hash: ZERO,
    token_address: { inner: ZERO },
  },
  randomness: ZERO,
  note_nonce: ZERO,
  witness: { leaf_index: ZERO, sibling_path: Array(42).fill(ZERO) },
  public_keys: {
    npk_m_hash: ZERO,
    ivpk_m: { inner: { x: ZERO, y: ZERO, is_infinite: true } },
    ovpk_m_hash: ZERO,
    tpk_m_hash: ZERO,
    mspk_m_hash: ZERO,
    fbpk_m_hash: ZERO,
  },
  class_id: "0x3",
}

describe("proveNoirCircuit on a failed assert", () => {
  beforeAll(async () => {
    await Promise.all([
      initACVM(wasm("@aztec-foundation/noir-acvm_js/web/acvm_js_bg.wasm")),
      initABI(wasm("@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm_bg.wasm")),
    ])
  })

  it("throws the circuit's message and keeps acvm's error as the cause", async () => {
    const err = (await proveNoirCircuit(circuit, outsideThePair, "golden-ticket").catch(
      (e: unknown) => e,
    )) as Error & { cause?: { rawAssertionPayload?: unknown } }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("escrow class is not a paylink")
    expect(err.cause?.rawAssertionPayload).toBeDefined()
  }, 60_000)
})
