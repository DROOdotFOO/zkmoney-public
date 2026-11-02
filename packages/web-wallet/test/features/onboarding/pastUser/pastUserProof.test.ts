// @vitest-environment node
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { hexToBytes, numberToHex, type Hex } from "viem"
import initACVM from "@aztec-foundation/noir-acvm_js/web/acvm_js.js"
import initABI from "@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm.js"
import { Barretenberg, BarretenbergSync, UltraHonkVerifierBackend } from "@aztec-foundation/bb.js"
import { ELIGIBILITY_SIGN_MESSAGE, ELIGIBILITY_VK_BASE64 } from "@obsidion/core/constants"
import circuit from "../../../../../contracts/src/artifacts/target/eligibility/eligibility.json"
import { proveNoirCircuit } from "../../../../src/platform/noirProver"
import {
  isPastUserAddress,
  NotPastUserError,
  pastUserInputs,
} from "../../../../src/features/onboarding/pastUserProof"

const require = createRequire(import.meta.url)
const wasm = (path: string) => ({ module_or_path: readFileSync(require.resolve(path)) })

const pastUser = privateKeyToAccount(`0x${"11".repeat(32)}`)
const OWNER: Hex = "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025"
// The campaign's nullifier for `pastUser`'s signature, so campaign claims stay spent.
const CAMPAIGN_NULLIFIER =
  18446540441679897329889196622992952050830878484121347127091100538641101703449n

const field = (value: bigint | Hex) => numberToHex(BigInt(value), { size: 32 })

describe("past-user proof", () => {
  // The served leaf file: past-user leaf hashes, sorted, 32 bytes each.
  let leaves: Uint8Array

  beforeAll(async () => {
    await Promise.all([
      initACVM(wasm("@aztec-foundation/noir-acvm_js/web/acvm_js_bg.wasm")),
      initABI(wasm("@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm_bg.wasm")),
      BarretenbergSync.initSingleton(),
    ])
    const addresses = [3n, 4n, 5n, 6n].map((n) => privateKeyToAccount(field(n)).address)
    const api = BarretenbergSync.getSingleton()
    const hashes = [...addresses, pastUser.address]
      .map((a) => api.poseidon2Hash({ inputs: [hexToBytes(field(1n)), hexToBytes(field(a))] }).hash)
      .sort((a, b) => Buffer.compare(a, b))
    leaves = new Uint8Array(hashes.flatMap((hash) => [...hash]))
  })

  it("proves a past user for the owner, and the pinned key verifies it", async () => {
    const signature = await pastUser.signMessage({ message: ELIGIBILITY_SIGN_MESSAGE })
    const inputs = await pastUserInputs({ signature, owner: OWNER, leaves })
    const laps: [string, number][] = []
    const { proof, publicInputs } = await proveNoirCircuit(
      circuit,
      inputs,
      "past-user",
      (lap, ms) => laps.push([lap, ms]),
    )
    expect(laps.map(([lap]) => lap)).toEqual(["wasm", "witness", "backend", "proof"])
    const times = laps.map(([, ms]) => ms)
    expect(times).toEqual([...times].sort((a, b) => a - b))

    expect(publicInputs.slice(1)).toEqual([field(1n), field(OWNER), field(CAMPAIGN_NULLIFIER)])
    expect(publicInputs).not.toContain(field(pastUser.address))
    const api = await Barretenberg.new({ threads: 1 })
    const verificationKey = Buffer.from(ELIGIBILITY_VK_BASE64, "base64")
    const verifier = new UltraHonkVerifierBackend(api)
    expect(await verifier.verifyProof({ proof, publicInputs, verificationKey })).toBe(true)
    await api.destroy()
  }, 300_000)

  it("refuses a wallet that is not on the list", async () => {
    const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`)
    const signature = await stranger.signMessage({ message: ELIGIBILITY_SIGN_MESSAGE })
    await expect(pastUserInputs({ signature, owner: OWNER, leaves })).rejects.toBeInstanceOf(
      NotPastUserError,
    )
  })

  it("finds a listed address without a signature", async () => {
    expect(await isPastUserAddress(pastUser.address, leaves)).toBe(true)
    expect(
      await isPastUserAddress(privateKeyToAccount(`0x${"22".repeat(32)}`).address, leaves),
    ).toBe(false)
  })
})
